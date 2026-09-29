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

  const instanceDir = path.join(os.homedir(), '.localmost', 'runner-3');
  const homeDir = os.homedir();

  /**
   * Build runner profiles for each set of sandbox options in turn, within one
   * load of the module, and return their text. `getconf` answers the per-user
   * temp directory lookup, or throws.
   */
  const profilesWith = (
    optionSets: Record<string, unknown>[],
    getconf: () => string = () => '/var/folders/zz/zyxw_vut0000gn/T/\n'
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
      const filters = [...body.matchAll(/\((subpath|literal|regex) #?"([^"]*)"\)/g)];
      const matches = filters.length === 0 || filters.some(([, kind, value]) =>
        kind === 'regex'
          ? new RegExp(value).test(target)
          : target === value || (kind === 'subpath' && target.startsWith(`${value}/`)));
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

    it('ignores a policy read or write path that resolves inside the runner directory', () => {
      // A repo policy has no business reaching the app's own runner dir - proxy
      // credentials, pids, other sandboxes. A declared read path there cannot be
      // fenced off by a profile deny without also blocking traversal into this
      // job's own sandbox, so such paths are dropped before the profile is built.
      const runnerDir = path.join(os.homedir(), '.localmost', 'runner');
      const profile = profileWith({
        filesystemPolicy: {
          level: 'strict',
          read: [path.join(runnerDir, 'sandbox'), `${runnerDir}/../runner/proxies`, '/tmp/legit-read'],
          write: [path.join(runnerDir, 'pids'), '/tmp/legit-write'],
        },
      });
      // The runner-internal paths are dropped from the policy allow blocks (the
      // write-deny block still names them, so scope the check to the allows).
      const allowRead = profile.slice(profile.indexOf('(allow file-read*'), profile.indexOf('(deny file-read*'));
      const policyWriteAllow = profile.slice(
        profile.indexOf('declares writable'),
        profile.indexOf('Never writable, whatever matched above')
      );
      expect(allowRead).not.toContain(`(subpath "${runnerDir}/sandbox")`);
      // A traversal spelling that resolves inside the runner dir is also dropped.
      expect(allowRead).not.toContain('/../runner/proxies');
      expect(allowRead).not.toContain(`(subpath "${runnerDir}/proxies")`);
      expect(policyWriteAllow).not.toContain(`(subpath "${runnerDir}/pids")`);
      // Legitimate declared paths outside the runner dir are still granted.
      expect(allowRead).toContain('(subpath "/tmp/legit-read")');
      expect(policyWriteAllow).toContain('(subpath "/tmp/legit-write")');
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
      const allowRead = profile.slice(profile.indexOf('(allow file-read*'), profile.indexOf('(deny file-read*'));
      // Reads use the directory nodes as literals for traversal, never the
      // runner dir or the sandbox root as a readable subtree.
      expect(allowRead).not.toContain(`(subpath "${runnerDir}")`);
      expect(allowRead).not.toContain(`(subpath "${runnerDir}/sandbox")`);
      // A traversal spelling that resolves inside the runner dir is also dropped.
      expect(allowRead).not.toContain('/../runner/proxies');
      expect(allowRead).not.toContain(`(subpath "${runnerDir}/proxies")`);
      expect(allowRead).toContain(`(literal "${runnerDir}")`);
      expect(allowRead).toContain(`(literal "${runnerDir}/sandbox")`);
      const denyRead = profile.slice(profile.indexOf('(deny file-read*'));
      expect(denyRead).toContain(`(subpath "${runnerDir}/proxies")`);
      expect(denyRead).toContain(`(subpath "${runnerDir}/config")`);
      expect(denyRead).toContain(`(subpath "${runnerDir}/sandbox-profiles")`);
      expect(denyRead).toContain(`(literal "${runnerDir}/broker-sessions.json")`);
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
      // Readable, and the directory nodes above it can be traversed.
      const allowRead = a.slice(a.indexOf('(allow file-read*'), a.indexOf('(deny file-read*'));
      expect(allowRead).toContain(`(subpath "${cacheA}")`);
      expect(allowRead).toContain(`(literal "${runnerDir}/caches")`);
      expect(allowRead).not.toContain(`(subpath "${runnerDir}/caches")`);
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
  });

  describe("the app's own data directories", () => {
    const appDir = path.join(os.homedir(), '.localmost');
    const runnerDir = path.join(appDir, 'runner');
    // Where the electron mock puts Electron's userData directory.
    const userDataDir = '/tmp/test';
    const ownToolCache = path.join(runnerDir, 'caches', 'aaaa1111', 'tool-cache');
    const ownPackages = path.join(runnerDir, 'caches', 'aaaa1111', 'packages');

    it('never lets a job write them, apart from its own sandbox and caches', () => {
      // Logs, job history, the CLI binary the user runs and whatever is added
      // there later: none of it is the job's, and a job that can write the
      // app's directories can plant what the app or the user later trusts.
      // The grants of both directories are dropped before the profile is
      // built; the deny that ends the write rules is the backstop behind that.
      const dockerSocket = path.join(instanceDir, 'docker.sock');
      const profile = profileWith({
        filesystemPolicy: { level: 'moderate', read: [], write: ['/opt/out', '~/.localmost', userDataDir] },
        dockerSocket,
        toolCacheDir: ownToolCache,
        packageCacheDir: ownPackages,
      });
      expect(profile).toContain(`(deny file-write*\n  (subpath "${appDir}")\n  (subpath "${userDataDir}"))`);
      for (const target of [
        path.join(appDir, 'logs', 'main.log'),
        path.join(appDir, 'job-history.json'),
        path.join(appDir, 'bin', 'localmost'),
        path.join(appDir, 'something-added-later'),
        path.join(userDataDir, 'Local State'),
        path.join(userDataDir, 'credentials'),
      ]) {
        expect(writable(profile, target)).toBe(false);
      }
      expect(writable(profile, path.join(instanceDir, '_work', 'out'))).toBe(true);
      expect(writable(profile, path.join(ownToolCache, 'node'))).toBe(true);
      expect(writable(profile, path.join(ownPackages, 'cargo', 'registry'))).toBe(true);
      expect(writable(profile, '/opt/out/artifact')).toBe(true);
      expect(writable(profile, dockerSocket)).toBe(false);
    });

    it('drops a policy path that is, contains, or lies inside either of them', () => {
      // A grant of ~ contains ~/.localmost: other workers' sandboxes, the
      // logs and the job history. It cannot be granted and then fenced off
      // without also cutting the way into the job's own sandbox, so it is
      // not granted. Relative workspace paths resolve inside the job's own
      // sandbox and are kept.
      const onLog = jest.fn();
      const dropped = ['~', '/', '~/.localmost', '~/.localmost/logs', userDataDir, `${userDataDir}/Cookies`, '/tmp'];
      const profile = profileWith({
        filesystemPolicy: { level: 'strict', read: [...dropped, '/opt/keep', './build'], write: [...dropped, '/opt/out'] },
        onLog,
      });
      const allowRead = profile.slice(profile.indexOf('(allow file-read*'), profile.indexOf('(deny file-read*'));
      const policyWriteAllow = profile.slice(profile.indexOf('declares writable'), profile.indexOf('(allow file-read*'));
      for (const entry of dropped) {
        const expanded = entry.startsWith('~') ? path.join(os.homedir(), entry.slice(1)) : entry;
        expect(allowRead).not.toContain(`(subpath "${expanded}")`);
        expect(policyWriteAllow).not.toContain(`(subpath "${expanded}")`);
        expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining(entry));
      }
      expect(readable(profile, path.join(os.homedir(), 'project', 'README'))).toBe(false);
      expect(allowRead).toContain('(subpath "/opt/keep")');
      expect(allowRead).toContain('(subpath "./build")');
      expect(policyWriteAllow).toContain('(subpath "/opt/out")');
    });

    it('drops them whatever their case or Unicode form, since seatbelt matches both loosely', () => {
      // On the default APFS volume seatbelt matches a path whatever its case
      // and normalization, so ~/.LOCALMOST grants what ~/.localmost would.
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
        expect(profile).not.toContain(`(subpath "${expanded}")`);
        expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining(entry));
      }
    });

    it('drops a grant of the app directory spelled in another Unicode form', () => {
      const previous = process.env.LOCALMOST_CONFIG_DIR;
      process.env.LOCALMOST_CONFIG_DIR = '/opt/café';
      try {
        const decomposed = '/opt/café/runner/sandbox';
        let profile = '';
        jest.isolateModules(() => {
          const { generateSandboxProfile } = require('./process-sandbox');
          profile = generateSandboxProfile({
            instanceDir: '/opt/café/runner/sandbox/1',
            filesystemPolicy: { level: 'strict', read: [decomposed, '/opt/other'], write: [] },
          });
        });
        expect(profile).not.toContain(`(subpath "${decomposed}")`);
        expect(profile).toContain('(subpath "/opt/other")');
      } finally {
        if (previous === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
        else process.env.LOCALMOST_CONFIG_DIR = previous;
      }
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

    it('keeps a deny that covers the app directories, since a deny only narrows', () => {
      // Dropping it, as a grant there is dropped, would quietly widen what
      // the approved policy says: /tmp contains the mock's userData directory.
      const profile = profileWith({
        filesystemPolicy: { level: 'strict', read: [], write: [], deny: ['/tmp', '~/.localmost/logs'] },
      });
      const denyRule = profile.slice(profile.indexOf('(deny file-read* file-write*'));
      expect(denyRule).toContain('(subpath "/tmp")');
      expect(denyRule).toContain(`(subpath "${path.join(os.homedir(), '.localmost', 'logs')}")`);
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
      expect(profileWith({})).not.toContain('(deny file-read* file-write*');
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

    it('keeps the broker denied as the last network rule, whatever loopback allows', () => {
      for (const loopback of [true, [8787, 5432]] as const) {
        const profile = profileWith({
          proxyPort,
          filesystemPolicy: { level: 'strict', read: [], write: [], loopback },
        });
        const brokerDeny = profile.indexOf('(deny network-outbound (remote ip "localhost:8787"))');
        expect(brokerDeny).toBeGreaterThan(-1);
        const networkRules = [...profile.matchAll(/^\((?:allow|deny) (?:network|system-socket)[^\n]*/gm)];
        expect(networkRules[networkRules.length - 1].index).toBe(brokerDeny);
      }
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
        expect(profile).toContain('(deny file-write*');
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
