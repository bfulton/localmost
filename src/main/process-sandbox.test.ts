import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { dockerSandboxGrants } from '../shared/docker-access';

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

  describe('docker access in the runner profile', () => {
    const endpoint = { socketPath: '/Users/dev/.docker/run/docker.sock' };

    /** Build a profile with the grants a level produces, and return its text. */
    const profileFor = (level: 'off' | 'socket' | 'contexts' | 'credentials'): string => {
      // Computed out here: the grants are plain data, and requiring the module
      // inside the isolated registry below leaves the profile unwritten.
      const dockerGrants = dockerSandboxGrants(level, endpoint, '/Users/dev');
      let profile = '';
      jest.isolateModules(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const mockProcess = createMockProcess(12360);
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

        const instanceDir = path.join(os.homedir(), '.localmost', 'runner-3');
        sandboxedSpawn(path.join(instanceDir, 'run.sh'), [], {
          cwd: instanceDir,
          dockerGrants,
        });

        profile = mockWriteFileSync.mock.calls[0][1];
      });
      return profile;
    };

    it('emits no docker rules when the level is off', () => {
      expect(profileFor('off')).not.toContain('docker.sock');
    });

    it('allows the resolved socket at socket level', () => {
      const profile = profileFor('socket');
      expect(profile).toContain(
        '(allow network-outbound (literal "/Users/dev/.docker/run/docker.sock"))'
      );
      expect(profile).toContain(
        '(allow file-write* (literal "/Users/dev/.docker/run/docker.sock"))'
      );
    });

    it('emits the socket allow after the deny block, so the literal wins', () => {
      // The Docker Desktop socket lives inside the denied ~/.docker, and
      // seatbelt takes the last matching rule.
      const profile = profileFor('socket');
      const deny = profile.indexOf('(deny file-read*');
      const allow = profile.indexOf(
        '(allow file-read* (literal "/Users/dev/.docker/run/docker.sock"))'
      );
      expect(deny).toBeGreaterThan(-1);
      expect(allow).toBeGreaterThan(deny);
    });

    it('keeps config.json denied at socket level', () => {
      expect(profileFor('socket')).not.toContain('config.json');
    });

    it('keeps config.json denied at contexts level, adding only the directory', () => {
      const profile = profileFor('contexts');
      expect(profile).toContain('(allow file-read* (subpath "/Users/dev/.docker/contexts"))');
      expect(profile).not.toContain('config.json');
    });

    it('allows config.json at credentials level', () => {
      expect(profileFor('credentials')).toContain(
        '(allow file-read* (literal "/Users/dev/.docker/config.json"))'
      );
    });

    it('never grants the ~/.docker directory itself', () => {
      for (const level of ['socket', 'contexts', 'credentials'] as const) {
        expect(profileFor(level)).not.toContain('(allow file-read* (subpath "/Users/dev/.docker"))');
      }
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
        sandboxedSpawn(runnerPath, [], { cwd: instanceDir });

        // Get the profile from the writeFileSync call
        const profile = mockWriteFileSync.mock.calls[0][1];

        expect(profile).toContain('(deny default)');
        expect(profile).toContain('(trace "/dev/stderr")');

        // Egress goes through the filtering proxy or nowhere. Raw sockets made
        // the host policy advisory: a workflow could ignore HTTP_PROXY and
        // connect straight out, which is exactly what the policy forbids.
        expect(profile).toContain('(deny network*)');
        expect(profile).not.toContain('(allow network*)');
        // Loopback only: the proxy lives there, and nothing leaves the machine
        // this way. A job that ignores HTTP_PROXY reaches nothing.
        expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
        // The escape hatch for runner registration stays off unless asked for.
        expect(profile).not.toMatch(/\(allow network-outbound\)\s*$/m);

        // The app's own control plane is never writable by a job: a job that
        // can write the approval cache can approve its own policy.
        expect(profile).toContain('(deny file-write*');
        expect(profile).toMatch(/deny file-write\*[\s\S]*policies/);
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
        expect(profile).toMatch(/deny file-write\*[\s\S]*policies/);
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
        // Profile should include both /var/folders and /private/var/folders
        // because /var is a symlink to /private/var on macOS
        expect(profile).toContain('/var/folders');
        expect(profile).toContain('/private/var/folders');
      });
    });
  });



});
