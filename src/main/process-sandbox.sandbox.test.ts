/**
 * Integration coverage for the runner profile's filesystem floor at the
 * seatbelt layer.
 *
 * The unit tests assert which rules the runner profile contains. They cannot
 * show that seatbelt accepts them - a rule the engine rejects fails every
 * worker spawn - or that a process under them is kept out of the shared temp
 * directories and the user's toolchain trees, whatever spelling a future rule
 * takes. So the same two modes as the docker isolation test:
 *
 *   constructed  On an unsandboxed machine, build the runner profile and
 *                apply it with sandbox-exec. Tests both directions: what the
 *                profile grants is writable, which is what makes each refusal
 *                mean anything.
 *
 *   ambient      Inside a localmost job, this process already runs under the
 *                runner's profile, and seatbelt refuses any nested profile
 *                that deviates from it, so assert what that profile does.
 *
 * Neither mode skips. macOS only, because seatbelt is.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateSandboxProfile, RunnerProfileOptions } from './process-sandbox';

const isMacOS = process.platform === 'darwin';
const homeDir = os.homedir();

/** A name no other process is using, for a probe that must not collide. */
const probeName = () => `localmost-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

/** The per-user temp directory bare mktemp writes to, resolved as seatbelt sees it. */
const userTempDir = (): string =>
  fs.realpathSync(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf-8' }).trim());

/** Run a shell command under the given profile file, or under the current one. */
const shell = (command: string, profilePath?: string, env: NodeJS.ProcessEnv = process.env) => {
  const argv = profilePath
    ? ['/usr/bin/sandbox-exec', ['-f', profilePath, '/bin/sh', '-c', command]] as const
    : ['/bin/sh', ['-c', command]] as const;
  const result = spawnSync(argv[0], [...argv[1]], { encoding: 'utf-8', timeout: 15000, env });
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr };
};

/** Whether `run` can write a new file at `target`; it is removed afterwards either way. */
const canCreate = (run: (command: string) => { ok: boolean }, target: string): boolean => {
  const existed = fs.existsSync(target);
  // touch, not a redirect: on a file that already exists, a write the sandbox
  // wrongly allowed changes only its time, never its contents.
  const ok = run(`/usr/bin/touch '${target}'`).ok;
  if (!existed && fs.existsSync(target)) fs.rmSync(target, { force: true });
  return ok;
};

/**
 * Whether `run` can create a directory under `parent`, creating `parent` too
 * if it does not exist. Either way the answer is the sandbox's: whether the
 * tree is there on this machine or not, a refused write is EPERM.
 */
const canCreateUnder = (run: (command: string) => { ok: boolean }, parent: string): boolean => {
  const parentExisted = fs.existsSync(parent);
  const target = path.join(parent, probeName());
  const ok = run(`/bin/mkdir -p '${target}'`).ok;
  fs.rmSync(parentExisted ? target : parent, { recursive: true, force: true });
  return ok;
};

/** Whether bare `mktemp` (or `mktemp -d`) works, and where its entry landed. */
const bareMktemp = (run: (command: string) => { ok: boolean; stdout: string }, flag: '' | '-d') => {
  const result = run(`/usr/bin/mktemp ${flag}`);
  if (result.stdout) fs.rmSync(result.stdout, { recursive: true, force: true });
  return { ok: result.ok, entry: result.stdout };
};

/**
 * Whether this process is outside any sandbox, so a profile can be constructed
 * and applied. Probed with `(allow default)`, the one profile seatbelt never
 * applies inside a sandbox - not with the runner profile, since a runner
 * profile the engine rejected would then pass for ambient mode instead of
 * failing the test that compiles it.
 */
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

if (!isMacOS) {
  describe("the runner profile's filesystem floor through seatbelt", () => {
    it('has nothing to assert off macOS, where seatbelt does not exist', () => {
      expect(process.platform).not.toBe('darwin');
    });
  });
} else if (canConstruct()) {
  describe("the runner profile's filesystem floor through a constructed seatbelt profile", () => {
    // Resolved: os.tmpdir() is under /var, a symlink, and seatbelt matches
    // the canonical path. The instance directory stands in for the worker's
    // sandbox; the package cache sits beside it, outside it, as a target's
    // does.
    let base: string;
    let instanceDir: string;
    let packageCacheDir: string;
    let jobTmp: string;

    beforeAll(() => {
      base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-runner-')));
      instanceDir = path.join(base, 'instance');
      packageCacheDir = path.join(base, 'packages');
      jobTmp = path.join(instanceDir, '_temp');
      fs.mkdirSync(jobTmp, { recursive: true });
      fs.mkdirSync(packageCacheDir, { recursive: true });
    });

    afterAll(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    /** A runner for shell commands under the runner profile built from `options`. */
    const underProfile = (options: Omit<RunnerProfileOptions, 'instanceDir'> = {}) => {
      const profilePath = path.join(base, `${probeName()}.sb`);
      fs.writeFileSync(profilePath, generateSandboxProfile({ instanceDir, ...options }));
      // The job's TMPDIR, as the worker's is: inside its own sandbox.
      const env = { PATH: '/usr/bin:/bin', HOME: homeDir, TMPDIR: jobTmp };
      return (command: string) => shell(command, profilePath, env);
    };

    it('compiles, and writes the job its own sandbox', () => {
      const run = underProfile();
      expect(run('/usr/bin/true').ok).toBe(true);
      expect(canCreate(run, path.join(jobTmp, probeName()))).toBe(true);
    });

    it.each(['strict', 'moderate', 'permissive'] as const)('refuses writes to /private/tmp under %s', (level) => {
      const run = underProfile({ filesystemPolicy: { level, read: [], write: [] } });
      expect(canCreate(run, path.join('/private/tmp', probeName()))).toBe(false);
      expect(canCreate(run, path.join('/tmp', probeName()))).toBe(false);
    });

    it('lets bare mktemp and mktemp -d create their entries in the per-user temp', () => {
      const run = underProfile();
      const file = bareMktemp(run, '');
      const dir = bareMktemp(run, '-d');
      expect(file.ok).toBe(true);
      expect(dir.ok).toBe(true);
      expect(fs.realpathSync(path.dirname(file.entry))).toBe(userTempDir());
    });

    it('refuses the per-user temp itself, where the xcrun cache the user trusts lives', () => {
      const run = underProfile();
      expect(canCreate(run, path.join(userTempDir(), 'xcrun_db'))).toBe(false);
      expect(canCreate(run, path.join(userTempDir(), probeName()))).toBe(false);
    });

    it("writes its target's package cache under moderate, and none of the user's toolchain trees", () => {
      const run = underProfile({ filesystemPolicy: { level: 'moderate', read: [], write: [] }, packageCacheDir });
      expect(canCreateUnder(run, packageCacheDir)).toBe(true);
      for (const tree of ['.cargo', '.gradle', 'go', '.local']) {
        expect(canCreateUnder(run, path.join(homeDir, tree))).toBe(false);
      }
    });
  });
} else {
  describe("the runner profile's filesystem floor through the ambient seatbelt profile", () => {
    // Already inside a localmost job: the runner applied this repository's
    // approved policy to this very process, and TMPDIR is the job's own.
    const run = (command: string) => shell(command);

    it("writes the job's own temp, so the refusals below are specific", () => {
      expect(canCreate(run, path.join(os.tmpdir(), probeName()))).toBe(true);
    });

    it('refuses writes to /private/tmp', () => {
      expect(canCreate(run, path.join('/private/tmp', probeName()))).toBe(false);
      expect(canCreate(run, path.join('/tmp', probeName()))).toBe(false);
    });

    it('lets bare mktemp and mktemp -d create their entries in the per-user temp', () => {
      expect(bareMktemp(run, '').ok).toBe(true);
      expect(bareMktemp(run, '-d').ok).toBe(true);
    });

    it('refuses the per-user temp itself, where the xcrun cache the user trusts lives', () => {
      expect(canCreate(run, path.join(userTempDir(), 'xcrun_db'))).toBe(false);
      expect(canCreate(run, path.join(userTempDir(), probeName()))).toBe(false);
    });

    it("writes where its package managers are pointed, and none of the user's toolchain trees", () => {
      // Under strict none are pointed anywhere; under moderate and permissive
      // each is the job's own or its target's package cache.
      for (const name of ['CARGO_HOME', 'GRADLE_USER_HOME', 'GOPATH']) {
        const dir = process.env[name];
        if (dir !== undefined) expect(canCreateUnder(run, dir)).toBe(true);
      }
      for (const tree of ['.cargo', '.gradle', 'go', '.local']) {
        expect(canCreateUnder(run, path.join(homeDir, tree))).toBe(false);
      }
    });
  });
}
