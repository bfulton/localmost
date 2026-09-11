import { describe, it, expect } from '@jest/globals';
import { spawn } from 'child_process';
import { sweepProcessGroup } from './process-group';

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
