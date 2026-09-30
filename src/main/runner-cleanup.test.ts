import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { cleanupSandboxDirectories, killOrphanedProcesses, markerHolders, parsePidRecord, signalOrphanPids, classifyLsofFailure, classifyPsFailure, lsofCanSeeOtherProcesses } from './runner-cleanup';

describe('killOrphanedProcesses', () => {
  const runnerDir = path.join(os.tmpdir(), `lm-cleanup-${process.pid}`);
  const sandboxBase = path.join(runnerDir, 'sandbox');
  const pidDir = path.join(runnerDir, 'pids');
  let realKill: typeof process.kill;
  let signalled: Array<[number, unknown]>;

  beforeEach(() => {
    fs.mkdirSync(pidDir, { recursive: true });
    fs.mkdirSync(path.join(sandboxBase, '1'), { recursive: true });
    signalled = [];
    realKill = process.kill;
    (process as unknown as { kill: unknown }).kill = ((pid: number, sig?: unknown) => {
      signalled.push([pid, sig]);
      return true;
    }) as never;
  });
  afterEach(() => {
    (process as unknown as { kill: unknown }).kill = realKill;
    fs.rmSync(runnerDir, { recursive: true, force: true });
  });

  // A stub for the process start-time lookup, so the test does not depend on a
  // real process or on `ps` (which behaves differently inside the sandbox).
  const startTimeOf = (want: Record<number, string>) => (pid: number) => want[pid] ?? null;

  it('signals an orphan whose recorded start time still matches', async () => {
    fs.writeFileSync(path.join(pidDir, '1.pid'), '4242 STARTED-AT');

    await killOrphanedProcesses(sandboxBase, () => undefined, startTimeOf({ 4242: 'STARTED-AT' }));

    expect(signalled.some(([p]) => p === 4242 || p === -4242)).toBe(true);
  });

  it('reads the app-owned pids directory, not the job-writable sandbox pid file', async () => {
    // A job can write its own sandbox; a pid file there must not steer the kill.
    fs.writeFileSync(path.join(sandboxBase, '1', 'runner.pid'), '4242 STARTED-AT');

    await killOrphanedProcesses(sandboxBase, () => undefined, startTimeOf({ 4242: 'STARTED-AT' }));

    expect(signalled.some(([p]) => p === 4242 || p === -4242)).toBe(false);
  });

  it('does not signal a pid whose start time no longer matches (reuse)', async () => {
    fs.writeFileSync(path.join(pidDir, '1.pid'), '4242 OLD-START');

    await killOrphanedProcesses(sandboxBase, () => undefined, startTimeOf({ 4242: 'NEW-START' }));

    expect(signalled).toEqual([]);
  });

  it('sends no SIGKILL when the pid changed hands during the grace period', async () => {
    // The worker exited on SIGTERM, and in the two seconds before the
    // escalation the OS gave its pid to a new process. A liveness probe
    // cannot tell the two apart; the start time can.
    fs.writeFileSync(path.join(pidDir, '1.pid'), '4242 STARTED-AT');
    const looks = ['STARTED-AT', 'LATER-START'];
    const startTimeOf = (pid: number) => (pid === 4242 ? (looks.length > 1 ? looks.shift()! : looks[0]) : null);

    await killOrphanedProcesses(sandboxBase, () => undefined, startTimeOf);

    expect(signalled.filter(([, sig]) => sig === 'SIGTERM')).toEqual([[-4242, 'SIGTERM']]);
    expect(signalled.filter(([, sig]) => sig === 'SIGKILL')).toEqual([]);
  });

  it('force-kills survivors of a worker that exited on SIGTERM', async () => {
    // The worker is gone after the grace period but its descendants are not.
    // While they live the group id cannot have been reused, so the group is
    // still the one verified above - the same rule the per-worker sweep uses.
    fs.writeFileSync(path.join(pidDir, '1.pid'), '4242 STARTED-AT');
    const looks: Array<string | null> = ['STARTED-AT', null];
    const startTimeOf = (pid: number) => (pid === 4242 ? (looks.length > 1 ? looks.shift()! : looks[0]) : null);

    await killOrphanedProcesses(sandboxBase, () => undefined, startTimeOf);

    expect(signalled.filter(([, sig]) => sig === 'SIGKILL')).toEqual([[-4242, 'SIGKILL']]);
  });

  it('force-kills as before when the second start-time lookup fails', async () => {
    // ps timing out under load is not evidence the pid changed hands.
    fs.writeFileSync(path.join(pidDir, '1.pid'), '4242 STARTED-AT');
    const looks: Array<string | undefined> = ['STARTED-AT', undefined];
    const startTimeOf = (pid: number) => (pid === 4242 ? (looks.length > 1 ? looks.shift() : looks[0]) : null);

    await killOrphanedProcesses(sandboxBase, () => undefined, startTimeOf);

    expect(signalled.filter(([, sig]) => sig === 'SIGKILL')).toEqual([[-4242, 'SIGKILL']]);
  });

  it('still force-kills a worker that ignored SIGTERM', async () => {
    fs.writeFileSync(path.join(pidDir, '1.pid'), '4242 STARTED-AT');

    await killOrphanedProcesses(sandboxBase, () => undefined, startTimeOf({ 4242: 'STARTED-AT' }));

    expect(signalled.filter(([, sig]) => sig === 'SIGKILL')).toEqual([[-4242, 'SIGKILL']]);
  });

  it('never signals this process, even if a stale pid file names it', async () => {
    fs.writeFileSync(path.join(pidDir, '1.pid'), String(process.pid));
    await killOrphanedProcesses(sandboxBase, () => undefined);
    expect(signalled).toEqual([]);
  });

  it('ignores a pid file with trailing junk, not treating it as a bare number', async () => {
    fs.writeFileSync(path.join(pidDir, '1.pid'), '4242junk');
    await killOrphanedProcesses(sandboxBase, () => undefined);
    expect(signalled).toEqual([]);
  });

  it('refuses to signal pid 1 or lower', async () => {
    fs.writeFileSync(path.join(pidDir, '1.pid'), '-1');
    fs.writeFileSync(path.join(pidDir, '2.pid'), '0');

    await killOrphanedProcesses(sandboxBase, () => undefined);

    expect(signalled).toEqual([]);
  });
});

describe('marker-based orphan reaping', () => {
  const runnerDir = path.join(os.tmpdir(), `lm-marker-${process.pid}`);
  const sandboxBase = path.join(runnerDir, 'sandbox');
  const pidDir = path.join(runnerDir, 'pids');
  let realKill: typeof process.kill;
  let signalled: Array<[number, unknown]>;

  beforeEach(() => {
    fs.mkdirSync(pidDir, { recursive: true });
    fs.mkdirSync(sandboxBase, { recursive: true });
    signalled = [];
    realKill = process.kill;
    (process as unknown as { kill: unknown }).kill = ((pid: number, sig?: unknown) => {
      signalled.push([pid, sig]);
      return true;
    }) as never;
  });
  afterEach(() => {
    (process as unknown as { kill: unknown }).kill = realKill;
    fs.rmSync(runnerDir, { recursive: true, force: true });
  });

  it('parses a two-line record: pid+start, then the marker path', () => {
    expect(parsePidRecord('4242 Mon Sep 28 13:50:00 2026\n/x/pids/1-ab.mark\n')).toEqual({
      pid: 4242, recordedStart: 'Mon Sep 28 13:50:00 2026', markerPath: '/x/pids/1-ab.mark',
    });
    expect(parsePidRecord('4242junk\n/x/m')).toMatchObject({ pid: null });
    expect(parsePidRecord('4242')).toEqual({ pid: 4242, recordedStart: '', markerPath: null });
  });

  it('signals the pids holding a leftover marker, escalating only to those still holding it', async () => {
    // Leader gone (no pid record at all) - the marker alone names survivors.
    // 6001 lets go after SIGTERM; 6002 does not. kill(pid, 0) cannot tell
    // 6001's exit from a stranger that inherited its pid during the grace
    // period, so escalation goes by a second look at the marker.
    const marker = path.join(pidDir, '1-deadbeef.mark');
    fs.writeFileSync(marker, '');
    const looks = [[6001, 6002], [6002], []];
    const holdersOf = (p: string) => (p === marker ? (looks.shift() ?? []) : []);

    // The boolean gates the caller's settle wait; something was signalled.
    expect(await killOrphanedProcesses(sandboxBase, () => undefined, () => null, holdersOf)).toBe(true);

    expect(signalled.filter(([, sig]) => sig === 'SIGTERM').map(([p]) => p)).toEqual([6001, 6002]);
    expect(signalled.filter(([, sig]) => sig === 'SIGKILL').map(([p]) => p)).toEqual([6002]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('force-kills a holder that appeared during the grace period', async () => {
    // 6001 forked 6003 after SIGTERM; the child holds the marker too and goes
    // with it - the original list would have missed it.
    const marker = path.join(pidDir, '1-deadbeef.mark');
    fs.writeFileSync(marker, '');
    const looks = [[6001], [6001, 6003], []];

    await killOrphanedProcesses(sandboxBase, () => undefined, () => null, (p) => (p === marker ? (looks.shift() ?? []) : []));

    expect(signalled.filter(([, sig]) => sig === 'SIGTERM').map(([p]) => p)).toEqual([6001]);
    expect(signalled.filter(([, sig]) => sig === 'SIGKILL').map(([p]) => p)).toEqual([6001, 6003]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('keeps the marker, and sends no SIGKILL, when the post-grace re-check is unavailable', async () => {
    // 6001 ignored SIGTERM and lsof then timed out. Dropping the marker here
    // would make 6001 unreachable for good: no leader record names it.
    const marker = path.join(pidDir, '1-deadbeef.mark');
    fs.writeFileSync(marker, '');
    const looks: Array<number[] | null> = [[6001], null];
    const next = (): number[] | null => (looks.length > 0 ? looks.shift()! : []);

    await killOrphanedProcesses(sandboxBase, () => undefined, () => null, (p) => (p === marker ? next() : []));

    expect(signalled).toEqual([[6001, 'SIGTERM']]);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('keeps the marker while a holder survives SIGKILL', async () => {
    const marker = path.join(pidDir, '1-deadbeef.mark');
    fs.writeFileSync(marker, '');
    const looks = [[6001], [6001], [6001]];

    await killOrphanedProcesses(sandboxBase, () => undefined, () => null, (p) => (p === marker ? (looks.shift() ?? []) : []));

    expect(signalled.filter(([, sig]) => sig === 'SIGKILL').map(([p]) => p)).toEqual([6001]);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('keeps a marker, and signals nothing, when it could not learn who holds it', async () => {
    // "Unknown" is not "nobody": the marker is the only reuse-proof handle on
    // the survivors, so a failed lsof must not cost it.
    const marker = path.join(pidDir, '1-deadbeef.mark');
    fs.writeFileSync(marker, '');
    const logged: string[] = [];

    await killOrphanedProcesses(sandboxBase, (m) => logged.push(m), () => null, () => null);

    expect(signalled).toEqual([]);
    expect(fs.existsSync(marker)).toBe(true);
    expect(logged.some((m) => m.includes('1-deadbeef.mark'))).toBe(true);
  });

  it("kills what an earlier run's jobs left under their profile marks, then drops the marks", async () => {
    // The app quit, or crashed, before a finished job was swept: something
    // it left outside its process group still runs under its profile, and
    // the mark in that profile is how to find it. By real path, since that
    // is what seatbelt answers for.
    const stem = path.join(fs.realpathSync(pidDir), '1-feedface');
    fs.writeFileSync(`${stem}.granted`, '');
    fs.writeFileSync(`${stem}.withheld`, '');
    const reaped: Array<{ granted: string; withheld: string }> = [];

    const result = await killOrphanedProcesses(sandboxBase, () => undefined, () => null, () => [], async (marker) => {
      reaped.push(marker);
      return [7001];
    });

    expect(reaped).toEqual([{ granted: `${stem}.granted`, withheld: `${stem}.withheld` }]);
    expect(result).toBe(true);
    expect(fs.existsSync(`${stem}.granted`)).toBe(false);
    expect(fs.existsSync(`${stem}.withheld`)).toBe(false);
  });

  it("gives an earlier run's worker its SIGTERM before killing by profile mark what escaped it", async () => {
    // The mark sweep stops and kills without warning. The worker's group,
    // found by its pid record, is sent SIGTERM first, so the runner can
    // disconnect from GitHub; the mark then takes only what that missed.
    fs.writeFileSync(path.join(pidDir, '1.pid'), `4242 STARTED-AT\n${path.join(pidDir, '1-feedface.mark')}\n`);
    const stem = path.join(fs.realpathSync(pidDir), '1-feedface');
    fs.writeFileSync(`${stem}.granted`, '');
    fs.writeFileSync(`${stem}.withheld`, '');
    let signalledBeforeReap: Array<[number, unknown]> | undefined;

    await killOrphanedProcesses(sandboxBase, () => undefined, (pid) => (pid === 4242 ? 'STARTED-AT' : null), () => [], async () => {
      signalledBeforeReap = [...signalled];
      return [];
    });

    expect(signalledBeforeReap).toContainEqual([-4242, 'SIGTERM']);
    expect(fs.existsSync(`${stem}.granted`)).toBe(false);
  });

  it('drops a mark it could not sweep by, and half of one, rather than keep them for ever', async () => {
    // Without the developer tools the sweep never runs; a mark kept for it
    // would be kept for good, one for every job.
    const stem = path.join(fs.realpathSync(pidDir), '1-feedface');
    fs.writeFileSync(`${stem}.granted`, '');
    fs.writeFileSync(`${stem}.withheld`, '');
    fs.writeFileSync(path.join(pidDir, '2-cafe.withheld'), '');
    const logged: string[] = [];
    const reaped: unknown[] = [];

    const result = await killOrphanedProcesses(sandboxBase, (m) => logged.push(m), () => null, () => [], async (marker) => {
      reaped.push(marker);
      return null;
    });

    expect(reaped).toHaveLength(1);
    expect(result).toBe(false);
    expect(fs.readdirSync(pidDir)).toEqual([]);
    expect(logged.some((m) => m.includes('1-feedface'))).toBe(true);
  });

  it('does not force-kill blind when the marker cannot be re-checked after the grace period', async () => {
    const logged: string[] = [];

    const result = await signalOrphanPids([6001], (m) => logged.push(m), 10, () => null);

    expect(signalled).toEqual([[6001, 'SIGTERM']]);
    expect(result).toEqual({ signalled: true, remaining: null });
    expect(logged.some((m) => /next sweep/.test(m))).toBe(true);
  });

  it('answers "nobody" for a marker that no longer exists', async () => {
    await expect(markerHolders(path.join(pidDir, 'never-made.mark'))).resolves.toEqual([]);
  });

  it('does not remember a probe that failed', async () => {
    // First probe-using test in this file, so the cache is empty here. A
    // transient failure must not blind every later sweep.
    await expect(lsofCanSeeOtherProcesses(async () => false)).resolves.toBe(false);
    await expect(lsofCanSeeOtherProcesses()).resolves.toBe(true);
  });

  it('answers "nobody" for an existing file nothing holds', async () => {
    const marker = path.join(pidDir, '1-0000beef.mark');
    fs.writeFileSync(marker, '');
    await expect(markerHolders(marker)).resolves.toEqual([]);
  });

  it('answers "unknown" for everything, and says so once, while lsof is not trusted', async () => {
    const marker = path.join(pidDir, '1-0000beef.mark');
    fs.writeFileSync(marker, '');
    const logged: string[] = [];
    const blind = async () => false;

    await expect(markerHolders(marker, (m) => logged.push(m), blind)).resolves.toBeNull();
    await expect(markerHolders(marker, (m) => logged.push(m), blind)).resolves.toBeNull();

    expect(logged).toEqual(["lsof cannot see other processes' open files here; marker files are kept, not swept"]);
  });

  it('proves lsof can see other processes before trusting an empty answer', async () => {
    await expect(lsofCanSeeOtherProcesses()).resolves.toBe(true);
  });

  it('reads a failed lsof run as holders, nobody, or unknown', () => {
    // execFile's shapes: numeric code for an exit status, string code for a
    // spawn failure, killed/signal for a timeout.
    expect(classifyLsofFailure({ code: 1, stdout: '', stderr: '' })).toEqual([]);
    expect(classifyLsofFailure({ code: 1, stdout: '4242\n4243\n', stderr: '' })).toEqual([4242, 4243]);
    expect(classifyLsofFailure({ code: 1, stdout: '', stderr: "lsof: can't get PID byte count" })).toBeNull();
    // Output beside an error is a partial answer, which is no answer.
    expect(classifyLsofFailure({ code: 1, stdout: '4242\n', stderr: "lsof: can't get PID byte count" })).toBeNull();
    expect(classifyLsofFailure({})).toBeNull();
    expect(classifyLsofFailure({ code: 2, stdout: '', stderr: '' })).toBeNull();
    expect(classifyLsofFailure({ code: 'ENOENT', stdout: '', stderr: '' })).toBeNull();
    // A run that was cut off cannot vouch for what it did not print.
    expect(classifyLsofFailure({ killed: true, signal: 'SIGTERM', code: null, stdout: '4242\n' })).toBeNull();
    // Never itself, never pid 1, no duplicates.
    expect(classifyLsofFailure({ code: 1, stdout: `1\n${process.pid}\n7\n7\n` })).toEqual([7]);
  });

  it('reads a failed ps run as no such process only when ps said so', () => {
    // execFileSync's shapes. `ps -p <pid>` for a pid nobody holds exits 1 and
    // prints nothing; a timeout or a failed spawn says nothing about the pid.
    expect(classifyPsFailure({ status: 1, signal: null, stdout: '', stderr: '' })).toBeNull();
    expect(classifyPsFailure({ status: null, signal: 'SIGTERM', code: 'ETIMEDOUT', stdout: '' })).toBeUndefined();
    expect(classifyPsFailure({ status: null, signal: null, code: 'ENOENT' })).toBeUndefined();
    expect(classifyPsFailure({ status: 1, signal: null, stdout: '', stderr: 'ps: some error' })).toBeUndefined();
    expect(classifyPsFailure({ status: 2, signal: null, stdout: '', stderr: '' })).toBeUndefined();
    expect(classifyPsFailure({})).toBeUndefined();
  });

  it('finds real survivors of a spawn by an inherited fd after the leader has exited', async () => {
    // The mechanism itself, end to end: a "leader" opens the marker on an
    // inherited fd, starts a child that outlives it, and exits. lsof on the
    // marker must still name the surviving child, and the sweep must signal
    // it - the case a pid or pgid cannot handle safely once the leader is gone.
    const marker = path.join(pidDir, '1-0123abcd.mark');
    fs.writeFileSync(marker, '');
    const fd = fs.openSync(marker, 'r');
    // Leader: a shell that starts a detached sleeper (inheriting fd 3) and exits.
    // The sleeper keeps fd 3 but not the stdout pipe, so 'close' means the
    // leader is gone and its output is fully read.
    const leader = spawn('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore', fd], detached: true });
    fs.closeSync(fd);
    const childPid = await new Promise<number>((resolve) => {
      let out = '';
      leader.stdout!.on('data', (d) => { out += d.toString(); });
      leader.on('close', () => resolve(parseInt(out.trim(), 10)));
    });
    try {
      // Leader is gone; only the sleeper holds the marker.
      const holders = await markerHolders(marker);
      expect(holders).toContain(childPid);
      const logged: string[] = [];

      await killOrphanedProcesses(sandboxBase, (m) => logged.push(m), () => null, markerHolders);

      expect(signalled.some(([p, sig]) => p === childPid && sig === 'SIGTERM')).toBe(true);
      expect(signalled.some(([p, sig]) => p === childPid && sig === 'SIGKILL')).toBe(true);
      // The signals are stubbed, so the sleeper never went away; a real lsof
      // says so at the final look, and the marker stays for the next sweep.
      // (Which list the SIGKILL came from is pinned by the injected-holders
      // tests above, not here.)
      expect(logged.some((m) => new RegExp(`Orphans ${childPid} still hold their marker after SIGKILL`).test(m))).toBe(true);
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      try { realKill(childPid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 20000);

  it('releases the marker once a real SIGTERM lands', async () => {
    // Same spawn shape, with the sleeper's signals forwarded for real: it
    // ends on SIGTERM, the re-check finds nobody, no SIGKILL is sent, and
    // the marker goes.
    const marker = path.join(pidDir, '1-4567abcd.mark');
    fs.writeFileSync(marker, '');
    const fd = fs.openSync(marker, 'r');
    const leader = spawn('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore', fd], detached: true });
    fs.closeSync(fd);
    const childPid = await new Promise<number>((resolve) => {
      let out = '';
      leader.stdout!.on('data', (d) => { out += d.toString(); });
      leader.on('close', () => resolve(parseInt(out.trim(), 10)));
    });
    (process as unknown as { kill: unknown }).kill = ((pid: number, sig?: unknown) => {
      signalled.push([pid, sig]);
      return pid === childPid ? realKill(pid, sig as never) : true;
    }) as never;
    try {
      await killOrphanedProcesses(sandboxBase, () => undefined, () => null, markerHolders);

      expect(signalled).toContainEqual([childPid, 'SIGTERM']);
      expect(signalled.some(([p, sig]) => p === childPid && sig === 'SIGKILL')).toBe(false);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      try { realKill(childPid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 20000);
});

describe('cleanupSandboxDirectories', () => {
  let root: string;
  let sandboxBase: string;
  let victim: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sweep-'));
    sandboxBase = path.join(root, 'sandbox');
    victim = path.join(root, 'victim');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'keep'), 'kept');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const sandbox = (name: string): string => {
    const dir = path.join(sandboxBase, name);
    fs.mkdirSync(path.join(dir, '_work'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_work', 'output'), 'job');
    return dir;
  };

  /** Each call made to the fs.promises functions a removal could use, in order. */
  const recordRemovalCalls = (): Array<{ op: string; paths: string[] }> => {
    const calls: Array<{ op: string; paths: string[] }> = [];
    for (const op of ['rename', 'rm', 'readdir', 'opendir', 'lstat', 'stat', 'unlink', 'rmdir'] as const) {
      const real = fs.promises[op].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
      jest.spyOn(fs.promises, op).mockImplementation(((...args: unknown[]) => {
        calls.push({ op, paths: args.filter((arg): arg is string => typeof arg === 'string') });
        return real(...args);
      }) as never);
    }
    return calls;
  };

  /**
   * That nothing walked a tree by path: apart from moving a sandbox aside,
   * no call used a path more than one entry below a directory named for
   * removal in the sandbox base, which only the app writes - so no link
   * swapped in anywhere in the tree could be followed.
   */
  const expectNoWalkByPath = (calls: Array<{ op: string; paths: string[] }>, base: string) => {
    for (const { op, paths } of calls) {
      expect(op).not.toBe('rm');
      for (const p of paths) {
        const rel = path.relative(base, p).split(path.sep);
        if (rel[0] === '') continue;
        if (rel[0].startsWith('.removing-')) {
          expect(rel.length).toBeLessThanOrEqual(2);
        } else {
          expect([op, rel.length]).toEqual(['rename', 1]);
        }
      }
    }
  };

  it('moves each sandbox out of its path before removing it', async () => {
    // Whatever of an earlier run's jobs outlived the kill before this sweep
    // still writes its sandbox's path; see removeSandbox.
    const dirs = [sandbox('1-abc123'), sandbox('2-def456')];
    for (const dir of dirs) fs.mkdirSync(path.join(dir, '_work', 'repo', 'src'), { recursive: true });
    const calls = recordRemovalCalls();

    await cleanupSandboxDirectories(sandboxBase, () => undefined);

    for (const dir of dirs) {
      const touching = calls.filter(({ paths }) => paths.some((p) => p === dir || p.startsWith(`${dir}/`)));
      expect(touching).toHaveLength(1);
      expect(touching[0].op).toBe('rename');
      const to = touching[0].paths[1];
      expect(path.dirname(to)).toBe(sandboxBase);
      expect(path.basename(to).startsWith('.removing-')).toBe(true);
    }
    expectNoWalkByPath(calls, sandboxBase);
    expect(fs.readdirSync(sandboxBase)).toEqual([]);
  });

  it('leaves a sandbox where it is when it cannot be moved out of its path', async () => {
    const dir = sandbox('1-abc123');
    const calls = recordRemovalCalls();
    jest.spyOn(fs.promises, 'rename').mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    );
    const logged: string[] = [];

    await cleanupSandboxDirectories(sandboxBase, (message) => logged.push(message));

    expect(calls.filter(({ paths }) => paths.some((p) => p === dir || p.startsWith(`${dir}/`)))).toEqual([]);
    expect(fs.readFileSync(path.join(dir, '_work', 'output'), 'utf-8')).toBe('job');
    // Startup is the only caller: nothing retries sooner than the next launch
    expect(logged.some((message) => message.includes('1-abc123') && /next launch/.test(message))).toBe(true);
    expect(logged.some((message) => /retry/.test(message))).toBe(false);
  });

  it('finishes a removal an earlier run left part done', async () => {
    const aside = path.join(sandboxBase, '.removing-1-abc123.0a1b2c3d');
    fs.mkdirSync(path.join(aside, '_work'), { recursive: true });
    fs.writeFileSync(path.join(aside, '_work', 'output'), 'job');

    await cleanupSandboxDirectories(sandboxBase, () => undefined);

    expect(fs.readdirSync(sandboxBase)).toEqual([]);
  });

  it('never follows a link planted at or in a sandbox', async () => {
    const linkedFrom = sandbox('1-abc123');
    fs.symlinkSync(victim, path.join(linkedFrom, '_work', 'link'));
    fs.symlinkSync(victim, path.join(sandboxBase, '2-def456'));

    await cleanupSandboxDirectories(sandboxBase, () => undefined);

    expect(fs.readFileSync(path.join(victim, 'keep'), 'utf-8')).toBe('kept');
    expect(fs.existsSync(linkedFrom)).toBe(false);
  });

  it('removes an empty directory in a sandbox that it cannot move out of the tree', async () => {
    // Moving a directory to another parent needs write on it, which a job
    // can take away; an empty one is still removed where it is.
    const dir = sandbox('1-abc123');
    fs.mkdirSync(path.join(dir, '_work', 'sealed'));
    fs.chmodSync(path.join(dir, '_work', 'sealed'), 0o555);

    await cleanupSandboxDirectories(sandboxBase, () => undefined);

    expect(fs.readdirSync(sandboxBase)).toEqual([]);
  });

  it('never follows a link a writer outside every job profile swaps in while it removes a sandbox', async () => {
    // A container a job started writes the workspace it bind-mounts through
    // Docker Desktop's file sharing, under no job's profile, so moving the
    // sandbox aside does not stop it. Here a shell working in the sandbox,
    // which follows the tree wherever it is moved, stands in for it: it
    // swaps each directory there for a link to the user's files, and back,
    // as fast as it can. A walk by path loses that race most times it runs;
    // one that never follows a link cannot lose it at all.
    for (let k = 0; k < 50; k++) fs.writeFileSync(path.join(victim, `v${k}`), 'x');
    for (let attempt = 0; attempt < 20; attempt++) {
      const dir = sandbox(`${attempt + 1}-abc123`);
      for (let j = 0; j < 20; j++) {
        fs.mkdirSync(path.join(dir, '_work', `d${j}`));
        for (let k = 0; k < 50; k++) fs.writeFileSync(path.join(dir, '_work', `d${j}`, `v${k}`), 'x');
      }
      const writer = spawn('/bin/bash', ['-c', `
        cd '${path.join(dir, '_work')}' || exit 1
        echo ready
        while :; do
          for j in $(seq 0 19); do
            mv d$j t$j 2>/dev/null && ln -s '${victim}' d$j 2>/dev/null; rm -f d$j 2>/dev/null; mv t$j d$j 2>/dev/null
          done
        done`], { stdio: ['ignore', 'pipe', 'ignore'] });
      const exited = new Promise((resolve) => writer.on('exit', resolve));
      try {
        await new Promise<void>((resolve, reject) => {
          writer.stdout!.on('data', () => resolve());
          exited.then(() => reject(new Error('the writer exited before it was in place')));
        });
        await cleanupSandboxDirectories(sandboxBase, () => undefined);
      } finally {
        writer.kill('SIGKILL');
        await exited;
      }

      expect(fs.readdirSync(victim)).toHaveLength(51);
      expect(fs.existsSync(dir)).toBe(false);
    }
    // With the writer gone, whatever it kept from being removed goes.
    await cleanupSandboxDirectories(sandboxBase, () => undefined);
    expect(fs.readdirSync(sandboxBase)).toEqual([]);
  }, 60000);
});
