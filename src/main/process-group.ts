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

import { lookUpStartTime, mayEscalate, StartTime } from './runner-cleanup';

/** How long a process gets to handle SIGTERM before SIGKILL. */
export const GRACE_MS = 10_000;

type StartTimeOf = (pid: number) => StartTime;

interface Escalation {
  /**
   * The leader's start time when the sweep began; null if it had already
   * exited, undefined if the lookup failed.
   */
  leaderStart: StartTime;
  startTimeOf: StartTimeOf;
  onLog?: (message: string) => void;
}

/** Escalations still waiting out their grace period, by process group. */
const pendingEscalations = new Map<number, Escalation & { timer: NodeJS.Timeout }>();

/**
 * SIGKILL the group, unless its id no longer names the group that was swept.
 *
 * A process group id is its leader's pid, and the OS can hand that pid out
 * again once every member of the group has exited - which is what SIGTERM
 * asks of them during the grace period. A new process given that pid that
 * leads a group of its own is then what kill(-pid) reaches. The OS never
 * reuses a pid while a group with that id still has members, so a live
 * process at `pid` is either the leader the sweep found (same start time) or
 * a stranger (anything else, including one where the sweep found none), and
 * only the first means the group is still ours to kill. mayEscalate() holds
 * the rule, shared with the startup sweep, including what a failed lookup
 * means.
 */
function escalate(pid: number, { leaderStart, startTimeOf, onLog }: Escalation): void {
  try {
    process.kill(-pid, 0);
  } catch {
    return; // Gone, which is the point.
  }
  if (!mayEscalate(leaderStart, startTimeOf(pid))) {
    onLog?.(`process group ${pid} ended and its id was reused; not sending SIGKILL`);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
    onLog?.(`process group ${pid} ignored SIGTERM; sent SIGKILL`);
  } catch {
    // Exited between the check and the signal.
  }
}

/**
 * Whether `pid`'s process group has any members this process may signal.
 * Signal 0 delivers nothing; it only asks.
 */
export function groupHasMembers(pid: number): boolean {
  if (pid <= 1 || !Number.isInteger(pid)) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill anything still waiting out a grace period, now.
 *
 * Called when the app is quitting: the escalation timers are unref'd so they
 * do not hold the app open, which means they never fire on the way out - and a
 * descendant that ignored SIGTERM would then outlive everything that could
 * reap it.
 */
export function finishPendingSweeps(): void {
  for (const [pid, pending] of pendingEscalations) {
    clearTimeout(pending.timer);
    escalate(pid, pending);
  }
  pendingEscalations.clear();
}

/**
 * Kill anything still running in `pid`'s process group, and report whether
 * there was anything to kill.
 *
 * Safe to call when the group is already empty, which is the normal case.
 */
export function sweepProcessGroup(
  pid: number | null | undefined,
  options: { graceMs?: number; onLog?: (message: string) => void; startTimeOf?: StartTimeOf } = {}
): boolean {
  // kill(-0) signals the caller's own process group and kill(-1) signals every
  // process this user may signal. Either would take down the app, so neither
  // is ever a group to sweep.
  if (pid === null || pid === undefined || pid <= 1 || !Number.isInteger(pid)) return false;

  const { graceMs = GRACE_MS, onLog, startTimeOf = lookUpStartTime } = options;

  try {
    // Signal 0 delivers nothing; it asks whether the group has any members.
    process.kill(-pid, 0);
  } catch {
    return false; // Empty group: the job cleaned up after itself.
  }

  // Who holds the pid now, so the escalation can tell this group from one
  // that takes over its id during the grace period.
  const leaderStart = startTimeOf(pid);

  onLog?.(`job processes outlived their worker; terminating process group ${pid}`);
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return false; // Raced us and exited between the check and the signal.
  }

  const escalation = setTimeout(() => {
    // Done with this group either way. Left in the map, finishPendingSweeps()
    // would later signal -pid, a group id the OS may by then have reused for
    // something unrelated.
    pendingEscalations.delete(pid);
    escalate(pid, { leaderStart, startTimeOf, onLog });
  }, graceMs);
  // Never hold the app open waiting to escalate.
  escalation.unref?.();

  // An unref'd timer does not survive the app quitting, and quit is exactly
  // when a surviving descendant matters most: nothing will be left to reap it.
  // finishNow() is the caller's way to say "there is no later" - it forgoes the
  // grace period and kills immediately.
  pendingEscalations.set(pid, { timer: escalation, leaderStart, startTimeOf, onLog });

  return true;
}
