 
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { FALLBACK_RUNNER_VERSION } from '../shared/constants';

// Mock http module
const mockServerListen = jest.fn<(port: number, callback: () => void) => void>();
const mockServerClose = jest.fn<(callback: () => void) => void>();
const mockServerCloseAllConnections = jest.fn();
const mockServer = {
  on: jest.fn(),
  listen: mockServerListen,
  close: mockServerClose,
  closeAllConnections: mockServerCloseAllConnections,
};
const mockCreateServer = jest.fn(() => mockServer);

jest.mock('http', () => ({
  createServer: mockCreateServer,
}));

// Mock https module
const mockHttpsRequest = jest.fn();
jest.mock('https', () => ({
  request: mockHttpsRequest,
}));

// Mock crypto
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto') as typeof import('crypto');
  return {
    ...actual,
    sign: jest.fn(() => Buffer.from('mock-signature')),
    createPrivateKey: jest.fn(() => 'mock-private-key'),
  };
});

// Mock app-state
jest.mock('./app-state', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

import { BrokerProxyService, extractGitHubJobInfo } from './broker-proxy-service';
import type { Target } from '../shared/types';

// Helper to create mock credentials for a single instance
const createMockInstanceCredentials = (instanceNum = 1) => ({
  instanceNum,
  runner: {
    agentId: instanceNum,
    agentName: `test-runner.${instanceNum}`,
    poolId: 1,
    poolName: 'Default',
    serverUrl: 'https://pipelines.actions.githubusercontent.com',
    gitHubUrl: 'https://github.com',
    workFolder: '_work',
    useV2Flow: true,
    serverUrlV2: 'https://broker.actions.githubusercontent.com/',
  },
  credentials: {
    scheme: 'OAuth',
    data: {
      clientId: 'test-client-id',
      authorizationUrl: 'https://vstoken.actions.githubusercontent.com',
      requireFipsCryptography: 'false',
    },
  },
  rsaParams: {
    d: 'mock-d',
    dp: 'mock-dp',
    dq: 'mock-dq',
    exponent: 'AQAB', // Standard RSA exponent
    inverseQ: 'mock-inverseQ',
    modulus: 'mock-modulus'.padEnd(256, '0'), // Needs to be at least 256 chars for key size
    p: 'mock-p',
    q: 'mock-q',
  },
});

// Helper to create array of mock credentials for multiple instances
const createMockCredentials = (count = 1) =>
  Array.from({ length: count }, (_, i) => createMockInstanceCredentials(i + 1));

const createMockTarget = (overrides?: Partial<Target>): Target => ({
  id: 'test-target-id',
  type: 'repo',
  owner: 'testowner',
  repo: 'testrepo',
  displayName: 'testowner/testrepo',
  url: 'https://github.com/testowner/testrepo',
  proxyRunnerName: 'localmost.test-host.testowner-testrepo',
  enabled: true,
  addedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

describe('BrokerProxyService', () => {
  let service: BrokerProxyService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BrokerProxyService(8787);

    // Default server mock behavior
    mockServerListen.mockImplementation((_port, callback) => {
      callback();
    });
    mockServerClose.mockImplementation((callback) => {
      callback();
    });
  });

  afterEach(async () => {
    // Ensure service is stopped
    try {
      await service.stop();
    } catch {
      // Ignore
    }
  });

  describe('constructor', () => {
    it('should create service with default port', () => {
      const s = new BrokerProxyService();
      expect(s.getPort()).toBe(8787);
    });

    it('should create service with custom port', () => {
      const s = new BrokerProxyService(9999);
      expect(s.getPort()).toBe(9999);
    });
  });

  describe('runner version reported to GitHub', () => {
    it('uses the installed runner version when one is provided', () => {
      const service = new BrokerProxyService();
      service.setRunnerVersion('2.336.0');

      expect(service.getRunnerVersion()).toBe('2.336.0');
    });

    it('defaults to the shared fallback rather than a private copy', () => {
      const service = new BrokerProxyService();

      // GitHub rejects deprecated runner versions with 403 RunnerVersionTooOld,
      // which silently prevents every runner from coming online. The default
      // must track the shared constant, not a separate hardcoded string.
      expect(service.getRunnerVersion()).toBe(FALLBACK_RUNNER_VERSION);
    });
  });

  describe('addTarget', () => {
    it('should add a target', () => {
      const target = createMockTarget();
      const creds = createMockCredentials();

      service.addTarget(target, creds);

      const status = service.getStatus();
      expect(status).toHaveLength(1);
      expect(status[0].targetId).toBe('test-target-id');
    });

    it('should add multiple targets', () => {
      const target1 = createMockTarget({ id: 'target-1' });
      const target2 = createMockTarget({ id: 'target-2' });
      const creds = createMockCredentials();

      service.addTarget(target1, creds);
      service.addTarget(target2, creds);

      const status = service.getStatus();
      expect(status).toHaveLength(2);
    });
  });

  describe('removeTarget', () => {
    interface RetryInternals {
      targets: Map<string, unknown>;
      sessionRetryTimeouts: Map<string, NodeJS.Timeout>;
      scheduleSessionRetry(state: unknown, instance: unknown): void;
    }

    it('cancels pending session retries for the removed target', () => {
      const target = createMockTarget();
      service.addTarget(target, createMockCredentials());

      const internals = service as unknown as RetryInternals;
      internals.scheduleSessionRetry(internals.targets.get(target.id), { instanceNum: 1 });
      expect(internals.sessionRetryTimeouts.size).toBe(1);

      service.removeTarget(target.id);

      // A retry that outlives its target retries forever against credentials
      // that no longer exist, logging an OAuth failure every interval.
      expect(internals.sessionRetryTimeouts.size).toBe(0);
    });

    it('leaves retries for other targets alone', () => {
      service.addTarget(createMockTarget({ id: 'target-1' }), createMockCredentials());
      service.addTarget(createMockTarget({ id: 'target-2' }), createMockCredentials());

      const internals = service as unknown as RetryInternals;
      internals.scheduleSessionRetry(internals.targets.get('target-1'), { instanceNum: 1 });
      internals.scheduleSessionRetry(internals.targets.get('target-2'), { instanceNum: 1 });

      service.removeTarget('target-1');

      expect(Array.from(internals.sessionRetryTimeouts.keys())).toEqual(['target-2/1']);
    });


    it('should remove a target', () => {
      const target = createMockTarget();
      const creds = createMockCredentials();

      service.addTarget(target, creds);
      expect(service.getStatus()).toHaveLength(1);

      service.removeTarget('test-target-id');
      expect(service.getStatus()).toHaveLength(0);
    });

    it('should do nothing when removing non-existent target', () => {
      service.removeTarget('non-existent');
      expect(service.getStatus()).toHaveLength(0);
    });
  });

  describe('getStatus', () => {
    it('should return empty array when no targets', () => {
      expect(service.getStatus()).toEqual([]);
    });

    it('should return status for all targets', () => {
      const target = createMockTarget();
      const creds = createMockCredentials();

      service.addTarget(target, creds);

      const status = service.getStatus();
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({
        targetId: 'test-target-id',
        registered: true,
        sessionActive: false,
        lastPoll: null,
        jobsAssigned: 0,
      });
    });
  });

  describe('getPort', () => {
    it('should return the configured port', () => {
      expect(service.getPort()).toBe(8787);
    });
  });

  describe('start', () => {
    it('should start the server', async () => {
      await service.start();

      expect(mockCreateServer).toHaveBeenCalled();
      expect(mockServerListen).toHaveBeenCalledWith(8787, expect.any(Function));
    });

    it('should not start twice', async () => {
      await service.start();
      await service.start();

      expect(mockCreateServer).toHaveBeenCalledTimes(1);
    });

    it('should reject on server error', async () => {
      mockServer.on.mockImplementation((...args: unknown[]) => {
        const [event, handler] = args as [string, (err: Error) => void];
        if (event === 'error') {
          // Simulate error after a tick
          setTimeout(() => handler(new Error('Port in use')), 0);
        }
      });
      mockServerListen.mockImplementation(() => {
        // Don't call callback, let error handler fire
      });

      await expect(service.start()).rejects.toThrow('Port in use');
    });
  });

  describe('stop', () => {
    it('should stop the server', async () => {
      await service.start();
      await service.stop();

      expect(mockServerClose).toHaveBeenCalled();
    });

    it('should do nothing if not running', async () => {
      await service.stop();

      expect(mockServerClose).not.toHaveBeenCalled();
    });
  });

  describe('events', () => {
    it('should be an EventEmitter', () => {
      expect(service).toBeInstanceOf(EventEmitter);
    });

    it('should allow subscribing to status-update events', () => {
      const handler = jest.fn();
      service.on('status-update', handler);

      // Verify it's registered (we can't easily trigger the event without more mocking)
      expect(service.listenerCount('status-update')).toBe(1);
    });

    it('should allow subscribing to job-received events', () => {
      const handler = jest.fn();
      service.on('job-received', handler);

      expect(service.listenerCount('job-received')).toBe(1);
    });

    it('should allow subscribing to error events', () => {
      const handler = jest.fn();
      service.on('error', handler);

      expect(service.listenerCount('error')).toBe(1);
    });
  });

  describe('target state management', () => {
    it('should track jobs assigned per target', () => {
      const target = createMockTarget();
      const creds = createMockCredentials();

      service.addTarget(target, creds);

      const status = service.getStatus();
      expect(status[0].jobsAssigned).toBe(0);
    });

    it('should track session state per target', () => {
      const target = createMockTarget();
      const creds = createMockCredentials();

      service.addTarget(target, creds);

      const status = service.getStatus();
      expect(status[0].sessionActive).toBe(false);
    });
  });

  describe('setCanAcceptJobCallback', () => {
    it('should accept callback function', () => {
      const callback = (): boolean => true;
      service.setCanAcceptJobCallback(callback);

      // Callback is stored internally - can't directly verify, but it shouldn't throw
      expect(true).toBe(true);
    });

    it('should allow capacity-based job acceptance', () => {
      let capacity = true;
      const callback = (): boolean => capacity;
      service.setCanAcceptJobCallback(callback);

      // Simulate changing capacity
      capacity = false;

      // The callback should now return false (at capacity)
      expect(callback()).toBe(false);
    });
  });

  describe('getQueuedJob', () => {
    it('should return null when no jobs queued', () => {
      expect(service.getQueuedJob()).toBeNull();
    });
  });

  describe('hasQueuedJobs', () => {
    it('should return false when no jobs queued', () => {
      expect(service.hasQueuedJobs()).toBe(false);
    });
  });

  describe('shutdown handling', () => {
    it('should handle stop gracefully', async () => {
      await service.start();

      // Stop should complete without error
      await expect(service.stop()).resolves.not.toThrow();
    });

    it('should clear polling on stop', async () => {
      await service.start();
      await service.stop();

      // Starting again should work (polling was properly cleaned up)
      await expect(service.start()).resolves.not.toThrow();
    });
  });
});

describe('extractGitHubJobInfo', () => {
  // The broker's job details carry GitHub context as a dict:
  // {"t":2,"d":[{"k":"run_id","v":"123"},...]}
  it('reads the run, repository, actor, sha and ref from the github context and the check run id from the job context', () => {
    const info = extractGitHubJobInfo({
      github: { d: [
        { k: 'run_id', v: '123' },
        { k: 'repository', v: 'owner/repo' },
        { k: 'actor', v: 'octocat' },
        { k: 'sha', v: 'abc1234def' },
        { k: 'ref', v: 'refs/heads/main' },
      ] },
      job: { d: [{ k: 'check_run_id', v: '456' }] },
    });

    expect(info).toEqual({
      githubRunId: 123,
      githubJobId: 456,
      githubRepo: 'owner/repo',
      githubActor: 'octocat',
      githubSha: 'abc1234def',
      githubRef: 'refs/heads/main',
    });
  });

  it('identifies nothing when the context is absent', () => {
    expect(extractGitHubJobInfo(undefined)).toEqual({});
  });

  it('extracts github.workflow into the job info', () => {
    // Per-workflow policy keys on the workflow, which only this field names;
    // the job name the runner prints later is a different thing.
    const info = extractGitHubJobInfo({ github: { d: [
      { k: 'run_id', v: '123' },
      { k: 'repository', v: 'owner/repo' },
      { k: 'workflow', v: 'integration' },
    ] } });

    expect(info.githubWorkflow).toBe('integration');
  });
});

describe('message routing', () => {
  interface Instance { sessionId?: string; runner: { agentName: string } }
  interface RoutingInternals {
    targets: Map<string, { target: Target; instances: Map<number, Instance> }>;
    messageQueues: Map<string, string[]>;
    pendingTargetAssignments: string[];
    localSessions: Map<string, { targetId?: string }>;
    handleRequest(req: unknown, res: unknown): Promise<void>;
    processMessage(state: unknown, instance: unknown, body: string): Promise<void>;
  }

  // Broker messages as GitHub delivers them: the inner body is a JSON string.
  const jobMessage = JSON.stringify({
    messageId: 2,
    messageType: 'RunnerJobRequest',
    body: JSON.stringify({ runner_request_id: 'req-1' }),
  });
  const refreshMessage = JSON.stringify({
    messageId: 1,
    messageType: 'RunnerRefreshConfig',
    body: JSON.stringify({ config_type: 'runner' }),
  });
  const cancelMessage = JSON.stringify({
    messageId: 3,
    messageType: 'JobCancellation',
    body: JSON.stringify({ jobId: 'req-1' }),
  });

  const fakeRequest = (method: string, url: string, body = '') => {
    const req = new EventEmitter() as EventEmitter & {
      method: string; url: string; headers: Record<string, string>;
      [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>;
    };
    req.method = method;
    req.url = url;
    req.headers = {};
    req[Symbol.asyncIterator] = async function* () { if (body) yield Buffer.from(body); };
    return req;
  };

  const fakeResponse = () => {
    let ended = false;
    const res = new EventEmitter() as EventEmitter & {
      statusCode: number; body: string; writableEnded: boolean;
      writeHead: (code: number) => unknown; end: (chunk?: unknown) => unknown;
    };
    Object.defineProperty(res, 'writableEnded', { get: () => ended });
    res.writeHead = (code) => { res.statusCode = code; return res; };
    res.end = (chunk) => { res.body = chunk ? String(chunk) : ''; ended = true; res.emit('close'); return res; };
    return res;
  };

  let service: BrokerProxyService;
  let internals: RoutingInternals;

  const request = async (method: string, url: string, body?: string) => {
    const res = fakeResponse();
    await internals.handleRequest(fakeRequest(method, url, body), res);
    return res;
  };

  const addTargetWithRunner = (id: string, agentName: string) => {
    const target = createMockTarget({ id, displayName: id });
    const cred = createMockInstanceCredentials(1);
    service.addTarget(target, [{ ...cred, runner: { ...cred.runner, agentName } }]);
    // An upstream session already exists, so /session doesn't try to create one.
    internals.targets.get(id)!.instances.get(1)!.sessionId = `upstream-${id}`;
    return target;
  };

  const createSession = async (body?: string): Promise<string> => {
    const res = await request('POST', '/session', body);
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).sessionId;
  };

  beforeEach(() => {
    service = new BrokerProxyService(8787);
    internals = service as unknown as RoutingInternals;
    // Upstream calls (acknowledge) succeed silently.
    mockHttpsRequest.mockImplementation((...args: unknown[]) => {
      const callback = args[1] as (res: EventEmitter) => void;
      const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; write: () => void; end: () => void };
      req.setTimeout = () => {};
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number };
        res.statusCode = 200;
        callback(res);
        res.emit('end');
      };
      return req;
    });
  });

  it('delivers the queued job before a stale RunnerRefreshConfig', async () => {
    // GitHub pushes RunnerRefreshConfig between jobs. If the next worker's first
    // poll returns that instead of its job, the runner rewrites its config and
    // restarts its session, and the job is never delivered.
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    internals.messageQueues.set(target.id, [refreshMessage, jobMessage]);
    internals.pendingTargetAssignments.push(target.id);

    const sessionId = await createSession();
    const res = await request('GET', `/message?sessionId=${sessionId}`);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).messageType).toBe('RunnerJobRequest');
  });

  it('drops RunnerRefreshConfig instead of queuing it for the next worker', async () => {
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    const state = internals.targets.get(target.id)!;

    await internals.processMessage(state, state.instances.get(1), refreshMessage);

    expect(internals.messageQueues.get(target.id) ?? []).toEqual([]);
  });

  it('queues a JobCancellation behind the job it is for', async () => {
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    internals.messageQueues.set(target.id, [jobMessage]);
    const state = internals.targets.get(target.id)!;

    await internals.processMessage(state, state.instances.get(1), cancelMessage);

    expect(internals.messageQueues.get(target.id)).toEqual([jobMessage, cancelMessage]);
  });

  it('queues a JobCancellation for a job a worker is running', async () => {
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    internals.messageQueues.set(target.id, [jobMessage]);
    internals.pendingTargetAssignments.push(target.id);
    const sessionId = await createSession();
    await request('GET', `/message?sessionId=${sessionId}`);
    const state = internals.targets.get(target.id)!;

    await internals.processMessage(state, state.instances.get(1), cancelMessage);

    expect(internals.messageQueues.get(target.id)).toEqual([cancelMessage]);
  });

  it('drops a JobCancellation for a job that is neither queued nor running', async () => {
    // GitHub redelivers a cancellation for a while after the job ends. Queued
    // for a target with no worker, it would be handed to the next worker.
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    const state = internals.targets.get(target.id)!;

    await internals.processMessage(state, state.instances.get(1), cancelMessage);

    expect(internals.messageQueues.get(target.id) ?? []).toEqual([]);
  });

  it("answers the runner's own acknowledge locally", async () => {
    const res = await request('POST', '/acknowledge?sessionId=abc', JSON.stringify({ runnerRequestId: 'req-1' }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{}');
  });

  it('rejects an oversized session request instead of buffering it', async () => {
    const res = await request('POST', '/session', 'x'.repeat(65 * 1024));

    expect(res.statusCode).toBe(413);
  });

  describe('session to target binding', () => {
    it('leaves a session unbound when its target has no job waiting', async () => {
      // A listener spawned ahead of any job runs in the generic sandbox, not
      // the repository's approved policy. Binding it would let it win the next
      // job and fail it (seen live: cargo denied reading ~/.rustup).
      addTargetWithRunner('target-a', 'runner-a.1');
      addTargetWithRunner('target-b', 'runner-b.1');

      const sessionId = await createSession(JSON.stringify({ agent: { name: 'runner-b.1' } }));

      expect(internals.localSessions.get(sessionId)?.targetId).toBeUndefined();
    });

    it("never hands a named session another target's pending assignment", async () => {
      const targetA = addTargetWithRunner('target-a', 'runner-a.1');
      addTargetWithRunner('target-b', 'runner-b.1');
      internals.pendingTargetAssignments.push(targetA.id);

      const sessionId = await createSession(JSON.stringify({ agent: { name: 'runner-b.1' } }));

      expect(internals.localSessions.get(sessionId)?.targetId).toBeUndefined();
      expect(internals.pendingTargetAssignments).toEqual([targetA.id]);
    });

    it('consumes the matching pending assignment, not the first one', async () => {
      const targetA = addTargetWithRunner('target-a', 'runner-a.1');
      const targetB = addTargetWithRunner('target-b', 'runner-b.1');
      internals.pendingTargetAssignments.push(targetA.id, targetB.id);

      await createSession(JSON.stringify({ agent: { name: 'runner-b.1' } }));

      expect(internals.pendingTargetAssignments).toEqual([targetA.id]);
    });

    it('falls back to the pending assignment when the request names no runner', async () => {
      const targetA = addTargetWithRunner('target-a', 'runner-a.1');
      internals.pendingTargetAssignments.push(targetA.id);

      const sessionId = await createSession();

      expect(internals.localSessions.get(sessionId)?.targetId).toBe(targetA.id);
    });
  });
});
