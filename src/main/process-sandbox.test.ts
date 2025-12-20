import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { EventEmitter } from 'events';

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

// Mock child_process
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  spawn: mockSpawn,
}));

// Import after mocking
import { spawnSandboxed } from './process-sandbox';

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
        }));

        const { spawnSandboxed: sandboxedSpawn } = require('./process-sandbox');

        const instanceDir = path.join(os.homedir(), '.localmost', 'runner-2');
        const runnerPath = path.join(instanceDir, 'run.sh');
        sandboxedSpawn(runnerPath, [], { cwd: instanceDir });

        // Get the profile from the writeFileSync call
        const profile = mockWriteFileSync.mock.calls[0][1];

        // Profile should deny by default
        expect(profile).toContain('(deny default)');
        // Profile should allow network access
        expect(profile).toContain('(allow network*)');
        // Profile should trace to stderr for debugging
        expect(profile).toContain('(trace "/dev/stderr")');
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
