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
    setPolicyAllowedHosts: jest.fn(),
    setPolicyLevel: jest.fn(),
  })),
}));

// Mock the filtering docker socket. A real one binds a unix socket inside the
// sandbox directory, which does not exist under the mocked fs. The stub keeps
// the one piece of state the manager reasons about: which repository it is
// bound to, and that it is bound to none until told.
jest.mock('./docker/docker-filter-proxy', () => ({
  DockerFilterProxy: jest.fn().mockImplementation((options: unknown) => {
    let repository: string | undefined;
    return {
      options,
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      bind: jest.fn((repo: string) => {
        repository = repo;
      }),
      boundRepository: jest.fn(() => repository),
    };
  }),
}));

import { RunnerManager, UNCLAIMED_WORKER_TIMEOUT_MS, JobEvent } from './runner-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LogEntry, RunnerState, JobHistoryEntry } from '../shared/types';
import { DockerPolicy } from '../shared/docker-policy';
import { spawnSandboxed } from './process-sandbox';
import { DockerFilterProxy } from './docker/docker-filter-proxy';
import type { DockerBackend } from './docker/docker-backend';
import { createMockProcess, RunnerManagerTestHelper } from './test-utils';

// Get the mocked function
const mockSpawnSandboxed = spawnSandboxed as jest.MockedFunction<typeof spawnSandboxed>;

/** What the mocked DockerFilterProxy hands back: the manager's view of a worker's socket. */
interface DockerSocketStub {
  options: {
    backend?: DockerBackend;
    onLog?: (entry: { level: 'info' | 'warn' | 'debug'; message: string }) => void;
    attachRegistryAuth?: (registry: string) => string | undefined;
  };
  start: jest.Mock;
  stop: jest.Mock;
  bind: jest.Mock;
  boundRepository: () => string | undefined;
}
const dockerSocketOf = (helper: RunnerManagerTestHelper, instanceNum: number): DockerSocketStub =>
  helper.dockerProxy(instanceNum) as DockerSocketStub;
const dockerSocketStub = (): DockerSocketStub =>
  new DockerFilterProxy({} as never) as unknown as DockerSocketStub;
/** Let the fire-and-forget policy application that follows "Running job" settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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
      const helper = new RunnerManagerTestHelper(runnerManager);
      helper.setInstance(1, { status: 'listening' });
      helper.setInstance(2, { status: 'offline' });

      expect(runnerManager.hasAvailableSlot()).toBe(true);
    });

    it('should return true when some instances have error status', () => {
      const helper = new RunnerManagerTestHelper(runnerManager);
      helper.setInstance(1, { status: 'listening' });
      helper.setInstance(2, { status: 'error' });

      expect(runnerManager.hasAvailableSlot()).toBe(true);
    });

    it('should return false when all instances are listening', () => {
      const helper = new RunnerManagerTestHelper(runnerManager);
      // Default runnerCount is 4
      helper.setInstance(1, { status: 'listening' });
      helper.setInstance(2, { status: 'listening' });
      helper.setInstance(3, { status: 'listening' });
      helper.setInstance(4, { status: 'listening' });

      expect(runnerManager.hasAvailableSlot()).toBe(false);
    });
  });

  describe('user filtering', () => {
    it('should allow all users when filter scope is everyone', () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getUserFilter: () => ({ scope: 'everyone', allowedUsers: 'just-me', allowlist: [] }),
        getCurrentUserLogin: () => 'testuser',
      });
      const helper = new RunnerManagerTestHelper(manager);

      expect(helper.isUserAllowed('anyuser')).toBe(true);
    });

    it('should allow all users when no filter is set', () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getUserFilter: () => undefined,
      });
      const helper = new RunnerManagerTestHelper(manager);

      expect(helper.isUserAllowed('anyuser')).toBe(true);
    });

    it('should only allow current user when trigger scope with just-me', () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getUserFilter: () => ({ scope: 'trigger', allowedUsers: 'just-me', allowlist: [] }),
        getCurrentUserLogin: () => 'testuser',
      });
      const helper = new RunnerManagerTestHelper(manager);

      expect(helper.isUserAllowed('testuser')).toBe(true);
      expect(helper.isUserAllowed('TestUser')).toBe(true); // case insensitive
      expect(helper.isUserAllowed('otheruser')).toBe(false);
    });

    it('should only allow users in allowlist when trigger scope with allowlist', () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getUserFilter: () => ({
          scope: 'trigger',
          allowedUsers: 'allowlist',
          allowlist: [
            { login: 'user1', avatar_url: '', name: null },
            { login: 'user2', avatar_url: '', name: null },
          ],
        }),
      });
      const helper = new RunnerManagerTestHelper(manager);

      expect(helper.isUserAllowed('user1')).toBe(true);
      expect(helper.isUserAllowed('User1')).toBe(true); // case insensitive
      expect(helper.isUserAllowed('user2')).toBe(true);
      expect(helper.isUserAllowed('user3')).toBe(false);
    });

    it('should block users when just-me but no current user is known', () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getUserFilter: () => ({ scope: 'trigger', allowedUsers: 'just-me', allowlist: [] }),
        getCurrentUserLogin: () => undefined,
      });
      const helper = new RunnerManagerTestHelper(manager);

      // Filtering was explicitly enabled. If we cannot identify ourselves we
      // cannot confirm the actor is us, so the job must not run.
      expect(helper.isUserAllowed('anyuser')).toBe(false);
    });

    it('blocks users when the filter config has an unrecognized allowedUsers', () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        // Config comes off disk and can be hand-edited or written by an older
        // build. An unknown value must not fall through to "allow".
        getUserFilter: () => ({ scope: 'trigger', allowedUsers: 'bogus', allowlist: [] } as never),
        getCurrentUserLogin: () => 'testuser',
      });
      const helper = new RunnerManagerTestHelper(manager);

      expect(helper.isUserAllowed('anyuser')).toBe(false);
    });

    it('blocks users when the filter config has an unrecognized scope', () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getUserFilter: () => ({ scope: 'bogus', allowedUsers: 'just-me', allowlist: [] } as never),
        getCurrentUserLogin: () => 'testuser',
      });
      const helper = new RunnerManagerTestHelper(manager);

      expect(helper.isUserAllowed('otheruser')).toBe(false);
      expect(helper.isUserAllowed('testuser')).toBe(true);
    });

    it('should handle empty allowlist', () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getUserFilter: () => ({ scope: 'trigger', allowedUsers: 'allowlist', allowlist: [] }),
      });
      const helper = new RunnerManagerTestHelper(manager);

      // Empty allowlist should not allow anyone
      expect(helper.isUserAllowed('anyuser')).toBe(false);
    });
  });

  // fetchActionsUrl was removed - job URLs are now extracted directly from job details

  describe('job-started target context', () => {
    it('reports the target repository, not "unknown", when a spawned worker starts its job', async () => {
      const events: JobEvent[] = [];
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        onJobEvent: (e) => events.push(e),
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, { name: 'localmost.host.owner-repo.1', status: 'listening' });

      // spawnWorkerForJob stores the job's target context under the numeric
      // instance id, which is where the job-started handler must look for it.
      helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'owner/repo' });

      await helper.parseRunnerOutput(1, 'Running job: build');

      const started = events.find((e) => e.type === 'started');
      expect(started?.repository).toBe('owner/repo');
    });
  });

  describe('contributors scope enforcement', () => {
    const JOB = {
      name: 'build',
      repository: 'owner/repo',
      startedAt: '2026-01-01T00:00:00Z',
      id: 'job-1',
      targetDisplayName: 'owner/repo',
      githubRunId: 42,
      githubActor: 'trusted',
      githubSha: 'abc1234def5678',
    };

    const CONTRIBUTORS_FILTER = {
      scope: 'contributors' as const,
      allowedUsers: 'just-me' as const,
      allowlist: [],
    };

    function setup(overrides: Record<string, unknown>) {
      const cancelWorkflowRun = jest.fn().mockResolvedValue(undefined);
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getUserFilter: () => CONTRIBUTORS_FILTER,
        getCurrentUserLogin: () => 'trusted',
        cancelWorkflowRun,
        ...overrides,
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, { name: 'runner-1', currentJob: { ...JOB } });
      return { helper, cancelWorkflowRun };
    }

    it('allows the job when every contributor is allowed', async () => {
      const { helper, cancelWorkflowRun } = setup({
        getAllContributors: async () => new Set(['trusted']),
      });

      await helper.checkJobUserFilter(1, 'runner-1');

      expect(cancelWorkflowRun).not.toHaveBeenCalled();
    });

    it('cancels the job when a contributor is not allowed', async () => {
      const { helper, cancelWorkflowRun } = setup({
        getAllContributors: async () => new Set(['trusted', 'stranger']),
      });

      await helper.checkJobUserFilter(1, 'runner-1');

      expect(cancelWorkflowRun).toHaveBeenCalledWith('owner', 'repo', 42);
    });

    it('cancels the job when the contributor lookup fails', async () => {
      const { helper, cancelWorkflowRun } = setup({
        getAllContributors: async () => {
          throw new Error('API is down');
        },
      });

      await helper.checkJobUserFilter(1, 'runner-1');

      expect(cancelWorkflowRun).toHaveBeenCalledWith('owner', 'repo', 42);
    });

    it('cancels the job when there is no SHA to check contributors against', async () => {
      const { helper, cancelWorkflowRun } = setup({
        getAllContributors: async () => new Set(['trusted']),
      });
      helper.setInstance(1, {
        name: 'runner-1',
        currentJob: { ...JOB, githubSha: undefined },
      });

      // Must not silently downgrade to the weaker trigger-author check:
      // the trigger author is allowed here, but the contributors are unknown.
      await helper.checkJobUserFilter(1, 'runner-1');

      expect(cancelWorkflowRun).toHaveBeenCalledWith('owner', 'repo', 42);
    });

    it('cancels the job when contributor lookup is unavailable', async () => {
      const { helper, cancelWorkflowRun } = setup({
        getAllContributors: undefined,
      });

      await helper.checkJobUserFilter(1, 'runner-1');

      expect(cancelWorkflowRun).toHaveBeenCalledWith('owner', 'repo', 42);
    });
  });

  describe('job completion', () => {
    it('handles a repeated completion line only once', async () => {
      // The runner can emit its completion line more than once. The handler
      // awaits the GitHub conclusion lookup before clearing currentJob, so a
      // second line arriving during that await would re-enter and report the
      // same job as completed twice.
      let releaseConclusion: (value: string) => void = () => {};
      const conclusionPending = new Promise<string>((resolve) => {
        releaseConclusion = resolve;
      });

      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getJobConclusion: () => conclusionPending,
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, {
        name: 'runner-1',
        status: 'busy',
        currentJob: {
          name: 'build',
          repository: 'owner/repo',
          startedAt: new Date().toISOString(),
          id: 'job-1',
          githubJobId: 999,
        },
      });

      const line = 'Job build completed with result: Succeeded';
      const first = helper.parseRunnerOutput(1, line);
      const second = helper.parseRunnerOutput(1, line);
      releaseConclusion('success');
      await Promise.all([first, second]);

      const completions = mockOnLog.mock.calls.filter(
        ([entry]) => typeof entry?.message === 'string' && entry.message.includes('Job completed:')
      );
      expect(completions).toHaveLength(1);
    });
  });

  describe('evaluateJobFilter', () => {
    function manager(opts: Record<string, unknown>) {
      return new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        ...opts,
      } as never);
    }

    it('allows any job when the scope is everyone', async () => {
      const m = manager({ getUserFilter: () => ({ scope: 'everyone', allowedUsers: 'just-me', allowlist: [] }) });

      await expect(m.evaluateJobFilter('o', 'r', 'stranger')).resolves.toEqual({ allowed: true, reason: '' });
    });

    it('blocks a disallowed trigger author', async () => {
      const m = manager({
        getUserFilter: () => ({ scope: 'trigger', allowedUsers: 'just-me', allowlist: [] }),
        getCurrentUserLogin: () => 'me',
      });

      const verdict = await m.evaluateJobFilter('o', 'r', 'stranger');
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toMatch(/stranger/);
    });

    it('blocks when a contributor is not allowed', async () => {
      const m = manager({
        getUserFilter: () => ({ scope: 'contributors', allowedUsers: 'just-me', allowlist: [] }),
        getCurrentUserLogin: () => 'me',
        getAllContributors: async () => new Set(['me', 'stranger']),
      });

      const verdict = await m.evaluateJobFilter('o', 'r', 'me', 'abc123');
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toMatch(/stranger/);
    });

    it('fails closed when the contributor lookup throws', async () => {
      const m = manager({
        getUserFilter: () => ({ scope: 'contributors', allowedUsers: 'just-me', allowlist: [] }),
        getCurrentUserLogin: () => 'me',
        getAllContributors: async () => {
          throw new Error('API down');
        },
      });

      const verdict = await m.evaluateJobFilter('o', 'r', 'me', 'abc123');
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toMatch(/API down/);
    });

    it('fails closed when there is no SHA to check contributors at', async () => {
      const m = manager({
        getUserFilter: () => ({ scope: 'contributors', allowedUsers: 'just-me', allowlist: [] }),
        getCurrentUserLogin: () => 'me',
        getAllContributors: async () => new Set(['me']),
      });

      const verdict = await m.evaluateJobFilter('o', 'r', 'me');
      expect(verdict.allowed).toBe(false);
    });
  });

  describe('repository network policy', () => {
    it('applies the hosts a repo declares to that instance proxy', async () => {
      const setPolicyAllowedHosts = jest.fn();
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async () => ({ hosts: ['index.crates.io'], level: 'strict' as const, readPaths: [], writePaths: [], docker: {} }),
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, {
        name: 'runner-1',
        currentJob: {
          name: 'build',
          repository: 'owner/repo',
          startedAt: new Date().toISOString(),
          id: 'job-1',
          targetDisplayName: 'owner/repo',
          githubSha: 'abc1234',
        },
      });
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyLevel: jest.fn() });

      await helper.applyRepoPolicy(1);

      expect(setPolicyAllowedHosts).toHaveBeenCalledWith(['index.crates.io']);
    });

    it('binds per-workflow policy by the github workflow name, not the scraped job name', async () => {
      // workflows.<name> keys on the workflow, but the only name the runner
      // prints is the job's. The broker reads github.workflow; it has to reach
      // the policy lookup or a per-workflow section never fires.
      const seen: string[] = [];
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async (_owner, _repo, _sha, workflowName) => {
          seen.push(workflowName);
          return { hosts: [], level: 'strict' as const, readPaths: [], writePaths: [], docker: {} };
        },
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, { name: 'runner-1', status: 'listening' });
      helper.setProxy(1, { setPolicyAllowedHosts: jest.fn(), setPolicyLevel: jest.fn() });
      helper.setPendingTargetContext('1', {
        targetId: 't1',
        targetDisplayName: 'owner/repo',
        githubSha: 'abc1234',
        githubWorkflow: 'integration',
      });

      await helper.parseRunnerOutput(1, 'Running job: Build and test'); // job name != workflow name

      expect(seen).toContain('integration');
      expect(seen).not.toContain('Build and test');
    });

    it('leaves an installed policy alone when it cannot identify the job', async () => {
      // This path only refines a policy that acquirejob already installed for
      // the job the worker claimed. Clearing here wiped a correct policy
      // whenever the job could not be identified, and the job ran with no
      // hosts - four concurrent runs failed that way before this changed.
      const setPolicyAllowedHosts = jest.fn();
      const getRepoPolicy = jest.fn().mockResolvedValue({ hosts: [], level: 'strict', readPaths: [], writePaths: [], docker: {} } as never);
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: getRepoPolicy as never,
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, {
        name: 'runner-1',
        currentJob: {
          name: 'build',
          repository: 'owner/repo',
          startedAt: new Date().toISOString(),
          id: 'job-1',
          targetDisplayName: 'owner/repo',
        },
      });
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyLevel: jest.fn() });

      await helper.applyRepoPolicy(1);

      expect(getRepoPolicy).not.toHaveBeenCalled();
      expect(setPolicyAllowedHosts).not.toHaveBeenCalled();
    });

    it('does not leave one repository\'s hosts on a proxy reused by another', async () => {
      // Proxies outlive a job. Instance 3 once ran a job whose policy was never
      // installed and inherited the previous repo's hosts; the guard is that
      // every job sets the policy for its own target before the runner starts.
      const setPolicyAllowedHosts = jest.fn();
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async (owner: string, repo: string) =>
          repo === 'first'
            ? { hosts: ['first.example'], level: 'strict' as const, readPaths: [], writePaths: [], docker: {} }
            : { hosts: ['second.example'], level: 'strict' as const, readPaths: [], writePaths: [], docker: {} },
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyLevel: jest.fn() });

      const runJob = async (repo: string) => {
        helper.setInstance(1, {
          name: 'runner-1',
          currentJob: {
            name: 'build',
            repository: `owner/${repo}`,
            startedAt: new Date().toISOString(),
            id: `job-${repo}`,
            targetDisplayName: `owner/${repo}`,
            githubSha: 'abc1234',
          },
        });
        await helper.applyRepoPolicy(1);
      };

      await runJob('first');
      await runJob('second');

      expect(setPolicyAllowedHosts).toHaveBeenLastCalledWith(['second.example']);
      expect(setPolicyAllowedHosts).not.toHaveBeenLastCalledWith(['first.example']);
    });

    it('keeps the policy when the job record is missing its commit SHA', async () => {
      // Concurrent jobs can leave currentJob without a SHA. Clearing and
      // bailing out there wiped the policy installed when the instance was
      // spawned, and the job ran with no hosts - three runs failed this way.
      const setPolicyAllowedHosts = jest.fn();
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async () => ({ hosts: ['codeload.github.com'], level: 'strict' as const, readPaths: [], writePaths: [], docker: {} }),
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setPendingTargetContext('3', {
        targetId: 't1',
        targetDisplayName: 'owner/repo',
        githubSha: 'abc1234',
      });
      helper.setInstance(3, {
        name: 'runner-3',
        currentJob: {
          name: 'build',
          repository: 'owner/repo',
          startedAt: new Date().toISOString(),
          id: 'job-3',
        },
      });
      helper.setProxy(3, { setPolicyAllowedHosts, setPolicyLevel: jest.fn() });

      await helper.applyRepoPolicy(3);

      expect(setPolicyAllowedHosts).toHaveBeenLastCalledWith(['codeload.github.com']);
    });

    it('runs the job when a worker was never stamped', async () => {
      // An unstamped worker got the closed profile, which is the safe one to
      // run under. A truthy sentinel here failed the drift check against every
      // real hash, so such a worker refused every job.
      const setPolicyAllowedHosts = jest.fn();
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async () => ({
          hosts: ['codeload.github.com'],
          level: 'strict' as const,
          readPaths: [],
          writePaths: [],
          docker: {},
        }),
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, {
        name: 'runner-1',
        currentJob: {
          name: 'build',
          repository: 'owner/repo',
          startedAt: new Date().toISOString(),
          id: 'job-1',
          targetDisplayName: 'owner/repo',
          githubSha: 'abc1234',
        },
      });
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyLevel: jest.fn() });

      await helper.applyRepoPolicy(1);

      expect(setPolicyAllowedHosts).toHaveBeenLastCalledWith(['codeload.github.com']);
    });

    it('does not stop the worker that just claimed the job', async () => {
      // currentJob is only set when the runner logs "Running job", which is
      // after the claim. Retiring on drift without excluding the claimant
      // stopped a worker whose job GitHub had already handed out, and the run
      // then failed on timeout with no steps - the 601s failure this avoids.
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async () => ({
          hosts: ['codeload.github.com'],
          level: 'strict' as const,
          readPaths: [],
          writePaths: [],
          docker: {},
        }),
      });
      const helper = new RunnerManagerTestHelper(manager);
      // Spawning records this, which is how retirement identifies the repo a
      // worker belongs to before its job starts.
      helper.setPendingTargetContext('1', {
        targetId: 't1',
        targetDisplayName: 'owner/repo',
        githubSha: 'abc1234',
      });
      helper.setInstance(1, {
        name: 'runner-1',
        policyStamp: 'a-stamp-from-an-older-policy',
        // No currentJob: the runner has not logged "Running job" yet.
      });
      helper.setProxy(1, { setPolicyAllowedHosts: jest.fn(), setPolicyLevel: jest.fn() });
      const stopInstance = jest
        .spyOn(manager, 'stopInstance')
        .mockResolvedValue(undefined as never);

      await helper.applyPolicyOnClaim(1, 'owner/repo', 'abc1234');

      expect(stopInstance).not.toHaveBeenCalledWith(1);
    });

    it('does not re-decide a job that is already running', async () => {
      // The job-started path refines a policy; it must not apply drift. A
      // policy approved mid-job would otherwise cut the network out from under
      // the job that retireWorkersForRepository promises to leave alone.
      const setPolicyAllowedHosts = jest.fn();
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async () => ({
          hosts: ['codeload.github.com'],
          level: 'strict' as const,
          readPaths: [],
          writePaths: [],
          docker: {},
        }),
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, {
        name: 'runner-1',
        policyStamp: 'a-stamp-from-an-older-policy',
        currentJob: {
          name: 'build',
          repository: 'owner/repo',
          startedAt: new Date().toISOString(),
          id: 'job-1',
          targetDisplayName: 'owner/repo',
          githubSha: 'abc1234',
        },
      });
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyLevel: jest.fn() });

      await helper.applyRepoPolicy(1);

      expect(setPolicyAllowedHosts).toHaveBeenLastCalledWith(['codeload.github.com']);
    });

    it('does not read a per-workflow host list as policy drift', async () => {
      // Hosts are resolved per workflow and applied per job; the profile is
      // not. Including them in the stamp made any repository with a workflows:
      // network section look like it had drifted, and its jobs were refused.
      const setPolicyAllowedHosts = jest.fn();
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async (_o: string, _r: string, _s: string, workflowName: string) => ({
          hosts: workflowName === 'build' ? ['build-only.example'] : [],
          level: 'strict' as const,
          readPaths: ['~/.npm'],
          writePaths: ['~/.npm'],
          docker: {},
        }),
      });
      const helper = new RunnerManagerTestHelper(manager);
      const stamped = manager as unknown as {
        stampFor(p: {
          level: string;
          readPaths: string[];
          writePaths: string[];
          docker: DockerPolicy;
        }): string;
      };
      helper.setInstance(1, {
        name: 'runner-1',
        // Stamped at spawn, where the workflow name is not yet known.
        policyStamp: stamped.stampFor({
          level: 'strict',
          readPaths: ['~/.npm'],
          writePaths: ['~/.npm'],
          docker: {},
        }),
        currentJob: {
          name: 'build',
          repository: 'owner/repo',
          startedAt: new Date().toISOString(),
          id: 'job-1',
          targetDisplayName: 'owner/repo',
          githubSha: 'abc1234',
        },
      });
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyLevel: jest.fn() });

      await helper.applyRepoPolicy(1);

      expect(setPolicyAllowedHosts).toHaveBeenLastCalledWith(['build-only.example']);
    });

    it('constrains a claim when the policy changed after the worker started', async () => {
      const setPolicyAllowedHosts = jest.fn();
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async () => ({
          hosts: ['codeload.github.com'],
          level: 'strict' as const,
          readPaths: [],
          writePaths: [],
          docker: {},
        }),
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, {
        name: 'runner-1',
        policyStamp: 'a-stamp-from-an-older-policy',
        currentJob: {
          name: 'build',
          repository: 'owner/repo',
          startedAt: new Date().toISOString(),
          id: 'job-1',
          targetDisplayName: 'owner/repo',
          githubSha: 'abc1234',
        },
      });
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyLevel: jest.fn() });

      await helper.applyPolicyOnClaim(1, 'owner/repo', 'abc1234');

      // The filesystem half is fixed in the profile, so the declared hosts are
      // withheld and the job is left with runner infrastructure only.
      expect(setPolicyAllowedHosts).toHaveBeenLastCalledWith([]);
    });

    it('applies the level the repository declares, per job', async () => {
      // Instances are pooled across repositories, so a level captured when the
      // proxy started could belong to whichever repo happened to run first.
      const setPolicyLevel = jest.fn();
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async () => ({ hosts: [], level: 'moderate' as const, readPaths: [], writePaths: [], docker: {} }),
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, {
        name: 'runner-1',
        currentJob: {
          name: 'build',
          repository: 'owner/repo',
          startedAt: new Date().toISOString(),
          id: 'job-1',
          targetDisplayName: 'owner/repo',
          githubSha: 'abc1234',
        },
      });
      helper.setProxy(1, { setPolicyAllowedHosts: jest.fn(), setPolicyLevel });

      await helper.applyRepoPolicy(1);

      expect(setPolicyLevel).toHaveBeenCalledWith('moderate');
    });

    it('applies strict with no hosts when a repository has no approved policy', async () => {
      const setPolicyAllowedHosts = jest.fn();
      const setPolicyLevel = jest.fn();
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async () => ({ hosts: [], level: 'strict' as const, readPaths: [], writePaths: [], docker: {} }),
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, {
        name: 'runner-1',
        currentJob: {
          name: 'build',
          repository: 'owner/repo',
          startedAt: new Date().toISOString(),
          id: 'job-1',
          targetDisplayName: 'owner/repo',
          githubSha: 'abc1234',
        },
      });
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyLevel });

      await helper.applyRepoPolicy(1);

      expect(setPolicyAllowedHosts).toHaveBeenCalledWith([]);
      expect(setPolicyLevel).toHaveBeenCalledWith('strict');
    });

    it('records the refusal and its reason where the user will see it', () => {
      const onJobEvent = jest.fn();
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        onJobEvent,
      });

      manager.recordRefusedJob({
        repository: 'owner/repo',
        jobName: 'build',
        reason: 'policy not approved',
        githubRunId: 42,
      });

      const history = manager.getJobHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        repository: 'owner/repo',
        status: 'cancelled',
        error: 'policy not approved',
      });

      // A refusal must not look like a job that started.
      expect(onJobEvent).toHaveBeenCalledTimes(1);
      expect(onJobEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'refused', reason: 'policy not approved' })
      );
    });
  });

  describe('slot reservation', () => {
    function managerWith(count: number) {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.runnerCount = count;
      return { manager, helper };
    }

    it('never hands the same slot to two jobs', () => {
      // The broker acquires a job from GitHub before a worker exists. Two jobs
      // arriving together must not be given the same slot, or one is acquired
      // upstream and then never run.
      const { helper } = managerWith(2);

      expect(helper.reserveSlot()).toBe(1);
      expect(helper.reserveSlot()).toBe(2);
      expect(helper.reserveSlot()).toBeNull();
    });

    it('reuses a slot once its reservation is released', () => {
      const { helper } = managerWith(1);

      const slot = helper.reserveSlot();
      expect(slot).toBe(1);
      helper.releaseSlotReservation(1);

      expect(helper.reserveSlot()).toBe(1);
    });

    it('does not reserve a slot held by a running instance', () => {
      const { helper } = managerWith(2);
      helper.setInstance(1, { name: 'runner-1', status: 'busy' });

      expect(helper.reserveSlot()).toBe(2);
    });
  });

  describe('slot release after a job', () => {
    function busyManager() {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
      });
      const helper = new RunnerManagerTestHelper(manager);
      for (let i = 1; i <= 4; i++) {
        helper.setInstance(i, { name: `runner-${i}`, status: 'busy' });
      }
      return { manager, helper };
    }

    it('frees the slot so the next job can be accepted', () => {
      // A worker restarted after finishing cannot take another job: the broker
      // only routes messages to workers spawned for a specific target. Holding
      // the slot made the broker report "At capacity" forever once every slot
      // had run once, with nothing actually running.
      const { manager, helper } = busyManager();
      expect(manager.hasAvailableSlot()).toBe(false);

      helper.releaseInstanceSlot(1);

      expect(manager.hasAvailableSlot()).toBe(true);
    });

    it('frees every slot as its job finishes, not just the scaled-up ones', () => {
      const { manager, helper } = busyManager();

      for (let i = 1; i <= 4; i++) {
        helper.releaseInstanceSlot(i);
      }

      expect(helper.instances.size).toBe(0);
      expect(manager.hasAvailableSlot()).toBe(true);
    });
  });

  describe('reaping a worker that never acquired a job', () => {
    function idlePool() {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
      });
      const helper = new RunnerManagerTestHelper(manager);
      for (let i = 1; i <= 4; i++) {
        helper.setInstance(i, { name: `runner-${i}`, status: 'listening', currentJob: null });
      }
      return { manager, helper };
    }

    it('frees the slot of a worker that never acquired a job', () => {
      // A worker spawned for a job that the broker never routed to it sits in
      // `listening` forever. It is `--once`, so it never exits, so the exit
      // handler that releases its slot never runs. Once every slot is held by
      // one of these the broker reports "At capacity" for every job and the
      // pool stops accepting work with nothing running.
      const { manager, helper } = idlePool();
      expect(manager.hasAvailableSlot()).toBe(false);

      helper.reapUnclaimedWorker(1);

      expect(manager.hasAvailableSlot()).toBe(true);
      expect(helper.instances.has(1)).toBe(false);
    });

    it('reclaims a worker that is still unclaimed when the deadline passes', () => {
      jest.useFakeTimers();
      try {
        const { manager, helper } = idlePool();
        helper.armAcquireDeadline(1);
        expect(manager.hasAvailableSlot()).toBe(false);

        jest.advanceTimersByTime(UNCLAIMED_WORKER_TIMEOUT_MS);

        expect(manager.hasAvailableSlot()).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not reclaim a worker whose deadline was disarmed by acquiring a job', () => {
      jest.useFakeTimers();
      try {
        const { manager, helper } = idlePool();
        helper.armAcquireDeadline(1);
        helper.disarmAcquireDeadline(1);

        jest.advanceTimersByTime(UNCLAIMED_WORKER_TIMEOUT_MS);

        expect(helper.instances.has(1)).toBe(true);
        expect(manager.hasAvailableSlot()).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('leaves a worker that did acquire a job alone', () => {
      const { manager, helper } = idlePool();
      helper.setInstance(1, {
        name: 'runner-1',
        status: 'busy',
        currentJob: {
          name: 'build',
          repository: 'bfulton/localmost',
          startedAt: new Date().toISOString(),
          id: 'job-1',
        },
      });

      helper.reapUnclaimedWorker(1);

      expect(helper.instances.has(1)).toBe(true);
      expect(manager.hasAvailableSlot()).toBe(false);
    });
  });

  describe('getStatus with shutting_down', () => {
    it('should return shutting_down status when stopping is true', () => {
      const helper = new RunnerManagerTestHelper(runnerManager);
      helper.stopping = true;
      helper.startedAt = new Date().toISOString();

      const status = runnerManager.getStatus();

      expect(status.status).toBe('shutting_down');
    });
  });

  describe('docker socket per worker', () => {
    const noHosts = { hosts: [], level: 'strict' as const, readPaths: [], writePaths: [] };
    const runPolicy: DockerPolicy = { run: { images: ['postgres:16'] } };

    it('starts a default-deny docker socket for a spawned worker and points DOCKER_HOST at it', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));

      await runnerManager.start();

      const socket = dockerSocketOf(new RunnerManagerTestHelper(runnerManager), 1);
      expect(socket).toBeDefined();
      const socketPath = '/Users/test/.localmost/runner/sandbox/1/docker.sock';
      expect(socket.start).toHaveBeenCalledWith(socketPath);
      // Born denying everything: nothing is bound until a job is claimed.
      expect(socket.boundRepository()).toBeUndefined();
      // Listening before the runner exists, so the job's first request finds it.
      expect(socket.start.mock.invocationCallOrder[0]).toBeLessThan(mockSpawnSandboxed.mock.invocationCallOrder[0]);
      const options = mockSpawnSandboxed.mock.calls[0][2]!;
      expect(options.env?.DOCKER_HOST).toBe(`unix://${socketPath}`);
      // The profile grants this socket by name; the daemon's is no longer handed over.
      expect(options).toHaveProperty('dockerSocket', socketPath);
      expect(options).not.toHaveProperty('dockerGrants');
    });

    it("builds each worker's docker socket on the configured backend and registry auth", async () => {
      const dockerBackend: DockerBackend = {
        name: 'test',
        supportsPrivileged: false,
        resolveEndpoint: () => null,
        workspaceMountRoot: (dir) => dir,
      };
      const attachRegistryAuth = jest.fn();
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        dockerBackend,
        attachRegistryAuth,
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));

      await manager.start();

      const socket = dockerSocketOf(new RunnerManagerTestHelper(manager), 1);
      expect(socket.options.backend).toBe(dockerBackend);
      expect(socket.options.attachRegistryAuth).toBe(attachRegistryAuth);
    });

    it("forwards the docker socket's log entries to the runner log", async () => {
      // The socket warns when no daemon is behind it and logs each denial
      // with its policy hint; neither is any use unless it reaches the log.
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));
      await runnerManager.start();
      const socket = dockerSocketOf(new RunnerManagerTestHelper(runnerManager), 1);

      socket.options.onLog?.({ level: 'warn', message: 'no Docker daemon resolved; the job runs without Docker' });

      expect(mockOnLog).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn', message: expect.stringContaining('no Docker daemon resolved') })
      );
    });

    it('binds the socket to the claimed repository with its per-workflow docker policy once the job runs', async () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async (_owner, _repo, _sha, workflowName) => ({
          ...noHosts,
          docker: workflowName === 'integration' ? runPolicy : {},
        }),
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, { name: 'runner-1', status: 'listening' });
      helper.setProxy(1, { setPolicyAllowedHosts: jest.fn(), setPolicyLevel: jest.fn() });
      const socket = dockerSocketStub();
      helper.setDockerProxy(1, socket);
      helper.setPendingTargetContext('1', {
        targetId: 't1',
        targetDisplayName: 'owner/repo',
        githubSha: 'abc1234',
        githubWorkflow: 'integration',
      });

      await helper.parseRunnerOutput(1, 'Running job: Build and test');
      await settle();

      expect(socket.boundRepository()).toBe('owner/repo');
      expect(socket.bind).toHaveBeenLastCalledWith('owner/repo', runPolicy);
    });

    it('binds on claim only when the claimed repository is the one the worker was spawned for', async () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async () => ({ ...noHosts, docker: runPolicy }),
      });
      const helper = new RunnerManagerTestHelper(manager);
      const sockets: DockerSocketStub[] = [];
      for (const instanceNum of [1, 2]) {
        helper.setPendingTargetContext(String(instanceNum), {
          targetId: 't1',
          targetDisplayName: 'owner/repo',
          githubSha: 'abc1234',
        });
        helper.setInstance(instanceNum, { name: `runner-${instanceNum}`, status: 'listening' });
        helper.setProxy(instanceNum, { setPolicyAllowedHosts: jest.fn(), setPolicyLevel: jest.fn() });
        const socket = dockerSocketStub();
        helper.setDockerProxy(instanceNum, socket);
        sockets.push(socket);
      }

      await helper.applyPolicyOnClaim(1, 'owner/repo', 'abc1234');
      // A worker spawned for one repository that claims another's job must not
      // inherit the first repository's grants: the socket stays as it was born.
      await helper.applyPolicyOnClaim(2, 'other/repo', 'abc1234');

      expect(sockets[0].boundRepository()).toBe('owner/repo');
      expect(sockets[1].bind).not.toHaveBeenCalled();
      expect(sockets[1].boundRepository()).toBeUndefined();
      expect(mockOnLog).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn', message: expect.stringMatching(/other\/repo/) })
      );
    });

    it('keeps the socket closed for the job that follows a mismatched claim', async () => {
      // The job-started line is attributed to the repository the worker was
      // spawned for, which is the one whose grants must not be inherited. The
      // refusal at claim has to hold when that line arrives.
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async () => ({ ...noHosts, docker: runPolicy }),
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' });
      helper.setInstance(1, { name: 'runner-1', status: 'listening' });
      helper.setProxy(1, { setPolicyAllowedHosts: jest.fn(), setPolicyLevel: jest.fn() });
      const socket = dockerSocketStub();
      helper.setDockerProxy(1, socket);

      await helper.applyPolicyOnClaim(1, 'other/repo', 'abc1234');
      await helper.parseRunnerOutput(1, 'Running job: build');
      await settle();

      expect(socket.bind).not.toHaveBeenCalled();
      expect(socket.boundRepository()).toBeUndefined();
    });

    it('stops the docker socket when the worker exits', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const proc = createMockProcess(12345);
      mockSpawnSandboxed.mockReturnValue(proc);
      await runnerManager.start();
      const helper = new RunnerManagerTestHelper(runnerManager);
      const socket = dockerSocketOf(helper, 1);

      proc.emit('exit', 0, null);
      await settle();

      expect(socket.stop).toHaveBeenCalled();
      expect(helper.dockerProxy(1)).toBeUndefined();
    });
  });

  describe('status aggregation with listening', () => {
    it('should return listening when instance is listening', () => {
      const helper = new RunnerManagerTestHelper(runnerManager);
      helper.startedAt = new Date().toISOString();
      helper.setInstance(1, { status: 'listening', currentJob: null });

      const status = runnerManager.getStatus();

      expect(status.status).toBe('listening');
    });

    it('should return busy over listening when any instance is busy', () => {
      const helper = new RunnerManagerTestHelper(runnerManager);
      helper.startedAt = new Date().toISOString();
      helper.setInstance(1, { status: 'listening', currentJob: null });
      helper.setInstance(2, {
        status: 'busy',
        currentJob: { name: 'test-job', repository: 'owner/repo', startedAt: new Date().toISOString(), id: 'job-1' }
      });

      const status = runnerManager.getStatus();

      expect(status.status).toBe('busy');
      expect(status.jobName).toBe('test-job');
    });
  });
});

describe('docker access', () => {
  const makeManager = () =>
    new RunnerManager({
      onLog: jest.fn(),
      onStatusChange: jest.fn(),
      onJobHistoryUpdate: jest.fn(),
    });

  it('changes the policy stamp when the docker policy changes', () => {
    const manager = makeManager();
    const stamp = (docker: DockerPolicy) =>
      (manager as any).stampFor({
        level: 'strict',
        readPaths: [],
        writePaths: [],
        docker,
      });

    // A worker spawned under one docker policy must not claim a job approved
    // under another.
    expect(stamp({})).not.toEqual(stamp({ run: { images: ['postgres:16'] } }));
    expect(stamp({ run: { images: ['postgres:16'] } })).toEqual(stamp({ run: { images: ['postgres:16'] } }));
  });
});

describe('job-start detection against injected output', () => {
  const startedNames = (events: JobEvent[]) => events.filter((e) => e.type === 'started').map((e) => e.jobName);

  const setup = () => {
    const events: JobEvent[] = [];
    const manager = new RunnerManager({
      onLog: jest.fn(),
      onStatusChange: jest.fn(),
      onJobHistoryUpdate: jest.fn(),
      onJobEvent: (e: JobEvent) => events.push(e),
    });
    const helper = new RunnerManagerTestHelper(manager);
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    return { helper, events };
  };

  it('ignores "Running job:" embedded in a line the job merely printed', async () => {
    const { helper, events } = setup();

    // A commit message, PR title or any echoed text can carry this. Here it
    // arrives the way it really did: inside the job's contextData JSON.
    await helper.parseRunnerOutput(1, '{"k":"message","v":"fix: match the `Running job: <name>` line properly"}');

    expect(startedNames(events)).toEqual([]);
  });

  it('ignores a second job start on a worker already running one', async () => {
    const { helper, events } = setup();

    await helper.parseRunnerOutput(1, 'Running job: build');
    // The runner is --once: one spawn runs exactly one job, so anything after
    // the first start is not a job, whatever it calls itself.
    await helper.parseRunnerOutput(1, 'Running job: evil');

    expect(startedNames(events)).toEqual(['build']);
  });

  it('still detects a genuine job start', async () => {
    const { helper, events } = setup();
    await helper.parseRunnerOutput(1, 'Running job: build');
    expect(startedNames(events)).toEqual(['build']);
  });
});

describe('a worker constrained by policy drift stays constrained', () => {
  it('does not reopen the docker socket or restore hosts when the job starts', async () => {
    const docker = { pull: { registries: ['docker.io'] }, run: { images: ['alpine:3'] } };
    const manager = new RunnerManager({
      onLog: jest.fn(),
      onStatusChange: jest.fn(),
      onJobHistoryUpdate: jest.fn(),
      getRepoPolicy: async () => ({
        hosts: ['example.com'], level: 'strict' as const, readPaths: [], writePaths: [], docker,
      }),
    });
    const helper = new RunnerManagerTestHelper(manager);
    const proxy = { setPolicyAllowedHosts: jest.fn(), setPolicyLevel: jest.fn(), getStats: jest.fn(), getPolicyLevel: jest.fn() };
    const dockerSocket = { bind: jest.fn(), boundRepository: jest.fn() };
    helper.setProxy(1, proxy);
    helper.setDockerProxy(1, dockerSocket);
    // A stamp that cannot match the policy above: the approved policy moved
    // after this worker was built, so its profile is out of date.
    helper.setInstance(1, {
      name: 'runner-1', status: 'busy', policyStamp: 'stale-stamp',
      currentJob: { name: 'build', repository: 'owner/repo', startedAt: 'now', id: 'job-1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' },
    });
    helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' });

    // The claim detects drift: network cut to nothing, docker socket left closed.
    await helper.applyPolicyOnClaim(1, 'owner/repo', 'abc1234');
    expect(proxy.setPolicyAllowedHosts).toHaveBeenLastCalledWith([]);
    expect(dockerSocket.bind).not.toHaveBeenCalled();

    // The job-start refresh must not undo that. It runs without isClaim, so it
    // never re-checks drift, and it used to fall straight through to widening.
    await helper.applyRepoPolicy(1);

    expect(dockerSocket.bind).not.toHaveBeenCalled();
    expect(proxy.setPolicyAllowedHosts).toHaveBeenLastCalledWith([]);
  });
});

describe('a released slot does not carry the finished job\'s context', () => {
  it('does not judge the next worker in that slot against the previous repository', async () => {
    const docker = { run: { images: ['alpine:3'] } };
    const manager = new RunnerManager({
      onLog: jest.fn(), onStatusChange: jest.fn(), onJobHistoryUpdate: jest.fn(),
      getRepoPolicy: async () => ({ hosts: [], level: 'strict' as const, readPaths: [], writePaths: [], docker }),
    });
    const helper = new RunnerManagerTestHelper(manager);

    // Slot 1 ran a job for owner/first, then the worker went away.
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'owner/first', githubSha: 'aaa1111' });
    helper.releaseInstanceSlot(1);

    // The slot is reused for a different repository, by a worker that did not
    // go through spawnWorkerForJob and so records no context of its own.
    const dockerSocket = { bind: jest.fn(), boundRepository: jest.fn() };
    helper.setProxy(1, { setPolicyAllowedHosts: jest.fn(), setPolicyLevel: jest.fn() });
    helper.setDockerProxy(1, dockerSocket);
    helper.setInstance(1, { name: 'runner-1', status: 'busy', claimedRepository: 'owner/second' });

    await helper.applyPolicyOnClaim(1, 'owner/second', 'bbb2222');

    // With the previous job's context still in the slot, this worker is judged
    // against owner/first and its socket never opens for the job it is running.
    expect(dockerSocket.bind).toHaveBeenCalledWith('owner/second', docker);
  });
});
