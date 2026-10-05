// The Stop hooks (Codex, and the Claude Code plugin) ask the board whether a session of a
// provider may finish its turn, through /api/hook/stop. These tests pin down when the
// board says no, and that the answer clears the moment the agent does its part.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { Store } from '../src/store.js';
import { startServer } from '../src/server.js';

function fixture(t) {
  const s = new Store(openDatabase(':memory:'));
  t.after(() => s.db.close());
  const p = s.ensureProject('p', '/tmp/hookp');
  const claude = s.ensureAgent('claude', 'claude'), codex = s.ensureAgent('codex', 'codex');
  s.join(claude, p); s.join(codex, p);
  return { s, p, claude, codex, h: s.human() };
}

test('a provider is held while a question addressed to it is unanswered', (t) => {
  const { s, p, claude } = fixture(t);
  const q = s.createThread(claude, { projectId: p.id, kind: 'question', title: 'need your take', body: 'thoughts? @codex', mentions: ['codex'] });
  let r = s.hookStopCheck(p.id, 'codex');
  assert.equal(r.block, true);
  assert.match(r.reason, /waiting on you/);
  assert.match(r.reason, /board_inbox/);
  assert.equal(s.hookStopCheck(p.id, 'claude').block, false, 'the asker owes nothing');

  // Any honest reaction ends the hold: declining is an answer too. The durable
  // notification must also be confirmed (board_notifications then board_receive),
  // exactly as the agent protocol demands.
  const codex = s.getAgent('codex');
  s.react(codex, q.id, 'declined', 'not my area');
  s.inbox(codex, p.id);
  const r2 = s.hookStopCheck(p.id, 'codex');
  assert.equal(r2.block, true, 'unreceived notifications still hold');
  assert.match(r2.reason, /board_receive/);
  s.receiveNotifications(codex, p.id, s.notifications(codex, p.id).map(n => n.id));
  assert.equal(s.hookStopCheck(p.id, 'codex').block, false);
});

test('an unread human message holds the provider; reading clears it', (t) => {
  const { s, p, h, codex } = fixture(t);
  const th = s.createThread(h, { projectId: p.id, kind: 'question', title: 'status?', body: 'where are we?' });
  assert.equal(s.hookStopCheck(p.id, 'codex').block, true);
  s.inbox(codex, p.id);
  s.react(codex, th.id, 'working', 'answering next');
  s.receiveNotifications(codex, p.id, s.notifications(codex, p.id).map(n => n.id));
  assert.equal(s.hookStopCheck(p.id, 'codex').block, false, 'read + acked + received: may stop');
  assert.equal(s.hookStopCheck(p.id, 'gemini').block, false, 'a provider with no agents here is never held');
});

test('board notices never hold anyone', (t) => {
  const { s, p } = fixture(t);
  s.systemPost(p.id, 'the board restarted');
  assert.equal(s.hookStopCheck(p.id, 'codex').block, false);
  assert.equal(s.hookStopCheck(p.id, 'claude').block, false);
});

test('the shared hook script blocks over HTTP and degrades silently', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-hook-'));
  const { server, base, store } = await startServer({ port: 0, dataDir: dir, quiet: true });
  t.after(() => { server.closeAllConnections(); server.close(); store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  // Some sandboxes let node reach an in-process listener but not an exec'd curl.
  // The script is curl-based by design (it must run on machines without node modules),
  // so when curl cannot reach the fixture, the rest of this test cannot run here.
  try { execFileSync('curl', ['-sf', '--max-time', '1', base + '/api/version']); }
  catch { t.skip('curl cannot reach an in-process listener in this sandbox'); return; }
  const claude = store.ensureAgent('claude', 'claude'), codex = store.ensureAgent('codex', 'codex');
  const p = store.ensureProject('hookproj', '/tmp/hookproj-' + process.pid);
  store.join(claude, p); store.join(codex, p);
  store.createThread(claude, { projectId: p.id, kind: 'question', title: 'q', body: 'please answer @codex', mentions: ['codex'] });

  const run = (event, env = {}, extra = {}) => execFileSync('sh', ['configs/hooks/board-hook.sh', 'hookproj', 'codex'], {
    input: JSON.stringify({ hook_event_name: event, session_id: 's1', cwd: p.path, stop_hook_active: false, ...extra }),
    env: { ...process.env, BOARD_URL: base, ...env }, encoding: 'utf8',
  });

  const stop = run('Stop');
  assert.match(stop, /"decision":"block"/);
  assert.match(stop, /board_inbox/);
  assert.equal(run('Stop', {}, { stop_hook_active: true }), '', 'never nudges twice in a row');
  assert.match(run('UserPromptSubmit'), /new message/i);
  assert.equal(run('UserPromptSubmit'), '', 'counter only fires when something is new');
  assert.match(run('SessionStart'), /board_status/);
  // Project resolution from cwd alone (the plugin path: no argument baked in).
  const auto = execFileSync('sh', ['configs/hooks/board-hook.sh'], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's2', cwd: p.path + '/src', stop_hook_active: false }),
    env: { ...process.env, BOARD_URL: base }, encoding: 'utf8',
  });
  assert.match(auto, /"decision":"block"/, 'project resolved from the directory');
  // A dead board never breaks a session: silent exit 0.
  assert.equal(execFileSync('sh', ['configs/hooks/board-hook.sh', 'hookproj', 'codex'], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's3', cwd: '/x', stop_hook_active: false }),
    env: { ...process.env, BOARD_URL: 'http://127.0.0.1:1' }, encoding: 'utf8',
  }), '');
});
