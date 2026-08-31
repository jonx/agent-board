import test from 'node:test';
import assert from 'node:assert/strict';
import { runInvariantChecks } from '../src/invariants.js';
import { openDatabase } from '../src/db.js';
import { Store } from '../src/store.js';
import { TOOL_NAMES } from '../src/mcp.js';

test('human-in-the-loop invariants hold', () => {
  const r = runInvariantChecks();
  assert.deepEqual(r.failures, []);
  assert.ok(r.ok);
});

test('no blocking primitive on the agent surface', () => {
  // Agents must never sit waiting for each other: the board is a mailbox, not a channel.
  for (const name of TOOL_NAMES) assert.doesNotMatch(name, /wait|block|poll|sleep/i, `tool ${name} invites idling`);
});

test('MCP surface exposes no human-only power', () => {
  for (const name of TOOL_NAMES) {
    assert.doesNotMatch(name, /approve|pause|resume|archive|delete|human/i, `tool ${name} looks like a human-only action`);
  }
});

test('review flow: agent verdict decides non-gated reviews', () => {
  const s = new Store(openDatabase(':memory:'));
  const a = s.ensureAgent('a'), b = s.ensureAgent('b'), p = s.ensureProject('p');
  s.join(a, p); s.join(b, p);
  const r = s.createThread(a, { projectId: p.id, kind: 'review', title: 'PR 1', body: 'please review', ref: 'abc123', mentions: ['b'] });
  assert.equal(r.status, 'open');
  const inbox = s.inbox(b, p.id);
  assert.equal(inbox.unread, 1);
  assert.ok(inbox.threads[0].mentions_you);
  s.post(b, { threadId: r.id, body: 'nit: rename', verdict: 'request_changes' });
  assert.equal(s.getThread(r.id).status, 'changes_requested');
  s.post(b, { threadId: r.id, body: 'lgtm', verdict: 'approve' });
  assert.equal(s.getThread(r.id).status, 'approved');
  assert.equal(s.inbox(b, p.id).unread, 0, 'own posts are not unread');
});

test('claims detect overlapping paths', () => {
  const s = new Store(openDatabase(':memory:'));
  const a = s.ensureAgent('a'), b = s.ensureAgent('b'), p = s.ensureProject('p');
  s.join(a, p); s.join(b, p);
  s.claim(a, p.id, ['src/api/'], { note: 'auth' });
  assert.throws(() => s.claim(b, p.id, ['src/api/users.js']), /already claimed/);
  const forced = s.claim(b, p.id, ['src/api/users.js'], { force: true });
  assert.equal(forced.conflicts.length, 1);
  s.release(a, p.id);
  assert.equal(s.activeClaims(p.id).filter(c => c.agent === 'a').length, 0);
});

test('a returning agent gets a to-do list instead of waiting', () => {
  const s = new Store(openDatabase(':memory:'));
  const a = s.ensureAgent('a'), b = s.ensureAgent('b'), p = s.ensureProject('p');
  s.join(a, p); s.join(b, p);
  const q = s.createThread(a, { projectId: p.id, kind: 'question', title: 'which lib?', body: 'stdlib or dep? @b' });
  assert.equal(s.waitingOnAgent(b, p.id).length, 1, 'b is expected to answer');
  assert.equal(s.waitingOnAgent(a, p.id).length, 0, 'the asker is not waiting on itself');
  assert.equal(s.unansweredAsks(a, p.id).length, 1, 'a sees its own question is still unanswered');
  s.post(b, { threadId: q.id, body: 'stdlib' });
  assert.equal(s.waitingOnAgent(b, p.id).length, 0, 'answered: off b\'s plate');
  assert.equal(s.unansweredAsks(a, p.id).length, 0);
});

test('attention model: only what concerns the human is flagged', () => {
  const s = new Store(openDatabase(':memory:'));
  const a = s.ensureAgent('a'), b = s.ensureAgent('b'), p = s.ensureProject('p'), h = s.human();
  s.join(a, p); s.join(b, p);
  const idx = () => Object.fromEntries(s.threadsIndex().map(t => [t.title, t.attention]));

  s.createThread(a, { projectId: p.id, kind: 'status', title: 'a — journal', body: 'progress' });
  s.createThread(a, { projectId: p.id, kind: 'question', title: 'agent chat', body: 'which lib? @b' });
  const rev = s.createThread(a, { projectId: p.id, kind: 'review', title: 'review', body: 'please look', mentions: ['all'] });
  s.systemPost(p.id, 'board updated');
  assert.deepEqual(idx(), { 'a — journal': 'ambient', 'agent chat': 'ambient', review: 'ambient', 'Board updates': 'ambient' },
    'agent-to-agent work, journals and board notices never demand the human');

  const dec = s.createThread(a, { projectId: p.id, kind: 'decision', title: 'drop table', body: 'irreversible' });
  assert.equal(idx()['drop table'], 'action', 'a decision waits for the human');

  s.post(b, { threadId: rev.id, body: 'ping @human, need your call on the licence' });
  assert.equal(idx().review, 'reply', 'an explicit @human mention reaches the human');

  const chat = s.listThreads(p.id, { status: 'all' }).find(t => t.title === 'agent chat');
  s.post(h, { threadId: chat.id, body: 'I would use the stdlib' });
  assert.equal(idx()['agent chat'], 'ambient', 'a thread the human just answered is settled');
  s.post(a, { threadId: chat.id, body: 'ok, doing that' });
  assert.equal(idx()['agent chat'], 'reply', 'someone replied to the human: back in their list');

  // Resolving the decision takes it off the list.
  s.post(h, { threadId: dec.id, body: 'ok' });
  assert.equal(idx()['drop table'], 'ambient');
});

test('one word from the human decides a thread waiting on them', () => {
  const s = new Store(openDatabase(':memory:'));
  const a = s.ensureAgent('a'), p = s.ensureProject('p'), h = s.human();
  s.join(a, p);
  const mk = (title) => s.createThread(a, { projectId: p.id, kind: 'decision', title, body: 'Drop the legacy table?' });

  let t = mk('d1');
  let r = s.post(h, { threadId: t.id, body: 'ok' });
  assert.equal(r.implied_verdict, 'approve');
  assert.equal(s.getThread(t.id).status, 'approved');

  t = mk('d2');
  r = s.post(h, { threadId: t.id, body: 'non' });
  assert.equal(s.getThread(t.id).status, 'rejected');

  t = mk('d3');
  r = s.post(h, { threadId: t.id, body: 'ok but rename the column first' });
  assert.equal(r.implied_verdict, undefined, 'a qualified answer is a comment, never a silent approval');
  assert.equal(s.getThread(t.id).status, 'awaiting_human');

  // Only on threads that are actually waiting, and only from the human.
  const q = s.createThread(a, { projectId: p.id, kind: 'question', title: 'q', body: 'x' });
  s.post(h, { threadId: q.id, body: 'ok' });
  assert.equal(s.getThread(q.id).status, 'open');
  const t2 = mk('d4');
  s.post(a, { threadId: t2.id, body: 'ok' });
  assert.equal(s.getThread(t2.id).status, 'awaiting_human', 'an agent saying ok decides nothing');
});
