
// Mock runner-downloader to avoid tar dependency issues
jest.mock('./runner-downloader', () => ({
  RunnerDownloader: jest.fn().mockImplementation(() => ({
    getBaseDir: jest.fn().mockReturnValue('/Users/test/.localmost/runner'),
    getArcDir: jest.fn().mockReturnValue('/Users/test/.localmost/runner/arc/v2.330.0'),
    getConfigDir: jest.fn().mockImplementation((instance: number) => `/Users/test/.localmost/runner/config/${instance}`),
    removeSandbox: jest.fn().mockResolvedValue(undefined),
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
import { ProxyServer } from './proxy-server';
import * as os from 'os';
import { LogEntry, RunnerState, JobHistoryEntry } from '../shared/types';
import { DockerPolicy } from '../shared/docker-policy';
import type { LocalmostrcConfig } from '../shared/localmostrc';
import { repoPolicyRuntime } from './repo-policy';
import { DockerFilterProxy } from './docker/docker-filter-proxy';
import { NO_DAEMON_MESSAGE, noDockerBackend } from './docker/docker-backend';
import type { DockerBackend, WorkerContext, WorkerDocker } from './docker/docker-backend';
import type { DockerVmConfig } from './config';

const vmConfig: DockerVmConfig = {
  prewarm: false, cpus: 4, memoryMiB: 8192, maxRunning: 2, dataDiskGiB: 64, bootTimeoutSec: 60,
  cacheLimitGiB: 20, pullMaxGiB: 10, jobPullMaxGiB: 30, minFreeGiB: 20,
};
import { createMockWorker, fakeIsolation, type FakeIsolation, RunnerManagerTestHelper } from './test-utils';

/** The macOS VM backend every manager here runs its workers on; a new one for each test. */
let isolation: FakeIsolation;
beforeEach(() => {
  isolation = fakeIsolation();
});

/** Stands in for the broker making a worker its per-start key. */
const perStartCredential = async () => ({
  credentials: {
    scheme: 'OAuth',
    data: { clientId: 'per-start-client', authorizationUrl: 'http://127.0.0.1:8787/w/key/_apis/oauth2/token', requireFipsCryptography: 'True' },
  },
  rsaParams: { d: 'D', dp: 'DP', dq: 'DQ', exponent: 'AQAB', inverseQ: 'IQ', modulus: 'N', p: 'P', q: 'Q' },
});


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

    mockOnLog = jest.fn();
    mockOnStatusChange = jest.fn();
    mockOnJobHistoryUpdate = jest.fn();

    // Default mocks
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('{}');

    runnerManager = new RunnerManager({
      isolation,
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
        isolation,
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
        isolation,
        onLog: mockOnLog,
        onStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
      });

      await expect(manager.initialize()).rejects.toThrow('Could not determine runner version');
      expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'offline' }));
    });

    it('should start runner process when configured', async () => {
      // Mock file existence checks
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      // Create mock process
      const mockProcess = createMockWorker(12345);
      isolation.spawnWorker.mockResolvedValue(mockProcess);

      const started = await new RunnerManagerTestHelper(runnerManager).spawnForJob();

      expect(started).toBe(true);
      expect(mockOnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
          message: expect.stringContaining('Spawning worker 1'),
        })
      );

      // Its runner was started in its VM.
      expect(isolation.spawnWorker).toHaveBeenCalled();
    });

    it('does nothing when initialized again while a worker is running', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      const mockProcess = createMockWorker(12346);
      isolation.spawnWorker.mockResolvedValue(mockProcess);

      await new RunnerManagerTestHelper(runnerManager).spawnForJob();

      // Try to start again
      await runnerManager.initialize();

      expect(mockOnLog).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('already running'),
        })
      );
      expect(isolation.spawnWorker).toHaveBeenCalledTimes(1);
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
      // An unstamped worker was started with no policy, which is the safe
      // state to run under. A truthy sentinel here failed the drift check against every
      // real hash, so such a worker refused every job.
      const setPolicyAllowedHosts = jest.fn();
      const manager = new RunnerManager({
        isolation,
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
        isolation,
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
        isolation,
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
      // Hosts are resolved per workflow and applied per job. The stamp is
      // taken over the whole approved policy, so the spawn's - before the
      // workflow is known - matches the claim's for any workflow.
      const approved: LocalmostrcConfig = {
        version: 1,
        shared: { filesystem: { read: ['~/.npm'] } },
        workflows: { build: { network: { allow: ['build-only.example'] } } },
      };
      const setPolicyAllowedHosts = jest.fn();
      const manager = new RunnerManager({
        isolation,
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        getRepoPolicy: async (_o: string, _r: string, _s: string, workflowName: string) => repoPolicyRuntime(approved, workflowName),
      });
      const helper = new RunnerManagerTestHelper(manager);
      helper.setInstance(1, {
        name: 'runner-1',
        claimedJob: { repository: 'owner/repo', sha: 'abc1234', workflow: 'build' },
        // Stamped at spawn, where the workflow name is not yet known.
        policyStamp: repoPolicyRuntime(approved, '').stamp,
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
        isolation,
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

      // What the worker was started with is fixed, so the declared hosts are
      // withheld and the job is left with runner infrastructure only.
      expect(setPolicyAllowedHosts).toHaveBeenLastCalledWith([]);
    });

    it('applies the level the repository declares, per job', async () => {
      // Instances are pooled across repositories, so a level captured when the
      // proxy started could belong to whichever repo happened to run first.
      const setPolicyLevel = jest.fn();
      const manager = new RunnerManager({
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        isolation,
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
        helper.setInstance(n, { name: `runner-${n}`, status: 'starting', worker: createMockWorker(4242) });
      });
      helper.stubCopyProxyCredentials(async () => undefined);
      // The proxy credentials directory has to look present, or the spawn takes
      // a genuine failure path and withdrawing would be correct.
      (jest.mocked(fs.existsSync) as unknown as jest.Mock).mockReturnValue(true);

      await manager.spawnWorkerForJob();

      expect(reserved).toHaveLength(1);
      expect(cancelled).toEqual([]);
    });

    it('withdraws it when the worker cannot be started', async () => {
      const reserved: Array<[string, number]> = [];
      const cancelled: Array<[string, number]> = [];
      const manager = new RunnerManager({
        isolation,
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

      await manager.spawnWorkerForJob().catch(() => undefined);

      expect(reserved).toHaveLength(1);
      expect(cancelled).toHaveLength(1);
    });
  });

  describe("a worker's own proxy", () => {
    it('revokes the broker key when startInstance fails after issuing it', async () => {
      const revoked: number[] = [];
      const manager = new RunnerManager({
        isolation,
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        issueBrokerUrl: () => `http://127.0.0.1:8787/w/${'c'.repeat(64)}/`,
        issueWorkerCredential: perStartCredential,
        revokeBrokerUrl: (n) => revoked.push(n),
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('{}');
      // startInstance needs a version, and issues the key before its VM starts.
      (manager as unknown as { runnerVersion: string }).runnerVersion = '1.0.0';
      // The runner cannot be started after the key is issued and written into the config.
      isolation.spawnWorker.mockRejectedValue(new Error('the guest agent refused the job'));

      await manager.startInstance(1);

      expect(revoked).toContain(1);
      // Its VM goes now, nothing having started in it.
      expect(isolation.release).toHaveBeenCalledTimes(1);
    });

    it('hands the runner a proxy URL with a per-worker token', async () => {
      // The proxy token isolates each worker on shared loopback.
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      isolation.spawnWorker.mockResolvedValue(createMockWorker(9911));

      await new RunnerManagerTestHelper(runnerManager).spawnForJob();

      const env = isolation.spawnWorker.mock.calls.at(-1)![2];
      expect(env.HTTPS_PROXY).toMatch(/^http:\/\/localmost:[0-9a-f]{48}@127\.0\.0\.1:/);
      expect(env.http_proxy).toBe(env.HTTPS_PROXY);
    });
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
      // that shell had. None of it is the job's, and the guest has its own
      // PATH and HOME.
      await withHostEnv({ FOO_SECRET: 'hunter2', SSH_AUTH_SOCK: '/tmp/agent.sock', NODE_OPTIONS: '--inspect' }, async () => {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        isolation.spawnWorker.mockResolvedValue(createMockWorker(12345));

        await new RunnerManagerTestHelper(runnerManager).spawnForJob();

        const env = isolation.spawnWorker.mock.calls.at(-1)![2];
        expect(env.FOO_SECRET).toBeUndefined();
        expect(env.SSH_AUTH_SOCK).toBeUndefined();
        expect(env.NODE_OPTIONS).toBeUndefined();
        expect(env.PATH).toBeUndefined();
        expect(env.HOME).toBeUndefined();
        // What the app sets for the runner itself.
        expect(env.ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT).toBe('true');
        expect(env.HTTPS_PROXY).toBeDefined();
      });
    });

    it("applies the repository's approved env policy", async () => {
      await withHostEnv({ DEVELOPER_DIR: '/Applications/Xcode-beta.app', FOO_SECRET: 'hunter2', LANG: 'C' }, async () => {
        const manager = new RunnerManager({
          isolation,
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
        isolation.spawnWorker.mockResolvedValue(createMockWorker(12345));

        await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' });

        const env = isolation.spawnWorker.mock.calls.at(-1)![2];
        expect(env.DEVELOPER_DIR).toBe('/Applications/Xcode-beta.app');
        expect(env.LANG).toBeUndefined();
        expect(env.FOO_SECRET).toBeUndefined();
      });
    });

    it('cannot use the env policy to replace what the app sets for the runner', async () => {
      await withHostEnv({ HTTPS_PROXY: 'http://evil.example:1' }, async () => {
        const manager = new RunnerManager({
          isolation,
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
        isolation.spawnWorker.mockResolvedValue(createMockWorker(12345));

        await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' });

        const env = isolation.spawnWorker.mock.calls.at(-1)![2];
        expect(env.HTTPS_PROXY).toMatch(/^http:\/\/localmost:/);
      });
    });
  });

  describe("a worker's broker address", () => {
    it('is issued per start and written into the runner config the worker reads', async () => {
      // The broker serves only workers holding a key it issued. The key goes
      // in the sandbox's own .runner, which is the one the runner reads.
      const issued: Array<[number, string | undefined]> = [];
      const manager = new RunnerManager({
        isolation,
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
      isolation.spawnWorker.mockResolvedValue(createMockWorker(12345));

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
        isolation,
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
      isolation.spawnWorker.mockResolvedValue(createMockWorker(12345));

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
      expect(order[rsaIndex]).toBeLessThan(isolation.spawnWorker.mock.invocationCallOrder[0]);
    });

    it('does not start a worker the broker could not make a key for', async () => {
      const revoked: number[] = [];
      const manager = new RunnerManager({
        isolation,
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
      isolation.spawnWorker.mockReset();

      await (manager as unknown as { startInstance(n: number): Promise<void> }).startInstance(1);

      expect(isolation.spawnWorker).not.toHaveBeenCalled();
      expect(revoked).toContain(1);
    });

    it('revokes the key and releases the VM when the slot is released on job completion', () => {
      const revoked: number[] = [];
      const manager = new RunnerManager({
        isolation,
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        revokeBrokerUrl: (n) => revoked.push(n),
      });
      const helper = new RunnerManagerTestHelper(manager);
      const job = { key: '1-1-aaaa', proxyPort: 1, brokerPort: 2, sandboxDir: '/Users/test/.localmost/runner/sandbox/1-aaaa', runnerVersion: '2.330.0' };
      helper.setInstance(1, { name: 'runner-1', status: 'busy', job });

      helper.releaseInstanceSlot(1);

      expect(revoked).toContain(1);
      expect(isolation.release).toHaveBeenCalledWith(job);
    });

    it('revokes keys and releases VMs for every instance when stop clears the pool', async () => {
      const revoked: number[] = [];
      const manager = new RunnerManager({
        isolation,
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        revokeBrokerUrl: (n) => revoked.push(n),
      });
      const helper = new RunnerManagerTestHelper(manager);
      const jobOf = (n: number) => ({ key: `${n}-x`, proxyPort: 1, brokerPort: 2, sandboxDir: `/Users/test/.localmost/runner/sandbox/${n}-x`, runnerVersion: '2.330.0' });
      // Listening, with no worker left to stop: stop() goes straight to the
      // finalize loop, which a late exit would otherwise find cleared.
      helper.setInstance(1, { name: 'runner-1', status: 'listening', job: jobOf(1) });
      helper.setInstance(2, { name: 'runner-2', status: 'busy', job: jobOf(2) });

      await manager.stop();

      expect(revoked).toEqual(expect.arrayContaining([1, 2]));
      expect(isolation.release).toHaveBeenCalledWith(jobOf(1));
      expect(isolation.release).toHaveBeenCalledWith(jobOf(2));
    });

    it('seals the proxy when the worker exits, not only when the slot restarts', async () => {
      // A finished worker's proxy token and allowed hosts otherwise stay live
      // until the slot is next started, which may be never - an orphan that
      // escaped reaping would keep the job's network for as long as it liked.
      const manager = new RunnerManager({ isolation, onLog: mockOnLog, onStatusChange: mockOnStatusChange, onJobHistoryUpdate: mockOnJobHistoryUpdate });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('{}');
      const proc = createMockWorker(12345);
      isolation.spawnWorker.mockResolvedValue(proc);
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
      const manager = new RunnerManager({ isolation, onLog: mockOnLog, onStatusChange: mockOnStatusChange, onJobHistoryUpdate: mockOnJobHistoryUpdate });
      const helper = new RunnerManagerTestHelper(manager);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('{}');
      const proc = createMockWorker(12345);
      isolation.spawnWorker.mockResolvedValue(proc);
      jest.useFakeTimers();
      try {
        await helper.spawnForJob();
        const proxy = (ProxyServer as unknown as jest.Mock).mock.results.at(-1)!.value;
        helper.releaseInstanceSlot(1); // the reap
        helper.setInstance(1, { name: 'runner-1', status: 'busy', worker: { pid: 6002, kill: jest.fn() } as never });
        const rotations = proxy.rotateAuthToken.mock.calls.length;

        proc.emit('exit', 0, null);
        await jest.advanceTimersByTimeAsync(0);

        const pool = (manager as unknown as { instances: Map<number, { worker: { pid: number } | null }> }).instances;
        expect(pool.get(1)?.worker?.pid).toBe(6002);
        expect(proxy.rotateAuthToken.mock.calls.length).toBe(rotations);
      } finally {
        jest.useRealTimers();
      }
    });

    it('is revoked when the worker exits', async () => {
      const revoked: number[] = [];
      const manager = new RunnerManager({
        isolation,
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        issueBrokerUrl: () => `http://127.0.0.1:8787/w/${'b'.repeat(64)}/`,
        issueWorkerCredential: perStartCredential,
        revokeBrokerUrl: (n) => revoked.push(n),
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('{}');
      const proc = createMockWorker(12345);
      isolation.spawnWorker.mockResolvedValue(proc);
      // The exit arms a marker settle timer; keep it from firing in a later test.
      jest.useFakeTimers();
      try {
        await new RunnerManagerTestHelper(manager).spawnForJob();
        expect(isolation.spawnWorker).toHaveBeenCalled();

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
        isolation,
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

      await manager.spawnWorkerForJob();

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
        helper.setInstance(n, { name: `runner-${n}`, status: 'error', worker: null });
      });
      (jest.mocked(fs.existsSync) as unknown as jest.Mock).mockReturnValue(true);

      await manager.spawnWorkerForJob();

      expect(cancelled).toEqual([['t1', 1, 'req-1']]);
      expect(helper.pendingTargetContext('1')).toBeUndefined();
    });

    it('forgets the job when the worker exits before taking it', async () => {
      const { helper, cancelled } = recordingManager();
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const proc = createMockWorker(12345);
      isolation.spawnWorker.mockResolvedValue(proc);
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
      const proc = createMockWorker(12345);
      isolation.spawnWorker.mockResolvedValue(proc);
      await helper.spawnForJob(context);
      const next = { targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'req-2' };
      helper.setInstance(1, { name: 'runner-1', status: 'starting', worker: createMockWorker(777) });
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
        isolation,
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

    it("releases the reaped worker's VM, with the listener in it, since it never exits on its own", () => {
      const { helper } = idlePool();
      const job = { key: '1-x', proxyPort: 1, brokerPort: 2, sandboxDir: '/Users/test/.localmost/runner/sandbox/1-x', runnerVersion: '2.330.0' };
      helper.setInstance(1, { name: 'runner-1', status: 'listening', currentJob: null, job, worker: createMockWorker(77) });

      helper.reapUnclaimedWorker(1);

      expect(isolation.release).toHaveBeenCalledWith(job);
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
        isolation,
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

    it('starts a default-deny docker socket for a spawned worker in its sandbox, before its VM', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      isolation.spawnWorker.mockResolvedValue(createMockWorker(12345));

      await new RunnerManagerTestHelper(runnerManager).spawnForJob();

      const socket = dockerSocketOf(new RunnerManagerTestHelper(runnerManager), 1);
      expect(socket).toBeDefined();
      const socketPath = '/Users/test/.localmost/runner/sandbox/1/docker.sock';
      expect(socket.start).toHaveBeenCalledWith(socketPath);
      // Born denying everything: nothing is bound until a job is claimed.
      expect(socket.boundRepository()).toBeUndefined();
      // Listening before the VM exists, as the relay into it will need it.
      expect(socket.start.mock.invocationCallOrder[0]).toBeLessThan(isolation.prepare.mock.invocationCallOrder[0]);
      // No job reaches it yet: the guest's environment names no docker host.
      expect(isolation.spawnWorker.mock.calls[0][2]).not.toHaveProperty('DOCKER_HOST');
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
        isolation,
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        dockerBackend,
        getDockerVmConfig: () => ({ ...vmConfig, bootTimeoutSec: 45 }),
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      isolation.spawnWorker.mockResolvedValue(createMockWorker(12345));

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
        isolation,
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      isolation.spawnWorker.mockResolvedValue(createMockWorker(12345));

      await new RunnerManagerTestHelper(manager).spawnForJob({ targetId: 't1', targetDisplayName: 'Owner/Repo' });

      const socket = dockerSocketOf(new RunnerManagerTestHelper(manager), 1);
      expect(socket.options.backend).toBe(noDockerBackend);
      const worker = socket.options.worker as WorkerDocker;
      worker.bind('Owner/Repo', { run: { images: ['alpine:3'] } });
      expect(await worker.endpoint(1000)).toEqual({ kind: 'none', reason: NO_DAEMON_MESSAGE });
    });

    it('boots a spare for the worker when dockerVm.prewarm is on', async () => {
      const worker = { prewarm: jest.fn() } as unknown as WorkerDocker;
      const manager = new RunnerManager({
        isolation,
        onLog: mockOnLog,
        onStatusChange: mockOnStatusChange,
        onJobHistoryUpdate: mockOnJobHistoryUpdate,
        dockerBackend: { name: 'test', supportsPrivileged: false, disposable: true, workspaceMountRoot: (d) => d, forWorker: () => worker },
        getDockerVmConfig: () => ({ ...vmConfig, prewarm: true }),
      });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      isolation.spawnWorker.mockResolvedValue(createMockWorker(12345));
      await new RunnerManagerTestHelper(manager).spawnForJob();
      expect(worker.prewarm).toHaveBeenCalledTimes(1);
    });

    it('starts no worker whose share nonce cannot be written', async () => {
      const manager = new RunnerManager({ isolation, onLog: mockOnLog, onStatusChange: mockOnStatusChange, onJobHistoryUpdate: mockOnJobHistoryUpdate });
      const helper = new RunnerManagerTestHelper(manager);
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      isolation.spawnWorker.mockResolvedValue(createMockWorker(12345));
      (manager as unknown as { downloader: { writeShareNonce: jest.Mock } }).downloader.writeShareNonce.mockImplementationOnce(() => {
        throw new Error("EEXIST: file already exists, open '_work/.localmost-share'");
      });
      isolation.spawnWorker.mockClear();
      await helper.spawnForJob();
      expect(isolation.spawnWorker).not.toHaveBeenCalled();
      expect(mockOnLog).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'error', message: expect.stringMatching(/work folder of instance 1: EEXIST/) })
      );
    });

    it("forwards the docker socket's log entries to the runner log", async () => {
      // The socket warns when no daemon is behind it and logs each denial
      // with its policy hint; neither is any use unless it reaches the log.
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      isolation.spawnWorker.mockResolvedValue(createMockWorker(12345));
      await new RunnerManagerTestHelper(runnerManager).spawnForJob();
      const socket = dockerSocketOf(new RunnerManagerTestHelper(runnerManager), 1);

      socket.options.onLog?.({ level: 'warn', message: 'no Docker daemon resolved; the job runs without Docker' });

      expect(mockOnLog).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn', message: expect.stringContaining('no Docker daemon resolved') })
      );
    });

    it('binds the socket to the claimed repository with its per-workflow docker policy once the job runs', async () => {
      const manager = new RunnerManager({
        isolation,
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
        isolation,
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
        isolation,
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
      const proc = createMockWorker(12345);
      isolation.spawnWorker.mockResolvedValue(proc);
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
      const firstWorker = createMockWorker(12345);
      isolation.spawnWorker.mockResolvedValueOnce(firstWorker).mockResolvedValueOnce(createMockWorker(12346));
      const helper = new RunnerManagerTestHelper(runnerManager);
      await helper.startWorkerWithoutJob(1);
      const first = dockerSocketOf(helper, 1);
      let finishRemoval: () => void = () => {};
      first.stop.mockReturnValue(new Promise<void>((resolve) => { finishRemoval = resolve; }));

      firstWorker.emit('exit', 0, null);
      await settle();
      const respawn = runnerManager.startInstance(1);
      await settle();
      expect(isolation.spawnWorker).toHaveBeenCalledTimes(1);

      finishRemoval();
      await respawn;
      expect(isolation.spawnWorker).toHaveBeenCalledTimes(2);
      expect(dockerSocketOf(helper, 1)).not.toBe(first);
    });

    describe("stopping waits for the socket to remove the job's containers", () => {
      // Quitting the app goes through stop(). Were it to finish first, a job's
      // `--restart` or detached containers would be left on the daemon with
      // nothing left to remove them.
      afterEach(() => {
        jest.useRealTimers();
      });

      /** Start a worker whose socket's removal stays pending until the returned function is called. */
      const workerWithSlowRemoval = async (): Promise<{ proc: ReturnType<typeof createMockWorker>; socket: DockerSocketStub; finishRemoval: () => void }> => {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        const proc = createMockWorker(12345);
        isolation.spawnWorker.mockResolvedValue(proc);
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
        // A live worker, whose runner exits on the SIGTERM sent into its VM.
        let exited = false;
        proc.once('exit', () => { exited = true; });
        isolation.signal.mockImplementation(async (_job, sig) => {
          if (sig === 'SIGTERM') process.nextTick(() => proc.emit('exit', null, 'SIGTERM'));
        });

        await expectStopToWaitFor(socket, finishRemoval);
        expect(exited).toBe(true);
      });

      it("when the worker's exit never reached the manager", async () => {
        const { socket, finishRemoval } = await workerWithSlowRemoval();
        // The runner ignores the SIGTERM: its VM is stopped under it after
        // the grace, and the socket's removal is still waited for.
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        let stopped = false;
        const stopping = runnerManager.stop().then(() => { stopped = true; });
        await jest.advanceTimersByTimeAsync(5000);
        for (let i = 0; i < 5; i++) await settle();
        expect(isolation.release).toHaveBeenCalled();
        expect(socket.stop).toHaveBeenCalled();
        expect(stopped).toBe(false);

        finishRemoval();
        await stopping;
        expect(stopped).toBe(true);
      });

      it('when the worker could not be spawned', async () => {
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        const helper = new RunnerManagerTestHelper(runnerManager);
        let socket: DockerSocketStub | undefined;
        let finishRemoval: () => void = () => {};
        isolation.spawnWorker.mockImplementationOnce(async () => {
          socket = dockerSocketOf(helper, 1);
          socket.stop.mockReturnValue(new Promise<void>((resolve) => { finishRemoval = resolve; }));
          throw new Error('the guest agent refused the job');
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
      const proc = createMockWorker(12345);
      isolation.spawnWorker.mockResolvedValue(proc);
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

describe('job-start detection against injected output', () => {
  const startedNames = (events: JobEvent[]) => events.filter((e) => e.type === 'started').map((e) => e.jobName);

  const setup = () => {
    const events: JobEvent[] = [];
    const manager = new RunnerManager({
      isolation,
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
      isolation,
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
    // after this worker started, so what it was started with is out of date.
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
      isolation,
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
      isolation,
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
      isolation,
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
      isolation,
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
      isolation,
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

      const spawned = m.spawnWorkerForJob();
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
      helper.setInstance(n, { name: `runner-${n}`, status: 'starting', worker: createMockWorker(4242) });
    });
    (jest.mocked(fs.existsSync) as unknown as jest.Mock).mockReturnValue(true);

    await expect(m.spawnWorkerForJob()).resolves.toBe(true);
  });

  it('says when the worker could not be started', async () => {
    const { m, helper } = manager();
    helper.setPendingTargetContext('next', { targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'req-1' });
    helper.stubCopyProxyCredentials(async () => undefined);
    helper.stubStartInstance(async () => undefined);
    (jest.mocked(fs.existsSync) as unknown as jest.Mock).mockReturnValue(true);

    await expect(m.spawnWorkerForJob()).resolves.toBe(false);
  });

  it("starts the worker with the job's context in its slot", async () => {
    const { m, helper } = manager();
    helper.setPendingTargetContext('next', { targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'req-1' });
    helper.stubCopyProxyCredentials(async () => undefined);
    let contextAtStart: unknown;
    helper.stubStartInstance(async (n) => {
      contextAtStart = helper.pendingTargetContext(String(n));
      helper.setInstance(n, { name: `runner-${n}`, status: 'starting', worker: createMockWorker(4243) });
    });
    (jest.mocked(fs.existsSync) as unknown as jest.Mock).mockReturnValue(true);

    await expect(m.spawnWorkerForJob()).resolves.toBe(true);
    expect(contextAtStart).toEqual(expect.objectContaining({ jobId: 'req-1', targetDisplayName: 'owner/repo' }));
  });

  it('starts no worker while no macOS VM can be started, and leaves nothing on offer', async () => {
    const { m, helper, onLog } = manager();
    isolation.available.mockReturnValue({ ok: false, reason: 'the golden macOS image is still being built' });
    helper.setPendingTargetContext('next', { targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'req-1' });
    const started = jest.fn(async () => undefined);
    helper.stubStartInstance(started);

    await expect(m.spawnWorkerForJob()).resolves.toBe(false);
    expect(started).not.toHaveBeenCalled();
    expect(helper.pendingTargetContext('next')).toBeUndefined();
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', message: 'This job will not run: Taking no jobs: the golden macOS image is still being built' })
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
      isolation,
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
      isolation,
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
