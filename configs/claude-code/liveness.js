// Shared by the hooks and the waiter: is the waiter behind a liveness file alive?
//
// Three ways this used to go wrong, all of which made a healthy waiter look dead:
//  - `kill(pid, 0)` throws EPERM when the caller may not signal a process that
//    exists (restricted hook execution). That is "alive", not "dead".
//  - Two waiters for one agent share one file. When one ended, its exit handler
//    deleted the file even though it now named the other, still running, waiter.
//  - Anything that removed the file wrongly left the waiter invisible until restart.
// So: only ESRCH means dead, a fresh heartbeat (the waiter rewrites the file at
// every poll) proves life without any signal at all, and a waiter only ever
// removes a file that still names itself.
import { readFileSync, rmSync, statSync } from 'node:fs';

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}

/** Alive if the process answers, or if the waiter touched its file recently. */
export function waiterFileAlive(path, heartbeatMs = 60_000) {
  let pid;
  try { pid = Number(readFileSync(path, 'utf8')); } catch { return false; }
  if (pidAlive(pid)) return true;
  try { return Date.now() - statSync(path).mtimeMs < heartbeatMs; } catch { return false; }
}

/** Remove the file only if it still names this pid: never another waiter's. */
export function releaseIfMine(path, pid = process.pid) {
  try { if (Number(readFileSync(path, 'utf8')) === pid) rmSync(path, { force: true }); } catch {}
}
