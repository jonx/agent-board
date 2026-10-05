// The liveness test behind the waiter files: only ESRCH means dead. EPERM means the
// process exists but the caller may not signal it, which is what a sandboxed hook
// sees; deleting the file in that case killed the reachability of a healthy waiter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pidAlive } from '../configs/claude-code/liveness.js';

test('a process we own is alive', () => {
  assert.equal(pidAlive(process.pid), true);
});

test('a pid nobody has is dead (ESRCH)', () => {
  // Find a free pid: spawn a short-lived child and wait for it to be reaped.
  const child = spawnSync('true');
  assert.equal(pidAlive(child.pid), false);
});

test('a process we may not signal is ALIVE (EPERM), not dead', (t) => {
  // pid 1 (launchd/init, owned by root) throws EPERM for an unprivileged caller:
  // the exact condition a restricted hook hits on a healthy waiter.
  if (process.getuid?.() === 0) return t.skip('running as root, kill(1,0) would succeed trivially');
  let code = null;
  try { process.kill(1, 0); } catch (e) { code = e.code; }
  if (code !== 'EPERM') return t.skip(`kill(1,0) gave ${code ?? 'no error'} here, not EPERM`);
  assert.equal(pidAlive(1), true);
});

test('garbage pids are dead, not errors', () => {
  assert.equal(pidAlive(NaN), false);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-5), false);
});
