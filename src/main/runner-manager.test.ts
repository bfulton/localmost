// Mock process-sandbox - define inside factory to avoid hoisting issues
jest.mock('./process-sandbox', () => ({
  spawnSandboxed: jest.fn(),
}));

// Mock runner-downloader to avoid tar dependency issues
jest.mock('./runner-downloader', () => ({
  RunnerDownloader: jest.fn().mockImplementation(() => ({
    getBaseDir: jest.fn().mockReturnValue('/Users/test/.localmost/runner'),
    getArcDir: jest.fn().mockReturnValue('/Users/test/.localmost/runner/arc/v2.330.0'),
    getConfigDir: jest.fn().mockImplementation((instance: number) => `/Users/test/.localmost/runner/config/${instance}`),
    getSandboxDir: jest.fn().mockImplementation((instance: number) => `/Users/test/.localmost/runner/sandbox/${instance}`),
    getToolCacheDir: jest.fn().mockReturnValue('/Users/test/.localmost/runner/tool-cache'),
    buildSandbox: jest.fn().mockImplementation((instance: number) => Promise.resolve(`/Users/test/.localmost/runner/sandbox/${instance}`)),
    isDownloaded: jest.fn().mockReturnValue(true),
    isConfigured: jest.fn().mockImplementation((_instance: number) => true),
    hasAnyProxyCredentials: jest.fn().mockReturnValue(true),
    copyProxyCredentials: jest.fn().mockResolvedValue(undefined),
    getInstalledVersion: jest.fn().mockReturnValue('2.330.0'),
  })),
}));

// Mock proxy-server to avoid real HTTP servers in tests
jest.mock('./proxy-server', () => ({
  ProxyServer: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(12345),
    stop: jest.fn().mockResolvedValue(undefined),
    getProxyUrl: jest.fn().mockReturnValue('http://localhost:12345'),
    getPort: jest.fn().mockReturnValue(12345),
  })),
}));

import { RunnerManager } from './runner-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { LogEntry, RunnerState, JobHistoryEntry } from '../shared/types';
import { spawnSandboxed } from './process-sandbox';

// Get the mocked function
const mockSpawnSandboxed = spawnSandboxed as jest.MockedFunction<typeof spawnSandboxed>;

// Create a mock process factory to properly handle the readonly pid
function createMockProcess(pid: number): any {
  const proc = new EventEmitter();
  Object.defineProperty(proc, 'pid', { value: pid, writable: false });
  (proc as any).stdout = new EventEmitter();
  (proc as any).stderr = new EventEmitter();
  (proc as any).kill = jest.fn();
  return proc;
}

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  promises: {
    mkdir: jest.fn(),
    chmod: jest.fn(),
    unlink: jest.fn(),
    rm: jest.fn().mockResolvedValue(undefined),
    readdir: jest.fn().mockResolvedValue([]),
    readFile: jest.fn().mockResolvedValue(''),
  },
}));

describe('RunnerManager', () => {
  let runnerManager: RunnerManager;
  let mockOnLog: jest.Mock<void, [LogEntry]>;
  let mockOnStatusChange: jest.Mock<void, [RunnerState]>;
  let mockOnJobHistoryUpdate: jest.Mock<void, [JobHistoryEntry[]]>;

  const mockConfigPath = path.join(os.homedir(), '.localmost', 'config.yaml');

  beforeEach(() => {
    jest.clearAllMocks();

    mockOnLog = jest.fn();
    mockOnStatusChange = jest.fn();
    mockOnJobHistoryUpdate = jest.fn();

    // Default mocks
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('{}');

    runnerManager = new RunnerManager({
      onLog: mockOnLog,
      onStatusChange: mockOnStatusChange,
      onJobHistoryUpdate: mockOnJobHistoryUpdate,
    });
  });

  describe('constructor', () => {
    it('should initialize with correct paths', () => {
      expect(runnerManager).toBeDefined();
    });

    it('should load runner name from config if available', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(`runnerConfig:
  runnerName: test-runner`);

      // Create new manager to test config loading
      new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
      });

      expect(fs.readFileSync).toHaveBeenCalledWith(mockConfigPath, 'utf-8');
    });
  });

  describe('getStatus', () => {
    it('should return offline status initially', () => {
      const status = runnerManager.getStatus();
      expect(status).toEqual({
        status: 'offline',
        startedAt: undefined,
      });
    });
  });

  describe('isRunning', () => {
    it('should return false when offline', () => {
      expect(runnerManager.isRunning()).toBe(false);
    });
  });

  describe('isConfigured', () => {
    it('should delegate to downloader.hasAnyProxyCredentials', () => {
      // The mock returns true by default
      expect(runnerManager.isConfigured()).toBe(true);
    });
  });

  describe('getJobHistory', () => {
    it('should return empty array initially', () => {
      expect(runnerManager.getJobHistory()).toEqual([]);
    });
  });

  describe('start', () => {
    it('should throw error if not downloaded', async () => {
      // Create a new manager with downloader that returns false for isDownloaded
      jest.resetModules();
      jest.doMock('./runner-downloader', () => ({
        RunnerDownloader: jest.fn().mockImplementation(() => ({
          getBaseDir: jest.fn().mockReturnValue('/Users/test/.localmost/runner'),
          getConfigDir: jest.fn().mockImplementation((instance: number) => `/Users/test/.localmost/runner/config/${instance}`),
          isDownloaded: jest.fn().mockReturnValue(false),
          isConfigured: jest.fn().mockReturnValue(true),
          hasAnyProxyCredentials: jest.fn().mockReturnValue(true),
          getInstalledVersion: jest.fn().mockReturnValue(null),
        })),
      }));

      const { RunnerManager: RM } = require('./runner-manager');
      const manager = new RM({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
      });

      await expect(manager.start()).rejects.toThrow('Runner is not downloaded');
    });

    it('should warn if binary not found in sandbox', async () => {
      // Mock sandbox exists but run.sh doesn't
      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        if (p.includes('run.sh')) return false;
        if (p.includes('.runner')) return true;
        if (p === mockConfigPath) return true;
        return false;
      });

      await runnerManager.start();

      // Should log a warning about missing binary
      expect(mockOnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          message: expect.stringContaining('Runner binary not found'),
        })
      );
    });

    it('should start runner process when configured', async () => {
      // Mock file existence checks
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      // Create mock process
      const mockProcess = createMockProcess(12345);
      mockSpawnSandboxed.mockReturnValue(mockProcess);

      await runnerManager.start();

      expect(mockOnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
          message: expect.stringContaining('Starting'),
        })
      );

      // Verify sandboxed spawn was called
      expect(mockSpawnSandboxed).toHaveBeenCalled();
    });

    it('should warn if already running', async () => {
      // Setup running state by mocking internal status
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      const mockProcess = createMockProcess(12346);
      mockSpawnSandboxed.mockReturnValue(mockProcess);

      await runnerManager.start();

      // Try to start again
      await runnerManager.start();

      expect(mockOnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          message: expect.stringContaining('already running'),
        })
      );
    });
  });

  describe('stop', () => {
    it('should log message if not running', async () => {
      await runnerManager.stop();

      expect(mockOnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
          message: expect.stringContaining('not running'),
        })
      );
    });
  });

  describe('log prefixing', () => {
    it('should not prefix app log messages with runner name', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(`runnerConfig:
  runnerName: my-runner`);

      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
      });

      // Trigger a log by calling stop (which logs even when not running)
      manager.stop();

      // App messages should NOT have the runner name prefix
      expect(mockOnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.not.stringContaining('[my-runner]'),
        })
      );
      expect(mockOnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('not running'),
        })
      );
    });
  });

  describe('hasAvailableSlot', () => {
    it('should return true when no instances are running', () => {
      expect(runnerManager.hasAvailableSlot()).toBe(true);
    });

    it('should return true when some instances are offline', () => {
      const instances = (runnerManager as any).instances;
      instances.set(1, { status: 'listening' });
      instances.set(2, { status: 'offline' });

      expect(runnerManager.hasAvailableSlot()).toBe(true);
    });

    it('should return true when some instances have error status', () => {
      const instances = (runnerManager as any).instances;
      instances.set(1, { status: 'listening' });
      instances.set(2, { status: 'error' });

      expect(runnerManager.hasAvailableSlot()).toBe(true);
    });

    it('should return false when all instances are listening', () => {
      const instances = (runnerManager as any).instances;
      // Default runnerCount is 4
      instances.set(1, { status: 'listening' });
      instances.set(2, { status: 'listening' });
      instances.set(3, { status: 'listening' });
      instances.set(4, { status: 'listening' });

      expect(runnerManager.hasAvailableSlot()).toBe(false);
    });
  });

  describe('user filtering', () => {
    it('should allow all users when filter mode is everyone', () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getUserFilter: () => ({ mode: 'everyone', allowlist: [] }),
        getCurrentUserLogin: () => 'testuser',
      });

      // Access private method via any cast for testing
      const isAllowed = (manager as any).isUserAllowed('anyuser');
      expect(isAllowed).toBe(true);
    });

    it('should allow all users when no filter is set', () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getUserFilter: () => undefined,
      });

      const isAllowed = (manager as any).isUserAllowed('anyuser');
      expect(isAllowed).toBe(true);
    });

    it('should only allow current user when filter mode is just-me', () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getUserFilter: () => ({ mode: 'just-me', allowlist: [] }),
        getCurrentUserLogin: () => 'testuser',
      });

      expect((manager as any).isUserAllowed('testuser')).toBe(true);
      expect((manager as any).isUserAllowed('TestUser')).toBe(true); // case insensitive
      expect((manager as any).isUserAllowed('otheruser')).toBe(false);
    });

    it('should only allow users in allowlist when filter mode is allowlist', () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getUserFilter: () => ({
          mode: 'allowlist',
          allowlist: [
            { login: 'user1', avatar_url: '', name: null },
            { login: 'user2', avatar_url: '', name: null },
          ],
        }),
      });

      expect((manager as any).isUserAllowed('user1')).toBe(true);
      expect((manager as any).isUserAllowed('User1')).toBe(true); // case insensitive
      expect((manager as any).isUserAllowed('user2')).toBe(true);
      expect((manager as any).isUserAllowed('user3')).toBe(false);
    });

    it('should allow user when just-me mode but no current user is set', () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getUserFilter: () => ({ mode: 'just-me', allowlist: [] }),
        getCurrentUserLogin: () => undefined,
      });

      // Should return true (allow) when current user is unknown
      expect((manager as any).isUserAllowed('anyuser')).toBe(true);
    });

    it('should handle empty allowlist', () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getUserFilter: () => ({ mode: 'allowlist', allowlist: [] }),
      });

      // Empty allowlist should not allow anyone
      expect((manager as any).isUserAllowed('anyuser')).toBe(false);
    });
  });

  describe('fetchActionsUrl', () => {
    it('should not fetch if getWorkflowRuns is not provided', async () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
      });

      // Add a job to history
      (manager as any).jobHistory = [{
        id: 'job-1',
        jobName: 'test-job',
        repository: 'owner/repo',
        status: 'completed',
        startedAt: new Date().toISOString(),
      }];

      // Should not throw and should return early
      await (manager as any).fetchActionsUrl('job-1', 'runner-1');
      // No error means it returned early as expected
    });

    it('should not fetch if job is not in history', async () => {
      const mockGetWorkflowRuns = jest.fn();
      const mockGetWorkflowJobs = jest.fn();

      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getWorkflowRuns: mockGetWorkflowRuns,
        getWorkflowJobs: mockGetWorkflowJobs,
      });

      await (manager as any).fetchActionsUrl('nonexistent-job', 'runner-1');

      expect(mockGetWorkflowRuns).not.toHaveBeenCalled();
    });

    it('should not fetch if repository is unknown', async () => {
      const mockGetWorkflowRuns = jest.fn();
      const mockGetWorkflowJobs = jest.fn();

      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getWorkflowRuns: mockGetWorkflowRuns,
        getWorkflowJobs: mockGetWorkflowJobs,
      });

      (manager as any).jobHistory = [{
        id: 'job-1',
        jobName: 'test-job',
        repository: 'unknown',
        status: 'completed',
        startedAt: new Date().toISOString(),
      }];

      await (manager as any).fetchActionsUrl('job-1', 'runner-1');

      expect(mockGetWorkflowRuns).not.toHaveBeenCalled();
    });

    it('should fetch and update actionsUrl when job is found', async () => {
      const mockGetWorkflowRuns = jest.fn().mockResolvedValue([
        { id: 123, name: 'CI', status: 'completed', created_at: new Date().toISOString(), actor: { login: 'user' } },
      ]);
      const mockGetWorkflowJobs = jest.fn().mockResolvedValue([
        { id: 456, name: 'build', runner_name: 'test-runner', html_url: 'https://github.com/owner/repo/actions/runs/123/jobs/456' },
      ]);

      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getWorkflowRuns: mockGetWorkflowRuns,
        getWorkflowJobs: mockGetWorkflowJobs,
      });

      (manager as any).jobHistory = [{
        id: 'job-1',
        jobName: 'test-job',
        repository: 'owner/repo',
        status: 'completed',
        startedAt: new Date().toISOString(),
      }];

      await (manager as any).fetchActionsUrl('job-1', 'test-runner');

      expect(mockGetWorkflowRuns).toHaveBeenCalledWith('owner', 'repo');
      expect(mockGetWorkflowJobs).toHaveBeenCalledWith('owner', 'repo', 123);
      expect((manager as any).jobHistory[0].actionsUrl).toBe('https://github.com/owner/repo/actions/runs/123/jobs/456');
    });

    it('should parse GitHub URL format for repository', async () => {
      const mockGetWorkflowRuns = jest.fn().mockResolvedValue([
        { id: 123, name: 'CI', status: 'completed', created_at: new Date().toISOString(), actor: { login: 'user' } },
      ]);
      const mockGetWorkflowJobs = jest.fn().mockResolvedValue([
        { id: 456, name: 'build', runner_name: 'test-runner', html_url: 'https://github.com/myorg/myrepo/actions/runs/123/jobs/456' },
      ]);

      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getWorkflowRuns: mockGetWorkflowRuns,
        getWorkflowJobs: mockGetWorkflowJobs,
      });

      (manager as any).jobHistory = [{
        id: 'job-1',
        jobName: 'test-job',
        repository: 'https://github.com/myorg/myrepo',
        status: 'completed',
        startedAt: new Date().toISOString(),
      }];

      await (manager as any).fetchActionsUrl('job-1', 'test-runner');

      expect(mockGetWorkflowRuns).toHaveBeenCalledWith('myorg', 'myrepo');
    });

    it('should handle API errors gracefully', async () => {
      const mockGetWorkflowRuns = jest.fn().mockRejectedValue(new Error('API rate limit'));
      const mockGetWorkflowJobs = jest.fn();

      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getWorkflowRuns: mockGetWorkflowRuns,
        getWorkflowJobs: mockGetWorkflowJobs,
      });

      (manager as any).jobHistory = [{
        id: 'job-1',
        jobName: 'test-job',
        repository: 'owner/repo',
        status: 'completed',
        startedAt: new Date().toISOString(),
      }];

      // Should not throw
      await (manager as any).fetchActionsUrl('job-1', 'test-runner');

      // actionsUrl should remain undefined
      expect((manager as any).jobHistory[0].actionsUrl).toBeUndefined();
    });

    it('should check multiple workflow runs to find matching job', async () => {
      const mockGetWorkflowRuns = jest.fn().mockResolvedValue([
        { id: 100, name: 'CI', status: 'completed', created_at: new Date().toISOString(), actor: { login: 'user' } },
        { id: 200, name: 'CI', status: 'completed', created_at: new Date().toISOString(), actor: { login: 'user' } },
      ]);
      const mockGetWorkflowJobs = jest.fn()
        .mockResolvedValueOnce([{ id: 101, name: 'build', runner_name: 'other-runner', html_url: 'https://...' }])
        .mockResolvedValueOnce([{ id: 201, name: 'build', runner_name: 'test-runner', html_url: 'https://github.com/owner/repo/actions/runs/200/jobs/201' }]);

      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getWorkflowRuns: mockGetWorkflowRuns,
        getWorkflowJobs: mockGetWorkflowJobs,
      });

      (manager as any).jobHistory = [{
        id: 'job-1',
        jobName: 'test-job',
        repository: 'owner/repo',
        status: 'completed',
        startedAt: new Date().toISOString(),
      }];

      await (manager as any).fetchActionsUrl('job-1', 'test-runner');

      expect(mockGetWorkflowJobs).toHaveBeenCalledTimes(2);
      expect((manager as any).jobHistory[0].actionsUrl).toBe('https://github.com/owner/repo/actions/runs/200/jobs/201');
    });
  });

  describe('getStatus with shutting_down', () => {
    it('should return shutting_down status when stopping is true', () => {
      (runnerManager as any).stopping = true;
      (runnerManager as any).startedAt = new Date().toISOString();

      const status = runnerManager.getStatus();

      expect(status.status).toBe('shutting_down');
    });
  });

  describe('status aggregation with listening', () => {
    it('should return listening when instance is listening', () => {
      const instances = (runnerManager as any).instances;
      (runnerManager as any).startedAt = new Date().toISOString();
      instances.set(1, { status: 'listening', currentJob: null });

      const status = runnerManager.getStatus();

      expect(status.status).toBe('listening');
    });

    it('should return busy over listening when any instance is busy', () => {
      const instances = (runnerManager as any).instances;
      (runnerManager as any).startedAt = new Date().toISOString();
      instances.set(1, { status: 'listening', currentJob: null });
      instances.set(2, {
        status: 'busy',
        currentJob: { name: 'test-job', repository: 'owner/repo' }
      });

      const status = runnerManager.getStatus();

      expect(status.status).toBe('busy');
      expect(status.jobName).toBe('test-job');
    });
  });
});
