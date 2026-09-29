/**
 * What a finished worker's job left running, found through seatbelt by the
 * profile it runs under.
 *
 * A process can leave its worker's process group with setsid() and close the
 * marker descriptor it inherited, and then neither the group sweep nor the
 * marker sweep reaches it. It cannot leave its sandbox: the runner profile
 * carries a process marker, and the kernel answers for it. As in the other
 * sandbox tests, a profile can only be constructed outside a localmost job;
 * inside one, the assertion is that the sweep takes nothing that is not
 * marked. macOS only, because seatbelt is.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { ChildProcess, execFileSync, spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateSandboxProfile, RunnerProfileOptions } from './process-sandbox';
import { reapMarkedProcessesAsync } from '../shared/sandbox-reaper';
import type { ProcessMarker } from '../shared/sandbox-profile';

const isMacOS = process.platform === 'darwin';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const gone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 250 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  return !alive(pid);
};

/** Whether a profile can be constructed and applied here; see process-sandbox.sandbox.test.ts. */
const canConstruct = (): boolean => {
  if (!isMacOS) return false;
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], {
      timeout: 5000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

/** A marker pair in `dir`, as the runner manager makes one per spawn. */
const makeMarker = (dir: string): ProcessMarker => {
  const stem = path.join(dir, `1-${crypto.randomBytes(8).toString('hex')}`);
  const marker = { granted: `${stem}.granted`, withheld: `${stem}.withheld` };
  fs.writeFileSync(marker.granted, '', { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(marker.withheld, '', { mode: 0o600, flag: 'wx' });
  return marker;
};

if (!isMacOS) {
  describe("what a finished worker's job left running", () => {
    it('has nothing to assert off macOS, where seatbelt does not exist', () => {
      expect(process.platform).not.toBe('darwin');
    });
  });
} else if (canConstruct()) {
  describe("what a finished worker's job left running", () => {
    // Resolved, as seatbelt matches canonical paths. The instance directory
    // stands in for the worker's sandbox, pids for the app's pid directory.
    let base: string;
    let instanceDir: string;
    let pidDir: string;
    const started: ChildProcess[] = [];

    beforeAll(() => {
      base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-reap-')));
      instanceDir = path.join(base, 'instance');
      pidDir = path.join(base, 'pids');
      fs.mkdirSync(instanceDir, { recursive: true });
      fs.mkdirSync(pidDir, { recursive: true });
    });

    afterAll(() => {
      for (const child of started) child.kill('SIGKILL');
      fs.rmSync(base, { recursive: true, force: true });
    });

    const writeProfile = (options: Omit<RunnerProfileOptions, 'instanceDir'> = {}): string => {
      const profilePath = path.join(base, `${crypto.randomBytes(4).toString('hex')}.sb`);
      fs.writeFileSync(profilePath, generateSandboxProfile({ instanceDir, ...options }));
      return profilePath;
    };

    /** A process that is not the finished job's, under `profile` if given. */
    const bystander = (profile?: string): ChildProcess => {
      const child = profile
        ? spawn('/usr/bin/sandbox-exec', ['-f', profile, '/bin/sleep', '60'], { stdio: 'ignore' })
        : spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
      started.push(child);
      return child;
    };

    it('is killed by the profile it runs under, even once it has left the process group', async () => {
      const marker = makeMarker(pidDir);
      // Another worker, still running its job under a profile of its own, and
      // processes under no runner profile at all: none of them is this job's.
      const others = [
        bystander(),
        bystander(writeProfile({ processMarker: makeMarker(pidDir) })),
        bystander(writeProfile()),
      ];

      // The finished job's step: a process that leaves the group, drops every
      // descriptor it was given, and outlives the job.
      const job = spawnSync(
        '/usr/bin/sandbox-exec',
        [
          '-f', writeProfile({ processMarker: marker }),
          '/bin/sh', '-c',
          "/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); sleep 60' </dev/null >/dev/null 2>&1 & echo $!",
        ],
        { encoding: 'utf-8', timeout: 15000, env: { PATH: '/usr/bin:/bin', HOME: os.homedir() } }
      );
      const survivor = parseInt(job.stdout.trim(), 10);
      try {
        expect(job.status).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(alive(survivor)).toBe(true);
        const pgid = parseInt(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(survivor)], { encoding: 'utf-8' }), 10);
        expect(pgid).toBe(survivor);

        const killed = await reapMarkedProcessesAsync(marker);

        expect(killed).toEqual([survivor]);
        expect(await gone(survivor)).toBe(true);
        for (const other of others) expect(alive(other.pid!)).toBe(true);
      } finally {
        if (survivor > 1 && alive(survivor)) process.kill(survivor, 'SIGKILL');
      }
    }, 30000);
  });
} else {
  describe("what a finished worker's job left running, inside a localmost job", () => {
    it('takes nothing a marked profile does not run, this job included', async () => {
      // Here every process, this suite included, runs under the job's own
      // profile, which carries no marker this test made.
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-reap-')));
      const other = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
      try {
        const killed = await reapMarkedProcessesAsync(makeMarker(dir));
        expect(killed === null || killed.length === 0).toBe(true);
        expect(alive(other.pid!)).toBe(true);
        expect(alive(process.pid)).toBe(true);
      } finally {
        other.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
