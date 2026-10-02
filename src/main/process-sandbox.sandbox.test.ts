/**
 * Integration coverage for the runner profile's filesystem floor, signals,
 * loopback and unix sockets at the seatbelt layer.
 *
 * The unit tests assert which rules the runner profile contains. They cannot
 * show that seatbelt accepts them - a rule the engine rejects fails every
 * worker spawn - or that a process under them is kept out of the shared temp
 * directories, the user's toolchain trees, the app's own data, the
 * operator's own Docker, other processes and loopback services it was not
 * granted, whatever spelling a future rule takes. So three modes, as every
 * *.sandbox.test.ts has: off macOS, which has no seatbelt and asserts only
 * that, and these two:
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

import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { execFileSync, spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import { app } from 'electron';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { generateSandboxProfile, RunnerProfileOptions, SandboxFilesystemPolicy } from './process-sandbox';
import { JOB_GIT_CONFIG, prepareJobHome } from '../shared/job-home';
import { dockerOnPath } from './test-utils/vm-fixtures';
import { defaults, preferenceAllowed, removeThrowawayDomain, sweepStaleThrowawayDomains, throwawayDomain } from '../shared/test-utils/preference-probe';

// The real home by default; one block below stands a directory of its own in
// for it, since os.homedir() is what the profile is built from.
jest.mock('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os');
  return { ...actual, homedir: jest.fn(actual.homedir) };
});
const realHomedir = jest.requireActual<typeof import('os')>('os').homedir;

const isMacOS = process.platform === 'darwin';
// The user's home by the user database: inside a localmost job HOME, and so
// os.homedir(), is the job's own home, while the profile is built from the
// app's, the real one.
const homeDir = os.userInfo().homedir;

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

/** A word for a shell command line, quoted so nothing in it is special. */
const sq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * renamex_np(from, to, RENAME_SWAP), by its syscall (renameatx_np, 488, with
 * AT_FDCWD), through the system perl: the one way to ask for an atomic swap
 * without a compiler or a developer-tools python. Exits nonzero with the
 * errno's text. Swapping a name with itself changes nothing when it is
 * allowed, so it probes a node's rename permission without moving it.
 */
const swapCommand = (from: string, to: string): string =>
  `/usr/bin/perl -e ${sq('my ($a, $b) = @ARGV; syscall(488, -2, $a, -2, $b, 2) == 0 or die "$!\\n"')} ${sq(from)} ${sq(to)}`;

/**
 * clonefileat(from, to, 0), by its syscall (462, with AT_FDCWD), through the
 * system perl as swapCommand is; with `byDescriptor`, fclonefileat (517) of a
 * descriptor opened on `from`. Exits nonzero with the errno's text. For a
 * directory the kernel clones the whole tree beneath it in one call.
 */
const cloneCommand = (from: string, to: string, byDescriptor = false): string =>
  byDescriptor
    ? `/usr/bin/perl -MPOSIX -e ${sq('my ($a, $b) = @ARGV; my $fd = POSIX::open($a, O_RDONLY) // die "open: $!\\n"; syscall(517, $fd, -2, $b, 0) == 0 or die "$!\\n"')} ${sq(from)} ${sq(to)}`
    : `/usr/bin/perl -e ${sq('my ($a, $b) = @ARGV; syscall(462, -2, $a, -2, $b, 0) == 0 or die "$!\\n"')} ${sq(from)} ${sq(to)}`;

/**
 * chmod(2) of a path to the mode it already has, through the system perl:
 * chmod(1) skips the call when the mode would not change. Changes nothing
 * when it is allowed, so it probes a node's mode permission safely.
 */
const sameModeCommand = (target: string): string =>
  `/usr/bin/perl -e ${sq('my $m = (stat $ARGV[0])[2] & 07777; chmod($m, $ARGV[0]) or die "$!\\n"')} ${sq(target)}`;

/**
 * Connect to a unix socket with nc under the profile at `profilePath`, from
 * `cwd`. Asynchronous, so a socket this process serves can accept while the
 * client waits; killed after 15 seconds should nothing close it.
 */
const connectUnder = (profilePath: string, socketPath: string, cwd: string) =>
  new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, '/usr/bin/nc', '-U', socketPath], {
      cwd,
      env: { PATH: '/usr/bin:/bin', HOME: homeDir },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });

const closeServers = (servers: net.Server[]) =>
  Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));

/**
 * Serve each of `socketPaths` with a listener that answers "hello" and
 * counts, in `accepted`, the connections it takes. All or none: one that
 * cannot listen closes the others and fails the caller.
 */
const serveSockets = async (socketPaths: string[], accepted: Map<string, number>): Promise<net.Server[]> => {
  const settled = await Promise.allSettled(
    socketPaths.map((socketPath) => {
      const server = net.createServer((socket) => {
        accepted.set(socketPath, (accepted.get(socketPath) ?? 0) + 1);
        socket.end('hello\n');
      });
      return new Promise<net.Server>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve(server));
      });
    })
  );
  const listening = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failed) {
    await closeServers(listening);
    throw failed.reason;
  }
  return listening;
};

/** The case variant of a path's last component, on the case-insensitive volume. */
const upperBase = (p: string): string => path.join(path.dirname(p), path.basename(p).toUpperCase());

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

    // The job's TMPDIR, as the worker's is: inside its own sandbox.
    const jobEnv = () => ({ PATH: '/usr/bin:/bin', HOME: homeDir, TMPDIR: jobTmp });

    /** Write the runner profile built from `options`, and return its path. */
    const writeProfile = (options: Omit<RunnerProfileOptions, 'instanceDir'> = {}): string => {
      const profilePath = path.join(base, `${probeName()}.sb`);
      fs.writeFileSync(profilePath, generateSandboxProfile({ instanceDir, ...options }));
      return profilePath;
    };

    /** A runner for shell commands under the runner profile built from `options`. */
    const underProfile = (options: Omit<RunnerProfileOptions, 'instanceDir'> = {}) => {
      const profilePath = writeProfile(options);
      return (command: string) => shell(command, profilePath, jobEnv());
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

    describe("Foundation's atomic writes, staged in the job's own suffixed temp directory", () => {
      // A sandboxed Foundation stages write(to:atomically:) in TemporaryItems
      // under the per-user temp directory, whatever the destination; with
      // DIRHELPER_USER_DIR_SUFFIX set, under T/<suffix>. The suffix is fixed
      // here, not per run: T/<suffix> as macOS makes it is protected from
      // removal as T is (sunlnk, com.apple.rootless), and the TemporaryItems
      // in it cannot be removed either, so a name per run would leave one
      // directory behind every time. Of the shape a job's own suffix has.
      const suffix = 'localmost-job-0123456789abcdef';
      let writer: string;

      beforeAll(() => {
        // Five lines of Swift, compiled into the job's own sandbox so the
        // profile lets it be loaded.
        const source = path.join(jobTmp, 'atomic-write.swift');
        writer = path.join(jobTmp, 'atomic-write');
        fs.writeFileSync(source, [
          'import Foundation',
          'let destination = URL(fileURLWithPath: CommandLine.arguments[1])',
          // Not try!: a trap on the expected failures would leave a crash
          // report in ~/Library/Logs/DiagnosticReports on every run.
          'do { try "atomic".write(to: destination, atomically: true, encoding: .utf8) }',
          'catch { FileHandle.standardError.write("\\(error)\\n".data(using: .utf8)!); exit(1) }',
          '',
        ].join('\n'));
        execFileSync('/usr/bin/xcrun', ['swiftc', '-o', writer, source], { stdio: 'ignore', timeout: 180000 });
      }, 200000);

      /** Run the writer under `profilePath` with `env` added, writing a new file in the job's sandbox. */
      const atomicWrite = (profilePath: string, env: NodeJS.ProcessEnv) => {
        const destination = path.join(jobTmp, `${probeName()}.txt`);
        const result = spawnSync('/usr/bin/sandbox-exec', ['-f', profilePath, writer, destination], {
          encoding: 'utf-8',
          timeout: 30000,
          env: { ...jobEnv(), ...env },
        });
        const written = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf-8') : undefined;
        fs.rmSync(destination, { force: true });
        return { ok: result.status === 0, written, stderr: result.stderr };
      };

      it('succeeds with the suffix, staging under T/<suffix>/TemporaryItems, and fails without it', () => {
        const staging = path.join(userTempDir(), suffix, 'TemporaryItems');
        const granted = writeProfile({ jobTempSuffix: suffix });
        const before = Date.now() - 2000;
        const suffixed = atomicWrite(granted, { DIRHELPER_USER_DIR_SUFFIX: suffix });
        expect(suffixed.stderr).not.toMatch(/permission/);
        expect(suffixed.ok).toBe(true);
        expect(suffixed.written).toBe('atomic');
        // The staging item was made and removed in there, just now.
        expect(fs.statSync(staging).mtimeMs).toBeGreaterThanOrEqual(before);
        // Without the suffix staging is in the shared T/TemporaryItems, which
        // stays closed: "You don't have permission to save the file".
        const unsuffixed = atomicWrite(granted, {});
        expect(unsuffixed.ok).toBe(false);
        expect(unsuffixed.stderr).toMatch(/Code=513/);
        expect(unsuffixed.written).toBeUndefined();
        // Nor with the suffix under a profile that grants no directory for it.
        const ungranted = atomicWrite(writeProfile(), { DIRHELPER_USER_DIR_SUFFIX: suffix });
        expect(ungranted.ok).toBe(false);
        expect(ungranted.stderr).toMatch(/Code=513/);
        expect(ungranted.written).toBeUndefined();
        // Each failure an error the writer reports, not a trap, which would
        // leave a crash report behind.
        for (const failed of [unsuffixed, ungranted]) expect(failed.stderr).not.toMatch(/Fatal error/);
      }, 90000);
    });

    it('closes the directories a wildcard in a deny stands for, and opens nothing else of them', () => {
      // Granted the tree, a job could rename out/secA to out/z and read
      // out/z/key from under a deny of out/sec*/key, or make out/secB and
      // move a twin of the key in. * stands within one name, and every
      // directory it matches is closed to writes as a node.
      const tree = path.join(base, probeName());
      const out = path.join(tree, 'out');
      fs.mkdirSync(path.join(out, 'secA'), { recursive: true });
      fs.mkdirSync(path.join(out, 'other'));
      fs.writeFileSync(path.join(out, 'secA', 'key'), 'SECRET');
      fs.writeFileSync(path.join(out, 'secA', 'other.txt'), 'plain');
      // A literal directory past a wildcard: deep/X/b carries deep/X/b/key.
      const deep = path.join(tree, 'deep');
      fs.mkdirSync(path.join(deep, 'X', 'b'), { recursive: true });
      fs.writeFileSync(path.join(deep, 'X', 'b', 'key'), 'SECRET');
      try {
        const run = underProfile({
          filesystemPolicy: { level: 'strict', read: [tree], write: [tree], deny: [`${out}/sec*/key`, `${deep}/*/b/key`] },
        });
        const at = (relative: string) => sq(path.join(out, relative));
        const inDeep = (relative: string) => sq(path.join(deep, relative));
        // The key: neither readable, nor renamed or linked to another name.
        expect(run(`/bin/cat ${at('secA/key')}`).ok).toBe(false);
        expect(run(`/bin/mv ${at('secA/key')} ${at('secA/k2')}`).ok).toBe(false);
        expect(run(`/bin/ln ${at('secA/key')} ${at('secA/hard')}`).ok).toBe(false);
        // The directory the wildcard stands for, and the one above it.
        expect(run(`/bin/mv ${at('secA')} ${at('z')}`).ok).toBe(false);
        expect(run(`/bin/mv ${sq(out)} ${sq(path.join(tree, 'out2'))}`).ok).toBe(false);
        // Nor swapped atomically with a sibling, which renames both at once.
        expect(run(swapCommand(path.join(out, 'secA'), path.join(out, 'other'))).ok).toBe(false);
        // A literal directory between a wildcard and the denied name is one
        // above it too: renamed, it would carry the key away.
        expect(run(`/bin/cat ${inDeep('X/b/key')}`).ok).toBe(false);
        expect(run(`/bin/mv ${inDeep('X/b')} ${inDeep('X/c')}`).ok).toBe(false);
        expect(run(`/bin/mv ${inDeep('X')} ${inDeep('Y')}`).ok).toBe(false);
        expect(run(`/usr/bin/touch ${inDeep('X/b/build.o')}`).ok).toBe(true);
        expect(run(`/bin/mkdir ${inDeep('X/b2')}`).ok).toBe(true);
        // Nor a directory made or moved in under a name it matches.
        expect(run(`/bin/mkdir ${at('secC')}`).ok).toBe(false);
        expect(run(`/bin/mv ${at('other')} ${at('secB')}`).ok).toBe(false);
        // Everything else stays as granted: inside the matched directory, and
        // names the wildcard does not match.
        expect(run(`/bin/cat ${at('secA/other.txt')}`).ok).toBe(true);
        expect(run(`/usr/bin/touch ${at('secA/build.o')}`).ok).toBe(true);
        expect(run(`/bin/mkdir ${at('plainB')}`).ok).toBe(true);
        expect(run(`/bin/mkdir ${at('plainB/secD')}`).ok).toBe(true);
        expect(fs.readFileSync(path.join(out, 'secA', 'key'), 'utf-8')).toBe('SECRET');
        expect(fs.readdirSync(out).sort()).toEqual(['other', 'plainB', 'secA']);
        expect(fs.readFileSync(path.join(deep, 'X', 'b', 'key'), 'utf-8')).toBe('SECRET');
      } finally {
        fs.rmSync(tree, { recursive: true, force: true });
      }
    });

    it("writes its target's package cache under moderate, and none of the user's toolchain trees", () => {
      const run = underProfile({ filesystemPolicy: { level: 'moderate', read: [], write: [] }, packageCacheDir });
      expect(canCreateUnder(run, packageCacheDir)).toBe(true);
      for (const tree of ['.cargo', '.gradle', 'go', '.local']) {
        expect(canCreateUnder(run, path.join(homeDir, tree))).toBe(false);
      }
    });

    /**
     * The runner profile built from `options` with the app's directory at
     * `appDir`, which is read when the profile is built and only then.
     */
    const profileWithAppDir = (appDir: string, options: Omit<RunnerProfileOptions, 'instanceDir'>): string => {
      const previous = process.env.LOCALMOST_CONFIG_DIR;
      process.env.LOCALMOST_CONFIG_DIR = appDir;
      try {
        return generateSandboxProfile({ instanceDir, ...options });
      } finally {
        if (previous === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
        else process.env.LOCALMOST_CONFIG_DIR = previous;
      }
    };

    /** A runner for shell commands under the given profile text. */
    const underProfileText = (profile: string) => {
      const profilePath = path.join(base, `${probeName()}.sb`);
      fs.writeFileSync(profilePath, profile);
      return (command: string) => shell(command, profilePath, jobEnv());
    };

    /** An app directory with another worker's sandbox, the logs and the runner template in it. */
    const makeAppDir = (name: string): string => {
      const appDir = path.join(base, name);
      fs.mkdirSync(path.join(appDir, 'logs'), { recursive: true });
      fs.mkdirSync(path.join(appDir, 'runner', 'arc'), { recursive: true });
      fs.mkdirSync(path.join(appDir, 'runner', 'sandbox', '2'), { recursive: true });
      fs.writeFileSync(path.join(appDir, 'runner', 'sandbox', '2', 'token'), 'token');
      fs.writeFileSync(path.join(appDir, 'logs', 'app.log'), 'log');
      return appDir;
    };

    it("refuses writes to the app's own data directory, whatever the policy grants", () => {
      // Logs, job history and the runner template live beside the job's
      // sandbox; the directory is denied after every grant, a grant of the
      // whole of it included.
      const configDir = makeAppDir('config');
      const granted = path.join(base, 'granted');
      fs.mkdirSync(granted, { recursive: true });
      const run = underProfileText(profileWithAppDir(configDir, {
        filesystemPolicy: { level: 'strict', read: [], write: [configDir, granted] },
      }));
      expect(canCreate(run, path.join(granted, probeName()))).toBe(true);
      expect(canCreate(run, path.join(configDir, 'logs', probeName()))).toBe(false);
      expect(canCreate(run, path.join(configDir, 'job-history.json'))).toBe(false);
      expect(canCreate(run, path.join(configDir, 'runner', 'arc', probeName()))).toBe(false);
    });

    it("keeps a grant that contains the app's data directory, less the directory", () => {
      // A grant of the directory above the app's reaches everything else in
      // there as approved. The app's directory is denied after it, and the
      // job's own sandbox and its target's caches, inside that directory as a
      // worker's are, given back.
      const appDir = base;
      makeAppDir('.');
      const above = path.dirname(appDir);
      const run = underProfileText(profileWithAppDir(appDir, {
        filesystemPolicy: { level: 'moderate', read: [above], write: [above] },
        packageCacheDir,
      }));
      expect(canCreate(run, path.join(above, probeName()))).toBe(true);
      expect(canCreate(run, path.join(appDir, 'logs', probeName()))).toBe(false);
      expect(canCreate(run, path.join(appDir, 'job-history.json'))).toBe(false);
      expect(canCreate(run, path.join(appDir, 'runner', 'arc', probeName()))).toBe(false);
      expect(canCreate(run, path.join(appDir, 'runner', 'sandbox', '2', probeName()))).toBe(false);
      expect(run(`/bin/cat '${path.join(appDir, 'runner', 'sandbox', '2', 'token')}'`).ok).toBe(false);
      expect(run(`/bin/cat '${path.join(appDir, 'logs', 'app.log')}'`).ok).toBe(false);
      expect(canCreate(run, path.join(jobTmp, probeName()))).toBe(true);
      expect(canCreateUnder(run, packageCacheDir)).toBe(true);
    });

    it("refuses the app's data directory before the app has created it, by its real path", () => {
      // Configured through /var, a symlink, and not there yet: a job granted
      // the directory above it by its real path could otherwise make it, and
      // plant what the app would then trust.
      const parent = path.join(base, 'unborn');
      fs.mkdirSync(parent, { recursive: true });
      const spelled = path.join(parent, 'app').replace(/^\/private\//, '/');
      expect(spelled).not.toBe(path.join(parent, 'app'));
      const run = underProfileText(profileWithAppDir(spelled, {
        filesystemPolicy: { level: 'strict', read: [], write: [parent] },
      }));
      expect(canCreate(run, path.join(parent, probeName()))).toBe(true);
      expect(canCreateUnder(run, path.join(parent, 'app'))).toBe(false);
    });

    it("refuses the directories on the way to the app's data directory before they exist", () => {
      // A job granted the directory above could otherwise put a link where
      // the app will later create the rest of the way down, and have the
      // app's directory made wherever the link points.
      const parent = path.join(base, 'unborn-above');
      const elsewhere = path.join(base, 'unborn-elsewhere');
      fs.mkdirSync(parent, { recursive: true });
      fs.mkdirSync(elsewhere, { recursive: true });
      const middle = path.join(parent, 'middle');
      const run = underProfileText(profileWithAppDir(path.join(middle, 'app'), {
        filesystemPolicy: { level: 'strict', read: [], write: [parent, elsewhere] },
      }));
      expect(canCreate(run, path.join(parent, probeName()))).toBe(true);
      const linked = run(`/bin/ln -s '${elsewhere}' '${middle}'`);
      const made = run(`/bin/mkdir '${middle}'`);
      fs.rmSync(middle, { recursive: true, force: true });
      expect(linked.ok).toBe(false);
      expect(made.ok).toBe(false);
    });

    it("refuses reads of the app's data directory granted in another case", () => {
      // seatbelt matches paths case-insensitively on the default APFS volume,
      // so a grant spelled in capitals reaches what the lower-case one would:
      // other workers' sandboxes and the logs.
      const appDir = makeAppDir('cased');
      const run = underProfileText(profileWithAppDir(appDir, {
        filesystemPolicy: { level: 'strict', read: [appDir.toUpperCase()], write: [] },
      }));
      const own = path.join(jobTmp, probeName());
      fs.writeFileSync(own, 'own');
      expect(run(`/bin/cat '${own}'`).ok).toBe(true);
      expect(run(`/bin/cat '${path.join(appDir, 'runner', 'sandbox', '2', 'token')}'`).ok).toBe(false);
      expect(run(`/bin/cat '${path.join(appDir, 'logs', 'app.log')}'`).ok).toBe(false);
    });

    it("refuses reads of the app's data directory granted by its real path", () => {
      // os.tmpdir() is under /var, a symlink to /private/var. seatbelt matches
      // the real path, so a grant of /private/var/... reaches an app directory
      // configured as /var/...
      const appDir = makeAppDir('linked');
      const spelled = appDir.replace(/^\/private\//, '/');
      expect(spelled).not.toBe(appDir);
      const run = underProfileText(profileWithAppDir(spelled, {
        filesystemPolicy: { level: 'strict', read: [appDir], write: [] },
      }));
      expect(run(`/bin/cat '${path.join(appDir, 'runner', 'sandbox', '2', 'token')}'`).ok).toBe(false);
      expect(run(`/bin/cat '${path.join(appDir, 'logs', 'app.log')}'`).ok).toBe(false);
    });

    describe('under a policy that grants the whole home directory', () => {
      // The app's directories where a user's machine has them: ~/.localmost
      // and Electron's under ~/Library/Application Support, both inside what
      // a grant of ~ covers. Stood in for by a directory of this test's own in
      // the real home directory, so the grant reaches them as it would the
      // real ones.
      let home: string;
      let appDir: string;
      let userData: string;
      let instance: string;
      let ownCache: string;
      let otherCache: string;
      let sibling: string;

      beforeAll(() => {
        home = fs.realpathSync(fs.mkdtempSync(path.join(homeDir, 'localmost-probe-')));
        appDir = path.join(home, '.localmost');
        userData = path.join(home, 'Library', 'Application Support', 'localmost');
        instance = path.join(appDir, 'runner', 'sandbox', '1');
        sibling = path.join(appDir, 'runner', 'sandbox', '2');
        ownCache = path.join(appDir, 'runner', 'caches', 'aaaa1111', 'tool-cache');
        otherCache = path.join(appDir, 'runner', 'caches', 'bbbb2222', 'tool-cache');
        for (const dir of [path.join(instance, '_temp'), sibling, ownCache, otherCache, userData,
          path.join(appDir, 'logs'), path.join(appDir, 'runner', 'arc'), path.join(home, 'project')]) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const files: Record<string, string> = {
          [path.join(instance, 'own')]: 'own',
          [path.join(ownCache, 'node')]: 'node',
          [path.join(otherCache, 'node')]: 'node',
          [path.join(sibling, 'token')]: 'token',
          [path.join(appDir, 'logs', 'app.log')]: 'log',
          [path.join(appDir, 'runner', 'broker-sessions.json.tmp')]: '{}',
          [path.join(userData, 'Cookies')]: 'cookies',
          [path.join(home, 'project', 'README')]: 'readme',
        };
        for (const [file, content] of Object.entries(files)) fs.writeFileSync(file, content);
      });

      afterAll(() => {
        fs.rmSync(home, { recursive: true, force: true });
      });

      /** A runner for shell commands in the job at `instance`, under read and write grants of ~. */
      const underHomeGrant = () => {
        const previousConfig = process.env.LOCALMOST_CONFIG_DIR;
        const getPath = jest.mocked(app.getPath);
        const previousUserData = app.getPath('userData');
        process.env.LOCALMOST_CONFIG_DIR = appDir;
        getPath.mockReturnValue(userData);
        let profile: string;
        try {
          profile = generateSandboxProfile({
            instanceDir: instance,
            toolCacheDir: ownCache,
            filesystemPolicy: { level: 'strict', read: ['~'], write: ['~'] },
          });
        } finally {
          if (previousConfig === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
          else process.env.LOCALMOST_CONFIG_DIR = previousConfig;
          getPath.mockReturnValue(previousUserData);
        }
        const profilePath = path.join(base, `${probeName()}.sb`);
        fs.writeFileSync(profilePath, profile);
        const env = { PATH: '/usr/bin:/bin', HOME: homeDir, TMPDIR: path.join(instance, '_temp') };
        const run = (command: string) => shell(command, profilePath, env);
        // The grant is in force, so each refusal below is the deny's doing
        // and not the grant's absence.
        expect(canCreate(run, path.join(home, 'project', probeName()))).toBe(true);
        return run;
      };
      const cat = (run: (command: string) => { ok: boolean }, file: string) => run(`/bin/cat '${file}'`).ok;

      it('reads and writes the rest of the home directory, as granted', () => {
        const run = underHomeGrant();
        expect(canCreateUnder(run, path.join(home, 'elsewhere'))).toBe(true);
        expect(cat(run, path.join(home, 'project', 'README'))).toBe(true);
        // And Electron's neighbours: a grant of ~/Library is no less a grant.
        expect(canCreateUnder(run, path.join(home, 'Library', 'Application Support', 'another-app'))).toBe(true);
      });

      it("reads and writes its own sandbox and its target's cache in the app's directory", () => {
        const run = underHomeGrant();
        expect(canCreate(run, path.join(instance, '_temp', probeName()))).toBe(true);
        expect(cat(run, path.join(instance, 'own'))).toBe(true);
        expect(canCreate(run, path.join(ownCache, probeName()))).toBe(true);
        expect(cat(run, path.join(ownCache, 'node'))).toBe(true);
      });

      it("neither reads nor writes anything else in the app's directories", () => {
        const run = underHomeGrant();
        for (const dir of [appDir, path.join(appDir, 'logs'), path.join(appDir, 'runner', 'arc'), sibling, otherCache, userData]) {
          expect(canCreate(run, path.join(dir, probeName()))).toBe(false);
        }
        expect(canCreate(run, path.join(appDir, 'job-history.json'))).toBe(false);
        for (const file of [
          path.join(appDir, 'logs', 'app.log'),
          path.join(otherCache, 'node'),
          // Refused here by the deny of the app's directories as much as by
          // name; the unit test that evaluates the named deny on its own is
          // what shows the name covers it.
          path.join(appDir, 'runner', 'broker-sessions.json.tmp'),
          path.join(userData, 'Cookies'),
        ]) {
          expect(cat(run, file)).toBe(false);
        }
      });

      it("cannot move the app's directories out from under the deny by renaming a directory above them", () => {
        // Renamed, the directory would sit outside the path the deny names,
        // readable and writable under ~ until moved back. Each rename is
        // undone from outside the sandbox should the sandbox let it through.
        const run = underHomeGrant();
        const cookies = path.join(userData, 'Cookies');
        for (const above of [path.dirname(userData), path.join(home, 'Library'), home]) {
          const moved = `${above}-moved`;
          const result = run(`/bin/mv '${above}' '${moved}' && /bin/cat '${path.join(moved, path.relative(above, cookies))}'`);
          if (fs.existsSync(moved)) fs.renameSync(moved, above);
          expect(result.stdout).not.toContain('cookies');
          expect(result.ok).toBe(false);
          expect(result.stderr).toContain('Operation not permitted');
        }
        expect(fs.readFileSync(cookies, 'utf-8')).toBe('cookies');
      });

      it("cannot read another worker's sandbox", () => {
        const run = underHomeGrant();
        expect(cat(run, path.join(sibling, 'token'))).toBe(false);
        expect(run(`/bin/ls '${sibling}'`).ok).toBe(false);
      });
    });

    describe('under write grants that reach the credentials a developer machine keeps', () => {
      // A stand-in home, so the developer's own keys are never in play: the
      // profile is built with HOME pointing at it, and its app directories
      // are where a user's machine has them, inside it. Each credential holds
      // a marker that must never reach the job's output.
      let home: string;
      const credentials: Record<string, string> = {
        '.ssh/id_ed25519': 'SECRET-ssh',
        '.netrc': 'SECRET-netrc',
        '.m2/settings.xml': 'SECRET-maven',
        '.gradle/gradle.properties': 'SECRET-gradle',
        '.cargo/credentials.toml': 'SECRET-cargo',
        '.nuget/NuGet/NuGet.Config': 'SECRET-nuget',
        'Library/Keychains/login.keychain-db': 'SECRET-keychain',
        // The plaintext stores other tools keep their tokens and passwords in.
        '.git-credentials': 'SECRET-git',
        '.pypirc': 'SECRET-pypi',
        '.gem/credentials': 'SECRET-rubygems',
        '.local/share/gem/credentials': 'SECRET-rubygems-xdg',
        // Kept inside a tool's ~/.local/share directory, which a policy
        // declares when a command in ~/.local/bin links into it.
        '.local/share/uv/credentials/credentials.toml': 'SECRET-uv',
        '.local/share/containers/podman/machine/machine': 'SECRET-podman',
        '.local/share/atuin/key': 'SECRET-atuin',
        '.terraform.d/credentials.tfrc.json': 'SECRET-terraform',
        '.azure/msal_token_cache.json': 'SECRET-azure',
        '.yarnrc.yml': 'SECRET-yarn',
        '.pgpass': 'SECRET-pgpass',
        '.vault-token': 'SECRET-vault',
        '.terraformrc': 'SECRET-terraformrc',
        '.boto': 'SECRET-boto',
        '.s3cfg': 'SECRET-s3cmd',
        '.my.cnf': 'SECRET-mysql',
        '.mylogin.cnf': 'SECRET-mysql-login',
        // moderate reads ~/.cache as a toolchain tree, with no grant at all.
        '.cache/huggingface/token': 'SECRET-huggingface',
        '.cache/huggingface/stored_tokens': 'SECRET-huggingface-stored',
      };
      // Credentials kept in a dotfiles repository and linked into place, as
      // GNU stow and the like do it: a directory and a single file.
      const linkedCredentials: Record<string, string> = {
        'dotfiles/aws/credentials': 'SECRET-aws',
        'dotfiles/m2/settings-security.xml': 'SECRET-maven-security',
      };
      const links: Record<string, string> = {
        '.aws': 'dotfiles/aws',
        '.m2/settings-security.xml': '../dotfiles/m2/settings-security.xml',
      };

      /** The job's sandbox under a stand-in home. */
      const instanceIn = (at: string) => path.join(at, '.localmost', 'runner', 'sandbox', '1');

      /** A stand-in home with nothing in it but the app's own directories. */
      const makeHome = (at: string) => {
        for (const dir of [path.join(instanceIn(at), '_temp'), path.join(at, 'Library', 'Application Support', 'localmost')]) {
          fs.mkdirSync(dir, { recursive: true });
        }
      };

      beforeAll(() => {
        home = path.join(base, 'home');
        makeHome(home);
        for (const dir of [path.join(home, '.gradle', 'caches'), path.join(home, '.gradle', 'wrapper')]) {
          fs.mkdirSync(dir, { recursive: true });
        }
        for (const [file, content] of Object.entries({ ...credentials, ...linkedCredentials })) {
          fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
          fs.writeFileSync(path.join(home, file), content);
        }
        for (const [link, target] of Object.entries(links)) fs.symlinkSync(target, path.join(home, link));
        fs.writeFileSync(path.join(home, 'notes.txt'), 'notes');
      });

      /**
       * A runner for shell commands in the job at `at`'s sandbox, its profile
       * built with `at` - by default `home` - as the home directory.
       */
      const underGrant = (filesystemPolicy: RunnerProfileOptions['filesystemPolicy'], at: string = home) => {
        const savedConfig = process.env.LOCALMOST_CONFIG_DIR;
        const getPath = jest.mocked(app.getPath);
        const previousUserData = app.getPath('userData');
        jest.mocked(os.homedir).mockReturnValue(at);
        process.env.LOCALMOST_CONFIG_DIR = path.join(at, '.localmost');
        getPath.mockReturnValue(path.join(at, 'Library', 'Application Support', 'localmost'));
        let profile: string;
        try {
          profile = generateSandboxProfile({ instanceDir: instanceIn(at), filesystemPolicy });
        } finally {
          jest.mocked(os.homedir).mockImplementation(realHomedir);
          if (savedConfig === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
          else process.env.LOCALMOST_CONFIG_DIR = savedConfig;
          getPath.mockReturnValue(previousUserData);
        }
        const profilePath = path.join(base, `${probeName()}.sb`);
        fs.writeFileSync(profilePath, profile);
        const env = { PATH: '/usr/bin:/bin', HOME: at, TMPDIR: path.join(instanceIn(at), '_temp') };
        return (command: string) => shell(command, profilePath, env);
      };

      /**
       * Rename `from` to `to` in the job and print `shown` from under the new
       * name, then assert the sandbox refused the rename and nothing of the
       * credentials came out. Undone from outside the sandbox should the
       * sandbox let it through.
       */
      const expectNoRenameIntoView = (run: (command: string) => ReturnType<typeof shell>, from: string, to: string, shown: string) => {
        const result = run(`/bin/mv '${path.join(home, from)}' '${path.join(home, to)}' && /bin/cat '${path.join(home, to, shown)}'`);
        if (fs.existsSync(path.join(home, to))) fs.renameSync(path.join(home, to), path.join(home, from));
        expect(result.stdout).not.toContain('SECRET');
        expect(result.ok).toBe(false);
        expect(result.stderr).toContain('Operation not permitted');
      };

      afterAll(() => {
        for (const [file, content] of Object.entries({ ...credentials, ...linkedCredentials })) {
          expect(fs.readFileSync(path.join(home, file), 'utf-8')).toBe(content);
        }
        for (const [link, target] of Object.entries(links)) {
          expect(fs.readlinkSync(path.join(home, link))).toBe(target);
        }
      });

      it('a write grant on a package cache cannot move its credential file to a readable name', () => {
        // moderate reads the package caches in the home directory, less the
        // credential files kept inside them, which are subtracted by name. A
        // write grant there let a job rename one to a name the read covers.
        const run = underGrant({ level: 'moderate', read: [], write: ['~/.gradle', '~/.m2', '~/.cargo', '~/.nuget'] });
        // The grant is in force, so each refusal below is the floor's doing.
        expect(canCreateUnder(run, path.join(home, '.gradle', 'caches'))).toBe(true);
        expect(canCreateUnder(run, path.join(home, '.gradle', 'wrapper'))).toBe(true);
        expect(canCreateUnder(run, path.join(home, '.m2', 'repository'))).toBe(true);
        expect(canCreate(run, path.join(home, '.nuget', 'NuGet', probeName()))).toBe(true);
        for (const [from, to] of [
          ['.gradle/gradle.properties', '.gradle/renamed'],
          ['.m2/settings.xml', '.m2/renamed'],
          ['.cargo/credentials.toml', '.cargo/renamed'],
          ['.nuget/NuGet/NuGet.Config', '.nuget/NuGet/renamed'],
        ]) {
          expectNoRenameIntoView(run, from, to, '');
        }
        // Nor the directory the credential file sits in.
        expectNoRenameIntoView(run, '.nuget/NuGet', '.nuget/renamed', 'NuGet.Config');
        for (const file of Object.keys(credentials)) {
          expect(run(`/bin/cat '${path.join(home, file)}'`).stdout).not.toContain('SECRET');
        }
      });

      it('cannot clone a package cache the level reads, to carry the credential files in it into the sandbox', () => {
        // moderate reads ~/.m2, ~/.gradle, ~/.cargo, ~/.nuget, ~/.cache and
        // ~/.local as toolchain trees, less the credential files inside. A
        // clone of the directory copied the whole tree in one call, those
        // files included, to a name in the job's sandbox no deny covers.
        const run = underGrant({ level: 'moderate', read: [], write: [] });
        const into = path.join(instanceIn(home), '_temp');
        for (const dir of ['.m2', '.gradle', '.cargo', '.nuget', path.join('.nuget', 'NuGet'), '.cache', '.local']) {
          for (const byDescriptor of [false, true]) {
            const copy = path.join(into, probeName());
            const result = run(`${cloneCommand(path.join(home, dir), copy, byDescriptor)} && /usr/bin/grep -r SECRET ${sq(copy)}`);
            const cloned = fs.existsSync(copy);
            fs.rmSync(copy, { recursive: true, force: true });
            expect([dir, byDescriptor, result.stdout]).toEqual([dir, byDescriptor, '']);
            expect([dir, byDescriptor, result.ok, cloned]).toEqual([dir, byDescriptor, false, false]);
          }
        }
        // The level's read is in force, so each refusal above is the clone
        // rule's: a file in the cache that is not a credential clones.
        const readable = path.join(home, '.gradle', 'caches', 'readable.txt');
        fs.writeFileSync(readable, 'cached');
        const copy = path.join(into, probeName());
        const result = run(`${cloneCommand(readable, copy)} && /bin/cat ${sq(copy)}`);
        fs.rmSync(copy, { force: true });
        fs.rmSync(readable);
        expect(result).toMatchObject({ ok: true, stdout: 'cached' });
      });

      it('a read grant on the home directory cannot read the credentials kept there, git and PyPI tokens included', () => {
        // ~/.git-credentials is where git's store helper keeps tokens in the
        // clear, and ~/.pypirc is where twine finds an upload token: a policy
        // that read ~ read both, since the floor did not name them.
        const run = underGrant({ level: 'strict', read: ['~'], write: [] });
        // The grant is in force, so each refusal below is the floor's doing.
        expect(run(`/bin/cat '${path.join(home, 'notes.txt')}'`).stdout).toBe('notes');
        for (const file of Object.keys(credentials)) {
          const result = run(`/bin/cat '${path.join(home, file)}'`);
          expect([file, result.stdout]).toEqual([file, '']);
          expect([file, result.stderr]).toEqual([file, expect.stringContaining('Operation not permitted')]);
        }
      });

      it('a write grant on the home directory cannot move ~/.ssh, or a directory above a credential, to a readable name', () => {
        const run = underGrant({ level: 'strict', read: ['~'], write: ['~'] });
        // Ordinary files in the home directory stay as granted.
        expect(canCreate(run, path.join(home, probeName()))).toBe(true);
        expect(canCreateUnder(run, path.join(home, 'elsewhere'))).toBe(true);
        expect(canCreateUnder(run, path.join(home, '.gradle', 'caches'))).toBe(true);
        expect(run(`/bin/cat '${path.join(home, 'notes.txt')}'`).stdout).toBe('notes');
        for (const [from, to, shown] of [
          ['.ssh', '.ssh-renamed', 'id_ed25519'],
          ['.netrc', 'netrc-renamed', ''],
          ['.m2', '.m2-renamed', 'settings.xml'],
          ['.gradle', '.gradle-renamed', 'gradle.properties'],
          ['.cargo', '.cargo-renamed', 'credentials.toml'],
          ['.nuget', '.nuget-renamed', path.join('NuGet', 'NuGet.Config')],
          ['Library', 'Library-renamed', path.join('Keychains', 'login.keychain-db')],
          [path.join('Library', 'Keychains'), path.join('Library', 'Keychains-renamed'), 'login.keychain-db'],
          ['.git-credentials', 'git-credentials-renamed', ''],
          ['.azure', '.azure-renamed', 'msal_token_cache.json'],
          ['.gem', '.gem-renamed', 'credentials'],
          ['.terraform.d', '.terraform.d-renamed', 'credentials.tfrc.json'],
          ['.local', '.local-renamed', path.join('share', 'gem', 'credentials')],
          [path.join('.local', 'share'), path.join('.local', 'share-renamed'), path.join('gem', 'credentials')],
          [path.join('.local', 'share', 'uv'), path.join('.local', 'share', 'uv-renamed'), path.join('credentials', 'credentials.toml')],
          [path.join('.local', 'share', 'containers', 'podman'), path.join('.local', 'share', 'containers', 'podman-renamed'),
            path.join('machine', 'machine')],
          [path.join('.local', 'share', 'atuin'), path.join('.local', 'share', 'atuin-renamed'), 'key'],
          ['.cache', '.cache-renamed', path.join('huggingface', 'token')],
          [path.join('.cache', 'huggingface'), path.join('.cache', 'huggingface-renamed'), 'token'],
        ]) {
          expectNoRenameIntoView(run, from, to, shown);
        }
        // Nor written in place: an authorized key or an SSH config is a way in.
        expect(canCreate(run, path.join(home, '.ssh', 'authorized_keys'))).toBe(false);
      });

      it('a write grant cannot reach a credential linked into place, by the path the link resolves to', () => {
        // Dotfile managers link ~/.aws to ~/dotfiles/aws, and a single file
        // such as ~/.m2/settings-security.xml the same way. seatbelt matches
        // the path a link resolves to, so a floor written as ~/.aws alone
        // held nothing there: the job read the credential through the link.
        const run = underGrant({ level: 'strict', read: ['~'], write: ['~'] });
        // The grant is in force beside them, so each refusal below is the floor's doing.
        expect(canCreateUnder(run, path.join(home, 'dotfiles', 'other'))).toBe(true);
        for (const file of ['.aws/credentials', 'dotfiles/aws/credentials', '.m2/settings-security.xml',
          'dotfiles/m2/settings-security.xml']) {
          expect(run(`/bin/cat '${path.join(home, file)}'`).stdout).not.toContain('SECRET');
        }
        for (const [from, to, shown] of [
          ['dotfiles/aws/credentials', 'dotfiles/aws/renamed', ''],
          ['dotfiles/aws', 'dotfiles/aws-renamed', 'credentials'],
          ['dotfiles', 'dotfiles-renamed', path.join('aws', 'credentials')],
          ['.aws', '.aws-renamed', 'credentials'],
          ['dotfiles/m2/settings-security.xml', 'dotfiles/m2/renamed', ''],
          ['dotfiles/m2', 'dotfiles/m2-renamed', 'settings-security.xml'],
          ['.m2/settings-security.xml', '.m2/renamed', ''],
        ]) {
          expectNoRenameIntoView(run, from, to, shown);
        }
      });

      it('a write grant cannot create a missing directory above a credential, which the user creates instead', () => {
        // Missing, ~/.gradle is still closed as a node: a link a job planted
        // there would carry the gradle.properties your own Gradle writes later
        // wherever the link points. So a grant of ~/.gradle writes in it only
        // once it exists.
        const fresh = path.join(base, 'fresh-home');
        makeHome(fresh);
        const gradle = underGrant({ level: 'strict', read: ['~/.gradle'], write: ['~/.gradle'] }, fresh);
        const whole = underGrant({ level: 'strict', read: ['~'], write: ['~'] }, fresh);
        expect(canCreateUnder(whole, path.join(fresh, 'elsewhere'))).toBe(true);
        expect(gradle(`/bin/mkdir -p '${path.join(fresh, '.gradle', 'caches')}'`).ok).toBe(false);
        for (const dir of ['.gradle', '.m2', '.cargo', '.nuget', '.gem', '.terraform.d', '.local', '.cache']) {
          const target = path.join(fresh, dir);
          expect(whole(`/bin/mkdir '${target}'`).ok).toBe(false);
          expect(whole(`/bin/ln -s '${path.join(fresh, 'elsewhere')}' '${target}'`).ok).toBe(false);
          const planted = fs.lstatSync(target, { throwIfNoEntry: false });
          fs.rmSync(target, { recursive: true, force: true });
          expect(planted).toBeUndefined();
        }
        // Once the user has made it, the grant writes in it.
        fs.mkdirSync(path.join(fresh, '.gradle'));
        expect(canCreateUnder(gradle, path.join(fresh, '.gradle', 'caches'))).toBe(true);
      });

      /** What tools keep in ~/.local beside bin and lib that is no credential, and a job still has no business reading. */
      const localData: Record<string, string> = {
        '.local/share/fish/fish_history': 'HISTORY-fish',
        '.local/state/tool/history': 'STATE-tool',
      };
      const plantLocal = () => {
        const tool = path.join(home, '.local', 'bin', 'tool');
        for (const [file, content] of Object.entries(localData)) {
          fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
          fs.writeFileSync(path.join(home, file), content);
        }
        fs.mkdirSync(path.dirname(tool), { recursive: true });
        fs.writeFileSync(tool, '#!/bin/sh\necho tool-ran\n', { mode: 0o755 });
        return tool;
      };
      const localSecrets = [
        '.local/share/uv/credentials/credentials.toml',
        '.local/share/containers/podman/machine/machine',
        '.local/share/atuin/key',
        '.local/share/gem/credentials',
      ];

      it.each(['moderate', 'permissive'] as const)(
        'reads and runs what is in ~/.local/bin under %s with no grant, and nothing tools keep elsewhere in ~/.local',
        (level) => {
          // ~/.local was read whole as a toolchain tree, and ~/.local/share
          // is where uv keeps its index credentials, Podman the SSH key into
          // its machine and atuin its sync key, and where shells keep their
          // history: each was printed by a job that declared nothing.
          const tool = plantLocal();
          const run = underGrant({ level, read: [], write: [] });
          expect(run(sq(tool)).stdout).toBe('tool-ran');
          for (const file of [...localSecrets, ...Object.keys(localData)]) {
            const result = run(`/bin/cat ${sq(path.join(home, file))}`);
            expect([file, result.stdout]).toEqual([file, '']);
            expect([file, result.stderr]).toEqual([file, expect.stringContaining('Operation not permitted')]);
          }
        }
      );

      it.each(['strict', 'moderate'] as const)(
        'a read grant on ~/.local/share under %s reads what tools keep there, and none of their secrets',
        (level) => {
          // A command in ~/.local/bin that links into ~/.local/share runs once
          // the repository declares where the link resolves. Declaring uv's or
          // Podman's whole directory handed the job the credentials beside the
          // tools, so those are on the floor with RubyGems'.
          plantLocal();
          const run = underGrant({ level, read: ['~/.local/share'], write: [] });
          // The grant is in force, so each refusal below is the floor's doing.
          expect(run(`/bin/cat ${sq(path.join(home, '.local/share/fish/fish_history'))}`).stdout).toBe('HISTORY-fish');
          for (const file of localSecrets) {
            const result = run(`/bin/cat ${sq(path.join(home, file))}`);
            expect([file, result.stdout]).toEqual([file, '']);
            expect([file, result.stderr]).toEqual([file, expect.stringContaining('Operation not permitted')]);
          }
        }
      );
    });

    describe("the user's preferences", () => {
      // The real home, unlike the blocks above: cfprefsd finds a user's
      // plists by uid, whatever HOME says or the profile was built from, so a
      // stand-in home would prove nothing. The one domain written is a
      // throwaway no app owns, planted from outside the sandbox and removed
      // after; Xcode's is only ever asked about (see preferenceAllowed).
      const domain = throwawayDomain();
      const plist = path.join(homeDir, 'Library', 'Preferences', `${domain}.plist`);

      beforeAll(() => {
        sweepStaleThrowawayDomains();
        expect(defaults(['write', domain, 'planted', '-string', 'PLANTED']).ok).toBe(true);
        expect(defaults(['read', domain, 'planted']).stdout).toBe('PLANTED');
      });

      afterAll(() => {
        removeThrowawayDomain(domain);
      });

      it.each(['strict', 'moderate', 'permissive'] as const)(
        "reads the global domain and the build domains under %s, and no other app's preferences",
        (level) => {
          // An unfiltered read handed a job every app's settings - licence
          // keys and account names included - through cfprefsd, past the
          // file floor that keeps it out of ~/Library/Preferences.
          const profilePath = writeProfile({ filesystemPolicy: { level, read: [], write: [] } });
          const locale = defaults(['read', '-g', 'AppleLocale']);
          expect(locale.ok).toBe(true);
          expect(defaults(['read', '-g', 'AppleLocale'], profilePath)).toEqual(locale);
          expect(preferenceAllowed('user-preference-read', 'com.apple.dt.Xcode', profilePath)).toBe(true);
          expect(defaults(['read', domain, 'planted'], profilePath).stdout).toBe('');
          // Finder's own, which is there on any Mac a user has logged in to.
          expect(defaults(['read', 'com.apple.finder']).ok).toBe(true);
          expect(defaults(['read', 'com.apple.finder'], profilePath).ok).toBe(false);
        }
      );

      it.each(['strict', 'moderate', 'permissive'] as const)(
        "writes no preference domain under %s, Xcode's included",
        (level) => {
          // Your own Xcode loads com.apple.dt.Xcode outside any sandbox, and
          // xcodebuild and swift build write none of it.
          const profilePath = writeProfile({ filesystemPolicy: { level, read: [], write: [] } });
          expect(preferenceAllowed('user-preference-write', 'com.apple.dt.Xcode', profilePath)).toBe(false);
          expect(defaults(['write', domain, 'job', '-string', 'JOB'], profilePath).ok).toBe(false);
          expect(defaults(['read', domain, 'job']).ok).toBe(false);
        }
      );

      it('reaches no plist through a grant of ~ or ~/Library/Preferences, so cfprefsd serves no domain through one', () => {
        // cfprefsd serves a domain to a process that may read (or write) its
        // plist, whatever the preference rules say: a filesystem grant there
        // was a way around them.
        const grants = ['~', '~/Library', '~/Library/Preferences'];
        const profilePath = writeProfile({ filesystemPolicy: { level: 'strict', read: grants, write: grants } });
        const run = (command: string) => shell(command, profilePath, jobEnv());
        // The grant is in force beside it, so each refusal below is the floor's doing.
        expect(canCreate(run, path.join(homeDir, 'Library', 'Caches', probeName()))).toBe(true);
        const read = run(`/bin/cat ${sq(plist)}`);
        expect(read.stdout).not.toContain('PLANTED');
        expect(read.stderr).toContain('Operation not permitted');
        expect(defaults(['read', domain, 'planted'], profilePath).stdout).toBe('');
        expect(defaults(['write', domain, 'job', '-string', 'JOB'], profilePath).ok).toBe(false);
        expect(defaults(['read', domain, 'job']).ok).toBe(false);
        expect(canCreate(run, path.join(homeDir, 'Library', 'Preferences', `${throwawayDomain()}.plist`))).toBe(false);
      });
    });

    it('refuses what a policy denies, read and write, inside what it grants', () => {
      const out = path.join(base, 'out');
      const secret = path.join(out, 'secret');
      fs.mkdirSync(secret, { recursive: true });
      fs.writeFileSync(path.join(out, 'visible'), 'visible');
      fs.writeFileSync(path.join(secret, 'key'), 'key');
      const run = underProfile({ filesystemPolicy: { level: 'strict', read: [out], write: [out], deny: [secret] } });
      expect(canCreate(run, path.join(out, probeName()))).toBe(true);
      expect(run(`/bin/cat '${path.join(out, 'visible')}'`).ok).toBe(true);
      expect(canCreate(run, path.join(secret, probeName()))).toBe(false);
      expect(run(`/bin/cat '${path.join(secret, 'key')}'`).ok).toBe(false);
    });

    it('refuses a file a glob deny matches', () => {
      const out = path.join(base, 'globbed');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'x.pem'), 'key');
      fs.writeFileSync(path.join(out, 'x.txt'), 'visible');
      const run = underProfile({ filesystemPolicy: { level: 'strict', read: [out], write: [out], deny: [`${out}/*.pem`] } });
      expect(run(`/bin/cat '${path.join(out, 'x.txt')}'`).ok).toBe(true);
      expect(canCreate(run, path.join(out, probeName()))).toBe(true);
      expect(run(`/bin/cat '${path.join(out, 'x.pem')}'`).ok).toBe(false);
      expect(canCreate(run, path.join(out, `${probeName()}.pem`))).toBe(false);
    });

    it('cannot move what a policy denies out from under the deny by renaming a directory above it', () => {
      // The deny matches paths, so renamed, the secret would sit under a name
      // the write grant covers and the deny does not. Each rename is undone
      // from outside the sandbox should the sandbox let it through.
      const out = path.join(base, 'renamed');
      for (const dir of [path.join(out, 'a', 'secret'), path.join(out, 'g')]) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(out, 'a', 'secret', 'key'), 'key');
      fs.writeFileSync(path.join(out, 'g', 'x.pem'), 'key');
      const run = underProfile({
        filesystemPolicy: {
          level: 'strict', read: [out], write: [out], deny: [path.join(out, 'a', 'secret'), `${out}/g/*.pem`],
        },
      });
      for (const [above, file] of [['a', path.join('secret', 'key')], ['g', 'x.pem']]) {
        const from = path.join(out, above);
        const moved = `${from}-moved`;
        const result = run(`/bin/mv '${from}' '${moved}' && /bin/cat '${path.join(moved, file)}'`);
        if (fs.existsSync(moved)) fs.renameSync(moved, from);
        expect(result.stdout).not.toContain('key');
        expect(result.ok).toBe(false);
      }
      const whole = run(`/bin/mv '${out}' '${out}-moved' && /bin/cat '${out}-moved/a/secret/key'`);
      if (fs.existsSync(`${out}-moved`)) fs.renameSync(`${out}-moved`, out);
      expect(whole.ok).toBe(false);
      // What the grant gives stays given: a new file beside the secret.
      expect(canCreate(run, path.join(out, 'a', probeName()))).toBe(true);
      expect(canCreate(run, path.join(out, 'g', probeName()))).toBe(true);
    });

    it('cannot clone a directory holding what a policy denies into its sandbox, and still clones a file', () => {
      // clonefile(2) of a directory copies the whole tree beneath it without
      // asking about each file: read on the directory and write where the
      // clone lands carried a denied file into the job's sandbox, readable
      // there under a name no deny covers. A glob deny and a literal one.
      const tree = path.join(base, probeName());
      const out = path.join(tree, 'out');
      fs.mkdirSync(path.join(out, 'secA'), { recursive: true });
      fs.mkdirSync(path.join(out, 'plain'));
      fs.writeFileSync(path.join(out, 'secA', 'key'), 'SECRET');
      fs.writeFileSync(path.join(out, 'plain', 'key'), 'SECRET');
      fs.writeFileSync(path.join(out, 'visible.txt'), 'visible');
      try {
        const run = underProfile({
          filesystemPolicy: { level: 'strict', read: [tree], write: [], deny: [`${out}/sec*/key`, path.join(out, 'plain', 'key')] },
        });
        for (const from of [out, path.join(out, 'secA'), path.join(out, 'plain')]) {
          for (const byDescriptor of [false, true]) {
            const copy = path.join(jobTmp, probeName());
            const result = run(`${cloneCommand(from, copy, byDescriptor)} && /usr/bin/grep -r SECRET ${sq(copy)}`);
            const cloned = fs.existsSync(copy);
            fs.rmSync(copy, { recursive: true, force: true });
            expect([from, byDescriptor, result.stdout]).toEqual([from, byDescriptor, '']);
            expect([from, byDescriptor, result.ok, cloned]).toEqual([from, byDescriptor, false, false]);
            expect(result.stderr).toContain('Operation not permitted');
          }
        }
        // A readable file still clones, by path and by descriptor.
        for (const byDescriptor of [false, true]) {
          const copy = path.join(jobTmp, probeName());
          const result = run(`${cloneCommand(path.join(out, 'visible.txt'), copy, byDescriptor)} && /bin/cat ${sq(copy)}`);
          fs.rmSync(copy, { force: true });
          expect(result).toMatchObject({ ok: true, stdout: 'visible' });
        }
        // cp -c -R clones file by file, so it copies the tree less the
        // denied files, as cp -R does.
        const copied = path.join(jobTmp, probeName());
        run(`/bin/cp -c -R ${sq(out)} ${sq(copied)}`);
        const visible = fs.existsSync(path.join(copied, 'visible.txt'));
        const keys = ['secA', 'plain'].filter((dir) => fs.existsSync(path.join(copied, dir, 'key')));
        fs.rmSync(copied, { recursive: true, force: true });
        expect([visible, keys]).toEqual([true, []]);
      } finally {
        fs.rmSync(tree, { recursive: true, force: true });
      }
    });

    it('refuses what a policy denies by a spelling that runs through a symlink', () => {
      // /tmp is a symlink to /private/tmp, and a link of the user's is one
      // too; seatbelt matches where they lead.
      const real = fs.realpathSync(fs.mkdtempSync('/tmp/localmost-deny-'));
      const viaTmp = real.replace(/^\/private/, '');
      const link = path.join(base, probeName());
      try {
        for (const dir of ['a', 'b']) {
          fs.mkdirSync(path.join(real, dir));
          fs.writeFileSync(path.join(real, dir, 'key'), 'key');
        }
        fs.writeFileSync(path.join(real, 'visible'), 'visible');
        fs.writeFileSync(path.join(real, 'x.pem'), 'key');
        fs.symlinkSync(real, link);
        const run = underProfile({
          filesystemPolicy: {
            level: 'strict', read: [real], write: [real], deny: [path.join(viaTmp, 'a'), path.join(link, 'b'), `${viaTmp}/*.pem`],
          },
        });
        expect(viaTmp).toMatch(/^\/tmp\//);
        expect(run(`/bin/cat '${path.join(real, 'visible')}'`).ok).toBe(true);
        // A glob through the link too: the directory before its * is resolved.
        expect(run(`/bin/cat '${path.join(real, 'x.pem')}'`).ok).toBe(false);
        expect(run(`/bin/cat '${path.join(real, 'a', 'key')}'`).ok).toBe(false);
        expect(canCreate(run, path.join(real, 'a', probeName()))).toBe(false);
        expect(run(`/bin/cat '${path.join(real, 'b', 'key')}'`).ok).toBe(false);
        expect(run(`/bin/cat '${path.join(link, 'b', 'key')}'`).ok).toBe(false);
      } finally {
        fs.rmSync(link, { force: true });
        fs.rmSync(real, { recursive: true, force: true });
      }
    });

    it('builds and applies a deny beneath what it cannot look up: an unsearchable directory, a symlink loop', () => {
      // The job cannot pass through either, so the deny holds as written;
      // stopping every spawn for the repository over it helped no one.
      const out = path.join(base, 'unresolvable');
      fs.mkdirSync(path.join(out, 'locked', 'inner'), { recursive: true });
      fs.writeFileSync(path.join(out, 'visible'), 'visible');
      fs.symlinkSync('loop', path.join(out, 'loop'));
      fs.chmodSync(path.join(out, 'locked'), 0o000);
      try {
        const run = underProfile({
          filesystemPolicy: {
            level: 'strict', read: [out], write: [out], deny: [path.join(out, 'locked', 'inner', 'secret'), path.join(out, 'loop', 'secret')],
          },
        });
        expect(run(`/bin/cat '${path.join(out, 'visible')}'`).ok).toBe(true);
        expect(canCreate(run, path.join(out, probeName()))).toBe(true);
      } finally {
        fs.chmodSync(path.join(out, 'locked'), 0o755);
        fs.rmSync(out, { recursive: true, force: true });
      }
    });

    it('lets a job signal its own children, and no process outside its sandbox', () => {
      const outside = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
      try {
        const run = underProfile();
        expect(run(`/bin/kill -0 ${outside.pid}`).ok).toBe(false);
        expect(run('/bin/sleep 60 & C=$!; /bin/kill -0 $C && /bin/kill -TERM $C').ok).toBe(true);
      } finally {
        outside.kill('SIGKILL');
      }
    });

    it('signals the members of its process group that share its sandbox, and no others', async () => {
      // An unsandboxed shell leads a fresh process group - never this test's
      // own - and starts one process outside the sandbox and then the job in
      // the same group. The job signals the whole group: its own child gets
      // it; the shell and the outside process must not.
      const profilePath = writeProfile();
      const job = '/bin/sleep 60 & C=$!; trap "" TERM; kill -TERM 0; wait $C; echo child=$?';
      const script = [
        '/bin/sleep 60 & OUTSIDE=$!',
        `/usr/bin/sandbox-exec -f '${profilePath}' /bin/sh -c '${job}'`,
        '/bin/kill -0 $OUTSIDE && echo outside=alive',
        '/bin/kill -KILL $OUTSIDE',
      ].join('\n');
      const shellProcess = spawn('/bin/sh', ['-c', script], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: jobEnv(),
      });
      let stdout = '';
      shellProcess.stdout.setEncoding('utf-8').on('data', (chunk: string) => { stdout += chunk; });
      const timer = setTimeout(() => shellProcess.kill('SIGKILL'), 15000);
      await new Promise((resolve) => shellProcess.on('close', resolve));
      clearTimeout(timer);
      expect(stdout).toContain('child=143');
      expect(stdout).toContain('outside=alive');
    });

    describe('loopback', () => {
      // Listeners outside the sandbox: one stands in for the worker's proxy,
      // the others for services on this machine. A connect under seatbelt is
      // refused before it leaves the process, and one it allows completes
      // against the listen backlog while this process waits.
      let proxy: net.Server;
      let broker: net.Server;
      let service: net.Server;
      let other: net.Server;
      const portOf = (server: net.Server) => (server.address() as net.AddressInfo).port;
      const listen = () =>
        new Promise<net.Server>((resolve, reject) => {
          const server = net.createServer((socket) => socket.destroy());
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => resolve(server));
        });
      const reaches = (run: (command: string) => { ok: boolean }, server: net.Server) =>
        run(`/usr/bin/nc -z -G 2 127.0.0.1 ${portOf(server)}`).ok;

      beforeAll(async () => {
        proxy = await listen();
        broker = await listen();
        service = await listen();
        other = await listen();
      });

      afterAll(async () => {
        await Promise.all([proxy, broker, service, other].map((server) => new Promise((resolve) => server.close(resolve))));
      });

      it('reaches its own proxy and the broker, and nothing else on loopback by default', () => {
        // The runner dials the broker directly - its HTTP client sends a
        // loopback destination around the proxy - so a profile that closed
        // the broker's port left every worker unable to open its session.
        const run = underProfile({ proxyPort: portOf(proxy), brokerPort: portOf(broker) });
        expect(reaches(run, proxy)).toBe(true);
        expect(reaches(run, broker)).toBe(true);
        expect(reaches(run, service)).toBe(false);
      });

      it('reaches a service whose port the policy declares, and not one whose port it does not', () => {
        const run = underProfile({
          proxyPort: portOf(proxy),
          filesystemPolicy: { level: 'strict', read: [], write: [], loopback: [portOf(service)] },
        });
        expect(reaches(run, proxy)).toBe(true);
        expect(reaches(run, service)).toBe(true);
        expect(reaches(run, other)).toBe(false);
      });

      it('reaches every loopback port only when the policy declares all of loopback', () => {
        const declared = underProfile({
          proxyPort: portOf(proxy),
          filesystemPolicy: { level: 'strict', read: [], write: [], loopback: true },
        });
        expect(reaches(declared, service)).toBe(true);
        expect(reaches(declared, other)).toBe(true);
        const undeclared = underProfile({ proxyPort: portOf(proxy) });
        expect(reaches(undeclared, service)).toBe(false);
        expect(reaches(undeclared, other)).toBe(false);
      });

      it('reaches nothing on loopback when it was given no proxy port', () => {
        const run = underProfile();
        expect(reaches(run, proxy)).toBe(false);
        expect(reaches(run, service)).toBe(false);
      });
    });
  });

  describe("the Docker VM's share through a constructed seatbelt profile", () => {
    // Laid out as the app lays it out: the sandbox at
    // <data>/runner/sandbox/<id>, the share <sandbox>/_work with its nonce,
    // the VM sockets under <data>/vm/jobs. A directory outside <data> stands
    // in for ~/.npm, granted by the policy, and another for the bundle's
    // docker-cli. The name of <data> is short so the VM socket's path fits.
    let data: string;
    let outside: string;
    let sandbox: string;
    let share: string;
    let nonce: string;
    let npm: string;
    let cli: string;
    let helper: string;
    let otherBinary: string;
    let profilePath: string;

    beforeAll(() => {
      data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l')));
      outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-outside-')));
      sandbox = path.join(data, 'runner', 'sandbox', '1-abcdef012345');
      share = path.join(sandbox, '_work');
      nonce = path.join(share, '.localmost-share');
      npm = path.join(outside, 'npm');
      cli = path.join(outside, 'docker-cli', 'docker');
      fs.mkdirSync(path.join(share, 'repo', 'repo'), { recursive: true });
      fs.writeFileSync(path.join(share, 'repo', 'repo', 'README'), 'checkout');
      fs.mkdirSync(path.join(sandbox, '_temp'));
      fs.mkdirSync(path.join(sandbox, 'sibling'));
      fs.writeFileSync(nonce, 'a'.repeat(32), { mode: 0o600 });
      fs.mkdirSync(npm);
      fs.mkdirSync(path.dirname(cli));
      fs.writeFileSync(cli, '#!/bin/sh\necho cli-ran\n', { mode: 0o755 });
      fs.writeFileSync(path.join(path.dirname(cli), 'beside'), 'not the cli');
      // The helper, where the bundle keeps it beside docker-cli: a compiled
      // binary, since seatbelt execs a Mach-O it cannot read but a shell
      // cannot run a script it cannot read. echo, re-signed ad hoc, because a
      // copy of a system binary is held to the system volume by its launch
      // constraint. Another copy under a name the profile does not deny shows
      // that the refusal is the helper rule's, not the read deny's.
      helper = path.join(outside, 'localmost-vm');
      otherBinary = path.join(outside, 'not-the-helper');
      for (const binary of [helper, otherBinary]) {
        fs.copyFileSync('/bin/echo', binary);
        execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', binary], { stdio: 'ignore' });
      }
      const previous = process.env.LOCALMOST_CONFIG_DIR;
      process.env.LOCALMOST_CONFIG_DIR = data;
      try {
        profilePath = path.join(outside, 'runner.sb');
        fs.writeFileSync(profilePath, generateSandboxProfile({
          instanceDir: sandbox,
          shareDir: share,
          dockerCli: cli,
          vmHelper: helper,
          filesystemPolicy: { level: 'strict', read: [], write: [npm] },
        }));
      } finally {
        if (previous === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
        else process.env.LOCALMOST_CONFIG_DIR = previous;
      }
    });

    afterAll(() => {
      fs.rmSync(data, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });

    /** A shell command under the runner profile, from the sandbox, as the job runs. */
    const run = (command: string) => {
      const result = spawnSync('/usr/bin/sandbox-exec', ['-f', profilePath, '/bin/sh', '-c', command], {
        cwd: sandbox,
        encoding: 'utf-8',
        timeout: 15000,
        env: { PATH: '/usr/bin:/bin', HOME: homeDir, TMPDIR: path.join(sandbox, '_temp') },
      });
      return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr };
    };

    /** Refused by seatbelt, not by anything else. */
    const refused = (command: string): boolean => {
      const result = run(command);
      return !result.ok && result.stderr.includes('Operation not permitted');
    };

    /**
     * The share and the sandbox are where they were, as the directories they
     * were, with the nonce as the app wrote it. What else is in the share is
     * the job's: `rm -rf _work` empties it, and only the node survives.
     */
    const intact = (): void => {
      for (const dir of [sandbox, share]) {
        const stat = fs.lstatSync(dir);
        expect([dir, stat.isDirectory(), stat.isSymbolicLink(), stat.mode & 0o777]).toEqual([dir, true, false, 0o755]);
      }
      expect(fs.readFileSync(nonce, 'utf-8')).toBe('a'.repeat(32));
    };

    it('creates, writes and removes anything under _work, and mkdir -p of _work itself', () => {
      const result = run(
        'mkdir -p _work && mkdir -p _work/a && mkdir -p _work/x/y && echo hi > _work/x/y/f && ' +
          'rm -rf _work/x/y && rm -rf _work/a _work/x && echo hi > _work/repo/repo/out && rm _work/repo/repo/out && echo ok'
      );
      expect(result).toMatchObject({ ok: true, stdout: 'ok' });
      intact();
    });

    it('cannot rename, remove, chmod or relink _work', () => {
      // Refused for the operation, not its effect: the ambient form probes
      // this way. The same call on a directory inside the share works.
      expect(refused(sameModeCommand('_work'))).toBe(true);
      expect(run(sameModeCommand('_work/repo'))).toMatchObject({ ok: true, stderr: '' });
      expect(refused('mv _work _w2')).toBe(true);
      expect(refused('rm -rf _work')).toBe(true);
      expect(refused('chmod 000 _work')).toBe(true);
      expect(refused('touch _work')).toBe(true);
      // The link would share wherever it points, were the directory gone. A
      // decoy stands in for the home directory, so that a profile that let
      // this through would send the tests after it nowhere that matters.
      const decoy = path.join(outside, 'decoy-home');
      fs.mkdirSync(decoy, { recursive: true });
      run(`rm -rf _work; ln -s ${sq(decoy)} _work`);
      intact();
    });

    it('cannot rename _work or the sandbox by a case variant of its name', () => {
      expect(refused('mv _WORK _w2')).toBe(true);
      expect(refused(`mv ${sq(upperBase(sandbox))} ${sq(path.join(outside, 'moved'))}`)).toBe(true);
      expect(refused(`mv ../${sq(path.basename(sandbox).toUpperCase())} ../elsewhere`)).toBe(true);
      intact();
    });

    it('cannot swap _work with a sibling, or the sandbox with another directory, with RENAME_SWAP', () => {
      expect(refused(swapCommand('sibling', '_work'))).toBe(true);
      expect(refused(swapCommand('sibling', '_WORK'))).toBe(true);
      fs.mkdirSync(path.join(npm, 'decoy'), { recursive: true });
      expect(refused(swapCommand(path.join(npm, 'decoy'), sandbox))).toBe(true);
      expect(refused(swapCommand(path.join(npm, 'decoy'), upperBase(sandbox)))).toBe(true);
      intact();
    });

    it('cannot move its sandbox into a path its policy lets it write, to put a link in its place', () => {
      // The grant is real, so the refusal below is the node deny's.
      expect(run(`touch ${sq(path.join(npm, 'probe'))} && echo ok`).stdout).toBe('ok');
      expect(refused(`mv ${sq(sandbox)} ${sq(path.join(npm, 'x'))}`)).toBe(true);
      intact();
      expect(fs.existsSync(path.join(npm, 'x'))).toBe(false);
    });

    it("can neither read nor replace the share's nonce", () => {
      expect(refused('cat _work/.localmost-share')).toBe(true);
      expect(refused('echo forged > _work/.localmost-share')).toBe(true);
      expect(refused('rm -f _work/.localmost-share')).toBe(true);
      expect(refused('mv _work/.localmost-share _work/taken')).toBe(true);
      expect(refused('cp _work/.localmost-share _work/copy')).toBe(true);
      // A hard link or a clone would give it a name the read deny does not cover.
      expect(refused('ln _work/.localmost-share _work/linked')).toBe(true);
      expect(refused('ln _work/.localmost-share _temp/linked')).toBe(true);
      expect(refused('cp -c _work/.localmost-share _temp/cloned')).toBe(true);
      for (const name of ['_work/copy', '_work/linked', '_temp/linked', '_temp/cloned']) {
        expect([name, fs.existsSync(path.join(sandbox, name))]).toEqual([name, false]);
      }
      intact();
    });

    it('cannot clone _work, which would give the nonce a name the deny does not cover', () => {
      // clonefile(2) of a directory copies the whole tree beneath it without
      // asking about each file, so a clone of _work carried a readable copy
      // of the nonce into _temp.
      for (const byDescriptor of [false, true]) {
        const result = run(`${cloneCommand('_work', '_temp/w', byDescriptor)} && cat _temp/w/.localmost-share`);
        const cloned = fs.existsSync(path.join(sandbox, '_temp', 'w'));
        fs.rmSync(path.join(sandbox, '_temp', 'w'), { recursive: true, force: true });
        expect([byDescriptor, result.stdout, cloned]).toEqual([byDescriptor, '', false]);
        expect(result.ok).toBe(false);
        expect(result.stderr).toContain('Operation not permitted');
      }
      // A file in it still clones, so the refusal is the directory's. Its
      // own file: an earlier case empties the share with rm -rf _work.
      fs.writeFileSync(path.join(share, 'built.txt'), 'built');
      const file = run(`${cloneCommand('_work/built.txt', '_temp/built.txt')} && cat _temp/built.txt`);
      fs.rmSync(path.join(sandbox, '_temp', 'built.txt'), { force: true });
      fs.rmSync(path.join(share, 'built.txt'));
      expect(file).toMatchObject({ ok: true, stdout: 'built' });
      intact();
    });

    it('lists, stats and walks _work with the nonce in it, which only hides its contents', () => {
      // Every job has the nonce, Docker or not, so a metadata deny would make
      // ls -la, find and du of _work fail in all of them.
      expect(run('ls -la@ _work >/dev/null && find _work >/dev/null && du -s _work >/dev/null && echo ok')).toMatchObject({ ok: true, stdout: 'ok', stderr: '' });
      expect(run('stat -f %z _work/.localmost-share')).toMatchObject({ ok: true, stdout: '32' });
      expect(run('test -f _work/.localmost-share && echo present')).toMatchObject({ ok: true, stdout: 'present' });
      expect(refused('cat _work/.localmost-share')).toBe(true);
      intact();
    });

    it('runs the bundled docker CLI, and reads nothing else beside it', () => {
      expect(run(sq(cli)).stdout).toBe('cli-ran');
      expect(refused(`cat ${sq(path.join(path.dirname(cli), 'beside'))}`)).toBe(true);
    });

    it('cannot run the Docker VM helper, by its path, a case variant, a link or a copy', () => {
      // A binary it cannot read still runs: the refusals below are the helper rule's.
      expect(refused(`cat ${sq(otherBinary)}`)).toBe(true);
      expect(run(`${sq(otherBinary)} ran`)).toMatchObject({ ok: true, stdout: 'ran' });
      expect(refused(`${sq(helper)} version`)).toBe(true);
      expect(refused(`${sq(upperBase(helper))} version`)).toBe(true);
      expect(refused(`ln -s ${sq(helper)} _temp/vm && _temp/vm version`)).toBe(true);
      expect(refused(`ln ${sq(helper)} _temp/vm-hard`)).toBe(true);
      expect(refused(`cp ${sq(helper)} _temp/vm-copy`)).toBe(true);
      expect(fs.existsSync(path.join(sandbox, '_temp', 'vm-hard'))).toBe(false);
      expect(fs.existsSync(path.join(sandbox, '_temp', 'vm-copy'))).toBe(false);
    });

    it('cannot connect to a unix socket under <data>/vm/jobs, and can to one in its own sandbox', async () => {
      const vmSocket = path.join(data, 'vm', 'jobs', '1-0123456789ab', 'docker.sock');
      // At the sandbox's top, so its path stays inside the 104 bytes a unix
      // socket's may have.
      const ownSocket = path.join(sandbox, 's.sock');
      fs.mkdirSync(path.dirname(vmSocket), { recursive: true });
      const accepted = new Map<string, number>();
      const listening = await serveSockets([vmSocket, ownSocket], accepted);
      try {
        const connect = (socketPath: string) => connectUnder(profilePath, socketPath, sandbox);
        const toVm = await connect(vmSocket);
        expect(toVm.code).not.toBe(0);
        expect(toVm.stdout).toBe('');
        expect(accepted.get(vmSocket)).toBeUndefined();
        // The same client, the same kind of socket, in the job's own sandbox.
        expect((await connect(ownSocket)).stdout).toBe('hello\n');
        expect(accepted.get(ownSocket)).toBe(1);
      } finally {
        await closeServers(listening);
      }
    });
  });

  describe("the operator's own Docker through a constructed seatbelt profile", () => {
    // Docker Desktop, where the operator still runs it: its socket at
    // ~/.docker/run/docker.sock, linked from /var/run/docker.sock, and the
    // registry credentials in ~/.docker/config.json. No job uses either. A
    // job that connected to the socket would bypass the filter in full, and
    // one that read config.json would hold the credentials that pulls made on
    // the Mac keep from it (S6). A stand-in home holds a listening socket and
    // a config.json of its own, and a link to the socket stands in for
    // /var/run/docker.sock. Its name is short so the socket's path fits.
    let root: string;
    let home: string;
    let sandbox: string;
    let desktopSocket: string;
    let desktopLink: string;
    let config: string;
    let served: string;
    let servers: net.Server[] = [];
    const accepted = new Map<string, number>();

    beforeAll(async () => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h')));
      home = path.join(root, 'u');
      sandbox = path.join(root, 's');
      desktopSocket = path.join(home, '.docker', 'run', 'docker.sock');
      desktopLink = path.join(root, 'docker.sock');
      config = path.join(home, '.docker', 'config.json');
      // Where the runner serves a worker its filtering socket: its sandbox.
      served = path.join(sandbox, 'docker.sock');
      fs.mkdirSync(path.dirname(desktopSocket), { recursive: true });
      fs.mkdirSync(path.join(sandbox, '_temp'), { recursive: true });
      fs.mkdirSync(path.join(sandbox, '_work'));
      fs.writeFileSync(config, '{"auths":{"https://index.docker.io/v1/":{"auth":"SECRET-docker"}}}');
      fs.symlinkSync(desktopSocket, desktopLink);
      servers = await serveSockets([desktopSocket, served], accepted);
    });

    afterAll(async () => {
      await closeServers(servers);
      fs.rmSync(root, { recursive: true, force: true });
    });

    /** Write the runner profile built from `options`, the stand-in its home, and return its path. */
    const profileFor = (options: Omit<RunnerProfileOptions, 'instanceDir'>): string => {
      jest.mocked(os.homedir).mockReturnValue(home);
      let profile: string;
      try {
        profile = generateSandboxProfile({ instanceDir: sandbox, ...options });
      } finally {
        jest.mocked(os.homedir).mockImplementation(realHomedir);
      }
      const profilePath = path.join(root, `${probeName()}.sb`);
      fs.writeFileSync(profilePath, profile);
      return profilePath;
    };

    // A worker given no docker at all, and what every worker is given now,
    // whatever its docker policy: its filtering socket and the VM's share.
    // The second policy also reads and writes the whole home directory, the
    // widest grant a policy can make, so what stays closed is the floor's.
    const profiles: Array<[string, () => string]> = [
      ['given nothing', () => profileFor({})],
      [
        'given its docker socket, its share and the whole home directory',
        () =>
          profileFor({
            dockerSocket: served,
            shareDir: path.join(sandbox, '_work'),
            filesystemPolicy: { level: 'strict', read: ['~'], write: ['~'] },
          }),
      ],
    ];

    it.each(profiles)(
      "reaches a socket in its own sandbox, and neither Docker's socket nor the link to it, %s",
      async (_name, build) => {
        const profilePath = build();
        accepted.clear();
        // The same client, the same kind of socket, in the job's own sandbox:
        // what makes each refusal below the profile's.
        expect((await connectUnder(profilePath, served, sandbox)).stdout).toBe('hello\n');
        expect(accepted.get(served)).toBe(1);
        for (const socketPath of [desktopSocket, desktopLink]) {
          const result = await connectUnder(profilePath, socketPath, sandbox);
          expect([socketPath, result.code === 0, result.stdout]).toEqual([socketPath, false, '']);
        }
        expect(accepted.get(desktopSocket)).toBeUndefined();
      }
    );

    it.each(profiles)('can neither read ~/.docker/config.json nor give it another name, %s', (_name, build) => {
      const env = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: path.join(sandbox, '_temp') };
      const run = (command: string) => shell(command, build(), env);
      const result = run(`/bin/cat ${sq(config)}`);
      expect(result.stdout).not.toContain('SECRET');
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('Operation not permitted');
      // A copy or a move would give it a name the deny does not cover.
      for (const verb of ['/bin/cp', '/bin/mv', '/bin/ln']) {
        const renamed = path.join(sandbox, '_temp', 'config.json');
        const moved = run(`${verb} ${sq(config)} ${sq(renamed)}`);
        const planted = fs.existsSync(renamed);
        fs.rmSync(renamed, { force: true });
        expect([verb, moved.ok, planted]).toEqual([verb, false, false]);
      }
      expect(fs.readFileSync(config, 'utf-8')).toContain('SECRET-docker');
    });
  });

  describe("a job's own home through a constructed seatbelt profile", () => {
    // A stand-in for the user's home, holding what a developer's does: a
    // regular ~/.gitconfig, a ~/.yarnrc.yml, credentials, and a cache a
    // policy grants. The job's home is in its sandbox, filled as the runner
    // fills it.
    let root: string;
    let home: string;
    let sandbox: string;
    let jobHome: string;

    beforeAll(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h')));
      home = path.join(root, 'u');
      sandbox = path.join(root, 's');
      jobHome = path.join(sandbox, 'home');
      fs.mkdirSync(path.join(sandbox, '_temp'), { recursive: true });
      fs.mkdirSync(jobHome, { mode: 0o700 });
      for (const [rel, content] of [
        ['.gitconfig', '[url "https://x-access-token:SECRET-git@github.com/"]\n\tinsteadOf = https://github.com/\n'],
        ['.yarnrc.yml', 'npmAuthToken: SECRET-yarn\n'],
        ['.aws/credentials', '[default]\naws_secret_access_key = SECRET-aws\n'],
        ['.granted/file', 'granted\n'],
        ['.cache/huggingface/token', 'SECRET-hf\n'],
        ['.cache/huggingface/hub/model', 'weights\n'],
        ['.cache/pip/wheel', 'wheel\n'],
        ['.gradle/gradle.properties', 'signing.password=SECRET-gradle\n'],
        ['.gradle/caches/jar', 'jar\n'],
      ] as const) {
        fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
        fs.writeFileSync(path.join(home, rel), content);
      }
      prepareJobHome(jobHome, { grants: ['~/.granted', '~/.aws', '~/.yarnrc.yml', '~/.cache', '~/.gradle'], realHome: home });
    });

    afterAll(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    /** A runner for shell commands under the profile, as a job with HOME its own. */
    const underProfile = (filesystemPolicy: SandboxFilesystemPolicy) => {
      jest.mocked(os.homedir).mockReturnValue(home);
      let profile: string;
      try {
        profile = generateSandboxProfile({ instanceDir: sandbox, filesystemPolicy });
      } finally {
        jest.mocked(os.homedir).mockImplementation(realHomedir);
      }
      const profilePath = path.join(root, `${probeName()}.sb`);
      fs.writeFileSync(profilePath, profile);
      const env = { PATH: '/usr/bin:/bin', HOME: jobHome, TMPDIR: path.join(sandbox, '_temp') };
      return (command: string) => shell(command, profilePath, env);
    };

    it("copies $HOME/.gitconfig, as actions/checkout does, where the user's own regular file broke it", () => {
      const run = underProfile({ level: 'strict', read: [], write: [] });
      const copy = path.join(sandbox, '_temp', 'gitconfig');
      // The old failure, for contrast: the user's own, which the floor denies.
      const real = run(`/bin/cp ${sq(path.join(home, '.gitconfig'))} ${sq(copy)}`);
      expect([real.ok, real.stderr]).toEqual([false, expect.stringContaining('Operation not permitted')]);

      const result = run(`/bin/cp "$HOME/.gitconfig" ${sq(copy)}`);
      expect(result).toMatchObject({ ok: true });
      expect(fs.readFileSync(copy, 'utf-8')).toBe(JOB_GIT_CONFIG);
      fs.rmSync(copy);
    });

    it('does not find ~/.yarnrc.yml through HOME, which Yarn 2+ found and failed to parse, granted or not', () => {
      const run = underProfile({ level: 'moderate', read: ['~/.yarnrc.yml'], write: [] });
      expect(run(`/bin/test -e "$HOME/.yarnrc.yml"`).ok).toBe(false);
      // Still there to be seen by its real path, and still not readable.
      expect(run(`/bin/test -e ${sq(path.join(home, '.yarnrc.yml'))}`).ok).toBe(true);
      expect(run(`/bin/cat ${sq(path.join(home, '.yarnrc.yml'))}`).stdout).not.toContain('SECRET');
    });

    it('reaches a granted path through the link in its home, and nothing the floor denies through one', () => {
      const run = underProfile({ level: 'strict', read: ['~/.granted', '~/.aws'], write: [] });
      expect(fs.lstatSync(path.join(jobHome, '.granted')).isSymbolicLink()).toBe(true);
      expect(run('/bin/cat "$HOME/.granted/file"')).toMatchObject({ ok: true, stdout: 'granted' });
      // Not linked, though the policy names it: found through HOME, it
      // failed as the real path does.
      expect(run('/bin/test -e "$HOME/.aws"').ok).toBe(false);
      const credentials = run(`/bin/cat ${sq(path.join(home, '.aws', 'credentials'))}`);
      expect(credentials.stdout).not.toContain('SECRET');
      expect([credentials.ok, credentials.stderr]).toEqual([false, expect.stringContaining('Operation not permitted')]);
    });

    it('finds no floor-denied credential through a granted directory, where Hugging Face and Gradle died on EPERM', () => {
      // Linked whole, ~/.cache led huggingface_hub to its token and ~/.gradle
      // the Gradle wrapper to gradle.properties, each denied: both crashed
      // under the grant meant to help (L4, L5). The rest of each is there.
      const run = underProfile({ level: 'strict', read: ['~/.cache', '~/.gradle'], write: [] });
      expect(run('/bin/test -e "$HOME/.cache/huggingface/token"').ok).toBe(false);
      expect(run('/bin/test -e "$HOME/.gradle/gradle.properties"').ok).toBe(false);
      expect(run('/bin/cat "$HOME/.cache/huggingface/hub/model"')).toMatchObject({ ok: true, stdout: 'weights' });
      expect(run('/bin/cat "$HOME/.cache/pip/wheel"')).toMatchObject({ ok: true, stdout: 'wheel' });
      expect(run('/bin/cat "$HOME/.gradle/caches/jar"')).toMatchObject({ ok: true, stdout: 'jar' });
      // The real paths stay denied.
      for (const rel of ['.cache/huggingface/token', '.gradle/gradle.properties']) {
        const result = run(`/bin/cat ${sq(path.join(home, rel))}`);
        expect([rel, result.ok, result.stdout]).toEqual([rel, false, '']);
      }
    });

    it('writes its own home', () => {
      const run = underProfile({ level: 'strict', read: [], write: [] });
      expect(canCreate(run, path.join(jobHome, '.npmrc'))).toBe(true);
      expect(canCreateUnder(run, path.join(jobHome, 'Library', 'Caches'))).toBe(true);
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

    it("refuses writes to the app's own data directory", () => {
      // Found from where the job runs, <app dir>/runner/sandbox/<n>/_temp, so
      // the directory is certainly there and a refusal is the sandbox's EPERM,
      // not a missing parent's ENOENT.
      const sandboxDir = path.dirname(fs.realpathSync(os.tmpdir()));
      expect(path.basename(path.dirname(sandboxDir))).toBe('sandbox');
      expect(path.basename(path.dirname(path.dirname(sandboxDir)))).toBe('runner');
      const appDir = path.dirname(path.dirname(path.dirname(sandboxDir)));
      const target = path.join(appDir, probeName());
      const result = run(`/usr/bin/touch '${target}'`);
      fs.rmSync(target, { force: true });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('Operation not permitted');
    });

    it("refuses reads in the app's own data directory outside the job's own sandbox", () => {
      // The runner template every worker is copied from, which is certainly
      // there while a job runs; listing it is a read of the directory itself.
      const sandboxDir = path.dirname(fs.realpathSync(os.tmpdir()));
      const runnerDir = path.dirname(path.dirname(sandboxDir));
      expect(path.basename(runnerDir)).toBe('runner');
      expect(fs.existsSync(path.join(runnerDir, 'arc'))).toBe(true);
      const result = run(`/bin/ls '${path.join(runnerDir, 'arc')}'`);
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('Operation not permitted');
    });

    it("runs with a home of its own, whose .gitconfig is the hermetic one checkout can copy", () => {
      // HOME is <sandbox>/home, beside this job's TMPDIR, <sandbox>/_temp.
      const sandboxDir = path.dirname(fs.realpathSync(os.tmpdir()));
      expect(fs.realpathSync(process.env.HOME ?? '')).toBe(path.join(sandboxDir, 'home'));
      const copy = path.join(os.tmpdir(), probeName());
      try {
        expect(run(`/bin/cp "$HOME/.gitconfig" ${sq(copy)}`).ok).toBe(true);
        expect(fs.readFileSync(copy, 'utf-8')).toBe(JOB_GIT_CONFIG);
      } finally {
        fs.rmSync(copy, { force: true });
      }
    });

    it('signals its own children', () => {
      expect(run('/bin/sleep 60 & C=$!; /bin/kill -0 $C && /bin/kill -TERM $C').ok).toBe(true);
    });

    it('reaches a listener it starts on loopback, which this repository declares', async () => {
      // This repository's policy declares all of loopback: its test suites
      // bind ephemeral 127.0.0.1 ports and talk to themselves.
      const server = net.createServer((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = server.address() as net.AddressInfo;
        expect(run(`/usr/bin/nc -z -G 2 127.0.0.1 ${port}`).ok).toBe(true);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("reads the global domain and the build domains, and no other app's preferences", () => {
      expect(defaults(['read', '-g', 'AppleLocale']).ok).toBe(true);
      expect(preferenceAllowed('user-preference-read', 'kCFPreferencesAnyApplication')).toBe(true);
      expect(preferenceAllowed('user-preference-read', 'com.apple.dt.Xcode')).toBe(true);
      expect(preferenceAllowed('user-preference-read', 'com.apple.finder')).toBe(false);
      // Finder's own plist is there - metadata stays readable - so the
      // refusal is the sandbox's, not a domain that does not exist.
      const finder = path.join(os.userInfo().homedir, 'Library', 'Preferences', 'com.apple.finder.plist');
      expect(fs.statSync(finder).size).toBeGreaterThan(0);
      expect(defaults(['read', 'com.apple.finder']).ok).toBe(false);
    });

    it("writes no preference domain, Xcode's included", () => {
      expect(preferenceAllowed('user-preference-write', 'com.apple.dt.Xcode')).toBe(false);
      const domain = throwawayDomain();
      const written = defaults(['write', domain, 'job', '-string', 'JOB']);
      if (written.ok) removeThrowawayDomain(domain);
      expect(written.ok).toBe(false);
    });
  });

  describe("the Docker VM's share through the ambient seatbelt profile", () => {
    // This job's own sandbox, share and nonce, found from its TMPDIR,
    // <data>/runner/sandbox/<id>/_temp. The job is running in the share, and
    // the first runs of these tests are under an installed app whose profile
    // may allow what they probe, so nothing here may move or empty the share
    // if the profile let it: each refusal is probed by something that
    // changes nothing when allowed (a swap of a name with itself, the node's
    // times, a chmod to the mode it has, rmdir of a directory that is not
    // empty). The constructed tests do the real moves and removals on a
    // sandbox of their own.
    const sandbox = path.dirname(fs.realpathSync(os.tmpdir()));
    const share = path.join(sandbox, '_work');
    const nonce = path.join(share, '.localmost-share');
    const data = path.dirname(path.dirname(path.dirname(sandbox)));

    /** Refused by seatbelt, not by anything else. */
    const refused = (command: string): boolean => {
      const result = shell(command);
      return !result.ok && result.stderr.includes('Operation not permitted');
    };

    it('runs where the app lays a job out, with the share and its nonce in place', () => {
      expect(path.basename(path.dirname(sandbox))).toBe('sandbox');
      expect(fs.lstatSync(share).isDirectory()).toBe(true);
      // Metadata is readable, the contents are not.
      expect(fs.existsSync(nonce)).toBe(true);
    });

    it('creates, writes and removes anything under _work, and mkdir -p of _work itself', () => {
      const probe = path.join(share, `.${probeName()}`);
      const result = shell(
        `mkdir -p ${sq(share)} && mkdir -p ${sq(path.join(probe, 'a'))} && mkdir -p ${sq(path.join(probe, 'x', 'y'))} && ` +
          `echo hi > ${sq(path.join(probe, 'x', 'y', 'f'))} && rm -rf ${sq(path.join(probe, 'x', 'y'))} && rm -rf ${sq(probe)} && echo ok`
      );
      fs.rmSync(probe, { recursive: true, force: true });
      expect(result).toMatchObject({ ok: true, stdout: 'ok' });
    });

    it('cannot rename, remove, chmod or relink _work', () => {
      // The probes work on a directory of the job's own, so each refusal
      // below is the node deny's.
      const own = path.join(sandbox, '_temp');
      expect(shell(swapCommand(own, own))).toMatchObject({ ok: true, stderr: '' });
      expect(shell(sameModeCommand(own))).toMatchObject({ ok: true, stderr: '' });
      expect(refused(swapCommand(share, share))).toBe(true);
      expect(refused(sameModeCommand(share))).toBe(true);
      expect(refused(`touch ${sq(share)}`)).toBe(true);
      // Not empty, so an rmdir the profile allowed would fail otherwise; a
      // job that cannot remove the node cannot put a link in its place.
      expect(refused(`rmdir ${sq(share)}`)).toBe(true);
    });

    it('cannot rename _work or the sandbox by a case variant of its name', () => {
      expect(refused(swapCommand(upperBase(share), upperBase(share)))).toBe(true);
      expect(refused(swapCommand(upperBase(sandbox), upperBase(sandbox)))).toBe(true);
      expect(refused(`touch ${sq(upperBase(share))}`)).toBe(true);
      expect(refused(`touch ${sq(upperBase(sandbox))}`)).toBe(true);
    });

    it('cannot swap the sandbox, or rename or remove it', () => {
      // By a swap with itself: a real move of either node could not be put
      // back safely, since the job runs in the share.
      expect(refused(swapCommand(sandbox, sandbox))).toBe(true);
      expect(refused(`touch ${sq(sandbox)}`)).toBe(true);
      expect(refused(`rmdir ${sq(sandbox)}`)).toBe(true);
    });

    it('lists, stats and walks _work with the nonce in it, which only hides its contents', () => {
      expect(shell(`ls -la ${sq(share)} >/dev/null && find ${sq(share)} -maxdepth 1 >/dev/null && echo ok`)).toMatchObject({ ok: true, stdout: 'ok' });
      expect(fs.statSync(nonce).isFile()).toBe(true);
    });

    it("can neither read nor replace the share's nonce, nor give it another name", () => {
      expect(refused(`cat ${sq(nonce)}`)).toBe(true);
      expect(refused(`touch ${sq(nonce)}`)).toBe(true);
      const names = [
        path.join(sandbox, '_temp', probeName()),
        path.join(sandbox, '_temp', probeName()),
        path.join(share, `.${probeName()}`),
        path.join(sandbox, '_temp', probeName()),
      ];
      try {
        expect(refused(`cp ${sq(nonce)} ${sq(names[0])}`)).toBe(true);
        expect(refused(`ln ${sq(nonce)} ${sq(names[1])}`)).toBe(true);
        expect(refused(`ln ${sq(nonce)} ${sq(names[2])}`)).toBe(true);
        expect(refused(`cp -c ${sq(nonce)} ${sq(names[3])}`)).toBe(true);
      } finally {
        for (const name of names) fs.rmSync(name, { force: true });
      }
    });

    it('runs the bundled docker CLI, ahead of any other on its PATH, and reads nothing else of the app bundle', () => {
      // Not necessarily first: npm and jest, which run this, put
      // node_modules/.bin in front. No other docker may come before it.
      const { bundledDir, resolved } = dockerOnPath(process.env.PATH ?? '');
      expect(bundledDir).toBeDefined();
      const cliDir = bundledDir!;
      expect(resolved).toBe(path.join(cliDir, 'docker'));
      expect(shell('command -v docker').stdout).toBe(path.join(cliDir, 'docker'));
      expect(shell('docker --version').stdout).toMatch(/^Docker version /);
      expect(refused(`ls ${sq(path.dirname(cliDir))}`)).toBe(true);
    });

    it("cannot connect to a unix socket in the app's data directory, where the VM sockets live", () => {
      // The app's own CLI socket, which is listening while the app runs this
      // job; <data>/vm/jobs is under the same deny, and this job cannot list
      // it to find one of its sockets.
      const cliSocket = path.join(data, 'localmost.sock');
      expect(fs.existsSync(cliSocket)).toBe(true);
      const result = shell(`/usr/bin/nc -U ${sq(cliSocket)} < /dev/null`);
      expect(result.ok).toBe(false);
      expect(refused(`ls ${sq(path.join(data, 'vm'))}`) || !fs.existsSync(path.join(data, 'vm'))).toBe(true);
    });
  });

  describe("the operator's own Docker through the ambient seatbelt profile", () => {
    // The real paths, on the machine this job runs on: Docker Desktop's
    // socket and the link to it, and its registry credentials. Whether they
    // are there or not, this job must reach none of them; the socket the
    // runner serves it is the positive case that gives that meaning.
    const dockerHost = process.env.DOCKER_HOST;
    const servedSocket = dockerHost?.startsWith('unix://') ? dockerHost.slice('unix://'.length) : undefined;
    const desktopSockets = ['/var/run/docker.sock', path.join(homeDir, '.docker', 'run', 'docker.sock')];

    /**
     * What a connect from this process, under the job's profile, comes to:
     * 'connected', or the error's code. Any listener counts, so a bypass
     * shows whatever serves the socket.
     */
    const connectFromHere = (socketPath: string) =>
      new Promise<string>((resolve) => {
        const socket = net.connect(socketPath);
        socket.once('connect', () => {
          socket.destroy();
          resolve('connected');
        });
        socket.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
      });

    it("is pointed at the socket the runner serves it, not Docker's own", () => {
      expect(servedSocket).toBeDefined();
      expect(desktopSockets).not.toContain(servedSocket);
    });

    it("connects to the served socket, and to neither of Docker's own", async () => {
      expect(await connectFromHere(servedSocket ?? '')).toBe('connected');
      for (const socketPath of desktopSockets) {
        expect([socketPath, await connectFromHere(socketPath)]).not.toEqual([socketPath, 'connected']);
      }
    });

    it('cannot read ~/.docker/config.json', () => {
      const result = shell(`/bin/cat ${sq(path.join(homeDir, '.docker', 'config.json'))}`);
      expect(result.ok).toBe(false);
      expect(result.stdout).toBe('');
    });
  });
}
