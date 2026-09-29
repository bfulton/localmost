import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import { spawn } from 'child_process';
import { sweepProcessGroup, finishPendingSweeps } from './process-group';

/** Is this pid still alive? Signal 0 checks without delivering anything. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (predicate: () => boolean, ms = 5000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
};

describe('sweepProcessGroup', () => {
  /** Anything these tests spawn, killed whatever the assertions did. */
  const spawned: number[] = [];
  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone, which is the usual case.
      }
    }
  });

  /**
   * A worker that exits leaving a child behind, which is exactly what happened
   * to a cancelled job: the Actions worker ended, its step's process did not,
   * and the orphan was reparented to launchd where nothing would ever reap it.
   * It ran 70 minutes past the cancellation on two cores.
   */
  const spawnLeaderThatLeavesAnOrphan = async (): Promise<{ leader: number; orphan: number }> => {
    // The leader prints its child's pid, then exits; the child outlives it in
    // the same process group, since detached made the leader a group leader.
    const proc = spawn('sh', ['-c', 'sleep 60 & echo $! ; exit 0'], { detached: true });
    const leader = proc.pid!;
    const orphan = await new Promise<number>((resolve) => {
      let out = '';
      proc.stdout.on('data', (c: Buffer) => {
        out += c.toString();
        if (out.trim()) resolve(Number(out.trim()));
      });
    });
    await waitFor(() => !alive(leader));
    spawned.push(orphan);
    return { leader, orphan };
  };

  it('kills a process left behind by a worker that already exited', async () => {
    const { leader, orphan } = await spawnLeaderThatLeavesAnOrphan();
    // The premise: the leader is gone and the orphan is not.
    expect(alive(leader)).toBe(false);
    expect(alive(orphan)).toBe(true);

    sweepProcessGroup(leader);

    expect(await waitFor(() => !alive(orphan))).toBe(true);
  });

  it('reports whether it found anything to sweep, so a caller can log only when it matters', async () => {
    const { leader, orphan } = await spawnLeaderThatLeavesAnOrphan();
    expect(sweepProcessGroup(leader)).toBe(true);
    await waitFor(() => !alive(orphan));

    // Nothing left in the group now: a second sweep finds no members.
    expect(sweepProcessGroup(leader)).toBe(false);
  });

  it('forgets an escalation once it has fired, so quit cannot signal a reused group', async () => {
    // Review: the timer fired and left its pid in the pending map, so a later
    // finishPendingSweeps() would SIGKILL -pid - a process group the OS may
    // since have handed to something unrelated.
    // Earlier tests sweep with the default ten-second grace; clear theirs so
    // this one sees only its own escalation.
    finishPendingSweeps();
    const { leader, orphan } = await spawnLeaderThatLeavesAnOrphan();
    sweepProcessGroup(leader, { graceMs: 20 });
    await waitFor(() => !alive(orphan));
    await new Promise((r) => setTimeout(r, 60));

    const realKill = process.kill;
    const signalled: number[] = [];
    (process as unknown as { kill: unknown }).kill = ((pid: number) => {
      signalled.push(pid);
      return true;
    }) as never;
    try {
      finishPendingSweeps();
    } finally {
      (process as unknown as { kill: unknown }).kill = realKill;
    }
    expect(signalled).toEqual([]);
  });

  it('is quiet about a pid that never existed, and about no pid at all', () => {
    expect(sweepProcessGroup(null)).toBe(false);
    expect(sweepProcessGroup(undefined)).toBe(false);
    // 2^31-1 is not a live pid on any machine this runs on.
    expect(sweepProcessGroup(2147483647)).toBe(false);
  });

  it('never signals the whole process table when handed pid 0 or 1', () => {
    // kill(-0) is "every process in the caller's group" and kill(-1) is
    // "every process the user may signal". Either would take down the app and
    // the user's session, so they are refused rather than passed through.
    expect(sweepProcessGroup(0)).toBe(false);
    expect(sweepProcessGroup(1)).toBe(false);
  });
});

describe('sweepProcessGroup escalation', () => {
  // Signals are recorded, not sent: these tests are about which pid the
  // SIGKILL would reach, and 4242 is nobody this test owns.
  let realKill: typeof process.kill;
  let signalled: Array<[number, unknown]>;

  beforeEach(() => {
    finishPendingSweeps();
    jest.useFakeTimers();
    signalled = [];
    realKill = process.kill;
    (process as unknown as { kill: unknown }).kill = ((pid: number, sig?: unknown) => {
      signalled.push([pid, sig]);
      return true;
    }) as never;
  });
  afterEach(() => {
    (process as unknown as { kill: unknown }).kill = realKill;
    jest.useRealTimers();
  });

  /** A start-time lookup that answers from a script, one look at a time. */
  const startTimes = (...answers: Array<string | null>) => {
    const seen: Array<string | null> = [...answers];
    return jest.fn((_pid: number) => (seen.length > 1 ? seen.shift()! : seen[0] ?? null));
  };
  const sigkills = () => signalled.filter(([, sig]) => sig === 'SIGKILL');

  it('sends no SIGKILL once the group id has been taken by an unrelated process', () => {
    // The leader was gone when the sweep began; during the grace period its
    // survivors exited and the OS gave pid 4242 to a new process that leads
    // its own group. kill(-4242) now names that stranger's group.
    const startTimeOf = startTimes(null, 'Tue Sep 29 10:00:05 2026');

    expect(sweepProcessGroup(4242, { graceMs: 1000, startTimeOf })).toBe(true);
    jest.advanceTimersByTime(1000);

    expect(sigkills()).toEqual([]);
    expect(startTimeOf).toHaveBeenCalledTimes(2);
  });

  it('still escalates on a leaderless group, and on a leader that ignored SIGTERM', () => {
    // Survivors of a leader that had already exited: nothing holds pid 4242.
    sweepProcessGroup(4242, { graceMs: 1000, startTimeOf: startTimes(null) });
    jest.advanceTimersByTime(1000);
    expect(sigkills()).toEqual([[-4242, 'SIGKILL']]);

    // The same leader, alive through the grace period.
    signalled = [];
    sweepProcessGroup(4343, { graceMs: 1000, startTimeOf: startTimes('Tue Sep 29 09:00:00 2026') });
    jest.advanceTimersByTime(1000);
    expect(sigkills()).toEqual([[-4343, 'SIGKILL']]);
  });

  it('checks the leader again when quit forgoes the grace period', () => {
    const startTimeOf = startTimes('Tue Sep 29 09:00:00 2026', 'Tue Sep 29 10:00:05 2026');
    sweepProcessGroup(4242, { graceMs: 1000, startTimeOf });

    finishPendingSweeps();

    expect(sigkills()).toEqual([]);
  });
});
