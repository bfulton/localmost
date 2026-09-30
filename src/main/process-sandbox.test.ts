import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { EventEmitter } from 'events';

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
  realpathSync: jest.fn((p: string) => p),
}));

// Mock child_process
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  spawn: mockSpawn,
}));

// Note: spawnSandboxed is imported via require() in each test's jest.isolateModules block
// This allows fresh imports with different mocks for each test scenario

// Create a mock process factory
function createMockProcess(pid: number): any {
  const proc = new EventEmitter();
  Object.defineProperty(proc, 'pid', { value: pid, writable: false });
  (proc as any).kill = jest.fn();
  return proc;
}

// Store original platform
const originalPlatform = process.platform;

describe('Process Sandbox', () => {
  const mockRunnerDir = path.join(os.homedir(), '.localmost', 'runner');

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    // Reset platform to original
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  afterAll(() => {
    // Restore original platform
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  describe('spawnSandboxed', () => {
    // These tests mock a non-darwin platform to test core security validations
    // (path allowlist, traversal prevention) without the sandbox-exec wrapper

    it('should allow spawning run.sh from runner directory', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const mockProcess = createMockProcess(12345);
        const localMockSpawn = jest.fn().mockReturnValue(mockProcess);
        jest.doMock('child_process', () => ({ spawn: localMockSpawn }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: jest.fn(),
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');

        const runnerPath = path.join(mockRunnerDir, 'run.sh');
        const result = sandboxedSpawn(runnerPath, [], { cwd: mockRunnerDir });

        expect(localMockSpawn).toHaveBeenCalledWith(runnerPath, [], {
          cwd: mockRunnerDir,
          shell: false,
        });
        expect(result).toBe(mockProcess);
      });
    });

    it('should allow spawning config.sh from runner directory', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const mockProcess = createMockProcess(12346);
        const localMockSpawn = jest.fn().mockReturnValue(mockProcess);
        jest.doMock('child_process', () => ({ spawn: localMockSpawn }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: jest.fn(),
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');

        const configPath = path.join(mockRunnerDir, 'config.sh');
        sandboxedSpawn(configPath, ['--url', 'test'], { cwd: mockRunnerDir });

        expect(localMockSpawn).toHaveBeenCalledWith(configPath, ['--url', 'test'], {
          cwd: mockRunnerDir,
          shell: false,
        });
      });
    });

    it('should allow spawning from runner instance directories (runner-2, runner-3, etc)', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const mockProcess = createMockProcess(12347);
        const localMockSpawn = jest.fn().mockReturnValue(mockProcess);
        jest.doMock('child_process', () => ({ spawn: localMockSpawn }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: jest.fn(),
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');

        const instanceDir = path.join(os.homedir(), '.localmost', 'runner-2');
        const runnerPath = path.join(instanceDir, 'run.sh');

        sandboxedSpawn(runnerPath, [], { cwd: instanceDir });

        expect(localMockSpawn).toHaveBeenCalled();
      });
    });

    it('should reject executables outside the sandbox', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        jest.doMock('child_process', () => ({ spawn: jest.fn() }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: jest.fn(),
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');

        expect(() => {
          sandboxedSpawn('/usr/bin/bash', []);
        }).toThrow('Security violation: Attempted to execute binary outside sandbox');
      });
    });

    it('should reject path traversal attempts', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        jest.doMock('child_process', () => ({ spawn: jest.fn() }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: jest.fn(),
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');

        const maliciousPath = path.join(mockRunnerDir, '..', '..', 'etc', 'passwd');
        expect(() => {
          sandboxedSpawn(maliciousPath, []);
        }).toThrow('Security violation');
      });
    });

    it('should reject working directory outside sandbox', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        jest.doMock('child_process', () => ({ spawn: jest.fn() }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: jest.fn(),
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');

        const runnerPath = path.join(mockRunnerDir, 'run.sh');
        expect(() => {
          sandboxedSpawn(runnerPath, [], { cwd: '/tmp' });
        }).toThrow('Security violation: Working directory outside sandbox');
      });
    });

    it('should reject non-allowlisted executables in sandbox', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        jest.doMock('child_process', () => ({ spawn: jest.fn() }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: jest.fn(),
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');

        const maliciousPath = path.join(mockRunnerDir, 'malicious.sh');
        expect(() => {
          sandboxedSpawn(maliciousPath, []);
        }).toThrow('Security violation: Executable not in allowlist');
      });
    });

    it('should throw if executable does not exist', () => {
      // Reset modules before isolation to ensure clean state
      jest.resetModules();
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        // Set up mocks BEFORE requiring the module
        jest.doMock('child_process', () => ({ spawn: jest.fn() }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn(() => false),
          writeFileSync: jest.fn(),
          unlinkSync: jest.fn(),
        }));

        // Now require the module - it will use our mocked fs
        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');

        const runnerPath = path.join(mockRunnerDir, 'run.sh');
        expect(() => {
          sandboxedSpawn(runnerPath, []);
        }).toThrow('Executable not found');
      });
    });

    it('should always set shell: false for security', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const mockProcess = createMockProcess(12348);
        const localMockSpawn = jest.fn().mockReturnValue(mockProcess);
        jest.doMock('child_process', () => ({ spawn: localMockSpawn }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: jest.fn(),
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');

        const runnerPath = path.join(mockRunnerDir, 'run.sh');
        // Try to pass shell: true - it should be overridden
        sandboxedSpawn(runnerPath, [], { cwd: mockRunnerDir, shell: true });

        expect(localMockSpawn).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ shell: false })
        );
      });
    });
  });

  describe('macOS sandbox-exec integration', () => {
    beforeEach(() => {
      // Force macOS platform for these tests
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      // Need to re-import the module to pick up the new platform
      jest.resetModules();
    });

  // Where a worker's sandbox is: its nodes on the way down are what the
  // profile gives back inside the app's directories.
  const instanceDir = path.join(os.homedir(), '.localmost', 'runner', 'sandbox', '3');
  const homeDir = os.homedir();

  /**
   * Build runner profiles for each set of sandbox options in turn, within one
   * load of the module, and return their text. `getconf` answers the per-user
   * temp directory lookup, or throws; `fsExtra` adds to or replaces the mocked
   * fs, to stand links in, say.
   */
  const profilesWith = (
    optionSets: Record<string, unknown>[],
    getconf: () => string = () => '/var/folders/zz/zyxw_vut0000gn/T/\n',
    fsExtra: Record<string, unknown> = {}
  ): string[] => {
    let profiles: string[] = [];
    jest.isolateModules(() => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const mockProcess = createMockProcess(12360);
      const localMockSpawn = jest.fn().mockReturnValue(mockProcess);
      const mockWriteFileSync = jest.fn();
      jest.doMock('child_process', () => ({ spawn: localMockSpawn, execFileSync: jest.fn(getconf) }));
      jest.doMock('fs', () => ({
        existsSync: jest.fn().mockReturnValue(true),
        writeFileSync: mockWriteFileSync,
        unlinkSync: jest.fn(),
        mkdirSync: jest.fn(),
        realpathSync: jest.fn((p: string) => p),
        ...fsExtra,
      }));

      const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');
      for (const options of optionSets) {
        sandboxedSpawn(path.join(instanceDir, 'run.sh'), [], { cwd: instanceDir, ...options });
      }

      profiles = mockWriteFileSync.mock.calls.map((call) => call[1]);
    });
    return profiles;
  };

  /** Build one runner profile with the given sandbox options. */
  const profileWith = (options: Record<string, unknown>, getconf?: () => string): string =>
    profilesWith([options], getconf)[0];

  /**
   * Whether a profile lets a job perform a file operation on a path: seatbelt
   * applies the last rule for that operation whose filters match it. A rule
   * may name several operations, as the policy deny does.
   */
  const permits = (profile: string, operation: 'file-read*' | 'file-write*', target: string): boolean => {
    let verdict = false;
    const rule = /\((allow|deny) ((?:file-[a-z*-]+[ \t]*)+)/g;
    for (let match = rule.exec(profile); match; match = rule.exec(profile)) {
      if (!match[2].trim().split(/\s+/).includes(operation)) continue;
      // The rule runs to the parenthesis that closes it.
      let depth = 0;
      let end = match.index;
      for (; end < profile.length; end++) {
        if (profile[end] === '(') depth++;
        else if (profile[end] === ')' && --depth === 0) break;
      }
      const body = profile.slice(match.index, end).replace(/;;.*$/gm, '');
      const filters = [...body.matchAll(/\((subpath|literal|prefix|regex) (#?)"([^"]*)"\)/g)];
      const matches = filters.length === 0 || filters.some(([, kind, raw, value]) =>
        kind === 'regex'
          // In a plain string a backslash is itself escaped; #"..." is raw.
          ? new RegExp(raw ? value : value.replace(/\\(.)/g, '$1')).test(target)
          : kind === 'prefix'
            ? target.startsWith(value)
            : target === value ||
              (kind === 'subpath' && target.startsWith(value.endsWith('/') ? value : `${value}/`)));
      if (matches) verdict = match[1] === 'allow';
    }
    return verdict;
  };

  /** Whether a profile lets a job write a path. */
  const writable = (profile: string, target: string): boolean => permits(profile, 'file-write*', target);

  /** Whether a profile lets a job read a path. */
  const readable = (profile: string, target: string): boolean => permits(profile, 'file-read*', target);

  describe("the worker's docker socket in the runner profile", () => {
    it('grants the worker docker socket read+connect but not write, and keeps ~/.docker fully denied', () => {
      const dockerSocket = path.join(instanceDir, 'docker.sock');
      const profile = profileWith({ dockerSocket });

      expect(profile).toContain(`(allow network-outbound (literal "${dockerSocket}"))`);
      expect(profile).toContain(`(allow file-read* (literal "${dockerSocket}"))`);
      expect(profile).not.toContain(`(allow file-write* (literal "${dockerSocket}"))`);
      // The sandbox directory is writable as a whole, so the socket has to be
      // subtracted by name - after that allow, since seatbelt takes the last
      // matching rule. Otherwise the job could unlink it and bind its own.
      const deny = profile.indexOf(`(deny file-write* (literal "${dockerSocket}"))`);
      const dirAllow = profile.indexOf(`(allow file-write*\n  (subpath "${instanceDir}"))`);
      expect(dirAllow).toBeGreaterThan(-1);
      expect(deny).toBeGreaterThan(dirAllow);
      // ~/.docker is denied in full, with no daemon-socket hole punched after it.
      expect(profile).toContain(`(subpath "${homeDir}/.docker")`);
      expect(profile).not.toMatch(/\.docker\/run\/docker\.sock/);
      expect(profile).not.toContain('config.json');
      expect(profile).not.toContain(`(allow file-read* (subpath "${homeDir}/.docker`);
    });

    it('emits no docker socket rules when the worker was given no socket', () => {
      expect(profileWith({})).not.toContain('docker.sock');
    });

    it('lets a job reach unix sockets only inside its own sandbox, not the shared temp dirs', () => {
      // A unix socket under /tmp or the user's $TMPDIR belongs to one of the
      // user's own processes - an editor, a daemon, an agent. Connecting to it
      // reaches outside the sandbox. The job's own TMPDIR is set inside the
      // sandbox, so well-behaved suites that bind under TMPDIR still work.
      const profile = profileWith({});
      const connect = profile.slice(
        profile.indexOf('(allow network-outbound\n  ;; The system sockets'),
        profile.indexOf('(allow network-bind (local')
      );
      expect(connect).toContain(`(subpath "${instanceDir}")`);
      expect(connect).not.toContain('(subpath "/tmp")');
      expect(connect).not.toContain('(subpath "/private/tmp")');
      expect(connect).not.toContain('(subpath "/private/var/folders")');

      const bind = profile.slice(profile.indexOf('(allow network-bind\n'));
      expect(bind).toContain(`(subpath "${instanceDir}")`);
      expect(bind).not.toContain('(subpath "/tmp")');
      expect(bind).not.toContain('(subpath "/private/var/folders")');
    });

    it('keeps the control plane and runner secrets unwritable even against a policy write path', () => {
      // seatbelt takes the last matching rule, so the write denials have to
      // come after the policy-declared write allow - otherwise a policy could
      // declare a write path into the pid directory or the proxy credentials
      // and reopen the very holes the read denials close.
      const appDir = path.join(os.homedir(), '.localmost');
      const runnerDir = path.join(appDir, 'runner');
      const profile = profileWith({
        dockerSocket: path.join(instanceDir, 'docker.sock'),
        filesystemPolicy: { level: 'strict', read: [], write: ['~/.localmost'] },
      });
      expect(writable(profile, path.join(appDir, 'policies', 'owner-repo.json'))).toBe(false);
      expect(writable(profile, path.join(runnerDir, 'pids', 'worker-1.pid'))).toBe(false);
      expect(writable(profile, path.join(runnerDir, 'proxies', 'target-a', '1', '.credentials_rsaparams'))).toBe(false);
      expect(writable(profile, path.join(runnerDir, 'config', '1', '.runner'))).toBe(false);
      expect(writable(profile, path.join(runnerDir, 'sandbox-profiles', 'sandbox-1.sb'))).toBe(false);
      expect(writable(profile, path.join(runnerDir, 'broker-sessions.json'))).toBe(false);
      expect(writable(profile, path.join(runnerDir, 'sandbox', '2', 'run.sh'))).toBe(false);
      // The job's own sandbox stays writable, all but its docker socket.
      expect(writable(profile, path.join(instanceDir, '_work', 'out'))).toBe(true);
      expect(writable(profile, path.join(instanceDir, 'docker.sock'))).toBe(false);
    });

    it("keeps the runner template and its integrity record unwritable, even under a policy that grants the app's directory", () => {
      // Every worker runs a copy of runner/arc, checked against the record in
      // runner/arc-manifests. A job that could write both could change the
      // runner every later job runs, and the check would pass. A policy write
      // path of ~ or ~/.localmost is dropped, and the deny that ends the write
      // rules would stand in its way if it were not.
      const appDir = path.join(os.homedir(), '.localmost');
      const runnerDir = path.join(appDir, 'runner');
      const ownToolCache = path.join(runnerDir, 'caches', 'aaaa1111', 'tool-cache');
      for (const grant of ['~', '~/.localmost']) {
        const profile = profileWith({
          filesystemPolicy: { level: 'strict', read: [], write: [grant] },
          toolCacheDir: ownToolCache,
        });
        expect(writable(profile, path.join(appDir, 'some-file'))).toBe(false);
        expect(writable(profile, path.join(runnerDir, 'arc', 'v2.336.0', 'bin', 'Runner.Worker.dll'))).toBe(false);
        expect(writable(profile, path.join(runnerDir, 'arc', 'v9.9.9', '.env'))).toBe(false);
        expect(writable(profile, path.join(runnerDir, 'arc-manifests', 'v2.336.0.json'))).toBe(false);
        expect(writable(profile, path.join(runnerDir, 'arc-staging-a1b2c3', 'tree', 'run.sh'))).toBe(false);
        // Renaming a directory the record and template live in, and putting
        // another in its place, is a write to that directory itself.
        expect(writable(profile, runnerDir)).toBe(false);
        expect(writable(profile, appDir)).toBe(false);
        // What a job may write in there is still writable: its own sandbox
        // and its own target's tool cache. Another target's cache and the old
        // shared one are not, whatever the policy grants above them.
        expect(writable(profile, path.join(instanceDir, '_work', 'repo', 'out.o'))).toBe(true);
        expect(writable(profile, path.join(ownToolCache, 'node', '20', 'bin', 'node'))).toBe(true);
        expect(writable(profile, path.join(runnerDir, 'caches', 'bbbb2222', 'tool-cache', 'node'))).toBe(false);
        expect(writable(profile, path.join(runnerDir, 'tool-cache', 'node', '20', 'bin', 'node'))).toBe(false);
      }
    });

    it('reaches nothing in the runner directory through a policy path that names it', () => {
      // A repo policy has no business reaching the app's own runner dir - proxy
      // credentials, pids, other sandboxes. A path there is granted as written,
      // and the deny of the app's directories that follows every grant takes
      // it back, all but the job's own sandbox.
      const runnerDir = path.join(os.homedir(), '.localmost', 'runner');
      const profile = profileWith({
        filesystemPolicy: {
          level: 'strict',
          read: [path.join(runnerDir, 'sandbox'), path.join(runnerDir, 'proxies'), '/tmp/legit-read'],
          write: [path.join(runnerDir, 'pids'), path.join(runnerDir, 'sandbox'), '/tmp/legit-write'],
        },
      });
      expect(readable(profile, path.join(runnerDir, 'sandbox', '2', 'token'))).toBe(false);
      expect(writable(profile, path.join(runnerDir, 'sandbox', '2', 'run.sh'))).toBe(false);
      expect(readable(profile, path.join(runnerDir, 'proxies', 'target-a', '1', '.credentials_rsaparams'))).toBe(false);
      expect(writable(profile, path.join(runnerDir, 'pids', 'worker-1.pid'))).toBe(false);
      expect(readable(profile, path.join(instanceDir, '_work', 'main.c'))).toBe(true);
      expect(writable(profile, path.join(instanceDir, '_work', 'out.o'))).toBe(true);
      // Declared paths outside the runner dir are granted as ever.
      expect(readable(profile, '/tmp/legit-read/file')).toBe(true);
      expect(writable(profile, '/tmp/legit-write/file')).toBe(true);
    });

    it('denies the pasteboard mach service so a job cannot read the clipboard', () => {
      // (allow mach*) is needed by system frameworks, but the clipboard often
      // holds passwords and tokens and no job needs it. Denied by name after
      // the blanket allow, where the last matching rule wins.
      const profile = profileWith({});
      const allow = profile.indexOf('(allow mach*)');
      const deny = profile.indexOf('(global-name "com.apple.pasteboard.1")');
      expect(allow).toBeGreaterThan(-1);
      expect(deny).toBeGreaterThan(allow);
    });

    it('does not open the whole runner directory, and denies the parts that hold secrets', () => {
      // The runner directory holds every target's proxy credentials, every
      // instance's registration, the broker's session tokens and the other
      // workers' sandboxes. Granting it read let any job read all of them and
      // register as another repository's runner. A job gets its own sandbox
      // and the shared tool cache, not the directory that contains them.
      const runnerDir = path.join(os.homedir(), '.localmost', 'runner');
      const profile = profileWith({ dockerSocket: path.join(instanceDir, 'docker.sock') });

      // The runner directory is not opened as a whole. Its node and the
      // sandbox node are readable so the runner can traverse into its own
      // sandbox, but not as subtrees - a sibling sandbox is never granted.
      expect(readable(profile, runnerDir)).toBe(true);
      expect(readable(profile, path.join(runnerDir, 'sandbox'))).toBe(true);
      expect(readable(profile, path.join(runnerDir, 'sandbox', '2'))).toBe(false);
      expect(readable(profile, path.join(runnerDir, 'sandbox', '2', 'token'))).toBe(false);
      expect(readable(profile, path.join(runnerDir, 'arc', 'v2.336.0', 'run.sh'))).toBe(false);
      expect(readable(profile, path.join(instanceDir, 'run.sh'))).toBe(true);
      // The secrets are denied by name as well, whatever overlaps them: the
      // first read deny is the one that names them.
      const denyRead = profile.slice(profile.indexOf('(deny file-read*'));
      const secrets = denyRead.slice(0, denyRead.indexOf('\n\n'));
      expect(secrets).toContain(`(subpath "${runnerDir}/proxies")`);
      expect(secrets).toContain(`(subpath "${runnerDir}/config")`);
      expect(secrets).toContain(`(subpath "${runnerDir}/sandbox-profiles")`);
      // The broker's session file, and the temporary file it is written
      // through before the rename, under any name the writer gives it.
      const named = `(allow file-read* (subpath "${runnerDir}"))\n${secrets}`;
      for (const name of ['broker-sessions.json', 'broker-sessions.json.tmp', 'broker-sessions.json.4242.tmp']) {
        expect(readable(named, path.join(runnerDir, name))).toBe(false);
      }
      expect(readable(named, path.join(runnerDir, 'other.json'))).toBe(true);
    });

    it('escapes quotes in the socket path, as the rest of the profile does', () => {
      // The path is built from the sandbox directory and lands in a security
      // DSL, where an unescaped quote would close the literal early and change
      // what the rule means.
      const profile = profileWith({ dockerSocket: '/tmp/od"d/docker.sock' });

      expect(profile).toContain('(allow network-outbound (literal "/tmp/od\\"d/docker.sock"))');
      expect(profile).toContain('(deny file-write* (literal "/tmp/od\\"d/docker.sock"))');
      expect(profile).not.toContain('(allow network-outbound (literal "/tmp/od"d/docker.sock"))');
    });
  });

  describe("the runner profile's filesystem floor", () => {
    it.each(['strict', 'moderate', 'permissive'] as const)(
      'keeps the credentials a developer machine holds closed to a write grant under %s, and the directories above them',
      (level) => {
        // The floor matches paths. With only reads denied, a write grant on a
        // package cache, ~/Library or ~ let a job rename a credential - or the
        // directory it sits in - to a name the grants cover, and read it there.
        const grants = ['~', '~/.gradle', '~/.m2', '~/.cargo', '~/.nuget', '~/Library'];
        const profile = profileWith({ filesystemPolicy: { level, read: grants, write: grants } });
        const home = (...parts: string[]) => path.join(homeDir, ...parts);
        for (const credential of [
          home('.ssh', 'id_ed25519'),
          home('.aws', 'credentials'),
          home('.config', 'gh', 'hosts.yml'),
          home('.docker', 'config.json'),
          home('Library', 'Keychains', 'login.keychain-db'),
          home('.netrc'),
          home('.npmrc'),
          home('.m2', 'settings.xml'),
          home('.m2', 'settings-security.xml'),
          home('.gradle', 'gradle.properties'),
          home('.cargo', 'credentials'),
          home('.cargo', 'credentials.toml'),
          home('.nuget', 'NuGet', 'NuGet.Config'),
        ]) {
          expect(readable(profile, credential)).toBe(false);
          expect(writable(profile, credential)).toBe(false);
        }
        // Each directory the floor names, and every directory above an entry,
        // as a node: none can be renamed, removed or replaced.
        for (const node of [
          home('.ssh'), home('Library', 'Keychains'), home('Library'), home('.m2'), home('.gradle'), home('.cargo'),
          home('.nuget'), home('.nuget', 'NuGet'), homeDir, path.dirname(homeDir),
        ]) {
          expect(writable(profile, node)).toBe(false);
        }
        // Nodes, not subtrees: what the grants give beside them stays given.
        for (const target of [
          home('.gradle', 'caches', 'modules-2'),
          home('.gradle', 'wrapper', 'dists'),
          home('.m2', 'repository', 'x.jar'),
          home('.nuget', 'NuGet', 'nugetorgadd.trk'),
          home('.cargo', 'registry', 'index'),
          home('Library', 'Caches', 'built'),
          home('project', 'built'),
        ]) {
          expect(writable(profile, target)).toBe(true);
        }
      }
    );

    it('keeps a credential linked into place closed by the path the link resolves to, and the directories above both', () => {
      // Dotfile managers link ~/.aws to ~/dotfiles/aws; a cache is moved to
      // another volume and linked back. seatbelt matches the path a link
      // resolves to, so the floor written as ~/.aws alone held nothing there.
      const home = (...parts: string[]) => path.join(homeDir, ...parts);
      const links: Record<string, string> = { [home('.aws')]: 'dotfiles/aws', [home('.m2')]: '/opt/cache/m2' };
      const grants = ['~', '/opt/cache'];
      const [profile] = profilesWith([{ filesystemPolicy: { level: 'strict', read: grants, write: grants } }], undefined, {
        lstatSync: jest.fn((p: string) => ({ isSymbolicLink: () => p in links })),
        readlinkSync: jest.fn((p: string) => links[p]),
      });
      for (const credential of [
        home('dotfiles', 'aws', 'credentials'),
        '/opt/cache/m2/settings.xml',
        '/opt/cache/m2/settings-security.xml',
      ]) {
        expect(readable(profile, credential)).toBe(false);
        expect(writable(profile, credential)).toBe(false);
      }
      for (const node of [
        home('dotfiles', 'aws'), home('dotfiles'), home('.aws'), home('.m2'), '/opt/cache/m2', '/opt/cache', '/opt', homeDir,
      ]) {
        expect(writable(profile, node)).toBe(false);
      }
      // Nodes, not subtrees: what the grants give beside them stays given.
      expect(writable(profile, home('dotfiles', 'zsh', 'zshrc'))).toBe(true);
      expect(writable(profile, '/opt/cache/m2/repository/x.jar')).toBe(true);
    });

    it.each(['strict', 'moderate', 'permissive'] as const)(
      'grants no shared temp directory as a whole under %s',
      (level) => {
        // /tmp and the per-user /var/folders tree are shared with the user's
        // own processes and every other worker: writable, a job could plant
        // files their tools trust (the xcrun cache, clang's module cache);
        // readable, it could read what they leave there. The job's TMPDIR is
        // in its own sandbox, which is granted separately.
        const profile = profileWith({ filesystemPolicy: { level, read: [], write: [] } });
        for (const shared of ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', '/var', os.tmpdir()]) {
          expect(profile).not.toContain(`(subpath "${shared}")`);
        }
        expect(profile).not.toContain('/var/folders/zz/zyxw_vut0000gn/T")');
      }
    );

    it('lets bare mktemp create its own entries in the per-user temp, by generated name only', () => {
      // macOS mktemp ignores TMPDIR: with no template it creates
      // tmp.XXXXXXXXXX in the per-user temp directory that confstr names, and
      // countless scripts call it that way. Only names of that exact shape
      // are granted, and not the directory itself, so a job can neither list
      // the directory nor touch anything else in it.
      const profile = profileWith({});
      const rules = [...profile.matchAll(/\(regex #"([^"]+)"\)/g)].map((m) => new RegExp(m[1]));
      expect(rules.length).toBeGreaterThan(0);
      const granted = (p: string) => rules.some((rule) => rule.test(p));
      for (const dir of ['/var/folders/zz/zyxw_vut0000gn/T', '/private/var/folders/zz/zyxw_vut0000gn/T']) {
        expect(granted(`${dir}/tmp.AbC123xYz9`)).toBe(true);
        expect(granted(`${dir}/tmp.AbC123xYz9/inside/file`)).toBe(true);
        expect(granted(dir)).toBe(false);
        expect(granted(`${dir}/`)).toBe(false);
        expect(granted(`${dir}/xcrun_db`)).toBe(false);
        expect(granted(`${dir}/tmp.short`)).toBe(false);
        expect(granted(`${dir}/foo.AbC123xYz9`)).toBe(false);
        expect(granted(`${dir}/com.example.ShipIt.AbC123xY`)).toBe(false);
      }
      expect(granted('/var/folders/zz/zyxw_vut0000gn/C/tmp.AbC123xYz9')).toBe(false);
      expect(granted('/var/folders/zz/other_user00gn/T/tmp.AbC123xYz9')).toBe(false);
    });

    it('grants nothing in the per-user temp when it cannot be looked up', () => {
      // Failing closed: mktemp without a template fails, nothing else changes.
      const failed = profileWith({}, () => { throw new Error('getconf: not found'); });
      expect(failed).not.toContain('(regex');
      expect(failed).not.toMatch(/\((subpath|literal|regex)[^)]*var\/folders/);
      // An answer that is not a per-user temp directory is not trusted either.
      const odd = profileWith({}, () => '/Users/someone\n');
      expect(odd).not.toContain('(regex');
    });

    it("grants only the tool cache it is given, so two targets' profiles share none", () => {
      // setup-* actions execute the highest matching toolchain they find in
      // the tool cache. A cache every job can write lets one repository's job
      // plant a binary another repository's job runs with its own secrets.
      const runnerDir = path.join(os.homedir(), '.localmost', 'runner');
      const cacheA = path.join(runnerDir, 'caches', 'aaaa1111', 'tool-cache');
      const cacheB = path.join(runnerDir, 'caches', 'bbbb2222', 'tool-cache');
      const writable = (profile: string) =>
        [...profile.matchAll(/\(allow file-write\*\n((?:\s*\(subpath "[^"]*"\)\n?)+)\)/g)]
          .flatMap((m) => [...m[1].matchAll(/\(subpath "([^"]*)"\)/g)].map((s) => s[1]));
      const a = profileWith({ toolCacheDir: cacheA });
      const b = profileWith({ toolCacheDir: cacheB });

      expect(writable(a)).toContain(cacheA);
      expect(writable(b)).toContain(cacheB);
      expect(a).not.toContain(cacheB);
      expect(b).not.toContain(cacheA);
      // Nothing either can write lies inside, or contains, the other's cache,
      // and neither names the old shared cache.
      for (const [profile, other] of [[a, cacheB], [b, cacheA]]) {
        for (const w of writable(profile)) {
          expect(other.startsWith(w + '/') || other === w || w.startsWith(other + '/')).toBe(false);
        }
        expect(profile).not.toContain(`(subpath "${runnerDir}/tool-cache")`);
      }
      // Readable, and the directory nodes above it can be traversed, but not
      // opened as subtrees on the way.
      expect(readable(a, path.join(cacheA, 'node', '20', 'bin', 'node'))).toBe(true);
      expect(readable(a, path.join(runnerDir, 'caches'))).toBe(true);
      expect(readable(a, path.join(runnerDir, 'caches', 'aaaa1111'))).toBe(true);
      expect(readable(a, path.join(runnerDir, 'caches', 'bbbb2222'))).toBe(false);
      expect(readable(a, path.join(cacheB, 'node', '20', 'bin', 'node'))).toBe(false);
    });

    it.each(['moderate', 'permissive'] as const)(
      "writes no toolchain tree in the user's home under %s, only the target's own package caches",
      (level) => {
        // ~/.cargo, ~/.local, ~/go and the rest are not only caches: they hold
        // directories on the user's PATH and config their own unsandboxed
        // tools load. The job's package managers are pointed at a directory of
        // its target's instead, and the installed toolchains stay readable.
        const homeDir = os.homedir();
        const packages = path.join(homeDir, '.localmost', 'runner', 'caches', 'aaaa1111', 'packages');
        const profile = profileWith({ filesystemPolicy: { level, read: [], write: [] }, packageCacheDir: packages });
        const writable = [...profile.matchAll(/\(allow file-write\*\n((?:\s*\(subpath "[^"]*"\)\n?)+)\)/g)]
          .flatMap((m) => [...m[1].matchAll(/\(subpath "([^"]*)"\)/g)].map((s) => s[1]));

        expect(writable).toContain(packages);
        for (const w of writable) {
          // Everything writable in the home is this job's own or its target's.
          if (w.startsWith(homeDir + '/')) {
            expect(w === packages || w.startsWith(path.join(homeDir, '.localmost') + '/')).toBe(true);
          }
        }
        for (const tree of ['.cargo', '.rustup', '.local', 'go', '.gradle', '.dotnet', '.npm', 'Library/Caches']) {
          expect(writable).not.toContain(path.join(homeDir, tree));
        }
        // Still readable: the job runs the toolchains the user installed.
        const allowRead = profile.slice(profile.indexOf('(allow file-read*'), profile.indexOf('(deny file-read*'));
        expect(allowRead).toContain(`(subpath "${path.join(homeDir, '.cargo')}")`);
        expect(allowRead).toContain(`(subpath "${path.join(homeDir, '.rustup')}")`);
        expect(allowRead).toContain(`(subpath "${packages}")`);
      }
    );

    it('grants strict no package caches, even if handed one', () => {
      const packages = path.join(os.homedir(), '.localmost', 'runner', 'caches', 'aaaa1111', 'packages');
      const profile = profileWith({ filesystemPolicy: { level: 'strict', read: [], write: [] }, packageCacheDir: packages });
      expect(profile).not.toContain(packages);
    });

    it('grants no tool cache at all when the worker has none', () => {
      // Per-sandbox, or a worker with no target: the runner keeps its tools
      // in the job's own work directory, and no shared path is writable.
      const profile = profileWith({});
      expect(profile).not.toContain('tool-cache');
      expect(profile).not.toContain('/caches');
    });

    it('reads the OS paths xcrun needs without the whole of /var', () => {
      // xcrun resolves tools through xcodebuild, which links a framework that
      // lives under /Library/Apple; with its cache out of the shared temp it
      // has to be able to do that itself.
      const allowRead = ((p: string) => p.slice(p.indexOf('(allow file-read*'), p.indexOf('(deny file-read*')))(profileWith({}));
      expect(allowRead).toContain('(subpath "/Library/Apple")');
      expect(allowRead).toContain('(subpath "/private/var/db")');
      expect(allowRead).toContain('(subpath "/private/var/select")');
      expect(allowRead).not.toContain('(subpath "/var")');
    });

    it('looks the per-user temp up again after a failed lookup, and says why it has none', () => {
      // A transient getconf failure must not leave every later job without
      // bare mktemp until the app restarts, and the missing grant must be
      // explained somewhere.
      let calls = 0;
      const onLog = jest.fn();
      const [first, second] = profilesWith([{ onLog }, { onLog }], () => {
        calls += 1;
        if (calls === 1) throw new Error('getconf: interrupted');
        return '/var/folders/zz/zyxw_vut0000gn/T/\n';
      });
      expect(first).not.toContain('(regex');
      expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('getconf: interrupted'));
      expect(second).toContain('(regex');
    });
  });

  describe("the runner profile's reach into other processes", () => {
    it('lets a job signal only the processes in its own sandbox', () => {
      // A bare (allow signal) let a job kill or stop any process the user
      // runs - the app, an editor, another worker's job. Its own children
      // and its own process group inherit its sandbox, so they stay in reach.
      const profile = profileWith({});
      expect(profile).toContain('(allow signal (target same-sandbox))');
      expect(profile).not.toMatch(/^\(allow signal\)$/m);
    });

    it("denies this app's own MachPortRendezvousServer, by this process's pid", () => {
      // Chromium's browser process serves its child processes their ports
      // under <bundle id>.MachPortRendezvousServer.<pid>. A job has no
      // business with it, and (allow mach*) would otherwise reach it. Matched
      // on the pid rather than a hardcoded bundle id: a development build runs
      // as Electron's own bundle, and a signed one may carry a team prefix.
      const profile = profileWith({});
      const rule = `(deny mach-lookup (global-name-regex #"\\.MachPortRendezvousServer\\.${process.pid}$"))`;
      expect(profile).toContain(rule);
      expect(profile.indexOf(rule)).toBeGreaterThan(profile.indexOf('(allow mach*)'));
      const pattern = new RegExp(`\\.MachPortRendezvousServer\\.${process.pid}$`);
      expect(pattern.test(`com.localmost.app.MachPortRendezvousServer.${process.pid}`)).toBe(true);
      expect(pattern.test(`com.github.Electron.MachPortRendezvousServer.${process.pid}`)).toBe(true);
      // Nobody else's: another process's server, or a pid that merely starts
      // with this one, stays reachable for the job's own browsers.
      expect(pattern.test(`com.google.Chrome.MachPortRendezvousServer.${process.pid}1`)).toBe(false);
      expect(pattern.test(`com.localmost.app.MachPortRendezvousServer.${process.pid + 1}`)).toBe(false);
    });

    it("ends with its spawn's process marker, after every grant and deny, whatever the policy", () => {
      // The marker is how the app finds what a finished job left running, in
      // or out of its process group: a profile that reads one file and not
      // its twin. Last, so neither a policy path nor the app directory rules
      // can change which of the two it reads.
      const pids = path.join(os.homedir(), '.localmost', 'runner', 'pids');
      const processMarker = { granted: path.join(pids, '1-ab.granted'), withheld: path.join(pids, '1-ab.withheld') };
      const profile = profileWith({
        processMarker,
        filesystemPolicy: { level: 'permissive', read: [pids], write: [pids], deny: [processMarker.granted] },
      });
      const rules = profile.trimEnd().split('\n').filter((line) => line.startsWith('('));
      expect(rules.slice(-2)).toEqual([
        `(deny file-read* (literal "${processMarker.withheld}"))`,
        `(allow file-read* (literal "${processMarker.granted}"))`,
      ]);
      expect(permits(profile, 'file-read*', processMarker.granted)).toBe(true);
      expect(permits(profile, 'file-read*', processMarker.withheld)).toBe(false);
      // Read, never written: the job cannot touch the files themselves.
      expect(permits(profile, 'file-write*', processMarker.granted)).toBe(false);
      expect(profileWith({})).not.toMatch(/\.granted"|\.withheld"/);
    });
  });

  describe("the app's own data directories", () => {
    const appDir = path.join(os.homedir(), '.localmost');
    const runnerDir = path.join(appDir, 'runner');
    // Where the electron mock puts Electron's userData directory.
    const userDataDir = '/tmp/test';
    const ownToolCache = path.join(runnerDir, 'caches', 'aaaa1111', 'tool-cache');
    const ownPackages = path.join(runnerDir, 'caches', 'aaaa1111', 'packages');

    it('never lets a job read or write them, apart from its own sandbox and caches', () => {
      // Logs, job history, the CLI binary the user runs, other workers'
      // sandboxes and whatever is added there later: none of it is the job's,
      // and a job that can write the app's directories can plant what the app
      // or the user later trusts. Denied after every grant, so a policy that
      // names them outright reaches nothing in them.
      const dockerSocket = path.join(instanceDir, 'docker.sock');
      const profile = profileWith({
        filesystemPolicy: {
          level: 'moderate',
          read: ['~/.localmost', userDataDir],
          write: ['/opt/out', '~/.localmost', userDataDir],
        },
        dockerSocket,
        toolCacheDir: ownToolCache,
        packageCacheDir: ownPackages,
      });
      expect(profile).toContain(`(deny file-read* file-write*\n  (subpath "${appDir}")\n  (subpath "${userDataDir}"))`);
      for (const target of [
        path.join(appDir, 'logs', 'main.log'),
        path.join(appDir, 'job-history.json'),
        path.join(appDir, 'bin', 'localmost'),
        path.join(appDir, 'something-added-later'),
        path.join(runnerDir, 'sandbox', '2', 'token'),
        path.join(runnerDir, 'caches', 'bbbb2222', 'tool-cache', 'node'),
        path.join(userDataDir, 'Local State'),
        path.join(userDataDir, 'credentials'),
      ]) {
        expect(writable(profile, target)).toBe(false);
        expect(readable(profile, target)).toBe(false);
      }
      expect(writable(profile, path.join(instanceDir, '_work', 'out'))).toBe(true);
      expect(readable(profile, path.join(instanceDir, '_work', 'main.c'))).toBe(true);
      expect(writable(profile, path.join(ownToolCache, 'node'))).toBe(true);
      expect(readable(profile, path.join(ownToolCache, 'node'))).toBe(true);
      expect(writable(profile, path.join(ownPackages, 'cargo', 'registry'))).toBe(true);
      expect(writable(profile, '/opt/out/artifact')).toBe(true);
      expect(writable(profile, dockerSocket)).toBe(false);
      expect(readable(profile, dockerSocket)).toBe(true);
    });

    it('keeps a policy path that is, contains, or lies inside either of them, less the directories themselves', () => {
      // A grant of ~ contains ~/.localmost, and one of ~/Library contains
      // Electron's directory (here /tmp contains the mock's). What such a
      // grant covers beyond them is what was approved, so it is granted; the
      // app's directories are denied after it, and only the job's own sandbox
      // and caches given back.
      const onLog = jest.fn();
      const covering = ['~', '/', '/Users', '/tmp', '~/.localmost', '~/.localmost/logs', userDataDir, `${userDataDir}/Cookies`];
      const profile = profileWith({
        filesystemPolicy: { level: 'strict', read: covering, write: covering },
        toolCacheDir: ownToolCache,
        proxyPort: 45678,
        onLog,
      });
      for (const target of [
        path.join(os.homedir(), 'project', 'README'),
        path.join(os.homedir(), 'Library', 'Application Support', 'another-app', 'state'),
        '/tmp/elsewhere/file',
        '/opt/file',
      ]) {
        expect(readable(profile, target)).toBe(true);
        expect(writable(profile, target)).toBe(true);
      }
      for (const target of [
        path.join(appDir, 'logs', 'main.log'),
        path.join(appDir, 'config.yaml'),
        path.join(runnerDir, 'sandbox', '2', 'token'),
        path.join(runnerDir, 'caches', 'bbbb2222', 'tool-cache', 'node'),
        path.join(userDataDir, 'Cookies'),
        userDataDir,
        appDir,
      ]) {
        expect(writable(profile, target)).toBe(false);
      }
      for (const target of [
        path.join(appDir, 'logs', 'main.log'),
        path.join(runnerDir, 'sandbox', '2', 'token'),
        path.join(runnerDir, 'sandbox', '2'),
        path.join(userDataDir, 'Cookies'),
        userDataDir,
      ]) {
        expect(readable(profile, target)).toBe(false);
      }
      // The credentials a developer machine keeps stay closed as ever.
      expect(readable(profile, path.join(os.homedir(), '.ssh', 'id_ed25519'))).toBe(false);
      // The job's own, and the way down to it.
      expect(writable(profile, path.join(instanceDir, '_work', 'out'))).toBe(true);
      expect(writable(profile, path.join(ownToolCache, 'node'))).toBe(true);
      for (const node of [appDir, runnerDir, path.join(runnerDir, 'sandbox'), path.join(runnerDir, 'caches')]) {
        expect(readable(profile, node)).toBe(true);
      }
      // Kept, and said to be narrowed, not refused.
      for (const entry of covering) {
        expect(onLog).toHaveBeenCalledWith('debug', expect.stringContaining(`app's own directories, which stay closed to the job: ${entry}`));
      }
      expect(onLog).not.toHaveBeenCalledWith('error', expect.anything());
    });

    it('never lets a job rename a directory above them, whatever the policy grants', () => {
      // The deny of the app's directories matches paths. Renaming the
      // directory above one moves it out from under the deny, where the job
      // reads and writes it under the new name before moving it back - or
      // leaves a link in its place for the app to write through. So the
      // directories above them are closed to writes as nodes, after every
      // grant; what is inside them stays as granted.
      const covering = ['~', '/', '/Users', '/tmp'];
      const profile = profileWith({
        filesystemPolicy: { level: 'strict', read: covering, write: covering },
        toolCacheDir: ownToolCache,
      });
      for (const node of [os.homedir(), path.dirname(os.homedir()), '/tmp']) {
        expect(writable(profile, node)).toBe(false);
      }
      for (const target of [
        path.join(os.homedir(), 'project'),
        path.join(os.homedir(), 'Library', 'Application Support', 'another-app'),
        path.join(path.dirname(os.homedir()), 'Shared', 'file'),
        '/tmp/elsewhere',
      ]) {
        expect(writable(profile, target)).toBe(true);
      }
      // Nodes, not subtrees: the job's own sandbox and caches are as before.
      expect(writable(profile, path.join(instanceDir, '_work', 'out'))).toBe(true);
      expect(writable(profile, path.join(ownToolCache, 'node'))).toBe(true);
    });

    it('notes a grant that reaches them in another case, since seatbelt matches it all the same', () => {
      // On the default APFS volume seatbelt matches a path whatever its case,
      // so ~/.LOCALMOST grants what ~/.localmost would, and the deny of the
      // app's directories takes it back the same way.
      const onLog = jest.fn();
      const spellings = [
        '~/.LOCALMOST',
        '~/.LocalMost/runner/sandbox',
        os.homedir().toUpperCase(),
        '/TMP/TEST/Cookies',
        '/Tmp',
      ];
      const profile = profileWith({
        filesystemPolicy: { level: 'strict', read: spellings, write: spellings },
        onLog,
      });
      for (const entry of spellings) {
        const expanded = entry.startsWith('~') ? path.join(os.homedir(), entry.slice(1)) : entry;
        expect(profile).toContain(`(subpath "${expanded}")`);
        expect(onLog).toHaveBeenCalledWith('debug', expect.stringContaining(entry));
      }
      // Granted before the deny, so the deny is what matches last.
      expect(profile.indexOf('(deny file-read* file-write*')).toBeGreaterThan(profile.lastIndexOf('(subpath "/Tmp")'));
    });

    it('notes a grant of the app directory spelled in another Unicode form, and denies the directory after it', () => {
      const previous = process.env.LOCALMOST_CONFIG_DIR;
      process.env.LOCALMOST_CONFIG_DIR = '/opt/café';
      try {
        // The same directory, its é decomposed into e and a combining accent.
        const decomposed = '/opt/cafe\u0301/runner/sandbox';
        const onLog = jest.fn();
        let profile = '';
        jest.isolateModules(() => {
          const { generateSandboxProfile } = require('./process-sandbox');
          profile = generateSandboxProfile({
            instanceDir: '/opt/café/runner/sandbox/1',
            filesystemPolicy: { level: 'strict', read: [decomposed, '/opt/other'], write: [] },
            onLog,
          });
        });
        expect(onLog).toHaveBeenCalledWith('debug', expect.stringContaining(decomposed));
        expect(onLog).not.toHaveBeenCalledWith('debug', expect.stringContaining('/opt/other'));
        const deny = profile.indexOf('(deny file-read* file-write*\n  (subpath "/opt/café")');
        expect(deny).toBeGreaterThan(profile.indexOf(`(subpath "${decomposed}")`));
        expect(readable(profile, '/opt/café/runner/sandbox/2/token')).toBe(false);
        expect(readable(profile, '/opt/café/runner/sandbox/1/run.sh')).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
        else process.env.LOCALMOST_CONFIG_DIR = previous;
      }
    });

    it('denies each directory by its real path too, even one not created yet', () => {
      // seatbelt matches the real path: /tmp is a symlink to /private/tmp, so
      // a deny of /tmp/... alone would not stop a grant of /private/tmp. And a
      // directory the app has yet to create is where a job granted its parent
      // could plant what the app would then trust.
      const previous = process.env.LOCALMOST_CONFIG_DIR;
      const unborn = `/tmp/localmost-unborn-${process.pid}/app`;
      process.env.LOCALMOST_CONFIG_DIR = unborn;
      try {
        let profile = '';
        jest.isolateModules(() => {
          jest.doMock('fs', () => jest.requireActual('fs'));
          const { generateSandboxProfile } = require('./process-sandbox');
          profile = generateSandboxProfile({
            instanceDir: `${unborn}/runner/sandbox/1`,
            filesystemPolicy: { level: 'strict', read: ['/private/tmp'], write: ['/private/tmp'] },
          });
        });
        // The deny of the app's directories, after the credentials' own.
        const deny = profile.slice(profile.indexOf('(deny file-read* file-write*', profile.indexOf(';; Never readable or writable, whatever was granted')));
        const denied = deny.slice(0, deny.indexOf('))\n') + 2);
        expect(denied).toContain(`(subpath "${unborn}")`);
        expect(denied).toContain(`(subpath "/private${unborn}")`);
        // Electron's directory, which the mock puts at /tmp/test.
        expect(denied).toContain(`(subpath "${userDataDir}")`);
        expect(denied).toContain(`(subpath "/private${userDataDir}")`);
        expect(writable(profile, `/private${unborn}/runner/arc/run.sh`)).toBe(false);
        expect(readable(profile, `/private${userDataDir}/Cookies`)).toBe(false);
        expect(writable(profile, '/private/tmp/elsewhere')).toBe(true);
        // Nor the directory on the way to it that is not there yet either,
        // where a link planted now would carry the app's directory elsewhere.
        expect(writable(profile, path.dirname(unborn))).toBe(false);
        expect(writable(profile, `/private${path.dirname(unborn)}`)).toBe(false);
        expect(writable(profile, `/private${path.dirname(unborn)}-sibling`)).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
        else process.env.LOCALMOST_CONFIG_DIR = previous;
      }
    });

    it("refuses to build a profile when an app directory's real path cannot be looked up", () => {
      // Only a directory that is not there yet is walked up from; any other
      // failure leaves the spelling seatbelt matches unknown, and a deny
      // under the wrong one would not hold.
      let build: () => string = () => '';
      jest.isolateModules(() => {
        jest.doMock('fs', () => ({
          ...jest.requireActual('fs'),
          realpathSync: jest.fn(() => {
            throw Object.assign(new Error('EACCES: permission denied, realpath'), { code: 'EACCES' });
          }),
        }));
        const { generateSandboxProfile } = require('./process-sandbox');
        build = () => generateSandboxProfile({ instanceDir });
      });
      expect(build).toThrow(/EACCES/);
    });
  });

  describe('policy deny paths', () => {
    it('refuses reading and writing what a deny names, over every grant', () => {
      const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
      const profile = profileWith({
        filesystemPolicy: {
          level: 'moderate',
          read: ['/opt/data'],
          write: ['/opt/out'],
          deny: ['/opt/out/secret', '/opt/data/private', '~/.cargo/bin'],
        },
      });
      expect(writable(profile, '/opt/out/artifact')).toBe(true);
      expect(writable(profile, '/opt/out/secret/key')).toBe(false);
      expect(readable(profile, '/opt/out/secret/key')).toBe(false);
      expect(readable(profile, '/opt/data/table')).toBe(true);
      expect(readable(profile, '/opt/data/private/table')).toBe(false);
      // A toolchain grant is narrowed too, with ~ expanded as grants are.
      expect(readable(profile, path.join(os.homedir(), '.cargo', 'registry', 'index'))).toBe(true);
      expect(readable(profile, path.join(cargoBin, 'cargo'))).toBe(false);
      // After the grants it narrows, so the last matching rule is the deny.
      const deny = profile.indexOf('(deny file-read* file-write*');
      expect(deny).toBeGreaterThan(profile.indexOf('(subpath "/opt/data")'));
      expect(deny).toBeGreaterThan(profile.indexOf('(subpath "/opt/out")'));
    });

    it("cannot take the job's own sandbox from it", () => {
      // The job's own sandbox is re-allowed after the deny: a deny that
      // covered it would only stop the runner from starting.
      const profile = profileWith({
        filesystemPolicy: { level: 'strict', read: [], write: [], deny: [path.join(instanceDir, '_work')] },
      });
      const deny = profile.indexOf('(deny file-read* file-write*');
      const reallow = profile.indexOf(`(allow file-read* file-write*\n  (subpath "${instanceDir}"))`);
      expect(deny).toBeGreaterThan(-1);
      expect(reallow).toBeGreaterThan(deny);
      expect(writable(profile, path.join(instanceDir, '_work', 'repo', 'out.o'))).toBe(true);
      expect(readable(profile, path.join(instanceDir, '_work', 'repo', 'main.c'))).toBe(true);
    });

    it('is not overridden by the directory nodes given back in the app directory', () => {
      // The nodes on the way down to the job's sandbox are given back before
      // the policy's denies, so a deny over them stands: the job may then
      // fail to start, but it does not get what its policy refused.
      const runnerDir = path.join(os.homedir(), '.localmost', 'runner');
      const profile = profileWith({
        filesystemPolicy: { level: 'strict', read: [], write: [], deny: [runnerDir] },
      });
      expect(readable(profile, runnerDir)).toBe(false);
      expect(readable(profile, path.join(runnerDir, 'sandbox'))).toBe(false);
      expect(readable(profile, path.join(instanceDir, 'run.sh'))).toBe(true);
    });

    /** Build a runner profile with every path's real spelling looked up on this machine. */
    const profileWithRealPaths = (options: Record<string, unknown>): string => {
      let profile = '';
      jest.isolateModules(() => {
        jest.doMock('fs', () => jest.requireActual('fs'));
        const { generateSandboxProfile } = require('./process-sandbox');
        profile = generateSandboxProfile({ instanceDir, ...options });
      });
      return profile;
    };

    it('keeps a deny that covers the app directories, since a deny only narrows', () => {
      // Dropping it would quietly widen what the approved policy says: /tmp
      // contains the mock's userData directory. Denied by its real path too,
      // the one seatbelt matches.
      const profile = profileWithRealPaths({
        filesystemPolicy: { level: 'strict', read: [], write: [], deny: ['/tmp', '~/.localmost/logs'] },
      });
      const denyRule = profile.slice(profile.lastIndexOf('(deny file-read* file-write*'));
      expect(denyRule).toContain('(subpath "/private/tmp")');
      expect(denyRule).toContain(`(subpath "${path.join(os.homedir(), '.localmost', 'logs')}")`);
    });

    it('refuses what a glob deny matches, and only that', () => {
      // A * entry written as a subpath named a file called "*.pem", which
      // nothing is: every .pem stayed readable and writable.
      const profile = profileWith({
        filesystemPolicy: {
          level: 'strict',
          read: ['/opt/out'],
          write: ['/opt/out'],
          deny: ['/opt/out/*.pem', '/opt/out/keys-*'],
        },
      });
      expect(readable(profile, '/opt/out/server.pem')).toBe(false);
      expect(writable(profile, '/opt/out/server.pem')).toBe(false);
      expect(readable(profile, '/opt/out/nested/client.pem')).toBe(false);
      expect(readable(profile, '/opt/out/keys-prod/id')).toBe(false);
      // What lies beneath a match too, as beneath a deny with no *.
      expect(readable(profile, '/opt/out/bundle.pem/key')).toBe(false);
      // Everything but the * is literal: the dot is a dot.
      expect(readable(profile, '/opt/out/serverXpem')).toBe(true);
      expect(writable(profile, '/opt/out/server.pem.txt')).toBe(true);
      expect(readable(profile, '/opt/out/keys')).toBe(true);
      expect(profile).not.toContain('(subpath "/opt/out/*.pem")');
    });

    it('denies a path reached through a symlink by its real path too', () => {
      // seatbelt matches the real path: /tmp, /etc and /var are symlinks into
      // /private, and the profile grants /private/etc, so a deny under the
      // spelling written alone matched nothing the job opened.
      const profile = profileWithRealPaths({
        filesystemPolicy: {
          level: 'strict',
          read: ['/private/tmp'],
          write: ['/private/tmp'],
          deny: ['/tmp/localmost-deny/x', '/etc/ssl/private', '/tmp/localmost-deny/*.pem'],
        },
      });
      const denyRule = profile.slice(profile.lastIndexOf('(deny file-read* file-write*'));
      expect(denyRule).toContain('(subpath "/tmp/localmost-deny/x")');
      expect(denyRule).toContain('(subpath "/private/tmp/localmost-deny/x")');
      expect(readable(profile, '/private/tmp/localmost-deny/x/key')).toBe(false);
      expect(writable(profile, '/private/tmp/localmost-deny/x/key')).toBe(false);
      expect(readable(profile, '/private/etc/ssl/private/key.pem')).toBe(false);
      expect(readable(profile, '/private/etc/ssl/cert.pem')).toBe(true);
      expect(readable(profile, '/private/tmp/localmost-deny/server.pem')).toBe(false);
      expect(writable(profile, '/private/tmp/localmost-deny/other')).toBe(true);
    });

    it('denies writing the directories above a deny, so renaming one cannot carry it away', () => {
      // A deny matches paths: granted /opt/out, a job could rename out/a to
      // out/b and read out/b/secret, or out/g to out/h and read every .pem.
      const profile = profileWith({
        filesystemPolicy: {
          level: 'strict', read: ['/opt/out'], write: ['/opt/out'], deny: ['/opt/out/a/secret', '/opt/out/g/*.pem'],
        },
      });
      for (const node of ['/opt/out/a', '/opt/out/g', '/opt/out', '/opt']) {
        expect(writable(profile, node)).toBe(false);
      }
      // Nodes, not what is in them: the grant still writes beside the secret.
      expect(writable(profile, '/opt/out/a/built')).toBe(true);
      expect(writable(profile, '/opt/out/g/built.txt')).toBe(true);
      expect(writable(profile, '/opt/out/other/built')).toBe(true);
      expect(readable(profile, '/opt/out/a')).toBe(true);
    });

    it('builds a deny it cannot look up beneath, denied as written and by the real path of what it can', () => {
      // A component the app cannot look up - unsearchable, or a symlink loop
      // anyone could plant above a deny - is one the job cannot pass through
      // either. Throwing there stopped every spawn for the repository.
      // Written through a link, as /tmp is one into /private, so it has two
      // spellings. Built under the real temp directory: a job may not write /tmp.
      const actualFs = jest.requireActual<typeof import('fs')>('fs');
      const base = actualFs.realpathSync(actualFs.mkdtempSync(path.join(os.tmpdir(), 'localmost-unresolvable-')));
      const real = path.join(base, 'real');
      const written = path.join(base, 'written');
      actualFs.mkdirSync(path.join(real, 'locked', 'inner'), { recursive: true });
      actualFs.symlinkSync('real', written);
      actualFs.symlinkSync('loop', path.join(real, 'loop'));
      actualFs.chmodSync(path.join(real, 'locked'), 0o000);
      try {
        const profile = profileWithRealPaths({
          filesystemPolicy: {
            level: 'strict', read: [], write: [], deny: [`${written}/locked/inner/secret`, `${written}/loop/secret`],
          },
        });
        const denyRule = profile.slice(profile.lastIndexOf('(deny file-read* file-write*'));
        for (const spelling of [written, real]) {
          expect(denyRule).toContain(`(subpath "${spelling}/locked/inner/secret")`);
          expect(denyRule).toContain(`(subpath "${spelling}/loop/secret")`);
          expect(writable(profile, `${spelling}/locked/inner`)).toBe(false);
        }
      } finally {
        actualFs.chmodSync(path.join(real, 'locked'), 0o755);
        actualFs.rmSync(base, { recursive: true, force: true });
      }
    });

    it('escapes deny paths, and resolves a traversing one rather than dropping it', () => {
      // Dropping a deny widens the approved policy, so an absolute one with
      // ".." is kept, resolved as seatbelt would resolve the path it guards.
      const profile = profileWith({
        filesystemPolicy: { level: 'strict', read: [], write: [], deny: ['/opt/a"b', '/opt/data/../etc'] },
      });
      const denyRule = profile.slice(profile.indexOf('(deny file-read* file-write*'));
      expect(denyRule).toContain('(subpath "/opt/a\\"b")');
      expect(denyRule).toContain('(subpath "/opt/etc")');
      expect(profile).not.toContain('/opt/data/../etc');
      // And none at all when the policy denies nothing.
      expect(profileWith({})).toContain(';; No policy-declared deny paths');
    });

    it('says a relative deny has no effect, since seatbelt never matches a relative path', () => {
      const onLog = jest.fn();
      const profile = profileWith({
        filesystemPolicy: { level: 'strict', read: [], write: [], deny: ['build/secret', '../up', '/opt/kept'] },
        onLog,
      });
      expect(profile).not.toContain('(subpath "build/secret")');
      expect(profile).not.toContain('../up');
      expect(profile).toContain('(subpath "/opt/kept")');
      expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('build/secret'));
      expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('../up'));
    });

    it('refuses to build a profile from a deny list that is not a list', () => {
      // Dropping it would widen the approved policy, so the spawn fails with
      // a message saying why rather than running the job without its denies.
      expect(() => profileWith({
        filesystemPolicy: { level: 'strict', read: [], write: [], deny: '/opt/secret' },
      })).toThrow(/deny list is not a list/);
    });
  });

  describe('loopback', () => {
    const proxyPort = 45678;
    const allowsRemote = (profile: string, spec: string) =>
      profile.includes(`(allow network-outbound (remote ip "localhost:${spec}"))`);

    it("reaches only this worker's own proxy by default", () => {
      // Loopback reaches every service on the machine: databases, a debugger
      // on 9229, a browser's remote debugging on 9222, local proxies. The
      // proxy is the one a job always needs.
      const profile = profileWith({ proxyPort });
      expect(allowsRemote(profile, String(proxyPort))).toBe(true);
      expect(profile).not.toContain('(remote ip "localhost:*")');
      expect(profile.match(/\(remote ip "localhost:\d+"\)/g)?.sort()).toEqual(
        [`(remote ip "localhost:${proxyPort}")`, '(remote ip "localhost:8787")'].sort()
      );
    });

    it('opens the ports a repository declares, or all of loopback when it declares true', () => {
      const listed = profileWith({
        proxyPort,
        filesystemPolicy: { level: 'strict', read: [], write: [], loopback: [5432, 6379] },
      });
      expect(allowsRemote(listed, String(proxyPort))).toBe(true);
      expect(allowsRemote(listed, '5432')).toBe(true);
      expect(allowsRemote(listed, '6379')).toBe(true);
      expect(listed).not.toContain('(remote ip "localhost:*")');

      const all = profileWith({
        proxyPort,
        filesystemPolicy: { level: 'strict', read: [], write: [], loopback: true },
      });
      expect(allowsRemote(all, '*')).toBe(true);
    });

    it("opens the broker's port, which the runner dials directly", () => {
      // The runner's HTTP client sends a loopback destination around its
      // proxy, so its Listener opens its session and fetches its token from
      // the broker at 127.0.0.1:<broker port> itself. The per-worker key in
      // that address is what guards the broker, not a closed port: a job
      // reaches the same port through its own proxy anyway.
      for (const loopback of [undefined, [5432]] as const) {
        const profile = profileWith({
          proxyPort,
          filesystemPolicy: { level: 'strict', read: [], write: [], ...(loopback ? { loopback } : {}) },
        });
        expect(allowsRemote(profile, '8787')).toBe(true);
        expect(profile).not.toMatch(/\(deny network-outbound \(remote ip/);
      }
      expect(allowsRemote(profileWith({ proxyPort, brokerPort: 9999 }), '9999')).toBe(true);
    });

    it('opens no loopback at all without the proxy port, and says so', () => {
      // Failing closed: a worker spawned without its proxy port cannot reach
      // anything, rather than reaching everything on loopback.
      for (const loopback of [undefined, [5432]]) {
        const onLog = jest.fn();
        const profile = profileWith({
          filesystemPolicy: { level: 'strict', read: [], write: [], ...(loopback ? { loopback } : {}) },
          onLog,
        });
        expect(profile).not.toMatch(/\(allow network-outbound \(remote ip/);
        expect(onLog).toHaveBeenCalledWith('error', expect.stringMatching(/proxy port/));
      }
      // Declaring all of loopback covers the proxy wherever it is.
      const all = profileWith({ filesystemPolicy: { level: 'strict', read: [], write: [], loopback: true } });
      expect(allowsRemote(all, '*')).toBe(true);
      // Registration has no proxy and is open to every destination anyway,
      // so the missing port is not worth an error there.
      const onLog = jest.fn();
      profileWith({ allowDirectNetwork: true, onLog });
      expect(onLog).not.toHaveBeenCalledWith('error', expect.stringMatching(/proxy port/));
    });

    it('drops a declared loopback port that is not a port', () => {
      const profile = profileWith({
        proxyPort,
        filesystemPolicy: { level: 'strict', read: [], write: [], loopback: [0, 70000, 1.5, -1, 5432] },
      });
      const ports = [...profile.matchAll(/\(remote ip "localhost:([^"]+)"\)/g)].map((m) => m[1]).sort();
      expect(ports).toEqual([String(proxyPort), '5432', '8787'].sort());
    });

    it('drops a loopback declaration that is neither true nor a list, and says so', () => {
      // Narrowing is the safe direction: the job keeps its proxy and nothing
      // else, rather than the spawn failing on the value.
      for (const loopback of ['true', '5432', { 5432: true }, false]) {
        const onLog = jest.fn();
        const profile = profileWith({
          proxyPort,
          filesystemPolicy: { level: 'strict', read: [], write: [], loopback },
          onLog,
        });
        const ports = [...profile.matchAll(/\(remote ip "localhost:([^"]+)"\)/g)].map((m) => m[1]).sort();
        expect(ports).toEqual([String(proxyPort), '8787'].sort());
        expect(onLog).toHaveBeenCalledWith('error', expect.stringMatching(/loopback/));
      }
    });

    it('says, in a registration profile, that the network is direct rather than closed', () => {
      const profile = profileWith({ allowDirectNetwork: true });
      expect(profile).not.toContain('nothing on loopback is reachable');
      expect(profile).toContain('(allow network-outbound)');
    });

    it('passes the proxy port to the profile, not to the spawned process', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const localMockSpawn = jest.fn().mockReturnValue(createMockProcess(12361));
        const mockWriteFileSync = jest.fn();
        jest.doMock('child_process', () => ({ spawn: localMockSpawn, execFileSync: jest.fn(() => '') }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: mockWriteFileSync,
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));
        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');
        sandboxedSpawn(path.join(instanceDir, 'run.sh'), [], { cwd: instanceDir, proxyPort });
        expect(mockWriteFileSync.mock.calls[0][1]).toContain(`(remote ip "localhost:${proxyPort}")`);
        expect(localMockSpawn.mock.calls[0][2]).not.toHaveProperty('proxyPort');
      });
    });
  });

    it('should use sandbox-exec on macOS', () => {
      // Re-require after platform change
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const mockProcess = createMockProcess(12349);
        const localMockSpawn = jest.fn().mockReturnValue(mockProcess);
        const mockWriteFileSync = jest.fn();
        jest.doMock('child_process', () => ({ spawn: localMockSpawn }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: mockWriteFileSync,
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');

        const runnerPath = path.join(mockRunnerDir, 'run.sh');
        sandboxedSpawn(runnerPath, ['--arg1'], { cwd: mockRunnerDir });

        // Profile is written to a temp file and passed via -f flag
        expect(mockWriteFileSync).toHaveBeenCalled();
        expect(localMockSpawn).toHaveBeenCalledWith(
          '/usr/bin/sandbox-exec',
          expect.arrayContaining(['-f', expect.stringContaining('sandbox-profile'), runnerPath, '--arg1']),
          expect.objectContaining({ cwd: mockRunnerDir, shell: false })
        );
      });
    });

    it('should generate sandbox profile with correct structure', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const mockProcess = createMockProcess(12350);
        const localMockSpawn = jest.fn().mockReturnValue(mockProcess);
        const mockWriteFileSync = jest.fn();
        jest.doMock('child_process', () => ({ spawn: localMockSpawn }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: mockWriteFileSync,
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');

        const instanceDir = path.join(os.homedir(), '.localmost', 'runner-2');
        const runnerPath = path.join(instanceDir, 'run.sh');
        sandboxedSpawn(runnerPath, [], { cwd: instanceDir, proxyPort: 45678 });

        // Get the profile from the writeFileSync call
        const profile = mockWriteFileSync.mock.calls[0][1];

        expect(profile).toContain('(deny default)');
        expect(profile).toContain('(trace "/dev/stderr")');

        // Egress goes through the filtering proxy or nowhere. Raw sockets made
        // the host policy advisory: a workflow could ignore HTTP_PROXY and
        // connect straight out, which is exactly what the policy forbids.
        expect(profile).toContain('(deny network*)');
        expect(profile).not.toContain('(allow network*)');
        // This worker's proxy only, on loopback. A job that ignores
        // HTTP_PROXY reaches nothing, not even the rest of loopback.
        expect(profile).toContain('(allow network-outbound (remote ip "localhost:45678"))');
        expect(profile).not.toContain('(remote ip "localhost:*")');
        // The escape hatch for runner registration stays off unless asked for.
        expect(profile).not.toMatch(/\(allow network-outbound\)\s*$/m);

        // The app's own control plane is never writable by a job: a job that
        // can write the approval cache can approve its own policy.
        expect(profile).toContain('(deny file-read* file-write*');
        expect(writable(profile, path.join(os.homedir(), '.localmost', 'policies', 'owner-repo.json'))).toBe(false);
      });
    });

    it('removes the profile even when the sandboxed process fails', () => {
      // Profiles moved out of the system temp directory, which the OS clears,
      // into the app's own. Keeping them on failure accumulated them forever.
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const mockProcess = createMockProcess(12355);
        const localMockSpawn = jest.fn().mockReturnValue(mockProcess);
        const mockUnlinkSync = jest.fn();
        jest.doMock('child_process', () => ({ spawn: localMockSpawn }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: jest.fn(),
          unlinkSync: mockUnlinkSync,
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');
        const instanceDir = path.join(os.homedir(), '.localmost', 'runner-2');
        sandboxedSpawn(path.join(instanceDir, 'run.sh'), [], { cwd: instanceDir });

        // A non-zero exit: a profile denial, a signal, a runner crash.
        mockProcess.emit('exit', 1, null);

        expect(mockUnlinkSync).toHaveBeenCalled();
      });
    });

    it('opens direct egress only when registration asks for it', () => {
      // Runner registration reaches GitHub without a proxy. If this stopped
      // being emitted, adding a repository would fail with no obvious cause.
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const mockProcess = createMockProcess(12354);
        const localMockSpawn = jest.fn().mockReturnValue(mockProcess);
        const mockWriteFileSync = jest.fn();
        jest.doMock('child_process', () => ({ spawn: localMockSpawn }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: mockWriteFileSync,
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');
        const instanceDir = path.join(os.homedir(), '.localmost', 'runner-2');
        sandboxedSpawn(path.join(instanceDir, 'config.sh'), [], {
          cwd: instanceDir,
          allowDirectNetwork: true,
        });
        const profile = mockWriteFileSync.mock.calls[0][1];

        expect(profile).toMatch(/^\(allow network-outbound\)$/m);
        // Still denies by default and still keeps the control plane closed.
        expect(profile).toContain('(deny network*)');
        expect(writable(profile, path.join(os.homedir(), '.localmost', 'policies', 'owner-repo.json'))).toBe(false);
      });
    });

    it('grants no toolchains or caches under strict', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const mockProcess = createMockProcess(12351);
        const localMockSpawn = jest.fn().mockReturnValue(mockProcess);
        const mockWriteFileSync = jest.fn();
        jest.doMock('child_process', () => ({ spawn: localMockSpawn }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: mockWriteFileSync,
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');
        const instanceDir = path.join(os.homedir(), '.localmost', 'runner-2');
        sandboxedSpawn(path.join(instanceDir, 'run.sh'), [], {
          cwd: instanceDir,
          filesystemPolicy: { level: 'strict', read: ['/opt/declared'], write: [] },
        });
        const profile = mockWriteFileSync.mock.calls[0][1];

        // Strict means what the repository declared, not a convenient default.
        expect(profile).toContain('(subpath "/opt/declared")');
        // The grants are gone; the credential denies for those trees remain,
        // so assert on the grant form rather than any mention of the path.
        expect(profile).not.toContain('(subpath "/opt/homebrew")');
        expect(profile).not.toContain(`(subpath "${path.join(os.homedir(), '.cargo')}")`);
        expect(profile).toContain(`${path.join(os.homedir(), '.cargo')}/credentials`);
      });
    });

    it('keeps toolchains and caches under moderate', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const mockProcess = createMockProcess(12352);
        const localMockSpawn = jest.fn().mockReturnValue(mockProcess);
        const mockWriteFileSync = jest.fn();
        jest.doMock('child_process', () => ({ spawn: localMockSpawn }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: mockWriteFileSync,
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');
        const instanceDir = path.join(os.homedir(), '.localmost', 'runner-2');
        sandboxedSpawn(path.join(instanceDir, 'run.sh'), [], {
          cwd: instanceDir,
          filesystemPolicy: { level: 'moderate', read: [], write: [] },
        });
        const profile = mockWriteFileSync.mock.calls[0][1];

        expect(profile).toContain('/opt/homebrew');
        expect(profile).toContain(path.join(os.homedir(), '.cargo'));
      });
    });

    it('never grants credentials kept inside those caches', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const mockProcess = createMockProcess(12353);
        const localMockSpawn = jest.fn().mockReturnValue(mockProcess);
        const mockWriteFileSync = jest.fn();
        jest.doMock('child_process', () => ({ spawn: localMockSpawn }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: mockWriteFileSync,
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');
        const instanceDir = path.join(os.homedir(), '.localmost', 'runner-2');
        sandboxedSpawn(path.join(instanceDir, 'run.sh'), [], {
          cwd: instanceDir,
          filesystemPolicy: { level: 'permissive', read: [], write: [] },
        });
        const profile = mockWriteFileSync.mock.calls[0][1];

        // Even at the loosest level the publishing credentials stay denied.
        expect(profile).toMatch(/deny file-read\*[\s\S]*settings\.xml/);
        expect(profile).toMatch(/deny file-read\*[\s\S]*gradle\.properties/);
      });
    });

    it('should restrict file writes to safe directories', () => {
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const mockProcess = createMockProcess(12352);
        const localMockSpawn = jest.fn().mockReturnValue(mockProcess);
        const mockWriteFileSync = jest.fn();
        jest.doMock('child_process', () => ({ spawn: localMockSpawn }));
        jest.doMock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          writeFileSync: mockWriteFileSync,
          unlinkSync: jest.fn(),
          mkdirSync: jest.fn(),
          realpathSync: jest.fn((p: string) => p),
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');

        const runnerPath = path.join(mockRunnerDir, 'run.sh');
        sandboxedSpawn(runnerPath, [], { cwd: mockRunnerDir });

        // Get the profile from the writeFileSync call
        const profile = mockWriteFileSync.mock.calls[0][1];

        // Profile restricts file writes to specific directories
        expect(profile).toContain('(allow file-write*');
        // Profile allows broad file reads
        expect(profile).toContain('(allow file-read*');
        // Profile should allow process operations
        expect(profile).toContain('(allow process*)');
        // Profile should include the runner directory for writes
        expect(profile).toContain('.localmost');
        // Not the shared temp directories: the job's temp is in its sandbox.
        expect(profile).not.toContain('(subpath "/private/var/folders")');
        expect(profile).not.toContain('(subpath "/private/tmp")');
      });
    });
  });



});
