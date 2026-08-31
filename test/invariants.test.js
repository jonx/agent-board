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

test('wait resolves on new message', async () => {
  const s = new Store(openDatabase(':memory:'));
  const a = s.ensureAgent('a'), b = s.ensureAgent('b'), p = s.ensureProject('p');
  s.join(a, p); s.join(b, p);
  const t = s.createThread(a, { projectId: p.id, kind: 'question', title: 'q', body: 'x' });
  s.inbox(b, p.id); // clear
  const w = s.waitForInbox(b, p.id, 2000);
  setTimeout(() => s.post(a, { threadId: t.id, body: 'ping' }), 20);
  assert.equal(await w, true);
  assert.equal(await s.waitForInbox(a, p.id, 30), false);
});
