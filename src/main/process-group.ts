/**
 * Terminating what a job leaves behind.
 *
 * A worker runs with --once: when it exits, its job is over and nothing of
 * that job should still be running. That is not guaranteed. A cancelled job
 * ended with the Actions worker gone and the step's own process still running
 * - reparented to launchd, where nothing would ever reap it - burning two
 * cores and writing to a full disk for over an hour after GitHub had marked
 * the job cancelled.
 *
 * Workers are spawned detached, so each one leads its own process group and
 * every descendant inherits it. That makes the orphan reachable: the group
 * outlives its leader for as long as any member is alive, so the leader's pid
 * still addresses the survivors after the leader itself is gone.
 */

/** How long a process gets to handle SIGTERM before SIGKILL. */
const GRACE_MS = 10_000;

/**
 * Kill anything still running in `pid`'s process group, and report whether
 * there was anything to kill.
 *
 * Safe to call when the group is already empty, which is the normal case.
 */
export function sweepProcessGroup(
  pid: number | null | undefined,
  options: { graceMs?: number; onLog?: (message: string) => void } = {}
): boolean {
  // kill(-0) signals the caller's own process group and kill(-1) signals every
  // process this user may signal. Either would take down the app, so neither
  // is ever a group to sweep.
  if (pid === null || pid === undefined || pid <= 1 || !Number.isInteger(pid)) return false;

  const { graceMs = GRACE_MS, onLog } = options;

  try {
    // Signal 0 delivers nothing; it asks whether the group has any members.
    process.kill(-pid, 0);
  } catch {
    return false; // Empty group: the job cleaned up after itself.
  }

  onLog?.(`job processes outlived their worker; terminating process group ${pid}`);
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return false; // Raced us and exited between the check and the signal.
  }

  const escalation = setTimeout(() => {
    try {
      process.kill(-pid, 0);
      process.kill(-pid, 'SIGKILL');
      onLog?.(`process group ${pid} ignored SIGTERM; sent SIGKILL`);
    } catch {
      // Gone, which is the point.
    }
  }, graceMs);
  // Never hold the app open waiting to escalate.
  escalation.unref?.();

  return true;
}
