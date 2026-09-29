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
 *                process runs under refuses the same connection.
 *
 * Neither mode skips. macOS only, because seatbelt is.
 */

import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { execFile, execFileSync } from 'child_process';
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
  });
}
