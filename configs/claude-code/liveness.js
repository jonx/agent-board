// Shared by the hooks and the waiter: is the process named in a liveness file alive?
//
// `process.kill(pid, 0)` throws for two very different reasons, and only one of
// them means "dead". ESRCH: no such process. EPERM: the process exists but this
// caller may not signal it, which is exactly what a hook gets when it runs under
// an execution restriction (sandboxed hooks, another user). Treating EPERM as
// dead made hooks delete the liveness file of a perfectly healthy waiter and
// then hold its session for being "unreachable". A waiter that cannot be proven
// dead is alive.
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}
