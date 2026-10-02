/**
 * What localmost adds to a job's environment, through seatbelt: a temp
 * directory of the job's own in the per-user temp directory, for Foundation;
 * the swift shim that turns SwiftPM's own sandbox off; and the JVM's options.
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
import { writeJobBin } from './job-shims';
import { javaToolOptions } from './worker-env';

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

/**
 * What a JVM in a job needs that the sandbox refused it: a temp file, and a
 * loopback connection to a server of its own - each reported, not thrown -
 * and the proxy it would use.
 */
const JAVA_PROBE_SOURCE = [
  'import java.io.File;',
  'import java.net.*;',
  'public class Probe {',
  '  public static void main(String[] args) {',
  '    try {',
  '      File f = File.createTempFile("probe", ".tmp");',
  '      f.delete();',
  '      System.out.println("tempfile ok " + f.getParent());',
  '    } catch (Exception e) {',
  '      System.out.println("tempfile failed " + e);',
  '    }',
  '    try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));',
  '         Socket client = new Socket(InetAddress.getByName("127.0.0.1"), server.getLocalPort());',
  '         Socket accepted = server.accept()) {',
  '      System.out.println("loopback ok");',
  '    } catch (Exception e) {',
  '      System.out.println("loopback failed " + e);',
  '    }',
  '    System.out.println("proxy " + System.getProperty("https.proxyHost") + ":" + System.getProperty("https.proxyPort"));',
  '    System.out.println("home " + System.getProperty("user.home"));',
  '  }',
  '}',
  '',
].join('\n');

/** Run a program, under the profile at `profilePath` when given one, from `cwd` (the scratch directory by default). */
const run = (argv: string[], env: NodeJS.ProcessEnv, profilePath?: string, timeout = 30_000, cwd = os.tmpdir()) => {
  const [command, ...args] = profilePath ? ['/usr/bin/sandbox-exec', '-f', profilePath, ...argv] : argv;
  const result = spawnSync(command, args, { encoding: 'utf-8', timeout, env, cwd });
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

    describe("the JVM's options", () => {
      // The JDK installed on this machine, read-only, as a policy grants it.
      let javaHome: string;
      let probe: string;

      beforeAll(() => {
        javaHome = execFileSync('/usr/libexec/java_home', { encoding: 'utf-8', timeout: 30_000 }).trim();
        probe = path.join(sandboxDir, '_work', 'Probe.java');
        fs.writeFileSync(probe, JAVA_PROBE_SOURCE);
      });

      /** The probe, run from source as a job would run java, with the given environment. */
      const java = (extraEnv: NodeJS.ProcessEnv) => {
        const profilePath = writeProfile({
          proxyPort: 51234,
          filesystemPolicy: { level: 'strict', read: [path.resolve(javaHome, '..', '..')], write: [], loopback: true },
        });
        return run([path.join(javaHome, 'bin', 'java'), probe], { ...baseEnv(), ...extraEnv }, profilePath, SWIFT_TIMEOUT_MS, sandboxDir);
      };

      it("let it make a temp file, use loopback and take the job's home, which it does not without them", () => {
        const without = java({});
        expect(without.stdout).toContain('tempfile failed');
        expect(without.stdout).toContain('loopback failed');
        // HOME is the job's, and the JVM still takes the user's from the user database.
        expect(without.stdout).toContain(`home ${os.userInfo().homedir}`);

        const jobHome = baseEnv().HOME!;
        const options = javaToolOptions({ tmpDir: jobTmp, home: jobHome, proxyUrl: `http://localmost:${'ab'.repeat(24)}@127.0.0.1:51234` });
        const result = java({ JAVA_TOOL_OPTIONS: options });
        expect(result.stdout.split('\n')).toEqual([
          `tempfile ok ${jobTmp}`,
          'loopback ok',
          'proxy 127.0.0.1:51234',
          `home ${jobHome}`,
        ]);
      }, SWIFT_TIMEOUT_MS);
    });

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

      describe('with the swift shim', () => {
        let pkg: string;
        let bin: string;

        beforeAll(() => {
          // A package under a name never built before, so SwiftPM has no
          // cached manifest for it and must compile Package.swift - the step
          // that runs under SwiftPM's own sandbox.
          pkg = path.join(sandboxDir, '_work', `pkg${randomBytes(4).toString('hex')}`);
          fs.mkdirSync(path.join(pkg, 'Sources', 'hello'), { recursive: true });
          fs.writeFileSync(
            path.join(pkg, 'Package.swift'),
            '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "hello", targets: [.executableTarget(name: "hello")])\n'
          );
          fs.writeFileSync(path.join(pkg, 'Sources', 'hello', 'main.swift'), 'print("hello")\n');
          bin = writeJobBin(sandboxDir, { shims: true });
        });

        /** `swift <args>` in the package as a job runs it, the job's bin directory first on PATH or not. */
        const swift = (args: string, withShims: boolean) => {
          const profilePath = writeProfile({
            tempSuffixDir: tempDir,
            filesystemPolicy: { level: 'strict', read: ['/Applications/Xcode.app'], write: [] },
          });
          const env = {
            ...baseEnv(),
            PATH: withShims ? `${bin}:/usr/bin:/bin` : '/usr/bin:/bin',
            DIRHELPER_USER_DIR_SUFFIX: path.basename(tempDir),
            xcrun_db: path.join(jobTmp, 'xcrun_db'),
            CLANG_MODULE_CACHE_PATH: path.join(jobTmp, 'clang-module-cache'),
          };
          return run(['/bin/sh', '-c', `swift ${args}`], env, profilePath, SWIFT_TIMEOUT_MS, pkg);
        };

        it('compiles a package manifest it has not compiled before, which fails without it', () => {
          const without = swift('package describe', false);
          expect(without.ok).toBe(false);
          expect(without.stdout + without.stderr).toMatch(/sandbox_apply: Operation not permitted/);

          const result = swift('package describe', true);
          expect(result.stdout + result.stderr).not.toMatch(/sandbox_apply/);
          expect(result).toMatchObject({ ok: true, stdout: expect.stringContaining('Name: hello') });
        }, 2 * SWIFT_TIMEOUT_MS);

        it('builds the package through to a linked executable', () => {
          // The native build system: the default one in Swift 6.4, Swift Build,
          // starts its link step with the per-user temp directory as its temp,
          // which the profile does not grant (docs/roadmap/job-environment.md).
          const result = swift('build --build-system native', true);
          expect(result.stdout + result.stderr).not.toMatch(/sandbox_apply/);
          expect(result).toMatchObject({ ok: true, stdout: expect.stringContaining('Build complete!') });
          expect(fs.existsSync(path.join(pkg, '.build', 'debug', 'hello'))).toBe(true);
        }, SWIFT_TIMEOUT_MS);
      });

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

    it("has its own bin directory on PATH, whose swift shim lets SwiftPM compile a new manifest", () => {
      // On PATH, though not necessarily first: setup-* actions put their
      // toolchains in front of everything the runner started with.
      const sandboxDir = path.dirname(fs.realpathSync(os.tmpdir()));
      expect((process.env.PATH ?? '').split(':')).toContain(path.join(sandboxDir, 'localmost', 'bin'));
      const pkg = path.join(os.tmpdir(), `pkg${randomBytes(4).toString('hex')}`);
      fs.mkdirSync(path.join(pkg, 'Sources', 'hello'), { recursive: true });
      try {
        fs.writeFileSync(
          path.join(pkg, 'Package.swift'),
          '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "hello", targets: [.executableTarget(name: "hello")])\n'
        );
        fs.writeFileSync(path.join(pkg, 'Sources', 'hello', 'main.swift'), 'print("hello")\n');
        const result = run(['/bin/sh', '-c', 'swift package describe'], process.env, undefined, SWIFT_TIMEOUT_MS, pkg);
        expect(result.stdout + result.stderr).not.toMatch(/sandbox_apply/);
        expect(result).toMatchObject({ ok: true, stdout: expect.stringContaining('Name: hello') });
      } finally {
        fs.rmSync(pkg, { recursive: true, force: true });
      }
    }, SWIFT_TIMEOUT_MS);

    it("gives the JVM its temp, its home, IPv4 and its proxy (no JDK is readable here to run)", () => {
      const options = (process.env.JAVA_TOOL_OPTIONS ?? '').split(' ');
      expect(options).toEqual(expect.arrayContaining([
        `-Djava.io.tmpdir=${os.tmpdir().replace(/\/$/, '')}`,
        `-Duser.home=${process.env.HOME}`,
        '-Djava.net.preferIPv4Stack=true',
        `-Dhttps.proxyPort=${new URL(process.env.HTTPS_PROXY ?? '').port}`,
      ]));
    });

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
