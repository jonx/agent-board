// Runtime self-check of the human-in-the-loop invariants, on a throwaway in-memory DB.
// server.js runs this before listening and refuses to start if anything fails, so a
// board modification (by an agent or anyone) that weakens oversight is caught immediately.
// test/invariants.test.js runs the same checks plus more.

import { openDatabase, FORBIDDEN_COLUMNS } from './db.js';
import { Store, BoardError } from './store.js';

export function runInvariantChecks() {
  const failures = [];
  const check = (name, fn) => { try { fn(); } catch (e) { failures.push(`${name}: ${e.message}`); } };
  const mustThrow = (name, fn, re) => check(name, () => {
    let threw = null;
    try { fn(); } catch (e) { threw = e; }
    if (!threw) throw new Error('expected an error, none thrown');
    if (re && !re.test(threw.message)) throw new Error(`wrong error: ${threw.message}`);
  });

  const db = openDatabase(':memory:');
  const s = new Store(db);
  const human = s.human();
  const a1 = s.ensureAgent('alpha', 'test'), a2 = s.ensureAgent('beta', 'test');
  const p = s.ensureProject('proj', '/tmp/proj');
  s.join(a1, p); s.join(a2, p);
  const q = s.createThread(a1, { projectId: p.id, kind: 'question', title: 'q', body: 'hello @beta' });
  const dec = s.createThread(a1, { projectId: p.id, kind: 'decision', title: 'critical', body: 'drop the table?' });

  // I0. No schema column can hide content.
  check('no hiding columns', () => {
    for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()) {
      for (const col of db.prepare(`PRAGMA table_info(${name})`).all()) {
        if (FORBIDDEN_COLUMNS.includes(col.name.toLowerCase())) throw new Error(`${name}.${col.name} exists`);
      }
    }
  });
  // I1/I2/I3. Append-only history.
  mustThrow('messages no update', () => db.prepare(`UPDATE messages SET body = 'x' WHERE id = 1`).run(), /append-only/);
  mustThrow('messages no delete', () => db.prepare(`DELETE FROM messages`).run(), /append-only/);
  mustThrow('events no delete', () => db.prepare(`DELETE FROM events`).run(), /append-only/);
  mustThrow('events no update', () => db.prepare(`UPDATE events SET data = '{}'`).run(), /append-only/);
  mustThrow('threads no delete', () => db.prepare(`DELETE FROM threads WHERE id = ?`).run(q.id), /cannot be deleted/);
  mustThrow('projects no delete', () => db.prepare(`DELETE FROM projects`).run(), /cannot be deleted/);
  mustThrow('message needs thread', () => db.prepare(`INSERT INTO messages (id,thread_id,project_id,author_id,body,prev_hash,hash,created_at) VALUES (999,999,1,1,'x','a','b','c')`).run(), /FOREIGN KEY/i);
  // I4. The human is untouchable.
  mustThrow('human no delete', () => db.prepare(`DELETE FROM agents WHERE role = 'human'`).run(), /cannot be removed/);
  mustThrow('human no demote', () => db.prepare(`UPDATE agents SET role = 'agent' WHERE id = ?`).run(human.id), /immutable/);
  mustThrow('agent no promote', () => db.prepare(`UPDATE agents SET role = 'human' WHERE id = ?`).run(a1.id), /immutable/);
  mustThrow('human no pause (sql)', () => db.prepare(`UPDATE agents SET paused_reason = 'x' WHERE id = ?`).run(human.id), /cannot be paused/);
  mustThrow('second human', () => db.prepare(`INSERT INTO agents (name, role, created_at) VALUES ('h2','human','now')`).run(), /only one human/);
  mustThrow('agent cannot be named human', () => s.ensureAgent('human'), /human account/);
  // I5. Human-gated decisions.
  check('decision waits for human', () => { if (dec.status !== 'awaiting_human' || !dec.needs_human) throw new Error(dec.status); });
  mustThrow('needs_human sticky', () => db.prepare(`UPDATE threads SET needs_human = 0 WHERE id = ?`).run(dec.id), /keeps requiring/);
  mustThrow('agent cannot approve decision', () => s.setThreadStatus(a2, dec.id, 'approved'), /human/);
  mustThrow('agent cannot resolve decision', () => s.setThreadStatus(a2, dec.id, 'resolved'), /human/);
  check('agent verdict on decision is advisory', () => {
    const r = s.post(a2, { threadId: dec.id, body: 'I say yes', verdict: 'approve' });
    if (!r.advisory || s.getThread(dec.id).status !== 'awaiting_human') throw new Error('agent verdict changed status');
  });
  check('human decides', () => {
    s.post(human, { threadId: dec.id, body: 'no', verdict: 'reject' });
    if (s.getThread(dec.id).status !== 'rejected') throw new Error('human verdict ignored');
  });
  check('board-change waits for human', () => {
    const bc = s.createThread(a1, { projectId: p.id, kind: 'board-change', title: 'add feature', body: 'diff', ref: 'branch' });
    if (bc.status !== 'awaiting_human') throw new Error(bc.status);
  });
  // I6. Pause is human-only and effective.
  mustThrow('agent cannot pause agent', () => s.pauseAgent(a1, a2.id, 'x'), /only the human/);
  mustThrow('agent cannot pause thread', () => s.pauseThread(a1, q.id, 'x'), /only the human/);
  mustThrow('agent cannot unpause thread', () => s.pauseThread(a1, q.id, null), /only the human/);
  mustThrow('human cannot be paused (store)', () => s.pauseAgent(human, human.id, 'x'), /cannot be paused/);
  check('paused agent cannot post', () => {
    s.pauseAgent(human, a2.id, 'stop');
    let threw = false; try { s.post(a2, { threadId: q.id, body: 'hi' }); } catch (e) { threw = e instanceof BoardError && e.code === 'paused'; }
    if (!threw) throw new Error('paused agent posted');
    s.pauseAgent(human, a2.id, null);
    s.post(a2, { threadId: q.id, body: 'hi again' });
  });
  check('paused thread blocks agents, not human', () => {
    s.pauseThread(human, q.id, 'hold');
    let threw = false; try { s.post(a1, { threadId: q.id, body: 'x' }); } catch (e) { threw = e.code === 'paused'; }
    if (!threw) throw new Error('agent posted to paused thread');
    s.post(human, { threadId: q.id, body: 'human can still speak' });
    s.pauseThread(human, q.id, null);
  });
  // I7. Everyone in a project sees everything: inbox is not filtered by recipient.
  check('inbox shows all project messages', () => {
    const a3 = s.ensureAgent('gamma', 'test'); s.join(a3, p);
    s.post(a1, { threadId: q.id, body: 'note only for @beta (there is no such thing)' });
    const inbox = s.inbox(a3, p.id, { peek: true });
    if (!inbox.threads.some(t => t.messages.some(m => m.body.includes('no such thing')))) throw new Error('mention hid a message from a third agent');
  });
  // I8. Hash chain intact.
  check('hash chain', () => { const v = s.verifyChain(); if (!v.ok) throw new Error(`broken at ${v.broken_at}`); });

  db.close();
  return { ok: failures.length === 0, failures };
}
