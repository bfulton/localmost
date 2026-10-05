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
    removeSandbox: jest.fn().mockResolvedValue(undefined),
    getToolCacheDir: jest.fn().mockImplementation((targetId: string) => `/Users/test/.localmost/runner/caches/${targetId}/tool-cache`),
    getTargetCacheDir: jest.fn().mockImplementation((targetId: string) => `/Users/test/.localmost/runner/caches/${targetId}`),
    writeShareNonce: jest.fn(() => "a".repeat(32)),
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
  ProxyServer: jest.fn().mockImplementation((options?: { authToken?: string }) => ({
    start: jest.fn().mockResolvedValue(12345),
    stop: jest.fn().mockResolvedValue(undefined),
    getProxyUrl: jest.fn().mockReturnValue(
      options?.authToken ? `http://localmost:${options.authToken}@127.0.0.1:12345` : 'http://127.0.0.1:12345'
    ),
    getPort: jest.fn().mockReturnValue(12345),
    setPolicyAllowedHosts: jest.fn(),
    setPolicyDeniedHosts: jest.fn(),
    setLoopbackPolicy: jest.fn(),
    setPolicyLevel: jest.fn(),
    rotateAuthToken: jest.fn(),
  })),
}));

// The sweep by profile mark runs python; stubbed, as nothing here runs sandboxed.
jest.mock('../shared/sandbox-reaper', () => ({
  reapMarkedProcessesAsync: jest.fn(async () => []),
  developerPython: jest.fn(async () => null),
}));

// Mock process-identity verification so tests can supply a matching start time,
// and the marker helpers so no real lsof runs. parsePidRecord is the real one.
const mockMarkerHolders = jest.fn((_p: string): number[] | null => []);
const mockSignalOrphanPids = jest.fn(async (..._args: unknown[]): Promise<{ signalled: boolean; remaining: number[] | null }> => ({ signalled: true, remaining: [] }));
jest.mock('./runner-cleanup', () => ({
  processStartTime: jest.fn(() => 'START'),
  lookUpStartTime: jest.fn(() => 'START'),
  mayEscalate: jest.requireActual('./runner-cleanup').mayEscalate,
  markerHolders: (p: string) => mockMarkerHolders(p),
  signalOrphanPids: (...args: unknown[]) => mockSignalOrphanPids(...args),
  parsePidRecord: jest.requireActual('./runner-cleanup').parsePidRecord,
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
      staysClosed: jest.fn(),
    };
  }),
}));

import { RunnerManager, UNCLAIMED_WORKER_TIMEOUT_MS, JobEvent } from './runner-manager';
import * as fs from 'fs';
import * as path from 'path';
import { GRACE_MS } from './process-group';
import { ProxyServer } from './proxy-server';
import * as os from 'os';
import { LogEntry, RunnerState, JobHistoryEntry } from '../shared/types';
import { DockerPolicy } from '../shared/docker-policy';
import { spawnSandboxed } from './process-sandbox';
import { DockerFilterProxy } from './docker/docker-filter-proxy';
import { dockerCliPath } from './vm/paths';
import * as paths from './paths';
import { NO_DAEMON_MESSAGE, noDockerBackend } from './docker/docker-backend';
import type { DockerBackend, WorkerContext, WorkerDocker } from './docker/docker-backend';
import type { DockerVmConfig } from './config';
import type { IsolationType } from '../shared/isolation';

const vmConfig: DockerVmConfig = {
  prewarm: false, cpus: 4, memoryMiB: 8192, maxRunning: 2, dataDiskGiB: 64, bootTimeoutSec: 60,
  cacheLimitGiB: 20, pullMaxGiB: 10, jobPullMaxGiB: 30, minFreeGiB: 20,
};
import { createMockProcess, RunnerManagerTestHelper } from './test-utils';

/** Stands in for the broker making a worker its per-start key. */
const perStartCredential = async () => ({
  credentials: {
    scheme: 'OAuth',
    data: { clientId: 'per-start-client', authorizationUrl: 'http://127.0.0.1:8787/w/key/_apis/oauth2/token', requireFipsCryptography: 'True' },
  },
  rsaParams: { d: 'D', dp: 'DP', dq: 'DQ', exponent: 'AQAB', inverseQ: 'IQ', modulus: 'N', p: 'P', q: 'Q' },
});

// Get the mocked function
const mockSpawnSandboxed = spawnSandboxed as jest.MockedFunction<typeof spawnSandboxed>;

/** What the mocked DockerFilterProxy hands back: the manager's view of a worker's socket. */
interface DockerSocketStub {
  options: {
    backend?: DockerBackend;
    worker?: WorkerDocker;
    bootTimeoutMs?: number;
    onLog?: (entry: { level: 'info' | 'warn' | 'debug'; message: string }) => void;
  };
  start: jest.Mock;
  stop: jest.Mock;
  bind: jest.Mock;
  boundRepository: () => string | undefined;
  staysClosed: jest.Mock;
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
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
  openSync: jest.fn(() => 42),
  closeSync: jest.fn(),
  chmodSync: jest.fn(),
  fchmodSync: jest.fn(),
  // Nothing is there to be found but a job's home, the directory
  // buildSandbox made, which is empty when it is filled.
  lstatSync: jest.fn((p: string) => {
    if (/\/sandbox\/[^/]+\/home$/.test(String(p))) return { isDirectory: () => true, isSymbolicLink: () => false };
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  }),
  // ...and, following links, everything a grant names in the real home.
  statSync: jest.fn(() => ({ isDirectory: () => true })),
  symlinkSync: jest.fn(),
  promises: {
    mkdir: jest.fn(),
    chmod: jest.fn(),
    unlink: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
    readdir: jest.fn().mockResolvedValue([]),
    readFile: jest.fn().mockResolvedValue(''),
    rename: jest.fn().mockResolvedValue(undefined),
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
    // clearAllMocks keeps implementations; a test that failed mid-way must
    // not leak its marker holders into the next one.
    mockMarkerHolders.mockReset();
    mockMarkerHolders.mockImplementation(() => []);
    mockSignalOrphanPids.mockReset();
    mockSignalOrphanPids.mockImplementation(async () => ({ signalled: true, remaining: [] }));

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

    it('reports a started runner with no worker as listening, not offline', () => {
      // Workers are spawned per job, so an idle pool legitimately holds zero
      // instances - that is the normal resting state, not a stopped runner.
      // Reporting offline for it made `localmost status` say Offline while the
      // app was up and accepting work, once the CLI began reading this instead
      // of the state machine.
      const helper = new RunnerManagerTestHelper(runnerManager);
      helper.startedAt = new Date().toISOString();

      expect(runnerManager.getStatus().status).toBe('listening');
    });

    it('still reports offline before the runner is started', () => {
      const helper = new RunnerManagerTestHelper(runnerManager);
      helper.startedAt = null;

      expect(runnerManager.getStatus().status).toBe('offline');
    });
  });

  describe('isRunning', () => {
    it('should return false when offline', () => {
      expect(runnerManager.isRunning()).toBe(false);
    });
  });

  describe('isInitialized', () => {
    it('is started by initialize() with no worker in the pool', async () => {
      // The pool is empty until a job arrives, so isRunning() cannot say
      // whether the runner was started - pause and resume decided by it.
      expect(runnerManager.isInitialized()).toBe(false);

      await runnerManager.initialize();

      expect(runnerManager.isRunning()).toBe(false);
      expect(runnerManager.isInitialized()).toBe(true);
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

  describe('starting the pool', () => {
    it('has no way to start a worker that is not for a job', () => {
      // start() used to bring up a listener in slot 1 with no job. A session
      // binds only through the expectation admission sets for a worker it
      // spawned, so that listener could never take a job; it only held a slot
      // and a live broker key. initialize() is the one way to start the pool.
      expect((RunnerManager.prototype as unknown as Record<string, unknown>).start).toBeUndefined();
    });

    it('refuses to start the pool with no runner installed', async () => {
      // Create a new manager with a downloader that has no runner version
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
      const onStatusChange = jest.fn();
      const manager = new RM({
        onLog: mockOnLog,
        onStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
      });

      await expect(manager.initialize()).rejects.toThrow('Could not determine runner version');
      expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'offline' }));
    });

    it('should warn if binary not found in sandbox', async () => {
      // Mock sandbox exists but run.sh doesn't
      (fs.existsSync as jest.Mock).mockImplementation((p: string) => {
        if (p.includes('run.sh')) return false;
        if (p.includes('.runner')) return true;
        if (p.includes('/proxies/')) return true;
        if (p === mockConfigPath) return true;
        return false;
      });

      const started = await new RunnerManagerTestHelper(runnerManager).spawnForJob();

      // Should log a warning about missing binary, and report no worker
      expect(started).toBe(false);
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

      const started = await new RunnerManagerTestHelper(runnerManager).spawnForJob();

      expect(started).toBe(true);
      expect(mockOnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
          message: expect.stringContaining('Spawning worker 1'),
        })
      );

      // Verify sandboxed spawn was called
      expect(mockSpawnSandboxed).toHaveBeenCalled();
    });

    it('does nothing when initialized again while a worker is running', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      const mockProcess = createMockProcess(12346);
      mockSpawnSandboxed.mockReturnValue(mockProcess);

      await new RunnerManagerTestHelper(runnerManager).spawnForJob();

      // Try to start again
      await runnerManager.initialize();

      expect(mockOnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('already running'),
        })
      );
      expect(mockSpawnSandboxed).toHaveBeenCalledTimes(1);
      expect(runnerManager.isRunning()).toBe(true);
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
    it('neither closes the job nor looks it up on a completion line, however often it comes', async () => {
      // A completion line is output the job can write itself, as often as it
      // likes: the job ends with its worker's exit, which looks it up once.
      const getJobConclusion = jest.fn(async () => 'success');
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getJobConclusion,
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
      await Promise.all([helper.parseRunnerOutput(1, line), helper.parseRunnerOutput(1, line)]);

      expect(getJobConclusion).not.toHaveBeenCalled();
      expect(helper.instances.get(1)!.currentJob?.id).toBe('job-1');
      expect(helper.instances.get(1)!.status).toBe('busy');
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

    it('blocks a disallowed trigger author even when every contributor is allowed', async () => {
      // An issue_comment or pull_request_target run checks out the default
      // branch head, whose history is all trusted, while the person who set it
      // going is a stranger. 'contributors' is the stricter scope; it must
      // refuse at least what 'trigger' refuses.
      const getAllContributors = jest.fn(async () => new Set(['me']));
      const m = manager({
        getUserFilter: () => ({ scope: 'contributors', allowedUsers: 'just-me', allowlist: [] }),
        getCurrentUserLogin: () => 'me',
        getAllContributors,
      });

      const verdict = await m.evaluateJobFilter('o', 'r', 'stranger', 'abc123');
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toMatch(/stranger/);
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
        claimedJob: { repository: 'owner/repo', sha: 'abc1234', workflow: '' },
        currentJob: {
          name: 'build',
          repository: 'owner/repo',
          startedAt: new Date().toISOString(),
          id: 'job-1',
          targetDisplayName: 'owner/repo',
          githubSha: 'abc1234',
        },
      });
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel: jest.fn() });

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
      // The claim recorded the workflow the broker read from github.workflow.
      helper.setInstance(1, { name: 'runner-1', status: 'listening', claimedJob: { repository: 'owner/repo', sha: 'abc1234', workflow: 'integration' }, });
      helper.setProxy(1, { setPolicyAllowedHosts: jest.fn(), setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel: jest.fn() });
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
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel: jest.fn() });

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
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel: jest.fn() });

      const runJob = async (repo: string) => {
        helper.setInstance(1, {
          name: 'runner-1',
          claimedJob: { repository: `owner/${repo}`, sha: 'abc1234', workflow: '' },
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
        claimedJob: { repository: 'owner/repo', sha: 'abc1234', workflow: '' },
        currentJob: {
          name: 'build',
          repository: 'owner/repo',
          startedAt: new Date().toISOString(),
          id: 'job-3',
        },
      });
      helper.setProxy(3, { setPolicyAllowedHosts, setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel: jest.fn() });

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
        claimedJob: { repository: 'owner/repo', sha: 'abc1234', workflow: '' },
        currentJob: {
          name: 'build',
          repository: 'owner/repo',
          startedAt: new Date().toISOString(),
          id: 'job-1',
          targetDisplayName: 'owner/repo',
          githubSha: 'abc1234',
        },
      });
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel: jest.fn() });

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
      helper.setProxy(1, { setPolicyAllowedHosts: jest.fn(), setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel: jest.fn() });
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
        claimedJob: { repository: 'owner/repo', sha: 'abc1234', workflow: '' },
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
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel: jest.fn() });

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
        claimedJob: { repository: 'owner/repo', sha: 'abc1234', workflow: 'build' },
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
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel: jest.fn() });

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
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel: jest.fn() });

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
        claimedJob: { repository: 'owner/repo', sha: 'abc1234', workflow: '' },
        currentJob: {
          name: 'build',
          repository: 'owner/repo',
          startedAt: new Date().toISOString(),
          id: 'job-1',
          targetDisplayName: 'owner/repo',
          githubSha: 'abc1234',
        },
      });
      helper.setProxy(1, { setPolicyAllowedHosts: jest.fn(), setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel });

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
        claimedJob: { repository: 'owner/repo', sha: 'abc1234', workflow: '' },
        currentJob: {
          name: 'build',
          repository: 'owner/repo',
          startedAt: new Date().toISOString(),
          id: 'job-1',
          targetDisplayName: 'owner/repo',
          githubSha: 'abc1234',
        },
      });
      helper.setProxy(1, { setPolicyAllowedHosts, setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel });

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

    it('does not reserve a slot whose worker is still starting', () => {
      // spawnWorkerForJob drops its reservation as soon as startInstance
      // returns, long before the runner prints "Listening for Jobs". What holds
      // the slot from then on is the instance's 'starting' status; were it
      // claimable, a second job would launch another worker under the same
      // runner name before the first one's session bound.
      const { helper } = managerWith(1);
      helper.setInstance(1, { name: 'runner-1', status: 'starting' });

      expect(helper.reserveSlot()).toBeNull();
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

  describe('killing stale runner processes', () => {
    it('never kills a worker this manager is currently running', async () => {
      // Seen live: auto-start spawned instance 1 as pid 5748, the stale-process
      // sweep read that pid out of the sandbox it had just written, killed it a
      // second later, and the pool never came back - the runner sat Offline for
      // eight hours while heartbeats carried on as if nothing were wrong.
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, {
        name: 'runner-1',
        status: 'listening',
        currentJob: null,
        process: { pid: 5748, kill: jest.fn() } as never,
      });

      const killed: number[] = [];
      const realKill = process.kill;
      (process as unknown as { kill: unknown }).kill = ((pid: number, sig?: unknown) => {
        // Signal 0 is the liveness probe; anything else is an actual kill.
        if (sig !== 0) killed.push(pid);
        return true;
      }) as never;
      try {
        (jest.mocked(fs.existsSync) as unknown as jest.Mock).mockReturnValue(true);
        (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([
          { name: '1.pid', isFile: () => true, isDirectory: () => false },
        ] as never);
        (jest.mocked(fs.promises.readFile) as unknown as jest.Mock).mockResolvedValue('5748 START' as never);

        await helper.killStaleProcesses();
      } finally {
        (process as unknown as { kill: unknown }).kill = realKill;
      }

      // The only record is the live worker's; the group signal would show as -5748.
      expect(killed).toEqual([]);
    });

    it('decides a pid record is live at signal time, not from a snapshot taken before reading it', async () => {
      // The worker spawns while the sweep is reading the pid directory, and
      // its fresh record is what the sweep then examines.
      const helper = new RunnerManagerTestHelper(runnerManager);
      const killed: Array<[number, unknown]> = [];
      const realKill = process.kill;
      (process as unknown as { kill: unknown }).kill = ((pid: number, sig?: unknown) => {
        if (sig !== 0) killed.push([pid, sig]);
        return true;
      }) as never;
      try {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([
          { name: '1.pid', isFile: () => true, isDirectory: () => false },
        ] as never);
        (jest.mocked(fs.promises.readFile) as unknown as jest.Mock).mockImplementation(async () => {
          helper.setInstance(1, { name: 'runner-1', status: 'starting', process: { pid: 5748, kill: jest.fn() } as never });
          return '5748 START';
        });

        await helper.killStaleProcesses();
      } finally {
        (process as unknown as { kill: unknown }).kill = realKill;
        (jest.mocked(fs.promises.readFile) as unknown as jest.Mock).mockReset();
        (jest.mocked(fs.promises.readFile) as unknown as jest.Mock).mockResolvedValue('' as never);
      }

      expect(killed).toEqual([]);
    });

    it('decides a marker is owned at signal time, not from a snapshot taken before lsof', async () => {
      const helper = new RunnerManagerTestHelper(runnerManager);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([
        { name: '1-cafef00d.mark', isFile: () => true, isDirectory: () => false },
      ] as never);
      const unlink = jest.mocked(fs.promises.unlink) as unknown as jest.Mock;
      unlink.mockResolvedValue(undefined as never);
      unlink.mockClear();
      // The worker spawns while lsof is running on its (already listed) marker.
      mockMarkerHolders.mockImplementation((p: string) => {
        helper.setInstance(1, { name: 'runner-1', status: 'busy', process: { pid: 5001, kill: jest.fn() } as never, markerPath: p });
        return [5001, 5002, 5003];
      });

      await helper.killStaleProcesses();

      expect(mockSignalOrphanPids).not.toHaveBeenCalled();
      expect(unlink.mock.calls.some(([f]) => String(f).endsWith('1-cafef00d.mark'))).toBe(false);
    });

    it('hands the worker a per-spawn marker fd and records the marker in its pid file', async () => {
      // Descendants inherit fd 3 and hold it for life, so a later sweep can
      // find exactly this spawn's survivors with lsof - even once the leader
      // (whose pid/pgid may be reused) is gone.
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([] as never);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(7777));
      (fs.writeFileSync as jest.Mock).mockClear();

      await new RunnerManagerTestHelper(runnerManager).spawnForJob();

      const opts = mockSpawnSandboxed.mock.calls.at(-1)![2]!;
      expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe', 42]);
      // The app closes its own copy; only the worker's tree holds the marker.
      expect(fs.closeSync).toHaveBeenCalledWith(42);
      const marker = (fs.writeFileSync as jest.Mock).mock.calls.find(([f]) => /\/pids\/1-[0-9a-f]+\.mark$/.test(String(f)));
      expect(marker).toBeDefined();
      expect(fs.openSync).toHaveBeenCalledWith(marker![0], 'r');
      const record = (fs.writeFileSync as jest.Mock).mock.calls.find(([f]) => String(f).endsWith('/pids/1.pid'));
      expect(String(record![1])).toMatch(/^7777 START\n.*\/pids\/1-[0-9a-f]+\.mark\n$/);
      // A previous spawn's marker may still be held; nothing removes it here.
      expect((fs.unlinkSync as jest.Mock).mock.calls.some(([f]) => String(f).endsWith('.mark'))).toBe(false);
    });

    it('starts the worker without a marker when the marker cannot be created', async () => {
      // Bookkeeping must not disable the runner: the spawn goes ahead with
      // process-group coverage only, and says so.
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([] as never);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(7778));
      (fs.writeFileSync as jest.Mock).mockImplementation((f: unknown) => {
        if (String(f).endsWith('.mark')) throw new Error('EACCES: permission denied');
      });
      try {
        await new RunnerManagerTestHelper(runnerManager).spawnForJob();

        const opts = mockSpawnSandboxed.mock.calls.at(-1)![2]!;
        expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
        const record = (fs.writeFileSync as jest.Mock).mock.calls.find(([f]) => String(f).endsWith('/pids/1.pid'));
        expect(String(record![1])).toBe('7778 START\n');
        expect(mockOnLog).toHaveBeenCalledWith(expect.objectContaining({
          level: 'warn', message: expect.stringContaining('Could not create marker'),
        }));
      } finally {
        (fs.writeFileSync as jest.Mock).mockReset();
      }
    });

    it('reaps a leaderless orphan group through its marker, by exact surviving pids', async () => {
      // The leader is gone (no start time to verify) but two descendants still
      // hold the marker. The pid/start-time path would leave them; the marker
      // path signals precisely those pids.
      const helper = new RunnerManagerTestHelper(runnerManager);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([
        { name: '1-deadbeef.mark', isFile: () => true, isDirectory: () => false },
      ] as never);
      (jest.mocked(fs.promises.unlink) as unknown as jest.Mock).mockResolvedValue(undefined as never);
      mockMarkerHolders.mockReturnValue([5001, 5002]);
      mockSignalOrphanPids.mockClear();

      await helper.killStaleProcesses();

      expect(mockSignalOrphanPids).toHaveBeenCalledWith([5001, 5002], expect.any(Function), 1000, expect.any(Function));
      // Escalation re-checks the marker itself, not bare liveness: the
      // callback handed over reads this marker's holders afresh.
      const recheck = mockSignalOrphanPids.mock.calls[0][3] as () => Promise<number[] | null>;
      mockMarkerHolders.mockClear();
      mockMarkerHolders.mockReturnValue([5002]);
      expect(await recheck()).toEqual([5002]);
      expect(mockMarkerHolders).toHaveBeenCalledWith(expect.stringMatching(/1-deadbeef\.mark$/));
      // The marker is consumed once nothing holds it.
      expect((jest.mocked(fs.promises.unlink) as unknown as jest.Mock).mock.calls.some(([f]) => String(f).endsWith('1-deadbeef.mark'))).toBe(true);
      mockMarkerHolders.mockReturnValue([]);
    });

    it.each([
      ['a holder survived', [5002] as number[] | null],
      ['the re-check was unavailable', null as number[] | null],
    ])('keeps a swept marker when %s', async (_why, remaining) => {
      const helper = new RunnerManagerTestHelper(runnerManager);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([
        { name: '1-deadbeef.mark', isFile: () => true, isDirectory: () => false },
      ] as never);
      const unlink = jest.mocked(fs.promises.unlink) as unknown as jest.Mock;
      unlink.mockResolvedValue(undefined as never);
      unlink.mockClear();
      mockMarkerHolders.mockReturnValue([5001, 5002]);
      mockSignalOrphanPids.mockResolvedValueOnce({ signalled: true, remaining });

      await helper.killStaleProcesses();

      expect(unlink.mock.calls.some(([f]) => String(f).endsWith('1-deadbeef.mark'))).toBe(false);
      expect(mockOnLog).toHaveBeenCalledWith(expect.objectContaining({
        level: 'warn', message: expect.stringContaining('1-deadbeef.mark'),
      }));
      mockMarkerHolders.mockReturnValue([]);
    });

    it("sweeps the marker of a worker that has exited but is still in the map", async () => {
      // A worker that exited with an error stays in the map as 'error' with no
      // process. Its marker is a finished spawn's: whatever still holds it is
      // a straggler, and the next Start must not mistake it for live.
      const helper = new RunnerManagerTestHelper(runnerManager);
      const marker = path.join((runnerManager as unknown as { pidDir(): string }).pidDir(), '1-0badf00d.mark');
      helper.setInstance(1, { name: 'runner-1', status: 'error', process: null, markerPath: marker });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([
        { name: '1-0badf00d.mark', isFile: () => true, isDirectory: () => false },
      ] as never);
      (jest.mocked(fs.promises.unlink) as unknown as jest.Mock).mockResolvedValue(undefined as never);
      mockMarkerHolders.mockReturnValue([7001]);
      mockSignalOrphanPids.mockClear();

      await helper.killStaleProcesses();

      expect(mockSignalOrphanPids).toHaveBeenCalledTimes(1);
      expect(mockSignalOrphanPids.mock.calls[0][0]).toEqual([7001]);
      mockMarkerHolders.mockReturnValue([]);
    });

    it("leaves a live worker's marker alone: no lsof, no signal, no unlink", async () => {
      // A marker belongs to a spawn, not a pid. Instance 1 is running now and
      // its whole tree - Listener, Worker, a step's shell - holds
      // 1-cafef00d.mark. Reaping "the holders other than the leader" would
      // kill the live job's steps, and removing the marker would blind the
      // sweep that runs if the app dies. A marker nobody owns is still swept.
      const helper = new RunnerManagerTestHelper(runnerManager);
      const liveMarker = path.join((runnerManager as unknown as { pidDir(): string }).pidDir(), '1-cafef00d.mark');
      helper.setInstance(1, { name: 'runner-1', status: 'busy', process: { pid: 5001, kill: jest.fn() } as never, markerPath: liveMarker });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([
        { name: '1-cafef00d.mark', isFile: () => true, isDirectory: () => false },
        { name: '2-0badf00d.mark', isFile: () => true, isDirectory: () => false },
      ] as never);
      const unlink = jest.mocked(fs.promises.unlink) as unknown as jest.Mock;
      unlink.mockResolvedValue(undefined as never);
      unlink.mockClear();
      mockMarkerHolders.mockClear();
      mockMarkerHolders.mockImplementation((p) => (p === liveMarker ? [5001, 5002, 5003] : [6001]));
      mockSignalOrphanPids.mockClear();

      await helper.killStaleProcesses();

      expect(mockMarkerHolders).not.toHaveBeenCalledWith(liveMarker);
      expect(mockMarkerHolders).toHaveBeenCalledWith(expect.stringMatching(/2-0badf00d\.mark$/));
      expect(mockSignalOrphanPids).toHaveBeenCalledTimes(1);
      expect(mockSignalOrphanPids.mock.calls[0][0]).toEqual([6001]);
      const unlinked = unlink.mock.calls.map(([f]) => String(f));
      expect(unlinked).not.toContain(liveMarker);
      expect(unlinked.some((f) => f.endsWith('2-0badf00d.mark'))).toBe(true);
      mockMarkerHolders.mockReset();
      mockMarkerHolders.mockImplementation(() => []);
    });

    it('skips a marker it did not record whose holders include a live worker', async () => {
      // Belt and braces for a worker this manager has but whose marker it never
      // recorded: its tree is still not ours to touch, and the marker stays.
      const helper = new RunnerManagerTestHelper(runnerManager);
      helper.setInstance(1, { name: 'runner-1', status: 'listening', process: { pid: 5001, kill: jest.fn() } as never });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([
        { name: '2-cafef00d.mark', isFile: () => true, isDirectory: () => false },
      ] as never);
      const unlink = jest.mocked(fs.promises.unlink) as unknown as jest.Mock;
      unlink.mockResolvedValue(undefined as never);
      unlink.mockClear();
      mockMarkerHolders.mockReturnValue([5001, 5002]);
      mockSignalOrphanPids.mockClear();

      await helper.killStaleProcesses();

      expect(mockSignalOrphanPids).not.toHaveBeenCalled();
      expect(unlink.mock.calls.some(([f]) => String(f).endsWith('2-cafef00d.mark'))).toBe(false);
      mockMarkerHolders.mockReturnValue([]);
    });

    it('keeps a marker whose holders it could not determine', async () => {
      // lsof failing is "unknown", never "nobody": signal nothing, keep the
      // marker for the next sweep, say so.
      const helper = new RunnerManagerTestHelper(runnerManager);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([
        { name: '3-feedface.mark', isFile: () => true, isDirectory: () => false },
      ] as never);
      const unlink = jest.mocked(fs.promises.unlink) as unknown as jest.Mock;
      unlink.mockResolvedValue(undefined as never);
      unlink.mockClear();
      mockMarkerHolders.mockReturnValue(null);
      mockSignalOrphanPids.mockClear();

      await helper.killStaleProcesses();

      expect(mockSignalOrphanPids).not.toHaveBeenCalled();
      expect(unlink.mock.calls.some(([f]) => String(f).endsWith('3-feedface.mark'))).toBe(false);
      expect(mockOnLog).toHaveBeenCalledWith(expect.objectContaining({
        level: 'warn', message: expect.stringContaining('3-feedface.mark'),
      }));
      mockMarkerHolders.mockReturnValue([]);
    });

    it('does not re-run the stale sweep when initialize is called while workers are live', async () => {
      // initialize() runs the sweep, and a Start click overlapping auto-start
      // must not sweep the workers auto-start just brought up.
      const helper = new RunnerManagerTestHelper(runnerManager);
      helper.setInstance(1, { name: 'runner-1', status: 'busy', process: { pid: 5001, kill: jest.fn() } as never });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockClear();
      mockOnStatusChange.mockClear();

      await runnerManager.initialize();

      expect(mockOnLog).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('already running') }));
      expect(mockOnStatusChange).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'starting' }));
      expect(fs.promises.readdir).not.toHaveBeenCalled();
    });

    it('reads pids from the app-owned pids directory, never the job-writable sandbox', async () => {
      // The pid a job writes into its own sandbox used to steer this sweep: a
      // job could drop any pid there and have the app SIGKILL it on the next
      // start. The authoritative pid file lives where the job cannot write.
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(4321));
      // The startup sweep is not what this test exercises; keep it from
      // inheriting another test's pid-file mocks or signalling a real pid.
      (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([] as never);
      (fs.writeFileSync as jest.Mock).mockClear();
      const runnerDir = jest.spyOn(paths, 'getRunnerDir').mockReturnValue('/Users/test/.localmost/runner');
      try {
        await new RunnerManagerTestHelper(runnerManager).spawnForJob();
      } finally {
        runnerDir.mockRestore();
      }

      const write = (fs.writeFileSync as jest.Mock).mock.calls.find(([f]) => String(f).endsWith('.pid'));
      expect(write).toBeDefined();
      // In the app-owned pids directory, getRunnerDir()/pids, which here
      // shares the runner-paths mock's root with the sandbox this spawn ran
      // in. Pinned exactly rather than by "not containing /sandbox/": inside
      // a localmost job the real data directory is under the job's own home,
      // and so under that job's sandbox.
      expect(String(write![0])).toBe('/Users/test/.localmost/runner/pids/1.pid');
      expect(String(mockSpawnSandboxed.mock.calls.at(-1)![2]!.cwd)).toBe('/Users/test/.localmost/runner/sandbox/1');
    });

    it('signals the whole process group of an orphan, not just its leader', async () => {
      // A crashed worker leaves descendants in its detached group. Signalling
      // only the leader pid strands them; the sweep targets the group.
      const helper = new RunnerManagerTestHelper(runnerManager);
      const signals: Array<[number, unknown]> = [];
      const realKill = process.kill;
      (process as unknown as { kill: unknown }).kill = ((pid: number, sig?: unknown) => {
        signals.push([pid, sig]);
        return true;
      }) as never;
      try {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([
          { name: '1.pid', isFile: () => true, isDirectory: () => false },
        ] as never);
        (jest.mocked(fs.promises.readFile) as unknown as jest.Mock).mockResolvedValue('4242 START' as never);
        (jest.mocked(fs.promises.unlink) as unknown as jest.Mock).mockResolvedValue(undefined as never);

        await helper.killStaleProcesses();
      } finally {
        (process as unknown as { kill: unknown }).kill = realKill;
      }

      // SIGTERM went to the group (negative pid), not only the leader.
      expect(signals).toContainEqual([-4242, 'SIGTERM']);
    });

    it('refuses to signal pid 1 or lower, whatever a stale file says', async () => {
      // parseInt('-1') is -1, and process.kill(-1) signals every process the
      // user owns; kill(0) signals the whole group. A pid file naming either
      // must be ignored, not obeyed.
      const helper = new RunnerManagerTestHelper(runnerManager);
      const killed: number[] = [];
      const realKill = process.kill;
      (process as unknown as { kill: unknown }).kill = ((pid: number, sig?: unknown) => {
        if (sig !== 0) killed.push(pid);
        return true;
      }) as never;
      try {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([
          { name: '1.pid', isFile: () => true, isDirectory: () => false },
          { name: '2.pid', isFile: () => true, isDirectory: () => false },
        ] as never);
        (jest.mocked(fs.promises.readFile) as unknown as jest.Mock)
          .mockResolvedValueOnce('-1' as never)
          .mockResolvedValueOnce('0' as never);
        (jest.mocked(fs.promises.unlink) as unknown as jest.Mock).mockResolvedValue(undefined as never);

        await helper.killStaleProcesses();
      } finally {
        (process as unknown as { kill: unknown }).kill = realKill;
      }

      expect(killed).toEqual([]);
    });
  });

  describe('announcing which worker a job belongs to', () => {
    it('keeps the announcement when the worker starts', async () => {
      // The withdrawal was added for the case where the spawn fails, and put in
      // a finally block - so it also ran on success, eleven seconds before the
      // worker's session arrived. The broker recorded the pairing, dropped it
      // again immediately, and then had no expectation to match, which is
      // exactly what the log showed: "Expecting worker ...1" at 00:35:28 and
      // "No expectation for ...1" at 00:35:39.
      const reserved: Array<[string, number]> = [];
      const cancelled: Array<[string, number]> = [];
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        onWorkerReservedForJob: (t, i) => reserved.push([t, i]),
        onWorkerReservationCancelled: (t, i) => cancelled.push([t, i]),
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.startedAt = new Date().toISOString();
      helper.setPendingTargetContext('next', { targetId: 't1', targetDisplayName: 'owner/repo' });
      helper.stubStartInstance(async (n) => {
        helper.setInstance(n, { name: `runner-${n}`, status: 'starting', process: createMockProcess(4242) });
      });
      helper.stubCopyProxyCredentials(async () => undefined);
      // The proxy credentials directory has to look present, or the spawn takes
      // a genuine failure path and withdrawing would be correct.
      (jest.mocked(fs.existsSync) as unknown as jest.Mock).mockReturnValue(true);

      await manager.spawnWorkerForJob('seatbelt');

      expect(reserved).toHaveLength(1);
      expect(cancelled).toEqual([]);
    });

    it('withdraws it when the worker cannot be started', async () => {
      const reserved: Array<[string, number]> = [];
      const cancelled: Array<[string, number]> = [];
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        onWorkerReservedForJob: (t, i) => reserved.push([t, i]),
        onWorkerReservationCancelled: (t, i) => cancelled.push([t, i]),
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.startedAt = new Date().toISOString();
      helper.setPendingTargetContext('next', { targetId: 't1', targetDisplayName: 'owner/repo' });
      helper.stubStartInstance(async () => {
        throw new Error('sandbox build failed');
      });
      helper.stubCopyProxyCredentials(async () => undefined);
      (jest.mocked(fs.existsSync) as unknown as jest.Mock).mockReturnValue(true);

      await manager.spawnWorkerForJob('seatbelt').catch(() => undefined);

      expect(reserved).toHaveLength(1);
      expect(cancelled).toHaveLength(1);
    });
  });

  describe("a worker's own proxy and git environment", () => {
    it('revokes the broker key when startInstance fails after issuing it', async () => {
      const revoked: number[] = [];
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        issueBrokerUrl: () => `http://127.0.0.1:8787/w/${'c'.repeat(64)}/`,
        issueWorkerCredential: perStartCredential,
        revokeBrokerUrl: (n) => revoked.push(n),
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('{}');
      // startInstance needs a version, and issues the key before spawning.
      (manager as unknown as { runnerVersion: string }).runnerVersion = '1.0.0';
      // Spawn throws after the key is issued and written into the config.
      mockSpawnSandboxed.mockImplementation(() => { throw new Error('spawn failed'); });

      const unlinked: string[] = [];
      (fs.unlinkSync as jest.Mock).mockImplementation((f: unknown) => { unlinked.push(String(f)); });

      await (manager as unknown as { startInstance(n: number): Promise<void> }).startInstance(1);

      expect(revoked).toContain(1);
      // Nothing started, so nothing holds the marker; it goes now rather than
      // lingering for a sweep.
      expect(unlinked.some((f) => /\/pids\/1-[0-9a-f]+\.mark$/.test(f))).toBe(true);
      mockSpawnSandboxed.mockReset();
    });

    it('hands the runner a proxy URL with a per-worker token and a hermetic git config', async () => {
      // The proxy token isolates each worker on shared loopback; the /dev/null
      // git config keeps checkout from falling back to a client that chokes on
      // the credentialed proxy URL, and makes the run machine-independent.
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(9911));

      await new RunnerManagerTestHelper(runnerManager).spawnForJob();

      const env = mockSpawnSandboxed.mock.calls.at(-1)![2]!.env!;
      expect(env.HTTPS_PROXY).toMatch(/^http:\/\/localmost:[0-9a-f]{48}@127\.0\.0\.1:/);
      expect(env.http_proxy).toBe(env.HTTPS_PROXY);
      // A per-job global config, the job home's .gitconfig, setting
      // proxyAuthMethod=basic so git sends the proxy token preemptively;
      // system config is skipped.
      expect(env.GIT_CONFIG_GLOBAL).toBe('/Users/test/.localmost/runner/sandbox/1/home/.gitconfig');
      expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null');
      const gitCfgWrite = (fs.writeFileSync as jest.Mock).mock.calls.find(([f]) => f === env.GIT_CONFIG_GLOBAL);
      expect(gitCfgWrite).toBeDefined();
      expect(String(gitCfgWrite![1])).toContain('proxyAuthMethod = basic');
      // Written exclusively, never through something already at the name.
      expect(gitCfgWrite![2]).toMatchObject({ flag: 'wx' });
    });

    it("runs the job with a home of its own, and ssh pointed into it", async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(9913));

      await new RunnerManagerTestHelper(runnerManager).spawnForJob();

      const env = mockSpawnSandboxed.mock.calls.at(-1)![2]!.env!;
      const home = '/Users/test/.localmost/runner/sandbox/1/home';
      expect(env.HOME).toBe(home);
      expect(env.GIT_SSH_COMMAND).toBe(`ssh -F '${home}/.ssh/config' -o UserKnownHostsFile='${home}/.ssh/known_hosts'`);
      expect(fs.mkdirSync).toHaveBeenCalledWith(`${home}/.ssh`, { mode: 0o700 });
    });

    it("links what the policy and the level grant under the real home into the job's home", async () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async () => ({ hosts: [], level: 'moderate', readPaths: ['~/.swiftpm'], writePaths: ['~/.p3-write', '/opt/elsewhere'], docker: {} }),
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(9914));

      await new RunnerManagerTestHelper(manager).spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' });

      const home = '/Users/test/.localmost/runner/sandbox/1/home';
      const links = (fs.symlinkSync as jest.Mock).mock.calls.map(([target, at]) => [String(at), String(target)]);
      expect(links).toEqual(expect.arrayContaining([
        [`${home}/.swiftpm`, path.join(os.homedir(), '.swiftpm')],
        [`${home}/.p3-write`, path.join(os.homedir(), '.p3-write')],
        // moderate's read grant on rustup's toolchains, which rustup finds through HOME.
        [`${home}/.rustup`, path.join(os.homedir(), '.rustup')],
        [`${home}/Library/Caches`, path.join(os.homedir(), 'Library', 'Caches')],
      ]));
      expect(links.some(([at]) => at.includes('elsewhere'))).toBe(false);
    });
  });

  describe('a directory the policy grants that does not exist yet', () => {
    const spawnWith = async (createMissingGrantedDirs: boolean) => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async () => ({ hosts: [], level: 'strict', readPaths: [], writePaths: ['~/.p3-missing/cache/', '~/.p3-missing-history'], docker: {} }),
        getJobEnvironmentConfig: () => ({ toolShims: true, javaToolOptions: true, perJobTempDir: true, createMissingGrantedDirs, swiftBuildLinkTemp: false }),
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(9915));
      await new RunnerManagerTestHelper(manager).spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' });
      // In the real home; the job's home gets the directory the link sits in.
      return (fs.mkdirSync as jest.Mock).mock.calls.filter(([dir]) => String(dir).startsWith(path.join(os.homedir(), '.p3-missing')));
    };

    it('is created before the job, one level at a time, by default', async () => {
      // What a grant without a trailing / names may be a file, the job's to
      // create; only the levels above it are made.
      const created = await spawnWith(true);
      expect(created).toEqual([
        [path.join(os.homedir(), '.p3-missing'), { mode: 0o755 }],
        [path.join(os.homedir(), '.p3-missing', 'cache'), { mode: 0o755 }],
      ]);
      expect(mockSpawnSandboxed).toHaveBeenCalled();
    });

    it('is left missing with the preference off', async () => {
      expect(await spawnWith(false)).toEqual([]);
    });

    it('is not created in a credential location the job is denied anyway', async () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async () => ({ hosts: [], level: 'strict', readPaths: [], writePaths: ['~/.ssh/p3-keys', '~/.config/p3'], docker: {} }),
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(9919));
      await new RunnerManagerTestHelper(manager).spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' });
      const inHome = (fs.mkdirSync as jest.Mock).mock.calls.filter(([dir]) =>
        [path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.config')].some((root) => String(dir).startsWith(root))
      );
      expect(inHome).toEqual([]);
    });
  });

  describe("a worker's temp", () => {

    it("points the caches tools keep in the shared per-user temp into the job's own temp", async () => {
      // The sandbox no longer grants the per-user temp and cache directories.
      // xcrun keeps its lookup cache there and fails without one it can
      // write; clang and swiftc keep their module cache there; zsh puts here-
      // documents in /tmp. Each has a variable that moves it.
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(9912));

      await new RunnerManagerTestHelper(runnerManager).spawnForJob();

      const env = mockSpawnSandboxed.mock.calls.at(-1)![2]!.env!;
      const jobTmp = '/Users/test/.localmost/runner/sandbox/1/_temp';
      expect(env.TMPDIR).toBe(jobTmp);
      expect(env.xcrun_db).toBe(`${jobTmp}/xcrun_db`);
      expect(env.CLANG_MODULE_CACHE_PATH).toBe(`${jobTmp}/clang-module-cache`);
      expect(env.TMPPREFIX).toBe(`${jobTmp}/zsh`);
    });

    describe("for the JVM's", () => {
      const spawnWith = async (javaToolOptions: boolean) => {
        const manager = new RunnerManager({
          onLog: mockOnLog,
          onStatusChange: mockOnStatusChange,
          onJobHistoryUpdate: mockOnJobHistoryUpdate,
          getJobEnvironmentConfig: () => ({ toolShims: true, javaToolOptions, perJobTempDir: true, createMissingGrantedDirs: true, swiftBuildLinkTemp: false }),
        });
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        mockSpawnSandboxed.mockReturnValue(createMockProcess(9918));
        await new RunnerManagerTestHelper(manager).spawnForJob();
        return mockSpawnSandboxed.mock.calls.at(-1)![2]!.env!;
      };

      it("sets JAVA_TOOL_OPTIONS: the job's temp, IPv4, and its proxy, by default", async () => {
        // The JVM reads neither TMPDIR nor HTTPS_PROXY, and its dual-stack
        // loopback connections are ones the sandbox cannot attribute.
        const env = await spawnWith(true);
        const options = env.JAVA_TOOL_OPTIONS!.split(' ');
        expect(options).toEqual(expect.arrayContaining([
          '-Djava.io.tmpdir=/Users/test/.localmost/runner/sandbox/1/_temp',
          // The JVM's home is the job's: it takes user.home from the user database, not HOME.
          '-Duser.home=/Users/test/.localmost/runner/sandbox/1/home',
          '-Djava.net.preferIPv4Stack=true',
          '-Dhttps.proxyHost=127.0.0.1',
          '-Dhttps.proxyPort=12345',
          '-Dhttps.proxyUser=localmost',
        ]));
        // The worker's own proxy token, the one in HTTPS_PROXY.
        expect(env.HTTPS_PROXY).toContain(options.find((o) => o.startsWith('-Dhttps.proxyPassword='))!.split('=')[1]);
      });

      it('sets none with the preference off', async () => {
        expect((await spawnWith(false)).JAVA_TOOL_OPTIONS).toBeUndefined();
      });
    });

    describe("for Swift Build's link step", () => {
      const spawnWith = async (swiftBuildLinkTemp?: boolean) => {
        const manager = new RunnerManager({
          onLog: mockOnLog,
          onStatusChange: mockOnStatusChange,
          onJobHistoryUpdate: mockOnJobHistoryUpdate,
          ...(swiftBuildLinkTemp !== undefined
            ? {
                getJobEnvironmentConfig: () => ({
                  toolShims: true,
                  javaToolOptions: true,
                  perJobTempDir: true,
                  createMissingGrantedDirs: true,
                  swiftBuildLinkTemp,
                }),
              }
            : {}),
        });
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        mockSpawnSandboxed.mockReturnValue(createMockProcess(9919));
        await new RunnerManagerTestHelper(manager).spawnForJob();
        return mockSpawnSandboxed.mock.calls.at(-1)![2]!;
      };

      it('grants its temp in the per-user temp directory only with the preference on', async () => {
        // The profile grants T/TemporaryDirectory.XXXXXX, a name the user's
        // own SwiftPM keeps manifests it is about to run in, only when asked.
        expect((await spawnWith(true)).swiftBuildLinkTemp).toBe(true);
        expect((await spawnWith(false)).swiftBuildLinkTemp).toBe(false);
      });

      it('does not grant it by default', async () => {
        expect((await spawnWith()).swiftBuildLinkTemp).toBe(false);
      });
    });

    describe('in the per-user temp directory', () => {
      const T = '/var/folders/zz/zyxw_vut0000gn/T';
      const sandboxDir = '/Users/test/.localmost/runner/sandbox/1-0123456789ab';
      const managerWith = (perJobTempDir: boolean) => {
        const manager = new RunnerManager({
          onLog: mockOnLog,
          onStatusChange: mockOnStatusChange,
          onJobHistoryUpdate: mockOnJobHistoryUpdate,
          getUserTempDir: () => T,
          getJobEnvironmentConfig: () => ({ toolShims: true, javaToolOptions: true, perJobTempDir, createMissingGrantedDirs: true, swiftBuildLinkTemp: false }),
        });
        const downloader = (manager as unknown as { downloader: { buildSandbox: jest.Mock } }).downloader;
        downloader.buildSandbox.mockResolvedValue(sandboxDir);
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        return manager;
      };

      it("is a directory of the job's own, made before it, named by DIRHELPER_USER_DIR_SUFFIX and granted", async () => {
        // Foundation ignores TMPDIR: NSTemporaryDirectory() and a sandboxed
        // process's atomic writes - SwiftPM's, xcodebuild's - go to the
        // per-user temp, which the sandbox does not grant. The suffix moves
        // them to T/<suffix>, which the app makes and the profile grants.
        mockSpawnSandboxed.mockReturnValue(createMockProcess(9916));

        await new RunnerManagerTestHelper(managerWith(true)).spawnForJob();

        const options = mockSpawnSandboxed.mock.calls.at(-1)![2]!;
        const suffix = options.env!.DIRHELPER_USER_DIR_SUFFIX!;
        expect(suffix).toMatch(/^localmost-[0-9a-f]{8}-1-0123456789ab$/);
        expect(options.tempSuffixDir).toBe(`${T}/${suffix}`);
        expect(fs.mkdirSync).toHaveBeenCalledWith(`${T}/${suffix}`, { mode: 0o700 });
      });

      it('is neither made nor named with the preference off', async () => {
        mockSpawnSandboxed.mockReturnValue(createMockProcess(9917));

        await new RunnerManagerTestHelper(managerWith(false)).spawnForJob();

        const options = mockSpawnSandboxed.mock.calls.at(-1)![2]!;
        expect(options.env!.DIRHELPER_USER_DIR_SUFFIX).toBeUndefined();
        expect(options.tempSuffixDir).toBeUndefined();
        expect((fs.mkdirSync as jest.Mock).mock.calls.some(([dir]) => String(dir).startsWith(T))).toBe(false);
      });

      it('is moved out of the per-user temp to be removed when the worker never starts', async () => {
        mockSpawnSandboxed.mockImplementation(() => { throw new Error('spawn failed'); });
        try {
          const manager = managerWith(true);
          (manager as unknown as { runnerVersion: string }).runnerVersion = '1.0.0';
          await (manager as unknown as { startInstance(n: number): Promise<void> }).startInstance(1);
          await settle();
        } finally {
          mockSpawnSandboxed.mockReset();
        }

        const [from, to] = (fs.promises.rename as jest.Mock).mock.calls.at(-1)! as [string, string];
        expect(from).toMatch(new RegExp(`^${T}/localmost-[0-9a-f]{8}-1-0123456789ab$`));
        expect(path.dirname(to)).toBe('/Users/test/.localmost/runner/sandbox');
        expect(path.basename(to).startsWith(`.removing-${path.basename(from)}.`)).toBe(true);
      });
    });
  });

  describe("a worker's tool cache", () => {
    const spawnFor = async (targetId?: string): Promise<NonNullable<Parameters<typeof spawnSandboxed>[2]>> => {
      const helper = new RunnerManagerTestHelper(runnerManager);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));
      // A worker is only ever spawned for a job, so the no-target case is the
      // bare start a re-registration restart makes.
      if (targetId) await helper.spawnForJob({ targetId, targetDisplayName: 'owner/repo' });
      else await helper.startWorkerWithoutJob();
      return mockSpawnSandboxed.mock.calls.at(-1)![2]!;
    };

    it("is the worker's own target's, in the env and in the profile", async () => {
      // setup-* actions execute what they find in the tool cache. One cache
      // per target means a job can only ever find tools its own repository's
      // jobs put there.
      const options = await spawnFor('t1');
      const cache = '/Users/test/.localmost/runner/caches/t1/tool-cache';
      expect(options.env?.RUNNER_TOOL_CACHE).toBe(cache);
      expect(options.env?.AGENT_TOOLSDIRECTORY).toBe(cache);
      expect(options).toHaveProperty('toolCacheDir', cache);
      expect(fs.mkdirSync).toHaveBeenCalledWith(cache, expect.objectContaining({ recursive: true }));
    });

    it('is not shared between targets', async () => {
      const first = await spawnFor('t1');
      await runnerManager.stop();
      const second = await spawnFor('t2');
      expect(second.toolCacheDir).toBe('/Users/test/.localmost/runner/caches/t2/tool-cache');
      expect(second.toolCacheDir).not.toBe(first.toolCacheDir);
    });

    it('is absent with per-sandbox selected, leaving the runner its own work directory', async () => {
      (runnerManager as unknown as { toolCacheLocation: string }).toolCacheLocation = 'per-sandbox';
      const options = await spawnFor('t1');
      expect(options.env?.RUNNER_TOOL_CACHE).toBeUndefined();
      expect(options.env?.AGENT_TOOLSDIRECTORY).toBeUndefined();
      expect(options.toolCacheDir).toBeUndefined();
    });

    it('is absent for a worker spawned without a target', async () => {
      // No target, no cache to give it: nothing shared is writable instead.
      const options = await spawnFor();
      expect(options.env?.RUNNER_TOOL_CACHE).toBeUndefined();
      expect(options.toolCacheDir).toBeUndefined();
    });
  });

  describe("a worker's package caches", () => {
    const spawnAt = async (
      level: 'strict' | 'moderate' | 'permissive',
      toolCacheLocation: 'persistent' | 'per-sandbox' = 'persistent'
    ) => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async () => ({ hosts: [], level, readPaths: [], writePaths: [], docker: {} }),
      });
      (manager as unknown as { toolCacheLocation: string }).toolCacheLocation = toolCacheLocation;
      const helper = new RunnerManagerTestHelper(manager);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));
      await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' });
      return mockSpawnSandboxed.mock.calls.at(-1)![2]!;
    };
    const packages = '/Users/test/.localmost/runner/caches/t1/packages';

    it.each(['moderate', 'permissive'] as const)(
      "point the package managers at the target's own directory under %s, not the user's home",
      async (level) => {
        // moderate used to grant write on ~/.cargo, ~/go, ~/.gradle and the
        // like, which hold the user's PATH directories and tool config. The
        // tools are moved rather than the grant kept.
        const options = await spawnAt(level);
        expect(options).toHaveProperty('packageCacheDir', packages);
        expect(fs.mkdirSync).toHaveBeenCalledWith(packages, expect.objectContaining({ recursive: true }));
        const env = options.env!;
        for (const key of [
          'npm_config_cache', 'YARN_CACHE_FOLDER', 'YARN_GLOBAL_FOLDER', 'npm_config_store_dir',
          'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CARGO_HOME', 'GRADLE_USER_HOME', 'GOPATH', 'GOCACHE',
          'PIP_CACHE_DIR', 'NUGET_PACKAGES', 'NUGET_HTTP_CACHE_PATH', 'DOTNET_CLI_HOME',
          'electron_config_cache', 'npm_config_devdir',
        ]) {
          expect(env[key]).toMatch(new RegExp(`^${packages}/`));
        }
        expect(env.MAVEN_OPTS).toBe(`-Dmaven.repo.local=${packages}/m2/repository`);
        // Maven 3.9 and later also read MAVEN_ARGS, which a workflow setting
        // MAVEN_OPTS for its JVM flags (-Xmx and the like) leaves alone.
        expect(env.MAVEN_ARGS).toBe(`-Dmaven.repo.local=${packages}/m2/repository`);
        // The installed toolchains are still found where the user put them.
        expect(env.RUSTUP_HOME).toBeUndefined();
      }
    );

    it('are not given under strict, which keeps what the repository declares', async () => {
      const options = await spawnAt('strict');
      expect(options.packageCacheDir).toBeUndefined();
      expect(options.env?.CARGO_HOME).toBeUndefined();
      expect(options.env?.GRADLE_USER_HOME).toBeUndefined();
    });

    it.each(['moderate', 'permissive'] as const)(
      "stay inside the job's own sandbox under %s with per-sandbox selected",
      async (level) => {
        // The package cache holds what the target's next job executes -
        // gradle init scripts, cargo's config and bin, GOPATH/bin - so one
        // kept across jobs would let a pull request's job plant code its
        // default branch's next job runs with that branch's secrets.
        // per-sandbox promises no cache outside the job at all.
        const options = await spawnAt(level, 'per-sandbox');
        expect(options.packageCacheDir).toBeUndefined();
        const inSandbox = '/Users/test/.localmost/runner/sandbox/1/_packages';
        const env = options.env!;
        for (const key of ['CARGO_HOME', 'GRADLE_USER_HOME', 'GOPATH', 'npm_config_cache', 'XDG_CACHE_HOME']) {
          expect(env[key]).toMatch(new RegExp(`^${inSandbox}/`));
        }
        expect(env.MAVEN_OPTS).toBe(`-Dmaven.repo.local=${inSandbox}/m2/repository`);
        const created = (fs.mkdirSync as jest.Mock).mock.calls.map(([dir]) => String(dir));
        expect(created.filter((dir) => dir.includes('/runner/caches/'))).toEqual([]);
      }
    );
  });

  describe("a worker's environment", () => {
    const withHostEnv = async (vars: Record<string, string>, run: () => Promise<void>) => {
      const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
      Object.assign(process.env, vars);
      try {
        await run();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    };

    it("does not carry the app's own environment into the job", async () => {
      // Launched from a shell, the app inherits every token and agent socket
      // that shell had. None of it is the job's.
      await withHostEnv({ FOO_SECRET: 'hunter2', SSH_AUTH_SOCK: '/tmp/agent.sock', NODE_OPTIONS: '--inspect' }, async () => {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));

        await new RunnerManagerTestHelper(runnerManager).spawnForJob();

        const env = mockSpawnSandboxed.mock.calls.at(-1)![2]!.env!;
        expect(env.FOO_SECRET).toBeUndefined();
        expect(env.SSH_AUTH_SOCK).toBeUndefined();
        expect(env.NODE_OPTIONS).toBeUndefined();
        // What the runner and a shell need to know who and where they are -
        // with the job's own bin directory, the bundled docker CLI and the
        // tool shims, first on PATH.
        expect(env.PATH).toBe(`/Users/test/.localmost/runner/sandbox/1/localmost/bin:${process.env.PATH}`);
        // HOME is the job's own, not the app's.
        expect(env.HOME).toBe('/Users/test/.localmost/runner/sandbox/1/home');
        // And what the app sets for the runner itself.
        expect(env.ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT).toBe('true');
        expect(env.HTTPS_PROXY).toBeDefined();
      });
    });

    it('gives the job the system PATH after the bundled CLI when the app has no PATH of its own', async () => {
      const saved = process.env.PATH;
      delete process.env.PATH;
      try {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));
        await new RunnerManagerTestHelper(runnerManager).spawnForJob();
      } finally {
        process.env.PATH = saved;
      }
      const env = mockSpawnSandboxed.mock.calls.at(-1)![2]!.env!;
      expect(env.PATH).toBe('/Users/test/.localmost/runner/sandbox/1/localmost/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    });

    describe('the swift and xcodebuild shims in its bin directory', () => {
      const bin = '/Users/test/.localmost/runner/sandbox/1/localmost/bin';
      const shimsWritten = async (toolShims: boolean) => {
        const manager = new RunnerManager({
          onLog: mockOnLog,
          onStatusChange: mockOnStatusChange,
          onJobHistoryUpdate: mockOnJobHistoryUpdate,
          getJobEnvironmentConfig: () => ({ toolShims, javaToolOptions: true, perJobTempDir: true, createMissingGrantedDirs: true, swiftBuildLinkTemp: false }),
        });
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));
        await new RunnerManagerTestHelper(manager).spawnForJob();
        const env = mockSpawnSandboxed.mock.calls.at(-1)![2]!.env!;
        // Each shim a new file, opened exclusively and given its mode by
        // descriptor, whatever the umask.
        const written = (fs.openSync as jest.Mock).mock.calls
          .filter(([file]) => path.dirname(String(file)) === bin)
          .map(([file, flag, mode]) => [path.basename(String(file)), flag, mode]);
        return { env, written };
      };

      it('are there by default', async () => {
        // SwiftPM and Xcode run each package manifest under a sandbox of their
        // own, which macOS refuses to start inside the job's; the shims add
        // the argument that turns it off.
        const { env, written } = await shimsWritten(true);
        expect(written).toEqual([
          ['swift', 'wx', 0o700],
          ['xcodebuild', 'wx', 0o700],
        ]);
        expect((fs.fchmodSync as jest.Mock).mock.calls).toEqual([[42, 0o700], [42, 0o700]]);
        expect((fs.chmodSync as jest.Mock).mock.calls).toEqual([[path.dirname(bin), 0o700], [bin, 0o700]]);
        expect(env.PATH!.split(':')[0]).toBe(bin);
      });

      it('are not with the preference off, and the docker CLI is still first on PATH', async () => {
        const { env, written } = await shimsWritten(false);
        expect(written).toEqual([]);
        expect(env.PATH!.split(':')[0]).toBe(bin);
        expect(fs.symlinkSync).toHaveBeenCalledWith(dockerCliPath(), `${bin}/docker`);
      });
    });

    it("applies the repository's approved env policy", async () => {
      await withHostEnv({ DEVELOPER_DIR: '/Applications/Xcode-beta.app', FOO_SECRET: 'hunter2', LANG: 'C' }, async () => {
        const manager = new RunnerManager({
          onLog: mockOnLog,
          onStatusChange: mockOnStatusChange,
          onJobHistoryUpdate: mockOnJobHistoryUpdate,
          getRepoPolicy: async () => ({
            hosts: [], level: 'strict' as const, readPaths: [], writePaths: [], docker: {},
            env: { allow: ['DEVELOPER_DIR'], deny: ['LANG'] },
          }),
        });
        const helper = new RunnerManagerTestHelper(manager);
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));

        await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' });

        const env = mockSpawnSandboxed.mock.calls.at(-1)![2]!.env!;
        expect(env.DEVELOPER_DIR).toBe('/Applications/Xcode-beta.app');
        expect(env.LANG).toBeUndefined();
        expect(env.FOO_SECRET).toBeUndefined();
      });
    });

    it('cannot use the env policy to replace what the app sets for the runner', async () => {
      await withHostEnv({ HTTPS_PROXY: 'http://evil.example:1', TMPDIR: '/tmp' }, async () => {
        const manager = new RunnerManager({
          onLog: mockOnLog,
          onStatusChange: mockOnStatusChange,
          onJobHistoryUpdate: mockOnJobHistoryUpdate,
          getRepoPolicy: async () => ({
            hosts: [], level: 'strict' as const, readPaths: [], writePaths: [], docker: {},
            env: { allow: ['*'] },
          }),
        });
        const helper = new RunnerManagerTestHelper(manager);
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));

        await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' });

        const env = mockSpawnSandboxed.mock.calls.at(-1)![2]!.env!;
        expect(env.HTTPS_PROXY).toMatch(/^http:\/\/localmost:/);
        expect(env.TMPDIR).toBe('/Users/test/.localmost/runner/sandbox/1/_temp');
      });
    });

    it('counts a change to the env policy as a policy change', () => {
      // The environment is fixed at spawn like the profile, so a worker built
      // under the old env policy must be recognised as stale.
      const stamped = runnerManager as unknown as { stampFor(p: object): string };
      const base = { level: 'strict', readPaths: [], writePaths: [], docker: {} };
      expect(stamped.stampFor({ ...base, env: { allow: ['DEVELOPER_DIR'], deny: [] } }))
        .not.toBe(stamped.stampFor({ ...base, env: { allow: [], deny: [] } }));
    });
  });

  describe("a worker's broker address", () => {
    it('is issued per start and written into the runner config the worker reads', async () => {
      // The broker serves only workers holding a key it issued. The key goes
      // in the sandbox's own .runner, which is the one the runner reads.
      const issued: Array<[number, string | undefined]> = [];
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        issueBrokerUrl: (n, t) => {
          issued.push([n, t]);
          return `http://127.0.0.1:8787/w/${'a'.repeat(64)}/`;
        },
        issueWorkerCredential: perStartCredential,
      });
      const helper = new RunnerManagerTestHelper(manager);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({ agentName: 'r1', serverUrlV2: 'http://localhost:8787/' }));
      mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));

      await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo' });

      expect(issued).toEqual([[1, 't1']]);
      const write = (fs.writeFileSync as jest.Mock).mock.calls.find(([file]) => String(file).endsWith('sandbox/1/.runner'));
      expect(write).toBeDefined();
      expect(JSON.parse(String(write![1])).serverUrlV2).toBe(`http://127.0.0.1:8787/w/${'a'.repeat(64)}/`);
    });

    it("gives the runner the broker's key for this start, never the registration's", async () => {
      // The sandbox is readable by the job. The registration's RSA key would
      // let the job act as the runner after it ends; the key the broker makes
      // for this start opens nothing but this worker's own token endpoint.
      const brokerUrl = `http://127.0.0.1:8787/w/${'a'.repeat(64)}/`;
      const issuedFiles = {
        credentials: {
          scheme: 'OAuth',
          data: { clientId: 'per-start-client', authorizationUrl: `${brokerUrl}_apis/oauth2/token`, requireFipsCryptography: 'True' },
        },
        rsaParams: { d: 'D', dp: 'DP', dq: 'DQ', exponent: 'AQAB', inverseQ: 'IQ', modulus: 'N', p: 'P', q: 'Q' },
      };
      const asked: number[] = [];
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        issueBrokerUrl: () => brokerUrl,
        issueWorkerCredential: async (n) => {
          asked.push(n);
          return issuedFiles;
        },
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
        agentName: 'r1',
        serverUrl: 'https://pipelinesghubeus2.actions.githubusercontent.com/abc/',
        serverUrlV2: 'http://localhost:8787/',
      }));
      mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));

      await new RunnerManagerTestHelper(manager).spawnForJob();

      expect(asked).toEqual([1]);
      const written = (name: string) => (fs.writeFileSync as jest.Mock).mock.calls.find(([file]) => String(file).endsWith(`sandbox/1/${name}`));
      const credentials = written('.credentials');
      const rsaParams = written('.credentials_rsaparams');
      expect(JSON.parse(String(credentials![1]))).toEqual(issuedFiles.credentials);
      expect(JSON.parse(String(rsaParams![1]))).toEqual(issuedFiles.rsaParams);
      expect(rsaParams![2]).toEqual(expect.objectContaining({ mode: 0o600 }));
      // With serverUrl equal to the broker address the listener skips its
      // second connection, to the pipelines service, which would need a token
      // GitHub honours.
      const runner = JSON.parse(String(written('.runner')![1]));
      expect(runner.serverUrl).toBe(brokerUrl);
      expect(runner.serverUrlV2).toBe(brokerUrl);
      // Both files are written before the runner exists to read them.
      const order = (fs.writeFileSync as jest.Mock).mock.invocationCallOrder;
      const rsaIndex = (fs.writeFileSync as jest.Mock).mock.calls.indexOf(rsaParams!);
      expect(order[rsaIndex]).toBeLessThan(mockSpawnSandboxed.mock.invocationCallOrder[0]);
    });

    it('does not start a worker the broker could not make a key for', async () => {
      const revoked: number[] = [];
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        issueBrokerUrl: () => `http://127.0.0.1:8787/w/${'a'.repeat(64)}/`,
        issueWorkerCredential: async () => undefined,
        revokeBrokerUrl: (n) => revoked.push(n),
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('{}');
      (manager as unknown as { runnerVersion: string }).runnerVersion = '1.0.0';
      mockSpawnSandboxed.mockReset();

      await (manager as unknown as { startInstance(n: number): Promise<void> }).startInstance(1);

      expect(mockSpawnSandboxed).not.toHaveBeenCalled();
      expect(revoked).toContain(1);
    });

    it('revokes the key and drops the pid file when the slot is released on job completion', () => {
      const revoked: number[] = [];
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        revokeBrokerUrl: (n) => revoked.push(n),
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, { name: 'runner-1', status: 'busy' });
      const unlinked: string[] = [];
      (fs.unlinkSync as jest.Mock).mockImplementation((f: unknown) => { unlinked.push(String(f)); });

      helper.releaseInstanceSlot(1);

      expect(revoked).toContain(1);
      expect(unlinked.some((f) => f.endsWith('/pids/1.pid'))).toBe(true);
    });

    // Marker settling: the pid record goes at once; the marker is swept only
    // after the exit sweep's SIGKILL has had its turn, so whatever still holds
    // it then has escaped the process group and is signalled by exact pid.
    const SETTLE_MS = GRACE_MS + 2000;
    const managerWithMarkers = () => {
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        revokeBrokerUrl: () => undefined,
      });
      const helper = new RunnerManagerTestHelper(manager);
      const pidDir = (manager as unknown as { pidDir(): string }).pidDir();
      const unlink = jest.mocked(fs.promises.unlink) as unknown as jest.Mock;
      unlink.mockResolvedValue(undefined as never);
      unlink.mockClear();
      const unlinked = () => unlink.mock.calls.map(([f]) => String(f));
      return { manager, helper, pidDir, unlinked };
    };

    it("removes a finalized instance's marker once nothing holds it", async () => {
      jest.useFakeTimers();
      try {
        const { helper, pidDir, unlinked } = managerWithMarkers();
        const marker = path.join(pidDir, '1-abcd.mark');
        helper.setInstance(1, { name: 'runner-1', status: 'busy', markerPath: marker });
        (fs.readFileSync as jest.Mock).mockReturnValue('4242 START\n');
        mockMarkerHolders.mockReturnValue([]);
        mockSignalOrphanPids.mockClear();

        helper.releaseInstanceSlot(1);

        expect((fs.unlinkSync as jest.Mock).mock.calls.some(([f]) => String(f).endsWith('/pids/1.pid'))).toBe(true);
        // Never removed with the record: its tree may still hold it.
        expect((fs.unlinkSync as jest.Mock).mock.calls.some(([f]) => String(f).endsWith('.mark'))).toBe(false);
        await jest.advanceTimersByTimeAsync(SETTLE_MS - 1);
        expect(unlinked()).not.toContain(marker);
        await jest.advanceTimersByTimeAsync(1);
        expect(unlinked()).toContain(marker);
        expect(mockSignalOrphanPids).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
        (fs.readFileSync as jest.Mock).mockReturnValue('{}');
      }
    });

    it("reaps what still holds a finalized instance's marker, found through its pid record", async () => {
      jest.useFakeTimers();
      try {
        const { helper, pidDir, unlinked } = managerWithMarkers();
        const marker = path.join(pidDir, '1-abcd.mark');
        // No instance-recorded marker: the pid record still names it.
        helper.setInstance(1, { name: 'runner-1', status: 'busy' });
        (fs.readFileSync as jest.Mock).mockReturnValue(`4242 START\n${marker}\n`);
        mockMarkerHolders.mockClear();
        mockMarkerHolders.mockReturnValue([7001]);
        mockSignalOrphanPids.mockClear();

        helper.releaseInstanceSlot(1);
        await jest.advanceTimersByTimeAsync(SETTLE_MS);

        expect(mockMarkerHolders).toHaveBeenCalledWith(marker);
        expect(mockSignalOrphanPids).toHaveBeenCalledTimes(1);
        expect(mockSignalOrphanPids.mock.calls[0][0]).toEqual([7001]);
        // The mock reports nothing remaining, so the marker is released.
        expect(unlinked()).toContain(marker);
      } finally {
        jest.useRealTimers();
        mockMarkerHolders.mockReturnValue([]);
        (fs.readFileSync as jest.Mock).mockReturnValue('{}');
      }
    });

    it("keeps a finalized instance's marker while a straggler survives", async () => {
      jest.useFakeTimers();
      try {
        const { helper, pidDir, unlinked } = managerWithMarkers();
        const marker = path.join(pidDir, '1-abcd.mark');
        helper.setInstance(1, { name: 'runner-1', status: 'busy', markerPath: marker });
        (fs.readFileSync as jest.Mock).mockReturnValue('4242 START\n');
        mockMarkerHolders.mockReturnValue([7001]);
        mockSignalOrphanPids.mockResolvedValueOnce({ signalled: true, remaining: [7001] });

        helper.releaseInstanceSlot(1);
        await jest.advanceTimersByTimeAsync(SETTLE_MS);

        expect(unlinked()).not.toContain(marker);
        expect(mockOnLog).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('1-abcd.mark kept') }));
      } finally {
        jest.useRealTimers();
        mockMarkerHolders.mockReturnValue([]);
        (fs.readFileSync as jest.Mock).mockReturnValue('{}');
      }
    });

    it('ignores a marker path in a pid record that is not one of its own', async () => {
      jest.useFakeTimers();
      try {
        const { helper } = managerWithMarkers();
        helper.setInstance(1, { name: 'runner-1', status: 'busy' });
        (fs.readFileSync as jest.Mock).mockReturnValue('4242 START\n/tmp/somewhere/1-abcd.mark\n');
        mockMarkerHolders.mockClear();

        helper.releaseInstanceSlot(1);
        await jest.advanceTimersByTimeAsync(SETTLE_MS);

        expect(mockMarkerHolders).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
        (fs.readFileSync as jest.Mock).mockReturnValue('{}');
      }
    });

    it('sweeps a marker once when the same exit is finalized twice', async () => {
      // A clean exit is finalized by the exit handler and again by
      // releaseInstanceSlot; ownership ends at the first, and one sweep runs.
      jest.useFakeTimers();
      try {
        const { manager, helper, pidDir } = managerWithMarkers();
        const marker = path.join(pidDir, '1-abcd.mark');
        helper.setInstance(1, { name: 'runner-1', status: 'busy', markerPath: marker });
        // The second finalize no longer has the instance's marker, but the
        // record still names it; the pending settle is what stops a repeat.
        (fs.readFileSync as jest.Mock).mockReturnValue(`4242 START\n${marker}\n`);
        mockMarkerHolders.mockClear();
        mockMarkerHolders.mockReturnValue([]);

        (manager as unknown as { finalizeInstance(n: number): void }).finalizeInstance(1);
        helper.releaseInstanceSlot(1);
        await jest.advanceTimersByTimeAsync(SETTLE_MS);

        expect(mockMarkerHolders).toHaveBeenCalledTimes(1);
        expect(mockMarkerHolders).toHaveBeenCalledWith(marker);
      } finally {
        jest.useRealTimers();
        (fs.readFileSync as jest.Mock).mockReturnValue('{}');
      }
    });

    it('reports a settle sweep that throws instead of dropping it', async () => {
      jest.useFakeTimers();
      try {
        const { helper, pidDir } = managerWithMarkers();
        const marker = path.join(pidDir, '1-abcd.mark');
        helper.setInstance(1, { name: 'runner-1', status: 'busy', markerPath: marker });
        (fs.readFileSync as jest.Mock).mockReturnValue('4242 START\n');
        mockMarkerHolders.mockImplementationOnce(() => { throw new Error('lsof exploded'); });

        helper.releaseInstanceSlot(1);
        await jest.advanceTimersByTimeAsync(SETTLE_MS);

        expect(mockOnLog).toHaveBeenCalledWith(expect.objectContaining({
          level: 'warn', message: expect.stringContaining('Sweep of 1-abcd.mark failed: lsof exploded'),
        }));
      } finally {
        jest.useRealTimers();
        (fs.readFileSync as jest.Mock).mockReturnValue('{}');
      }
    });

    it("settles the marker of a worker that exits with an error", async () => {
      // The error-exit path finalizes only through the exit handler; the
      // marker written at spawn is what gets swept. The exit also runs the
      // real process-group sweep, which must not reach a real pid.
      jest.useFakeTimers();
      const realKill = process.kill;
      (process as unknown as { kill: unknown }).kill = (() => true) as never;
      try {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        (fs.readFileSync as jest.Mock).mockReturnValue('{}');
        (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([] as never);
        const proc = createMockProcess(12346);
        mockSpawnSandboxed.mockReturnValue(proc);
        (fs.writeFileSync as jest.Mock).mockClear();
        const unlink = jest.mocked(fs.promises.unlink) as unknown as jest.Mock;
        unlink.mockResolvedValue(undefined as never);
        unlink.mockClear();
        mockMarkerHolders.mockClear();
        mockMarkerHolders.mockReturnValue([]);
        await new RunnerManagerTestHelper(runnerManager).spawnForJob();
        const marker = String((fs.writeFileSync as jest.Mock).mock.calls.find(([f]) => /\/pids\/1-[0-9a-f]+\.mark$/.test(String(f)))![0]);

        proc.emit('exit', 1, null);
        await jest.advanceTimersByTimeAsync(SETTLE_MS);

        expect(mockMarkerHolders).toHaveBeenCalledWith(marker);
        expect(unlink.mock.calls.map(([f]) => String(f))).toContain(marker);
      } finally {
        (process as unknown as { kill: unknown }).kill = realKill;
        jest.useRealTimers();
      }
    });

    it('keeps a worker that spawns while initialize() is still sweeping', async () => {
      // The broker is already handing out jobs during the sweep. The previous
      // pool's records are dropped before it, so this worker is not dropped
      // with them.
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([
        { name: '9-deadbeef.mark', isFile: () => true, isDirectory: () => false },
      ] as never);
      let answer!: (holders: number[]) => void;
      mockMarkerHolders.mockImplementationOnce((() => new Promise<number[]>((resolve) => { answer = resolve; })) as unknown as () => number[]);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(6001));

      const running = runnerManager.initialize();
      await settle();
      await (runnerManager as unknown as { startInstance(n: number): Promise<void> }).startInstance(1);
      answer([]);
      await running;

      expect(runnerManager.isRunning()).toBe(true);
      expect(mockSpawnSandboxed).toHaveBeenCalledTimes(1);
      const pool = (runnerManager as unknown as { instances: Map<number, { process: { pid: number } | null }> }).instances;
      expect(pool.get(1)?.process?.pid).toBe(6001);
    });

    it('revokes keys and drops pid files for every instance when stop clears the pool', async () => {
      const revoked: number[] = [];
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        revokeBrokerUrl: (n) => revoked.push(n),
      });
      const helper = new RunnerManagerTestHelper(manager);
      // Already-exited processes, so stop() skips the kill loop and reaches the
      // finalize loop; a late exit would otherwise find the map cleared.
      const pidDir = (manager as unknown as { pidDir(): string }).pidDir();
      const held = path.join(pidDir, '1-aaaa.mark');
      const free = path.join(pidDir, '2-bbbb.mark');
      helper.setInstance(1, { name: 'runner-1', status: 'listening', process: { exitCode: 0, killed: true } as never, markerPath: held });
      helper.setInstance(2, { name: 'runner-2', status: 'busy', process: { exitCode: 0, killed: true } as never, markerPath: free });
      const unlinked: string[] = [];
      (fs.unlinkSync as jest.Mock).mockImplementation((f: unknown) => { unlinked.push(String(f)); });
      const unlink = jest.mocked(fs.promises.unlink) as unknown as jest.Mock;
      unlink.mockResolvedValue(undefined as never);
      unlink.mockClear();
      mockMarkerHolders.mockImplementation((p) => (p === held ? [7001] : []));
      mockSignalOrphanPids.mockResolvedValueOnce({ signalled: true, remaining: [7001] });
      jest.useFakeTimers();
      try {
        await manager.stop();

        expect(revoked).toEqual(expect.arrayContaining([1, 2]));
        expect(unlinked.filter((f) => /\/pids\/[12]\.pid$/.test(f)).length).toBeGreaterThanOrEqual(2);
        // Markers are not unlinked with the records; each is swept once its
        // tree has had the exit grace, and a held one stays.
        expect(unlinked.some((f) => f.endsWith('.mark'))).toBe(false);
        expect(unlink.mock.calls.map(([f]) => String(f))).not.toContain(free);
        await jest.advanceTimersByTimeAsync(GRACE_MS + 2000);
        const swept = unlink.mock.calls.map(([f]) => String(f));
        expect(swept).toContain(free);
        expect(swept).not.toContain(held);
      } finally {
        jest.useRealTimers();
        mockMarkerHolders.mockReset();
        mockMarkerHolders.mockImplementation(() => []);
      }
    });

    it('seals the proxy when the worker exits, not only when the slot restarts', async () => {
      // A finished worker's proxy token and allowed hosts otherwise stay live
      // until the slot is next started, which may be never - an orphan that
      // escaped reaping would keep the job's network for as long as it liked.
      const manager = new RunnerManager({ onLog: mockOnLog, onStatusChange: mockOnStatusChange, onJobHistoryUpdate: mockOnJobHistoryUpdate });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('{}');
      const proc = createMockProcess(12345);
      mockSpawnSandboxed.mockReturnValue(proc);
      jest.useFakeTimers();
      try {
        await new RunnerManagerTestHelper(manager).spawnForJob();
        const proxy = (ProxyServer as unknown as jest.Mock).mock.results.at(-1)!.value;
        const rotationsAtStart = proxy.rotateAuthToken.mock.calls.length;
        expect(rotationsAtStart).toBeGreaterThan(0);

        proc.emit('exit', 0, null);
        await jest.advanceTimersByTimeAsync(0);

        expect(proxy.rotateAuthToken.mock.calls.length).toBeGreaterThan(rotationsAtStart);
        expect(proxy.setPolicyAllowedHosts).toHaveBeenLastCalledWith([]);
        expect(proxy.setPolicyLevel).toHaveBeenLastCalledWith('strict');
      } finally {
        jest.useRealTimers();
      }
    });

    it('ignores a clean exit from a worker that no longer holds its slot', async () => {
      // A reaped worker handles SIGTERM gracefully and reports code 0 - after
      // the reap freed its slot, and possibly after a job refilled it. That
      // exit must not free the replacement's slot or seal its proxy.
      const manager = new RunnerManager({ onLog: mockOnLog, onStatusChange: mockOnStatusChange, onJobHistoryUpdate: mockOnJobHistoryUpdate });
      const helper = new RunnerManagerTestHelper(manager);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('{}');
      const proc = createMockProcess(12345);
      mockSpawnSandboxed.mockReturnValue(proc);
      jest.useFakeTimers();
      try {
        await helper.spawnForJob();
        const proxy = (ProxyServer as unknown as jest.Mock).mock.results.at(-1)!.value;
        helper.releaseInstanceSlot(1); // the reap
        helper.setInstance(1, { name: 'runner-1', status: 'busy', process: { pid: 6002, kill: jest.fn() } as never });
        const rotations = proxy.rotateAuthToken.mock.calls.length;

        proc.emit('exit', 0, null);
        await jest.advanceTimersByTimeAsync(0);

        const pool = (manager as unknown as { instances: Map<number, { process: { pid: number } | null }> }).instances;
        expect(pool.get(1)?.process?.pid).toBe(6002);
        expect(proxy.rotateAuthToken.mock.calls.length).toBe(rotations);
      } finally {
        jest.useRealTimers();
      }
    });

    it('is revoked when the worker exits', async () => {
      const revoked: number[] = [];
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        issueBrokerUrl: () => `http://127.0.0.1:8787/w/${'b'.repeat(64)}/`,
        issueWorkerCredential: perStartCredential,
        revokeBrokerUrl: (n) => revoked.push(n),
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('{}');
      const proc = createMockProcess(12345);
      mockSpawnSandboxed.mockReturnValue(proc);
      // The exit arms a marker settle timer; keep it from firing in a later test.
      jest.useFakeTimers();
      try {
        await new RunnerManagerTestHelper(manager).spawnForJob();
        expect(mockSpawnSandboxed).toHaveBeenCalled();

        proc.emit('exit', 0, null);
        await jest.advanceTimersByTimeAsync(0);

        // Clean exit frees the slot, which revokes; the identity-gated exit
        // cleanup may revoke again. Idempotent, so assert it happened at least once.
        expect(revoked).toContain(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('a worker that will never take its job', () => {
    function recordingManager() {
      const cancelled: Array<[string, number, string | undefined]> = [];
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        onWorkerReservedForJob: () => undefined,
        onWorkerReservationCancelled: (t, i, j) => cancelled.push([t, i, j]),
      });
      return { manager, helper: new RunnerManagerTestHelper(manager), cancelled };
    }
    const context = { targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'req-1' };

    it('gives up its job when it is reaped, so the next worker is not handed it', () => {
      // The reap recorded the job as failed and left it queued at the broker,
      // where the next worker for the repository took it in place of its own.
      const { helper, cancelled } = recordingManager();
      helper.setInstance(1, { name: 'runner-1', status: 'listening', currentJob: null });
      helper.setPendingTargetContext('1', context);

      helper.reapUnclaimedWorker(1);

      expect(cancelled).toEqual([['t1', 1, 'req-1']]);
    });

    it('forgets the job it was spawned for when it cannot be given credentials', async () => {
      // Left keyed by instance, the failed job's repository and policy would be
      // what a later start of this slot is built from.
      const { manager, helper, cancelled } = recordingManager();
      helper.startedAt = new Date().toISOString();
      helper.setPendingTargetContext('next', context);
      helper.stubStartInstance(async () => undefined);
      (jest.mocked(fs.existsSync) as unknown as jest.Mock).mockReturnValue(false);

      await manager.spawnWorkerForJob('seatbelt');

      expect(cancelled).toEqual([['t1', 1, 'req-1']]);
      expect(helper.pendingTargetContext('1')).toBeUndefined();
    });

    it('forgets the job when the start fails without throwing', async () => {
      // startInstance reports most failures by marking the instance and
      // returning, so returning is not the same as starting.
      const { manager, helper, cancelled } = recordingManager();
      helper.startedAt = new Date().toISOString();
      helper.setPendingTargetContext('next', context);
      helper.stubCopyProxyCredentials(async () => undefined);
      helper.stubStartInstance(async (n) => {
        helper.setInstance(n, { name: `runner-${n}`, status: 'error', process: null });
      });
      (jest.mocked(fs.existsSync) as unknown as jest.Mock).mockReturnValue(true);

      await manager.spawnWorkerForJob('seatbelt');

      expect(cancelled).toEqual([['t1', 1, 'req-1']]);
      expect(helper.pendingTargetContext('1')).toBeUndefined();
    });

    it('forgets the job when the worker exits before taking it', async () => {
      const { helper, cancelled } = recordingManager();
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const proc = createMockProcess(12345);
      mockSpawnSandboxed.mockReturnValue(proc);
      await helper.spawnForJob(context);

      proc.emit('exit', 1, null);
      await settle();

      expect(cancelled).toEqual([['t1', 1, 'req-1']]);
      expect(helper.pendingTargetContext('1')).toBeUndefined();
    });

    it("leaves the slot's next worker alone when an old worker's exit arrives late", async () => {
      // A reaped worker is signalled and its slot handed out at once, so its
      // exit can land after the next worker has been spawned into the slot.
      const { helper, cancelled } = recordingManager();
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const proc = createMockProcess(12345);
      mockSpawnSandboxed.mockReturnValue(proc);
      await helper.spawnForJob(context);
      const next = { targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'req-2' };
      helper.setInstance(1, { name: 'runner-1', status: 'starting', process: createMockProcess(777) });
      helper.setPendingTargetContext('1', next);

      proc.emit('exit', 1, null);
      await settle();

      expect(cancelled).toEqual([]);
      expect(helper.pendingTargetContext('1')).toBe(next);
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

    it('removes the reaped worker\'s pid file so a later sweep cannot act on it', () => {
      const { helper } = idlePool();
      const unlinked: string[] = [];
      (fs.unlinkSync as jest.Mock).mockImplementation((f: unknown) => { unlinked.push(String(f)); });
      helper.reapUnclaimedWorker(1);
      expect(unlinked.some((f) => f.endsWith('/pids/1.pid'))).toBe(true);
    });

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

    it("revokes the reaped worker's broker key, since it never exits to trigger the exit handler", () => {
      const revoked: number[] = [];
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        revokeBrokerUrl: (n) => revoked.push(n),
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, { name: 'runner-1', status: 'listening', currentJob: null });

      helper.reapUnclaimedWorker(1);

      expect(revoked).toContain(1);
    });

    it('reports the job that never started, instead of reclaiming the slot in silence', () => {
      // A consumer watched five runs: two were killed by GitHub at exactly
      // 600s having never run a step, and localmost showed a healthy spawn
      // followed by heartbeats straight through - no failure, no refusal,
      // indistinguishable from an idle runner. The slot was reclaimed at 120s
      // and nobody was told, so nothing connected the reap to the dead job.
      const { helper } = idlePool();
      const events: JobEvent[] = [];
      helper.setOnJobEvent((e) => events.push(e as JobEvent));
      helper.setPendingTargetContext('1', {
        targetId: 't1',
        targetDisplayName: 'owner/repo',
        actionsUrl: 'https://github.com/owner/repo/actions/runs/1/job/2',
        githubRunId: 1,
        githubJobId: 2,
        githubWorkflow: 'macos',
      });

      helper.reapUnclaimedWorker(1);

      expect(events).toHaveLength(1);
      expect(events[0].repository).toBe('owner/repo');
      expect(events[0].status).toBe('failed');
      expect(events[0].reason).toMatch(/never started/i);
      // And it lands in history, so it is visible after the notification goes.
      const recorded = mockOnJobHistoryUpdate.mock.calls.at(-1)?.[0] as Array<{ status: string; actionsUrl?: string }>;
      expect(recorded.at(-1)?.status).toBe('failed');
      expect(recorded.at(-1)?.actionsUrl).toContain('/job/2');
    });

    it("reports an organization target's unstarted job under the job's repository", () => {
      // An org target's name is the organization alone; recorded under it,
      // the failure named no repository and could not be cancelled from the
      // status page.
      const { helper } = idlePool();
      const events: JobEvent[] = [];
      helper.setOnJobEvent((e) => events.push(e as JobEvent));
      helper.setPendingTargetContext('1', {
        targetId: 't2',
        targetDisplayName: 'myorg',
        githubRepo: 'myorg/app',
        githubRunId: 1,
        githubJobId: 2,
        githubWorkflow: 'macos',
      });

      helper.reapUnclaimedWorker(1);

      expect(events[0].repository).toBe('myorg/app');
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

      await new RunnerManagerTestHelper(runnerManager).spawnForJob();

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
      // BuildKit, the default builder since Docker 23, streams a build over a
      // gRPC session the filter cannot inspect. The classic builder is the one
      // `build:` policy actually describes, so the job is pinned to it.
      expect(options.env?.DOCKER_BUILDKIT).toBe('0');
      // The job's temp is inside its own sandbox, not the user's shared
      // $TMPDIR: the sandbox can no longer reach unix sockets in the shared
      // temp, so a socket bound under TMPDIR has to land somewhere it may use.
      const socketDir = '/Users/test/.localmost/runner/sandbox/1';
      expect(options.env?.TMPDIR).toBe(`${socketDir}/_temp`);
      expect(options.env?.RUNNER_TEMP).toBe(`${socketDir}/_temp`);
      // The profile grants this socket by name; the daemon's is no longer handed over.
      expect(options).toHaveProperty('dockerSocket', socketPath);
      expect(options).not.toHaveProperty('dockerGrants');
    });

    it("builds each worker's docker socket on its own worker of the backend, with the §5.4 context", async () => {
      const contexts: WorkerContext[] = [];
      const worker = { prewarm: jest.fn() } as unknown as WorkerDocker;
      const dockerBackend: DockerBackend = {
        name: 'test',
        supportsPrivileged: false,
        disposable: true,
        workspaceMountRoot: (dir) => dir,
        forWorker: (ctx) => {
          contexts.push(ctx);
          return worker;
        },
      };
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        dockerBackend,
        dockerCli: '/Applications/localmost.app/Contents/Resources/docker-cli/docker',
        getDockerVmConfig: () => ({ ...vmConfig, bootTimeoutSec: 45 }),
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));

      await new RunnerManagerTestHelper(manager).spawnForJob({ targetId: 't1', targetDisplayName: 'Owner/Repo' });

      const socket = dockerSocketOf(new RunnerManagerTestHelper(manager), 1);
      expect(socket.options.backend).toBe(dockerBackend);
      expect(socket.options.worker).toBe(worker);
      expect(socket.options.bootTimeoutMs).toBe(45_000);
      expect(contexts).toHaveLength(1);
      const [ctx] = contexts;
      expect(ctx).toMatchObject({
        slot: 1,
        sandboxDir: '/Users/test/.localmost/runner/sandbox/1',
        sandboxId: '1',
        shareNonce: 'a'.repeat(32),
        spawnRepository: 'Owner/Repo',
      });
      // The worker's proxy, read when asked: its port and its token-bearing URL.
      expect(ctx.proxy()).toEqual({ port: 12345, url: expect.stringMatching(/^http:\/\/localmost:[0-9a-f]+@127\.0\.0\.1:12345$/) });
      // No spare unless dockerVm.prewarm says so.
      expect(worker.prewarm).not.toHaveBeenCalled();
    });

    it('serves a worker no daemon at all when the runner was given no backend', async () => {
      // Never a fallback to the operator's own daemon (owner decision 3).
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));

      await new RunnerManagerTestHelper(manager).spawnForJob({ targetId: 't1', targetDisplayName: 'Owner/Repo' });

      const socket = dockerSocketOf(new RunnerManagerTestHelper(manager), 1);
      expect(socket.options.backend).toBe(noDockerBackend);
      const worker = socket.options.worker as WorkerDocker;
      worker.bind('Owner/Repo', { run: { images: ['alpine:3'] } });
      expect(await worker.endpoint(1000)).toEqual({ kind: 'none', reason: NO_DAEMON_MESSAGE });
    });

    it('gives the job the bundled CLI first on its PATH, an empty config of its own, the share rules and the helper deny', async () => {
      const cli = '/Applications/localmost.app/Contents/Resources/docker-cli/docker';
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        dockerCli: cli,
        vmHelper: '/Applications/localmost.app/Contents/Resources/localmost-vm',
        macVmHelper: '/Applications/localmost.app/Contents/Resources/localmost-macvm',
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));

      await new RunnerManagerTestHelper(manager).spawnForJob();

      const [, , options] = mockSpawnSandboxed.mock.calls[mockSpawnSandboxed.mock.calls.length - 1];
      const env = options!.env as NodeJS.ProcessEnv;
      expect(env.DOCKER_CONFIG).toBe('/Users/test/.localmost/runner/sandbox/1/.docker');
      // First on PATH, the job's bin directory, where the CLI is linked.
      expect(env.PATH!.split(':')[0]).toBe('/Users/test/.localmost/runner/sandbox/1/localmost/bin');
      expect(fs.symlinkSync).toHaveBeenCalledWith(cli, '/Users/test/.localmost/runner/sandbox/1/localmost/bin/docker');
      expect(env.DOCKER_HOST).toBe('unix:///Users/test/.localmost/runner/sandbox/1/docker.sock');
      expect(env.DOCKER_BUILDKIT).toBe('0');
      expect(options).toMatchObject({
        shareDir: '/Users/test/.localmost/runner/sandbox/1/_work',
        dockerCli: cli,
        // The helpers, which the job's profile refuses to run.
        vmHelper: '/Applications/localmost.app/Contents/Resources/localmost-vm',
        macVmHelper: '/Applications/localmost.app/Contents/Resources/localmost-macvm',
      });
    });

    it('boots a spare for the worker when dockerVm.prewarm is on', async () => {
      const worker = { prewarm: jest.fn() } as unknown as WorkerDocker;
      const manager = new RunnerManager({
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        dockerBackend: { name: 'test', supportsPrivileged: false, disposable: true, workspaceMountRoot: (d) => d, forWorker: () => worker },
        getDockerVmConfig: () => ({ ...vmConfig, prewarm: true }),
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));
      await new RunnerManagerTestHelper(manager).spawnForJob();
      expect(worker.prewarm).toHaveBeenCalledTimes(1);
    });

    it('starts no worker whose share nonce cannot be written', async () => {
      const manager = new RunnerManager({ onLog: mockOnLog, onStatusChange: mockOnStatusChange, onJobHistoryUpdate: mockOnJobHistoryUpdate });
      const helper = new RunnerManagerTestHelper(manager);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));
      (manager as unknown as { downloader: { writeShareNonce: jest.Mock } }).downloader.writeShareNonce.mockImplementationOnce(() => {
        throw new Error("EEXIST: file already exists, open '_work/.localmost-share'");
      });
      mockSpawnSandboxed.mockClear();
      await helper.spawnForJob();
      expect(mockSpawnSandboxed).not.toHaveBeenCalled();
      expect(mockOnLog).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'error', message: expect.stringMatching(/work folder of instance 1: EEXIST/) })
      );
    });

    it("forwards the docker socket's log entries to the runner log", async () => {
      // The socket warns when no daemon is behind it and logs each denial
      // with its policy hint; neither is any use unless it reaches the log.
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValue(createMockProcess(12345));
      await new RunnerManagerTestHelper(runnerManager).spawnForJob();
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
      helper.setInstance(1, { name: 'runner-1', status: 'listening', claimedJob: { repository: 'owner/repo', sha: 'abc1234', workflow: 'integration' }, });
      helper.setProxy(1, { setPolicyAllowedHosts: jest.fn(), setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel: jest.fn() });
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
        helper.setProxy(instanceNum, { setPolicyAllowedHosts: jest.fn(), setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel: jest.fn() });
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
      helper.setProxy(1, { setPolicyAllowedHosts: jest.fn(), setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel: jest.fn() });
      const socket = dockerSocketStub();
      helper.setDockerProxy(1, socket);

      await helper.applyPolicyOnClaim(1, 'other/repo', 'abc1234');
      await helper.parseRunnerOutput(1, 'Running job: build');
      await settle();

      expect(socket.bind).not.toHaveBeenCalled();
      expect(socket.boundRepository()).toBeUndefined();
      // Its spare, booted for owner/repo, is stopped at the claim.
      expect(socket.staysClosed).toHaveBeenCalledWith('the claim is for other/repo, not owner/repo, so the Docker socket stays closed');
    });

    it('stops the docker socket when the worker exits', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const proc = createMockProcess(12345);
      mockSpawnSandboxed.mockReturnValue(proc);
      const helper = new RunnerManagerTestHelper(runnerManager);
      await helper.spawnForJob();
      const socket = dockerSocketOf(helper, 1);

      proc.emit('exit', 0, null);
      await settle();

      expect(socket.stop).toHaveBeenCalled();
      expect(helper.dockerProxy(1)).toBeUndefined();
    });

    it('starts the next socket in the slot only once the last one has removed its containers', async () => {
      // Stopping removes the containers the job left, which takes a moment.
      // The next worker's socket binds the same path, so it waits; the app
      // quitting waits the same way, rather than leaving them running.
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      mockSpawnSandboxed.mockReturnValueOnce(createMockProcess(12345)).mockReturnValueOnce(createMockProcess(12346));
      const helper = new RunnerManagerTestHelper(runnerManager);
      await helper.startWorkerWithoutJob(1);
      const first = dockerSocketOf(helper, 1);
      let finishRemoval: () => void = () => {};
      first.stop.mockReturnValue(new Promise<void>((resolve) => { finishRemoval = resolve; }));

      (mockSpawnSandboxed.mock.results[0].value as ReturnType<typeof createMockProcess>).emit('exit', 0, null);
      await settle();
      const respawn = runnerManager.startInstance(1);
      await settle();
      expect(mockSpawnSandboxed).toHaveBeenCalledTimes(1);

      finishRemoval();
      await respawn;
      expect(mockSpawnSandboxed).toHaveBeenCalledTimes(2);
      expect(dockerSocketOf(helper, 1)).not.toBe(first);
    });

    describe("stopping waits for the socket to remove the job's containers", () => {
      // Quitting the app goes through stop(). Were it to finish first, a job's
      // `--restart` or detached containers would be left on the daemon with
      // nothing left to remove them.
      const realKill = process.kill;
      afterEach(() => {
        (process as unknown as { kill: unknown }).kill = realKill;
      });

      /** Start a worker whose socket's removal stays pending until the returned function is called. */
      const workerWithSlowRemoval = async (): Promise<{ proc: ReturnType<typeof createMockProcess>; socket: DockerSocketStub; finishRemoval: () => void }> => {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        const proc = createMockProcess(12345);
        mockSpawnSandboxed.mockReturnValue(proc);
        const helper = new RunnerManagerTestHelper(runnerManager);
        await helper.spawnForJob();
        const socket = dockerSocketOf(helper, 1);
        let finishRemoval: () => void = () => {};
        socket.stop.mockReturnValue(new Promise<void>((resolve) => { finishRemoval = resolve; }));
        return { proc, socket, finishRemoval };
      };

      const expectStopToWaitFor = async (socket: DockerSocketStub, finishRemoval: () => void): Promise<void> => {
        let stopped = false;
        const stopping = runnerManager.stop().then(() => { stopped = true; });
        for (let i = 0; i < 5; i++) await settle();
        expect(socket.stop).toHaveBeenCalled();
        expect(stopped).toBe(false);

        finishRemoval();
        await stopping;
        expect(stopped).toBe(true);
      };

      it('when the worker exits on the stop', async () => {
        const { proc, socket, finishRemoval } = await workerWithSlowRemoval();
        // A live worker, which exits on the group's SIGTERM; its group is then
        // empty, so the sweep that follows sends nothing more.
        Object.defineProperty(proc, 'exitCode', { value: null, writable: true });
        let exited = false;
        proc.once('exit', () => { exited = true; });
        (process as unknown as { kill: unknown }).kill = ((pid: number, sig?: unknown) => {
          if (pid === -12345 && sig === 'SIGTERM') {
            process.nextTick(() => proc.emit('exit', null, 'SIGTERM'));
            return true;
          }
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        }) as never;

        await expectStopToWaitFor(socket, finishRemoval);
        expect(exited).toBe(true);
      });

      it("when the worker's exit never reached the manager", async () => {
        const { socket, finishRemoval } = await workerWithSlowRemoval();
        await expectStopToWaitFor(socket, finishRemoval);
      });

      it('when the worker could not be spawned', async () => {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        const helper = new RunnerManagerTestHelper(runnerManager);
        let socket: DockerSocketStub | undefined;
        let finishRemoval: () => void = () => {};
        mockSpawnSandboxed.mockImplementationOnce(() => {
          socket = dockerSocketOf(helper, 1);
          socket.stop.mockReturnValue(new Promise<void>((resolve) => { finishRemoval = resolve; }));
          throw new Error('spawn EAGAIN');
        });
        await runnerManager.initialize();

        let started = false;
        const starting = runnerManager.startInstance(1).then(() => { started = true; });
        for (let i = 0; i < 5; i++) await settle();
        expect(socket?.stop).toHaveBeenCalled();
        expect(started).toBe(false);

        finishRemoval();
        await starting;
        expect(helper.dockerProxy(1)).toBeUndefined();
      });
    });

    it('leaves a socket that took the slot while the last one was removing its containers', async () => {
      // The finished stop forgets only its own socket, never whichever one
      // holds the slot by the time it is done.
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const proc = createMockProcess(12345);
      mockSpawnSandboxed.mockReturnValue(proc);
      const helper = new RunnerManagerTestHelper(runnerManager);
      await helper.startWorkerWithoutJob(1);
      const first = dockerSocketOf(helper, 1);
      let finishRemoval: () => void = () => {};
      first.stop.mockReturnValue(new Promise<void>((resolve) => { finishRemoval = resolve; }));

      proc.emit('exit', 0, null);
      await settle();
      const replacement = dockerSocketStub();
      helper.setDockerProxy(1, replacement);
      finishRemoval();
      await settle();

      expect(helper.dockerProxy(1)).toBe(replacement);
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

  it('leaves docker out of the policy stamp, since the socket is bound per claim', () => {
    const manager = makeManager();
    const stamp = (docker: DockerPolicy) =>
      (manager as any).stampFor({
        level: 'strict',
        readPaths: [],
        writePaths: [],
        docker,
      });

    // Docker merges shared with the claimed workflow's section and the socket
    // is bound to that at every claim; nothing of it is in the profile. The
    // spawn stamp is taken before the workflow is known, so stamping docker
    // made every claim of a workflow with its own docker section drift.
    expect(stamp({})).toEqual(stamp({ run: { images: ['postgres:16'] } }));
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
    const proxy = {
      setPolicyAllowedHosts: jest.fn(), setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(),
      setPolicyLevel: jest.fn(), getStats: jest.fn(), getPolicyLevel: jest.fn(),
    };
    const dockerSocket = { bind: jest.fn(), boundRepository: jest.fn(), staysClosed: jest.fn() };
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
    expect(dockerSocket.staysClosed).toHaveBeenCalledWith(expect.stringMatching(/policy changed since this worker started/));

    // The job-start refresh must not undo that. It runs without isClaim, so it
    // never re-checks drift, and it used to fall straight through to widening.
    await helper.applyRepoPolicy(1);

    expect(dockerSocket.bind).not.toHaveBeenCalled();
    expect(proxy.setPolicyAllowedHosts).toHaveBeenLastCalledWith([]);
  });
});

describe('a released slot does not carry the finished job\'s context', () => {
  it('does not judge the next worker in that slot against the previous repository', () => {
    const manager = new RunnerManager({
      onLog: jest.fn(), onStatusChange: jest.fn(), onJobHistoryUpdate: jest.fn(),
    });
    const helper = new RunnerManagerTestHelper(manager);

    // Slot 1 ran a job for owner/first, then the worker went away.
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'owner/first', githubSha: 'aaa1111' });
    helper.releaseInstanceSlot(1);

    // With the previous job's context still in the slot, the next worker there
    // is judged against owner/first and its socket never opens for the job it
    // is running.
    expect(helper.pendingTargetContext('1')).toBeUndefined();
  });
});

describe('a worker nobody spawned for a job', () => {
  it('keeps its docker socket closed whatever job it claims', async () => {
    // Only spawnWorkerForJob records what a worker is for. A worker without
    // that record - an idle listener - used to be taken as spawned for
    // whatever repository its claim named, so a job reaching it opened the
    // socket with that repository's container grants.
    const docker = { run: { images: ['alpine:3'] } };
    const manager = new RunnerManager({
      onLog: jest.fn(), onStatusChange: jest.fn(), onJobHistoryUpdate: jest.fn(),
      getRepoPolicy: async () => ({ hosts: ['example.com'], level: 'strict' as const, readPaths: [], writePaths: [], docker }),
    });
    const helper = new RunnerManagerTestHelper(manager);
    const dockerSocket = { bind: jest.fn(), boundRepository: jest.fn(), staysClosed: jest.fn() };
    helper.setProxy(1, { setPolicyAllowedHosts: jest.fn(), setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel: jest.fn() });
    helper.setDockerProxy(1, dockerSocket);
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });

    await helper.applyPolicyOnClaim(1, 'owner/repo', 'abc1234');

    expect(dockerSocket.bind).not.toHaveBeenCalled();
  });

  it('opens it for the repository it was spawned for', async () => {
    const docker = { run: { images: ['alpine:3'] } };
    const manager = new RunnerManager({
      onLog: jest.fn(), onStatusChange: jest.fn(), onJobHistoryUpdate: jest.fn(),
      getRepoPolicy: async () => ({ hosts: [], level: 'strict' as const, readPaths: [], writePaths: [], docker }),
    });
    const helper = new RunnerManagerTestHelper(manager);
    const dockerSocket = { bind: jest.fn(), boundRepository: jest.fn(), staysClosed: jest.fn() };
    helper.setProxy(1, { setPolicyAllowedHosts: jest.fn(), setPolicyDeniedHosts: jest.fn(), setLoopbackPolicy: jest.fn(), setPolicyLevel: jest.fn() });
    helper.setDockerProxy(1, dockerSocket);
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' });

    await helper.applyPolicyOnClaim(1, 'owner/repo', 'abc1234');

    expect(dockerSocket.bind).toHaveBeenCalledWith('owner/repo', docker);
  });
});

describe('the job a worker claims through its proxy', () => {
  it("asks the broker about the job as this worker's, not as anyone's", async () => {
    // The id comes from the acquirejob body, which the job can write. Resolved
    // globally, naming another repository's job installed that repository's
    // hosts on this worker's proxy.
    const getJobTarget = jest.fn((..._args: unknown[]) => undefined);
    const manager = new RunnerManager({
      onLog: jest.fn(), onStatusChange: jest.fn(), onJobHistoryUpdate: jest.fn(),
      getJobTarget: getJobTarget as never,
    });
    const helper = new RunnerManagerTestHelper(manager);
    await helper.startInstanceProxy(3);
    const options = jest.mocked(ProxyServer).mock.calls.at(-1)![0] as { onJobAcquired: (jobId: string) => Promise<void> };
    const proxy = jest.mocked(ProxyServer).mock.results.at(-1)!.value as { setPolicyAllowedHosts: jest.Mock };

    await options.onJobAcquired('req-other');

    expect(getJobTarget).toHaveBeenCalledWith(3, 'req-other');
    expect(proxy.setPolicyAllowedHosts).toHaveBeenLastCalledWith([]);
  });
});

describe('spawning the worker for an admitted job', () => {
  function manager() {
    const onLog = jest.fn();
    const m = new RunnerManager({
      onLog, onStatusChange: jest.fn(), onJobHistoryUpdate: jest.fn(),
    });
    const helper = new RunnerManagerTestHelper(m);
    helper.startedAt = new Date().toISOString();
    return { m, helper, onLog };
  }

  it('says when no worker was started, and does not leave the job on offer', async () => {
    // Only the worker spawned for a job may take it, so a job put back in
    // 'next' for something else to pick up is a job nothing will ever run -
    // with its payload held at the broker. The caller drops it instead.
    jest.useFakeTimers();
    try {
      const { m, helper } = manager();
      helper.runnerCount = 1;
      helper.setInstance(1, { name: 'runner-1', status: 'busy' });
      helper.setPendingTargetContext('next', { targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'req-1' });

      const spawned = m.spawnWorkerForJob('seatbelt');
      await jest.advanceTimersByTimeAsync(61_000);

      await expect(spawned).resolves.toBe(false);
      expect(helper.pendingTargetContext('next')).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('says when it started the worker', async () => {
    const { m, helper } = manager();
    helper.setPendingTargetContext('next', { targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'req-1' });
    helper.stubCopyProxyCredentials(async () => undefined);
    helper.stubStartInstance(async (n) => {
      helper.setInstance(n, { name: `runner-${n}`, status: 'starting', process: createMockProcess(4242) });
    });
    (jest.mocked(fs.existsSync) as unknown as jest.Mock).mockReturnValue(true);

    await expect(m.spawnWorkerForJob('seatbelt')).resolves.toBe(true);
  });

  it('says when the worker could not be started', async () => {
    const { m, helper } = manager();
    helper.setPendingTargetContext('next', { targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'req-1' });
    helper.stubCopyProxyCredentials(async () => undefined);
    helper.stubStartInstance(async () => undefined);
    (jest.mocked(fs.existsSync) as unknown as jest.Mock).mockReturnValue(true);

    await expect(m.spawnWorkerForJob('seatbelt')).resolves.toBe(false);
  });

  it('starts a seatbelt worker with the isolation it was chosen under in its context', async () => {
    const { m, helper } = manager();
    helper.setPendingTargetContext('next', { targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'req-1' });
    helper.stubCopyProxyCredentials(async () => undefined);
    let contextAtStart: unknown;
    helper.stubStartInstance(async (n) => {
      contextAtStart = helper.pendingTargetContext(String(n));
      helper.setInstance(n, { name: `runner-${n}`, status: 'starting', process: createMockProcess(4243) });
    });
    (jest.mocked(fs.existsSync) as unknown as jest.Mock).mockReturnValue(true);

    await expect(m.spawnWorkerForJob('seatbelt')).resolves.toBe(true);
    expect(contextAtStart).toEqual(expect.objectContaining({ jobId: 'req-1', isolation: 'seatbelt' }));
  });

  it.each(['service-account', 'macos-vm'] as const)(
    'starts no worker for %s, which has no implementation in this build, and leaves nothing on offer',
    async (isolation) => {
      const { m, helper, onLog } = manager();
      helper.setPendingTargetContext('next', { targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'req-1' });
      const started = jest.fn(async () => undefined);
      helper.stubStartInstance(started);

      await expect(m.spawnWorkerForJob(isolation)).resolves.toBe(false);
      expect(started).not.toHaveBeenCalled();
      expect(helper.pendingTargetContext('next')).toBeUndefined();
      expect(onLog).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'error', message: expect.stringContaining(`${isolation} isolation has no implementation in this build`) })
      );
    }
  );

  it('starts no worker for a type it does not know, rather than running it under seatbelt', async () => {
    // A type added to ISOLATION_TYPES without a case here fails to compile;
    // this is what it does at runtime if one ever arrives anyway.
    const { m, helper, onLog } = manager();
    helper.setPendingTargetContext('next', { targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'req-1' });
    const started = jest.fn(async () => undefined);
    helper.stubStartInstance(started);

    await expect(m.spawnWorkerForJob('linux-vm' as unknown as IsolationType)).resolves.toBe(false);
    expect(started).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', message: expect.stringContaining('unknown isolation type "linux-vm"') })
    );
  });

  // The stub above is module-wide; later describes in this file have no
  // beforeEach of their own to reset it.
  afterEach(() => {
    (jest.mocked(fs.existsSync) as unknown as jest.Mock).mockReset();
  });
});

describe('a job start on a worker', () => {
  function manager() {
    const m = new RunnerManager({
      onLog: jest.fn(), onStatusChange: jest.fn(), onJobHistoryUpdate: jest.fn(),
    });
    const helper = new RunnerManagerTestHelper(m);
    helper.startedAt = new Date().toISOString();
    return { m, helper };
  }

  it("takes its context only from its own slot, never from admission's 'next'", async () => {
    // 'next' is admission's hand-off to spawnWorkerForJob, which takes it in
    // the same tick. A worker with no context of its own was not spawned for
    // a job, and whatever lingered in 'next' is not its job.
    const { helper } = manager();
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    helper.setPendingTargetContext('next', { targetId: 't2', targetDisplayName: 'owner/other', jobId: 'req-2' });

    await helper.parseRunnerOutput(1, 'Running job: build');

    expect(helper.instances.get(1)!.currentJob?.targetDisplayName).toBeUndefined();
    expect(helper.pendingTargetContext('next')).toBeDefined();
  });

  it('does not start a listener in another slot when every worker is busy', async () => {
    // Only a worker spawned and announced for a job can take one, so a
    // listener started ahead of any job never binds; it would hold a slot
    // until the pool stops and take a job from nobody.
    const { helper } = manager();
    helper.runnerCount = 2;
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'req-1' });
    const startInstance = jest.fn(async (_n: number) => undefined);
    helper.stubStartInstance(startInstance);

    await helper.parseRunnerOutput(1, 'Running job: build');
    await settle();

    expect(startInstance).not.toHaveBeenCalled();
  });
});

describe('a job that names no actor', () => {
  function manager(scope: 'everyone' | 'trigger' | 'contributors', cancelWorkflowRun = jest.fn(async () => undefined)) {
    return new RunnerManager({
      onLog: jest.fn(), onStatusChange: jest.fn(), onJobHistoryUpdate: jest.fn(),
      getUserFilter: () => ({ scope, allowedUsers: 'just-me', allowlist: [] }),
      getCurrentUserLogin: () => 'me',
      getAllContributors: async () => new Set(['me']),
      cancelWorkflowRun,
    });
  }
  const evaluate = (m: RunnerManager) =>
    (m.evaluateJobFilter as (o: string, r: string, actor: string | undefined, sha?: string) => ReturnType<RunnerManager['evaluateJobFilter']>)
      .call(m, 'o', 'r', undefined, 'abc123');

  it('is refused by any scope that filters', async () => {
    for (const scope of ['trigger', 'contributors'] as const) {
      const verdict = await evaluate(manager(scope));
      expect(verdict.allowed).toBe(false);
    }
  });

  it('is admitted when nobody is filtered', async () => {
    await expect(evaluate(manager('everyone'))).resolves.toEqual({ allowed: true, reason: '' });
  });

  it('is cancelled by the job-start backstop rather than waved through', async () => {
    const cancelWorkflowRun = jest.fn(async () => undefined);
    const helper = new RunnerManagerTestHelper(manager('trigger', cancelWorkflowRun));
    helper.setInstance(1, {
      name: 'runner-1',
      currentJob: { name: 'build', repository: 'owner/repo', startedAt: 'now', id: 'job-1', targetDisplayName: 'owner/repo', githubRunId: 42 },
    });

    await helper.checkJobUserFilter(1, 'runner-1');

    expect(cancelWorkflowRun).toHaveBeenCalledWith('owner', 'repo', 42);
  });
});
