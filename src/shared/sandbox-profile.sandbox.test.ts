/**
 * Integration coverage for the `localmost test` profiles at the seatbelt layer.
 *
 * The unit tests assert which rules a profile contains. They cannot show what
 * those rules let a process do: `(allow network-outbound (local ip))` reads
 * like "loopback only" and matches a connection to anywhere. So the profiles
 * are applied with sandbox-exec and a real process tries what a step would.
 *
 * As in docker-access.sandbox.test.ts, which mode applies depends on whether
 * this process is already inside a sandbox:
 *
 *   constructed  On an unsandboxed machine, build a profile and apply it with
 *                sandbox-exec. Each refusal is paired with an allowed case, so
 *                the refusal is specific rather than a profile that runs
 *                nothing.
 *
 *   ambient      Inside a localmost job, seatbelt refuses any nested profile
 *                that deviates from the one in force, so constructing one is
 *                impossible. What can still be shown is that the profile this
 *                process runs under refuses the same connection, and that
 *                the generated profiles carry the rules in question. The
 *                generated profiles are not applied in this mode: CI inside
 *                a job covers them only structurally, and the constructed
 *                mode has to run on a machine outside one.
 *
 * Neither mode skips. macOS only, because seatbelt is.
 */

import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { ChildProcess, execFile, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  generateSandboxProfile,
  generateDiscoveryProfile,
  MACOS_BASELINE_READ_PATHS,
  SandboxProfileOptions,
} from './sandbox-profile';
import { getWorkspacesDir, removeWorkspace } from './workspace';

// The real home by default; one block below stands a scratch directory in for
// it, since os.homedir() is what the profiles are built from.
jest.mock('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os');
  return { ...actual, homedir: jest.fn(actual.homedir) };
});
const realHomedir = jest.requireActual<typeof import('os')>('os').homedir;

const isMacOS = process.platform === 'darwin';
const execFileAsync = promisify(execFile);

/**
 * An address no machine answers on (TEST-NET-1, RFC 5737). Unsandboxed, a
 * connect to it times out or is unreachable; only the sandbox refuses it with
 * EPERM, which is what makes the error text a finding about the profile.
 */
const OFF_BOX = '192.0.2.1';

/** Connect with nc and report how it ended: its exit status and what it said. */
const tryConnect = async (
  profile: string | null,
  host: string,
  port: number
): Promise<{ ok: boolean; output: string }> => {
  const nc = ['/usr/bin/nc', '-v', '-z', '-G', '2', '-w', '2', host, String(port)];
  let command = nc;
  let profileDir: string | undefined;
  if (profile !== null) {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-net-'));
    const profilePath = path.join(profileDir, 'profile.sb');
    fs.writeFileSync(profilePath, profile);
    command = ['/usr/bin/sandbox-exec', '-f', profilePath, ...nc];
  }
  try {
    const { stdout, stderr } = await execFileAsync(command[0], command.slice(1), { timeout: 15000 });
    return { ok: true, output: stdout + stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}` };
  } finally {
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  }
};

const readable = { filesystem: { read: MACOS_BASELINE_READ_PATHS } };

const canConstruct = (): boolean => {
  if (!isMacOS) return false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-probe-'));
  const probePath = path.join(dir, 'probe.sb');
  fs.writeFileSync(
    probePath,
    generateSandboxProfile({ workDir: fs.realpathSync(dir), proxyPort: 1, policy: readable })
  );
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-f', probePath, '/usr/bin/true'], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

if (!isMacOS) {
  describe('test-mode profiles through seatbelt', () => {
    it('has nothing to assert off macOS, where seatbelt does not exist', () => {
      expect(process.platform).not.toBe('darwin');
    });
  });
} else if (canConstruct()) {
  describe('test-mode network confinement through a constructed profile', () => {
    // Stands in for the proxy: the one loopback port a step must reach.
    let proxy: net.Server;
    let proxyPort: number;
    let workDir: string;

    beforeAll(async () => {
      workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-net-work-')));
      proxy = net.createServer((socket) => socket.end());
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      proxyPort = (proxy.address() as net.AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      fs.rmSync(workDir, { recursive: true, force: true });
    });

    const profiles = (): [string, string][] => {
      const options: SandboxProfileOptions = { workDir, proxyPort, policy: readable };
      return [
        ['enforcement', generateSandboxProfile(options)],
        ['discovery', generateDiscoveryProfile({ workDir, proxyPort, logFile: '' })],
      ];
    };

    it('reaches the proxy on loopback, so the refusal below is specific', async () => {
      for (const [, profile] of profiles()) {
        expect(await tryConnect(profile, '127.0.0.1', proxyPort)).toMatchObject({ ok: true });
      }
    });

    it('refuses a direct connection off the machine', async () => {
      // Unsandboxed the same connect is attempted and fails on the route; the
      // sandbox has to refuse it before it leaves.
      expect((await tryConnect(null, OFF_BOX, 9)).output).not.toContain('Operation not permitted');
      for (const [mode, profile] of profiles()) {
        const result = await tryConnect(profile, OFF_BOX, 9);
        expect({ mode, ok: result.ok }).toEqual({ mode, ok: false });
        expect(result.output).toContain('Operation not permitted');
      }
    });

    describe('a service of the user\'s on loopback', () => {
      // Two listeners standing in for what a developer machine runs on
      // loopback: a database, a debugger port.
      let services: net.Server[];
      let ports: number[];

      beforeAll(async () => {
        services = [net.createServer((socket) => socket.end()), net.createServer((socket) => socket.end())];
        await Promise.all(services.map((s) => new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))));
        ports = services.map((s) => (s.address() as net.AddressInfo).port);
      });

      afterAll(async () => {
        await Promise.all(services.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
      });

      const enforcing = (loopback?: true | number[]) =>
        generateSandboxProfile({ workDir, proxyPort, policy: readable, loopback });

      it('is refused to a step unless the checkout was granted it', async () => {
        expect(await tryConnect(null, '127.0.0.1', ports[0])).toMatchObject({ ok: true });
        const refused = await tryConnect(enforcing(), '127.0.0.1', ports[0]);
        expect(refused.ok).toBe(false);
        expect(refused.output).toContain('Operation not permitted');
        // The proxy, on the same interface, is still reached.
        expect(await tryConnect(enforcing(), '127.0.0.1', proxyPort)).toMatchObject({ ok: true });
      });

      it('is reached on exactly the ports granted, or all of them under true', async () => {
        const one = enforcing([ports[0]]);
        expect(await tryConnect(one, '127.0.0.1', ports[0])).toMatchObject({ ok: true });
        const other = await tryConnect(one, '127.0.0.1', ports[1]);
        expect(other.ok).toBe(false);
        expect(other.output).toContain('Operation not permitted');
        for (const port of ports) {
          expect(await tryConnect(enforcing(true), '127.0.0.1', port)).toMatchObject({ ok: true });
        }
      });

      it('is reached under discovery, which observes the whole workflow', async () => {
        const discovery = generateDiscoveryProfile({ workDir, proxyPort, logFile: '' });
        expect(await tryConnect(discovery, '127.0.0.1', ports[1])).toMatchObject({ ok: true });
      });
    });
  });

  describe('test-mode signals through a constructed profile', () => {
    // A process of the user's that no step started; only processes this test
    // spawns are ever signalled.
    let outsider: ChildProcess;
    let workDir: string;

    beforeAll(() => {
      workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-signal-')));
      outsider = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    });

    afterAll(() => {
      outsider.kill('SIGKILL');
      fs.rmSync(workDir, { recursive: true, force: true });
    });

    const run = async (profile: string, argv: string[]): Promise<{ ok: boolean; output: string }> => {
      const profilePath = path.join(workDir, `signal-${Date.now()}.sb`);
      fs.writeFileSync(profilePath, profile);
      try {
        const { stdout, stderr } = await execFileAsync('/usr/bin/sandbox-exec', ['-f', profilePath, ...argv], {
          timeout: 15000,
        });
        return { ok: true, output: stdout + stderr };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message: string };
        return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}` };
      } finally {
        fs.rmSync(profilePath, { force: true });
      }
    };

    const profiles = (): [string, string][] => [
      ['enforcement', generateSandboxProfile({ workDir, proxyPort: 1, policy: readable })],
      ['discovery', generateDiscoveryProfile({ workDir, proxyPort: 1, logFile: '' })],
    ];

    it('signals what the step itself started, so the refusal below is specific', async () => {
      for (const [mode, profile] of profiles()) {
        const result = await run(profile, ['/bin/sh', '-c', '/bin/sleep 30 & p=$!; /bin/kill -TERM "$p" && wait "$p"; [ $? -eq 143 ]']);
        expect({ mode, ...result }).toMatchObject({ mode, ok: true });
      }
    });

    it('cannot signal a process of the user\'s that it did not start', async () => {
      // Unsandboxed the same probe succeeds; the profile has to refuse it.
      expect((await execFileAsync('/bin/kill', ['-0', String(outsider.pid)])).stderr).toBe('');
      for (const [mode, profile] of profiles()) {
        const result = await run(profile, ['/bin/kill', '-0', String(outsider.pid)]);
        expect({ mode, ok: result.ok }).toEqual({ mode, ok: false });
        expect(result.output).toContain('Operation not permitted');
      }
      expect(outsider.exitCode).toBeNull();
    });
  });

  describe('test-mode app data confinement through a constructed profile', () => {
    // A stand-in app data directory, laid out as the real one is, with this
    // run's workspace inside it the way createWorkspace puts it there.
    let appDir: string;
    let workDir: string;
    const savedConfigDir = process.env.LOCALMOST_CONFIG_DIR;

    beforeAll(() => {
      appDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-appdata-')));
      process.env.LOCALMOST_CONFIG_DIR = appDir;
      workDir = path.join(appDir, 'workspaces', 'ws-1');
      fs.mkdirSync(workDir, { recursive: true });
      fs.mkdirSync(path.join(appDir, 'runner', 'arc'), { recursive: true });
      fs.mkdirSync(path.join(appDir, 'policies'));
      fs.writeFileSync(path.join(appDir, 'config.yaml'), 'secret: yes\n');
    });

    afterAll(() => {
      if (savedConfigDir === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
      else process.env.LOCALMOST_CONFIG_DIR = savedConfigDir;
      fs.rmSync(appDir, { recursive: true, force: true });
    });

    const run = (profile: string, argv: string[]): boolean => {
      const profilePath = path.join(os.tmpdir(), `localmost-appdata-${process.pid}-${Date.now()}.sb`);
      fs.writeFileSync(profilePath, profile);
      try {
        execFileSync('/usr/bin/sandbox-exec', ['-f', profilePath, ...argv], { timeout: 5000, stdio: 'ignore' });
        return true;
      } catch {
        return false;
      } finally {
        fs.unlinkSync(profilePath);
      }
    };

    it('writes the workspace but not the runner template, approvals or settings, whatever the policy says', () => {
      // A checkout's own .localmostrc is applied in test mode without approval,
      // so it may declare the app data directory writable. That must not reach
      // the runner template every worker is copied from, or the approvals.
      const profile = generateSandboxProfile({
        workDir,
        proxyPort: 1,
        policy: {
          filesystem: {
            read: [...MACOS_BASELINE_READ_PATHS, appDir],
            write: [appDir, path.join(appDir, 'runner')],
          },
        },
      });

      expect(run(profile, ['/usr/bin/touch', path.join(workDir, 'built')])).toBe(true);
      expect(run(profile, ['/usr/bin/touch', path.join(appDir, 'runner', 'arc', 'planted')])).toBe(false);
      expect(run(profile, ['/usr/bin/touch', path.join(appDir, 'policies', 'owner__repo.json')])).toBe(false);
      expect(run(profile, ['/bin/cat', path.join(appDir, 'config.yaml')])).toBe(false);
      expect(fs.existsSync(path.join(appDir, 'runner', 'arc', 'planted'))).toBe(false);
    });

    it('lets a step make and remove what it likes in the workspace, but not remove the workspace itself', () => {
      // An empty workspace a step could rmdir, then put a link in its place for
      // the app's unsandboxed writes to follow.
      const emptyWorkDir = path.join(appDir, 'workspaces', 'ws-2');
      fs.mkdirSync(emptyWorkDir);
      for (const profile of [
        generateSandboxProfile({ workDir: emptyWorkDir, proxyPort: 1, policy: readable }),
        generateDiscoveryProfile({ workDir: emptyWorkDir, proxyPort: 1, logFile: '' }),
      ]) {
        expect(run(profile, ['/bin/mkdir', path.join(emptyWorkDir, 'sub')])).toBe(true);
        expect(run(profile, ['/bin/rmdir', path.join(emptyWorkDir, 'sub')])).toBe(true);
        expect(run(profile, ['/bin/rmdir', emptyWorkDir])).toBe(false);
        expect(fs.statSync(emptyWorkDir).isDirectory()).toBe(true);
      }
    });

    it('keeps a step process left running in its workspace from changing the tree once its removal has begun', async () => {
      // One that outlived the CLI's reap keeps its profile, which grants
      // write on the workspace's path. Were the tree removed where it is,
      // the process could swap a directory in it for a link while the
      // removal walked it.
      const id = 'ws-aaaa-1111';
      const workspace = path.join(getWorkspacesDir(), id);
      fs.mkdirSync(path.join(workspace, 'd0'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'd0', 'output'), 'step');
      const victim = path.join(appDir, 'victim');
      fs.mkdirSync(victim);
      fs.writeFileSync(path.join(victim, 'keep'), 'kept');
      const profilePath = path.join(appDir, 'leftover.sb');
      fs.writeFileSync(profilePath, generateSandboxProfile({ workDir: workspace, proxyPort: 1, policy: readable }));
      // While the workspace is where it was, the swap is one its profile
      // allows: what refuses it below is the workspace being moved aside.
      fs.mkdirSync(path.join(workspace, 'c0'));
      const swapInPlace = `cd '${workspace}' && /bin/mv c0 c0.moved && /bin/ln -s '${victim}' c0`;
      expect(run(fs.readFileSync(profilePath, 'utf-8'), ['/bin/sh', '-c', swapInPlace])).toBe(true);
      expect(fs.lstatSync(path.join(workspace, 'c0')).isSymbolicLink()).toBe(true);
      fs.unlinkSync(path.join(workspace, 'c0'));
      fs.rmdirSync(path.join(workspace, 'c0.moved'));
      const leftover = spawn(
        '/usr/bin/sandbox-exec',
        [
          '-f', profilePath,
          '/bin/sh', '-c',
          `cd '${workspace}' && echo ready && read cue && /bin/mv d0 d0.moved && /bin/ln -s '${victim}' d0`,
        ],
        { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', HOME: realHomedir() } }
      );
      const exited = new Promise<number | null>((resolve) => leftover.on('exit', (code) => resolve(code)));
      // It makes its move once the removal has begun listing the tree, which
      // a real one would have to win a race to do; here it always does.
      const realReaddir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
      let swapped: boolean | undefined;
      const readdir = jest.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: unknown[]) => {
        if (swapped === undefined) {
          leftover.stdin!.end('go\n');
          swapped = (await exited) === 0;
        }
        return realReaddir(...args);
      }) as never);
      try {
        await new Promise<void>((resolve, reject) => {
          leftover.stdout!.on('data', (chunk) => {
            if (String(chunk).includes('ready')) resolve();
          });
          exited.then((code) => reject(new Error(`the leftover exited (${code}) before it was in place`)));
        });
        expect(await removeWorkspace(id)).toBe(true);
      } finally {
        readdir.mockRestore();
        leftover.kill('SIGKILL');
      }

      // Its swap is refused: once moved aside, nothing in the tree is a path
      // its profile grants. That the removal never follows a link, even one
      // a writer seatbelt does not confine swaps in, is workspace.cleanup.test.ts.
      expect(swapped).toBe(false);
      expect(fs.readFileSync(path.join(victim, 'keep'), 'utf-8')).toBe('kept');
      expect(fs.readdirSync(getWorkspacesDir()).filter((name) => name !== 'ws-1' && name !== 'ws-2')).toEqual([]);
    });
  });

  describe('test-mode home directory confinement through a constructed profile', () => {
    // A stand-in home, so the developer's real keys are never in play. Not
    // under the temp directories, which every test profile may write; the
    // build output directory is ignored by git and outside every grant.
    let home: string;
    let workDir: string;

    beforeAll(() => {
      const scratch = path.join(process.cwd(), 'build');
      fs.mkdirSync(scratch, { recursive: true });
      home = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'localmost-home-')));
      jest.mocked(os.homedir).mockReturnValue(home);
      workDir = path.join(home, 'project');
      fs.mkdirSync(workDir);
      fs.mkdirSync(path.join(home, '.ssh'));
      fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY\n');
      fs.mkdirSync(path.join(home, '.cargo', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(home, 'notes.txt'), 'hello\n');
    });

    afterAll(() => {
      jest.mocked(os.homedir).mockImplementation(realHomedir);
      fs.rmSync(home, { recursive: true, force: true });
    });

    const run = (profile: string, argv: string[]): boolean => {
      const profilePath = path.join(os.tmpdir(), `localmost-home-${process.pid}-${Date.now()}.sb`);
      fs.writeFileSync(profilePath, profile);
      try {
        execFileSync('/usr/bin/sandbox-exec', ['-f', profilePath, ...argv], { timeout: 5000, stdio: 'ignore' });
        return true;
      } catch {
        return false;
      } finally {
        fs.unlinkSync(profilePath);
      }
    };

    it('does not let a checkout with any .localmostrc write where the user\'s own builds execute from', () => {
      const profile = generateSandboxProfile({ workDir, proxyPort: 1, policy: readable });
      expect(run(profile, ['/usr/bin/touch', path.join(workDir, 'built')])).toBe(true);
      expect(run(profile, ['/usr/bin/touch', path.join(home, '.cargo', 'bin', 'cargo')])).toBe(false);
    });

    it('writes no shared temp directory, but lets bare mktemp work', () => {
      // A planted file in /tmp or the per-user temp outlives the run and is
      // there for the next one and for the user's own tools.
      const userTemp = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf-8' }).trim();
      const planted = [path.join('/tmp', `localmost-planted-${process.pid}`), path.join(userTemp, `localmost-planted-${process.pid}`)];
      for (const profile of [
        generateSandboxProfile({ workDir, proxyPort: 1, policy: readable }),
        generateDiscoveryProfile({ workDir, proxyPort: 1, logFile: '' }),
      ]) {
        for (const target of planted) {
          expect({ target, ok: run(profile, ['/usr/bin/touch', target]) }).toEqual({ target, ok: false });
          fs.rmSync(target, { force: true });
        }
        // Scripts call mktemp with no template constantly, and it ignores TMPDIR.
        expect(run(profile, ['/bin/sh', '-c', 'f=$(/usr/bin/mktemp) && echo x > "$f" && rm "$f"'])).toBe(true);
        expect(run(profile, ['/bin/sh', '-c', 'd=$(/usr/bin/mktemp -d) && touch "$d/f" && rm -r "$d"'])).toBe(true);
      }
    });

    it('lets --updaterc observe reads and writes without writing the disk', () => {
      const profile = generateDiscoveryProfile({ workDir, proxyPort: 1, logFile: '' });
      expect(run(profile, ['/bin/cat', path.join(home, 'notes.txt')])).toBe(true);
      expect(run(profile, ['/usr/bin/touch', path.join(workDir, 'built')])).toBe(true);
      expect(run(profile, ['/usr/bin/touch', path.join(home, 'planted')])).toBe(false);
      expect(run(profile, ['/usr/bin/touch', path.join(home, '.cargo', 'bin', 'cargo')])).toBe(false);
      expect(run(profile, ['/bin/cat', path.join(home, '.ssh', 'id_ed25519')])).toBe(false);
      expect(fs.existsSync(path.join(home, 'planted'))).toBe(false);
    });

    it('matches a wildcard policy path literally apart from its *', () => {
      // `*` became `.*` with every other character left as regex syntax, so the
      // dot in a name like ".npm" matched any character.
      fs.mkdirSync(path.join(home, 'data'));
      fs.writeFileSync(path.join(home, 'data', 'a.bc'), 'granted\n');
      fs.writeFileSync(path.join(home, 'data', 'aXbc'), 'not granted\n');
      const profile = generateSandboxProfile({
        workDir,
        proxyPort: 1,
        policy: { filesystem: { read: [...MACOS_BASELINE_READ_PATHS, path.join(home, 'data', 'a.b*')] } },
      });
      expect(run(profile, ['/bin/cat', path.join(home, 'data', 'a.bc')])).toBe(true);
      expect(run(profile, ['/bin/cat', path.join(home, 'data', 'aXbc')])).toBe(false);
    });

    it('refuses what a deny names by a spelling that runs through a symlink, and what a glob deny matches', () => {
      // /tmp is a symlink to /private/tmp, and a link of the user's is one
      // too; seatbelt matches where they lead.
      const real = fs.realpathSync(fs.mkdtempSync('/tmp/localmost-deny-'));
      try {
        for (const dir of [path.join(real, 'a'), path.join(home, 'kept', 'b')]) {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'key'), 'key\n');
        }
        fs.writeFileSync(path.join(real, 'visible'), 'visible\n');
        fs.writeFileSync(path.join(home, 'kept', 'server.pem'), 'key\n');
        fs.symlinkSync(path.join(home, 'kept'), path.join(home, 'link'));
        const profile = generateSandboxProfile({
          workDir,
          proxyPort: 1,
          policy: {
            filesystem: {
              read: [...MACOS_BASELINE_READ_PATHS, real, '~'],
              deny: [path.join(real.replace(/^\/private/, ''), 'a'), path.join(home, 'link', 'b'), `${home}/link/*.pem`],
            },
          },
        });
        expect(run(profile, ['/bin/cat', path.join(real, 'visible')])).toBe(true);
        expect(run(profile, ['/bin/cat', path.join(real, 'a', 'key')])).toBe(false);
        expect(run(profile, ['/bin/cat', path.join(home, 'notes.txt')])).toBe(true);
        expect(run(profile, ['/bin/cat', path.join(home, 'kept', 'b', 'key')])).toBe(false);
        expect(run(profile, ['/bin/cat', path.join(home, 'kept', 'server.pem')])).toBe(false);
      } finally {
        fs.rmSync(real, { recursive: true, force: true });
      }
    });

    it('cannot move what a deny names out from under it by renaming a directory above it', () => {
      // The deny matches paths, so renamed, the secret would sit under a name
      // the write grant covers and the deny does not. Each rename is undone
      // from outside the sandbox should the sandbox let it through.
      const out = path.join(home, 'renamed');
      for (const dir of [path.join(out, 'a', 'secret'), path.join(out, 'g')]) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(out, 'a', 'secret', 'key'), 'key\n');
      fs.writeFileSync(path.join(out, 'g', 'x.pem'), 'key\n');
      const profile = generateSandboxProfile({
        workDir,
        proxyPort: 1,
        policy: {
          filesystem: {
            read: [...MACOS_BASELINE_READ_PATHS, out],
            write: [out],
            deny: [path.join(out, 'a', 'secret'), `${out}/g/*.pem`],
          },
        },
      });
      for (const [above, file] of [['a', path.join('secret', 'key')], ['g', 'x.pem']]) {
        const from = path.join(out, above);
        const moved = `${from}-moved`;
        const ok = run(profile, ['/bin/sh', '-c', `/bin/mv '${from}' '${moved}' && /bin/cat '${path.join(moved, file)}'`]);
        if (fs.existsSync(moved)) fs.renameSync(moved, from);
        expect(ok).toBe(false);
      }
      // What the grant gives stays given: a new file beside the secret.
      expect(run(profile, ['/usr/bin/touch', path.join(out, 'a', 'built')])).toBe(true);
      expect(run(profile, ['/usr/bin/touch', path.join(out, 'g', 'built')])).toBe(true);
    });

    it('builds and applies a deny beneath what it cannot look up: an unsearchable directory, a symlink loop', () => {
      const out = path.join(home, 'unresolvable');
      fs.mkdirSync(path.join(out, 'locked', 'inner'), { recursive: true });
      fs.writeFileSync(path.join(out, 'visible'), 'visible\n');
      fs.symlinkSync('loop', path.join(out, 'loop'));
      fs.chmodSync(path.join(out, 'locked'), 0o000);
      try {
        const profile = generateSandboxProfile({
          workDir,
          proxyPort: 1,
          policy: {
            filesystem: {
              read: [...MACOS_BASELINE_READ_PATHS, out],
              deny: [path.join(out, 'locked', 'inner', 'secret'), path.join(out, 'loop', 'secret')],
            },
          },
        });
        expect(run(profile, ['/bin/cat', path.join(out, 'visible')])).toBe(true);
      } finally {
        fs.chmodSync(path.join(out, 'locked'), 0o755);
      }
    });

    it('keeps private keys unreadable even when the policy declares the home directory', () => {
      const profile = generateSandboxProfile({
        workDir,
        proxyPort: 1,
        policy: { filesystem: { read: [...MACOS_BASELINE_READ_PATHS, '~'] } },
      });
      expect(run(profile, ['/bin/cat', path.join(home, 'notes.txt')])).toBe(true);
      expect(run(profile, ['/bin/cat', path.join(home, '.ssh', 'id_ed25519')])).toBe(false);
    });
  });
} else {
  describe('test-mode network confinement through the ambient profile', () => {
    it('refuses a direct connection off the machine', async () => {
      const result = await tryConnect(null, OFF_BOX, 9);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('Operation not permitted');
    });

    it('generates profiles that carry the rules the constructed mode would apply', () => {
      // Not a substitute for applying them - that needs a machine outside a
      // job - but it holds the rules this file is about in place here too.
      const workDir = '/Users/test/.localmost/workspaces/ws-1';
      const enforcement = generateSandboxProfile({ workDir, proxyPort: 1, policy: readable });
      const discovery = generateDiscoveryProfile({ workDir, proxyPort: 1, logFile: '' });
      // Loopback: only the proxy under enforcement, the granted ports on
      // request, everything under discovery.
      expect(enforcement).toContain('(allow network-outbound (remote ip "localhost:1"))');
      expect(enforcement).not.toContain('"localhost:*"))');
      expect(
        generateSandboxProfile({ workDir, proxyPort: 1, policy: readable, loopback: [5432] })
      ).toContain('(allow network-outbound (remote ip "localhost:5432"))');
      expect(discovery).toContain('(allow network-outbound (remote ip "localhost:*"))');
      for (const profile of [enforcement, discovery]) {
        expect(profile).not.toContain('(local ip)');
        expect(profile).toContain('(deny network*)');
        expect(profile).toContain(`(deny file-write* (literal "${workDir}"))`);
        expect(profile).not.toContain('(subpath "/private/tmp")');
        expect(profile).toContain('(allow signal (target same-sandbox))');
        expect(profile).not.toContain('(allow signal)');
      }
    });
  });
}
