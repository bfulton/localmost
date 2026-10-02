/**
 * What localmost adds to a job's environment, through seatbelt: a temp
 * directory of the job's own in the per-user temp directory, for Foundation.
 *
 * The unit tests assert the variables a worker is given and the rules its
 * profile carries; they cannot show that macOS honours the one and seatbelt
 * the other. So three modes, as every *.sandbox.test.ts has: off macOS,
 * which has no seatbelt and asserts only that, and these two:
 *
 *   constructed  On an unsandboxed machine, build the runner profile and run
 *                the tools under it with sandbox-exec, with the environment
 *                a worker gets and without it, so each success means the
 *                environment is what made it work.
 *
 *   ambient      Inside a localmost job, this process already runs under the
 *                runner's profile with the worker's environment, and seatbelt
 *                refuses a nested profile, so assert what that environment
 *                does.
 *
 * Neither mode skips. macOS only, because seatbelt is.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateSandboxProfile, RunnerProfileOptions } from './process-sandbox';
import { createJobTempDir, removeJobTempDir, userTempDir } from './job-temp';

const isMacOS = process.platform === 'darwin';

/** Building and running Swift, under a loaded machine, takes a while. */
const SWIFT_TIMEOUT_MS = 180_000;

/** A Foundation atomic write of "hello" to the path it is given, as SwiftPM and xcodebuild make them. */
const ATOMIC_WRITE_SOURCE = [
  'import Foundation',
  'let dest = URL(fileURLWithPath: CommandLine.arguments[1])',
  'do {',
  '  try "hello".write(to: dest, atomically: true, encoding: .utf8)',
  '} catch {',
  '  FileHandle.standardError.write("\\(error)\\n".data(using: .utf8)!)',
  '  exit(1)',
  '}',
  '',
].join('\n');

/** Run a program, under the profile at `profilePath` when given one. */
const run = (argv: string[], env: NodeJS.ProcessEnv, profilePath?: string, timeout = 30_000) => {
  const [command, ...args] = profilePath ? ['/usr/bin/sandbox-exec', '-f', profilePath, ...argv] : argv;
  const result = spawnSync(command, args, { encoding: 'utf-8', timeout, env });
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim(), stderr: result.stderr ?? '' };
};

/**
 * Whether this process is outside any sandbox, so a profile can be
 * constructed and applied: probed with `(allow default)`, the one profile
 * seatbelt never applies inside one.
 */
const canConstruct = (): boolean => {
  if (!isMacOS) return false;
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

if (!isMacOS) {
  describe("a job's environment through seatbelt", () => {
    it('has nothing to assert off macOS, where seatbelt does not exist', () => {
      expect(process.platform).not.toBe('darwin');
    });
  });
} else if (canConstruct()) {
  describe("a job's environment through a constructed seatbelt profile", () => {
    // In the checkout's build directory: on the same volume as the per-user
    // temp directory, so a job temp directory can be moved here to be
    // removed, and outside it.
    let base: string;
    let sandboxDir: string;
    let jobTmp: string;
    let atomicWrite: string;
    const userTemp = userTempDir();

    beforeAll(() => {
      const build = path.join(process.cwd(), 'build');
      fs.mkdirSync(build, { recursive: true });
      base = fs.realpathSync(fs.mkdtempSync(path.join(build, 'job-env-')));
      sandboxDir = path.join(base, 'sandbox', `9-${randomBytes(6).toString('hex')}`);
      jobTmp = path.join(sandboxDir, '_temp');
      fs.mkdirSync(jobTmp, { recursive: true });
      fs.mkdirSync(path.join(sandboxDir, '_work'));
      fs.writeFileSync(path.join(base, 'aw.swift'), ATOMIC_WRITE_SOURCE);
      atomicWrite = path.join(base, 'aw');
      execFileSync('/usr/bin/xcrun', ['swiftc', '-o', atomicWrite, path.join(base, 'aw.swift')], {
        timeout: SWIFT_TIMEOUT_MS,
        stdio: 'ignore',
      });
    }, SWIFT_TIMEOUT_MS);

    afterAll(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    /** Write the runner profile for the stand-in sandbox, and return its path. */
    const writeProfile = (options: Omit<RunnerProfileOptions, 'instanceDir'> = {}): string => {
      const profilePath = path.join(base, `${randomBytes(4).toString('hex')}.sb`);
      fs.writeFileSync(profilePath, generateSandboxProfile({ instanceDir: sandboxDir, ...options }));
      return profilePath;
    };

    const baseEnv = (): NodeJS.ProcessEnv => ({ PATH: '/usr/bin:/bin', HOME: path.join(sandboxDir, 'home'), TMPDIR: jobTmp });

    describe("the job's own temp directory", () => {
      let tempDir: string;

      beforeAll(() => {
        expect(userTemp).toBeDefined();
        tempDir = createJobTempDir(userTemp!, sandboxDir);
      });

      afterAll(async () => {
        await removeJobTempDir(userTemp!, tempDir, path.join(base, 'sandbox'));
      });

      it("lets Foundation's atomic writes stage in it, where without it they fail", () => {
        const out = path.join(sandboxDir, '_work', 'atomic.txt');
        const without = run([atomicWrite, out], baseEnv(), writeProfile());
        expect([without.ok, fs.existsSync(out)]).toEqual([false, false]);
        expect(without.stderr).toMatch(/permission|513/i);

        const env = { ...baseEnv(), DIRHELPER_USER_DIR_SUFFIX: path.basename(tempDir) };
        const result = run([atomicWrite, out], env, writeProfile({ tempSuffixDir: tempDir }));
        expect(result).toMatchObject({ ok: true });
        expect(fs.readFileSync(out, 'utf-8')).toBe('hello');
      }, SWIFT_TIMEOUT_MS);

      it('can neither remove nor rename the directory itself', () => {
        const profilePath = writeProfile({ tempSuffixDir: tempDir });
        const env = { ...baseEnv(), DIRHELPER_USER_DIR_SUFFIX: path.basename(tempDir) };
        expect(run(['/bin/rmdir', tempDir], env, profilePath).ok).toBe(false);
        expect(run(['/bin/mv', tempDir, path.join(jobTmp, 'moved')], env, profilePath).ok).toBe(false);
        expect(fs.statSync(tempDir).isDirectory()).toBe(true);
        // Its contents are the job's.
        expect(run(['/usr/bin/touch', path.join(tempDir, 'mine')], env, profilePath).ok).toBe(true);
      });
    });
  });
} else {
  describe("a job's environment through the ambient seatbelt profile", () => {
    // Inside a localmost job: the runner gave this process the worker's
    // environment and profile. TMPDIR is <sandbox>/_temp.
    let atomicWrite: string;

    beforeAll(() => {
      fs.writeFileSync(path.join(os.tmpdir(), 'aw.swift'), ATOMIC_WRITE_SOURCE);
      atomicWrite = path.join(os.tmpdir(), 'aw');
      execFileSync('/usr/bin/xcrun', ['swiftc', '-o', atomicWrite, path.join(os.tmpdir(), 'aw.swift')], {
        timeout: SWIFT_TIMEOUT_MS,
        stdio: 'ignore',
      });
    }, SWIFT_TIMEOUT_MS);

    it('has a temp directory of its own, where Foundation stages its atomic writes', () => {
      expect(process.env.DIRHELPER_USER_DIR_SUFFIX).toMatch(/^localmost-[0-9a-f]{8}-\d+-[0-9a-f]{12}$/);
      const out = path.join(os.tmpdir(), `atomic-${randomBytes(4).toString('hex')}.txt`);
      try {
        expect(run([atomicWrite, out], process.env)).toMatchObject({ ok: true });
        expect(fs.readFileSync(out, 'utf-8')).toBe('hello');
      } finally {
        fs.rmSync(out, { force: true });
      }
    }, SWIFT_TIMEOUT_MS);
  });
}
