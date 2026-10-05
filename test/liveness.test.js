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

import { mkdtempSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waiterFileAlive, releaseIfMine } from '../configs/claude-code/liveness.js';

test('a waiter ending never deletes the file of the waiter that replaced it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'live-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'proj.claude');
  // Waiter A (an older pid) started first, then waiter B overwrote the file with its pid.
  writeFileSync(f, String(process.pid));
  releaseIfMine(f, 999999);                       // A exits: the file names B, so it stays
  assert.equal(existsSync(f), true);
  releaseIfMine(f, process.pid);                  // B exits: its own file goes
  assert.equal(existsSync(f), false);
});

test('a fresh heartbeat proves life even when the pid cannot be checked', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'live-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'proj.claude');
  writeFileSync(f, '2147480000');                 // a pid nobody has
  assert.equal(waiterFileAlive(f), true, 'just written: the waiter is polling');
  const old = (Date.now() - 5 * 60_000) / 1000;
  utimesSync(f, old, old);
  assert.equal(waiterFileAlive(f), false, 'stale heartbeat and no process: dead');
  writeFileSync(f, String(process.pid)); utimesSync(f, old, old);
  assert.equal(waiterFileAlive(f), true, 'a live process counts whatever the file age');
});
