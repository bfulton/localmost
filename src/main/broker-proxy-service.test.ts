 
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
    mockServerListen.mockImplementation((...args: unknown[]) => {
      (args[args.length - 1] as () => void)();
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
      // Loopback only. Bound to every interface, anything on the same network
      // could reach it.
      expect(mockServerListen).toHaveBeenCalledWith(8787, '127.0.0.1', expect.any(Function));
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

describe('the workflow a per-workflow policy section keys on', () => {
  it('uses the workflow filename, which is what .localmostrc keys are documented to match', () => {
    const info = extractGitHubJobInfo({ github: { d: [
      { k: 'workflow', v: 'CI / build and test' },
      { k: 'workflow_ref', v: 'bfulton/localmost/.github/workflows/ci.yaml@refs/heads/main' },
    ] } });
    expect(info.githubWorkflow).toBe('ci');
  });

  it('handles a .yml extension and a ref containing slashes', () => {
    const info = extractGitHubJobInfo({ github: { d: [
      { k: 'workflow_ref', v: 'o/r/.github/workflows/docker-access.yml@refs/pull/35/merge' },
    ] } });
    expect(info.githubWorkflow).toBe('docker-access');
  });

  it('falls back to the workflow name when no ref is supplied', () => {
    const info = extractGitHubJobInfo({ github: { d: [{ k: 'workflow', v: 'Docker Access' }] } });
    expect(info.githubWorkflow).toBe('Docker Access');
  });
});

describe('message routing', () => {
  interface Instance { sessionId?: string; runner: { agentName: string } }
  interface RoutingInternals {
    targets: Map<string, { target: Target; instances: Map<number, Instance> }>;
    messageQueues: Map<string, string[]>;
    pendingTargetAssignments: string[];
    localSessions: Map<string, { targetId?: string; currentJobId?: string }>;
    acquiredJobDetails: Map<string, string>;
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
    (req as unknown as { resume: () => void }).resume = () => {};
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

  // Every worker reaches the broker through its own URL, whose path carries a
  // key the broker issued for that worker's start. Requests go through the
  // most recently started worker unless a test names another prefix.
  let workerPrefix = '';
  const prefixOf = (brokerUrl: string) => new URL(brokerUrl).pathname.replace(/\/$/, '');
  const startWorker = (instanceNum: number, targetId?: string) => {
    workerPrefix = prefixOf(service.issueWorkerKey(instanceNum, targetId));
    return workerPrefix;
  };

  const request = async (method: string, url: string, body?: string, prefix = workerPrefix) => {
    const res = fakeResponse();
    await internals.handleRequest(fakeRequest(method, `${prefix}${url}`, body), res);
    return res;
  };

  const addTargetWithRunner = (id: string, agentName: string) => {
    const target = createMockTarget({ id, displayName: id });
    const cred = createMockInstanceCredentials(1);
    service.addTarget(target, [{ ...cred, runner: { ...cred.runner, agentName } }]);
    // An upstream session already exists, so /session doesn't try to create one.
    internals.targets.get(id)!.instances.get(1)!.sessionId = `upstream-${id}`;
    startWorker(1, id);
    return target;
  };

  const createSession = async (body?: string, prefix = workerPrefix): Promise<string> => {
    const res = await request('POST', '/session', body, prefix);
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

  it('binds the worker it was told was spawned for the job, whoever polls first', async () => {
    // Measured by a consumer over five runs: every job that ran was executed by
    // the NEXT job's worker, ~10s after that job was assigned, and any job with
    // no successor inside 600s was killed by GitHub having never run a step.
    //
    // pendingTargetAssignments is a list of target ids, so with several
    // instances on one target arrival order is the only thing telling them
    // apart. Whichever session polled first consumed the assignment and the
    // worker actually spawned for the job came back unbound - permanently, and
    // since queues are per-target every later worker then drained the oldest
    // message. Naming the worker removes ordering from the decision.
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    internals.messageQueues.set(target.id, [jobMessage]);
    service.expectWorkerForJob(target.id, 1);

    const sessionId = await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }));
    const res = await request('GET', `/message?sessionId=${sessionId}`);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).messageType).toBe('RunnerJobRequest');
  });

  it('leaves a listener nobody spawned for a job unbound', async () => {
    // The property that gate protects: a listener spawned ahead of any job runs
    // in the generic sandbox, not the repository's approved policy. Binding it
    // would let it win the job and fail on a path the policy never granted.
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    internals.messageQueues.set(target.id, [jobMessage]);
    // Nothing was spawned for this job.

    const sessionId = await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }));

    expect(internals.localSessions.get(sessionId)?.targetId).toBeUndefined();
    expect(internals.messageQueues.get(target.id)).toHaveLength(1);
  });

  it('expects a worker only once, so a later listener cannot reuse the binding', async () => {
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    service.expectWorkerForJob(target.id, 1);

    const first = await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }));
    const second = await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }));

    expect(internals.localSessions.get(first)?.targetId).toBe(target.id);
    expect(internals.localSessions.get(second)?.targetId).toBeUndefined();
  });


  describe('who may talk to the broker', () => {
    const jobWithRunService = JSON.stringify({
      messageId: 2,
      messageType: 'RunnerJobRequest',
      body: JSON.stringify({ runner_request_id: 'req-1', run_service_url: 'http://localhost:8787/' }),
    });

    it('refuses a request that carries no worker key', async () => {
      // A job can reach the broker through its own proxy, so the address alone
      // proves nothing. Only a worker the app started holds a key.
      addTargetWithRunner('target-a', 'runner-a.1');

      const res = await request('POST', '/session', undefined, '');

      expect(res.statusCode).toBe(403);
    });

    it('refuses a key once the slot has been started again', async () => {
      addTargetWithRunner('target-a', 'runner-a.1');
      const old = workerPrefix;
      startWorker(1, 'target-a');

      const res = await request('POST', '/session', undefined, old);

      expect(res.statusCode).toBe(403);
    });

    it('takes the worker from its key, not from the name in the request', async () => {
      // The name in a session request is whatever the caller writes. A job
      // naming the worker another job was expected on would take that job.
      const targetA = addTargetWithRunner('target-a', 'runner-a.1');
      const cred = createMockInstanceCredentials(2);
      service.addTarget(createMockTarget({ id: 'target-b', displayName: 'target-b' }), [
        { ...cred, runner: { ...cred.runner, agentName: 'runner-b.2' } },
      ]);
      internals.targets.get('target-b')!.instances.get(2)!.sessionId = 'upstream-b';
      internals.messageQueues.set(targetA.id, [jobMessage]);
      service.expectWorkerForJob(targetA.id, 1);
      const intruder = startWorker(2, 'target-b');

      const sessionId = await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }), intruder);

      expect(internals.localSessions.get(sessionId)?.targetId).toBeUndefined();
      expect(internals.messageQueues.get(targetA.id)).toHaveLength(1);
    });

    it('hands job details only to the worker the job was delivered to', async () => {
      const target = addTargetWithRunner('target-a', 'runner-a.1');
      internals.acquiredJobDetails.set('req-1', JSON.stringify({ jobId: 'req-1' }));
      internals.acquiredJobDetails.set('2', JSON.stringify({ jobId: 'req-1' }));
      internals.messageQueues.set(target.id, [jobWithRunService]);
      service.expectWorkerForJob(target.id, 1);

      const early = await request('POST', '/acquirejob', JSON.stringify({ jobMessageId: 2 }));
      expect(early.statusCode).toBe(403);
      expect(internals.acquiredJobDetails.has('2')).toBe(true);

      const sessionId = await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }));
      await request('GET', `/message?sessionId=${sessionId}`);
      const res = await request('POST', '/acquirejob', JSON.stringify({ jobMessageId: 2 }));

      expect(res.statusCode).toBe(200);
    });

    it("points a delivered job's run service at the worker's own address", async () => {
      // The runner sends acquirejob, renewjob and finishjob to run_service_url.
      // Without its key there, every one of them would be refused.
      const target = addTargetWithRunner('target-a', 'runner-a.1');
      internals.messageQueues.set(target.id, [jobWithRunService]);
      service.expectWorkerForJob(target.id, 1);

      const sessionId = await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }));
      const res = await request('GET', `/message?sessionId=${sessionId}`);

      const inner = JSON.parse(JSON.parse(res.body).body);
      expect(new URL(inner.run_service_url).pathname).toBe(`${workerPrefix}/`);
    });

    it("refuses to poll another worker's session", async () => {
      addTargetWithRunner('target-a', 'runner-a.1');
      const sessionId = await createSession();
      const cred = createMockInstanceCredentials(2);
      service.addTarget(createMockTarget({ id: 'target-b', displayName: 'target-b' }), [cred]);
      const other = startWorker(2, 'target-b');

      const res = await request('GET', `/message?sessionId=${sessionId}`, undefined, other);

      expect(res.statusCode).toBe(404);
    });

    it('forwards nothing upstream for a worker holding no job', async () => {
      // Forwarding used to fall back to the first target with a session, so
      // any caller could send requests upstream on the runner's credentials.
      addTargetWithRunner('target-a', 'runner-a.1');
      mockHttpsRequest.mockClear();

      const res = await request('POST', '/finishjob', JSON.stringify({ planId: 'p', jobId: 'req-9' }));

      expect(res.statusCode).toBe(403);
      expect(mockHttpsRequest).not.toHaveBeenCalled();
    });
  });

  describe('abandoning a worker that never took its job', () => {
    const secondJob = JSON.stringify({
      messageId: 4,
      messageType: 'RunnerJobRequest',
      body: JSON.stringify({ runner_request_id: 'req-2' }),
    });

    it('drops the job it was spawned for, so the next worker is not handed it', () => {
      // A worker reaped for never acquiring its job left the job queued. The
      // next worker spawned for the same repository drained the queue in order
      // and ran the dead job instead of its own - after the history had already
      // recorded that job as failed.
      const target = addTargetWithRunner('target-a', 'runner-a.1');
      internals.messageQueues.set(target.id, [jobMessage]);
      internals.pendingTargetAssignments.push(target.id);
      service.expectWorkerForJob(target.id, 1);

      internals.acquiredJobDetails.set('req-1', JSON.stringify({ secret: 'in here' }));

      service.forgetExpectedWorker(target.id, 1, 'req-1');

      expect(internals.messageQueues.get(target.id)).toEqual([]);
      expect(internals.pendingTargetAssignments).toEqual([]);
      // The acquired payload holds the job's secrets; it must not outlive a
      // job no worker will run.
      expect(internals.acquiredJobDetails.has('req-1')).toBe(false);
    });

    it('leaves the other jobs queued for the same repository alone', () => {
      const target = addTargetWithRunner('target-a', 'runner-a.1');
      internals.messageQueues.set(target.id, [jobMessage, secondJob]);
      internals.pendingTargetAssignments.push(target.id, target.id);
      service.expectWorkerForJob(target.id, 1);

      service.forgetExpectedWorker(target.id, 1, 'req-1');

      expect(internals.messageQueues.get(target.id)).toEqual([secondJob]);
      expect(internals.pendingTargetAssignments).toEqual([target.id]);
    });

    it('does not take an assignment its own session already used', async () => {
      // Binding consumed this worker's assignment. The one still queued
      // belongs to another job's worker, which would come back unbound.
      const target = addTargetWithRunner('target-a', 'runner-a.1');
      internals.messageQueues.set(target.id, [jobMessage, secondJob]);
      internals.pendingTargetAssignments.push(target.id, target.id);
      service.expectWorkerForJob(target.id, 1);
      await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }));

      service.forgetExpectedWorker(target.id, 1, 'req-1');

      expect(internals.pendingTargetAssignments).toEqual([target.id]);
      expect(internals.messageQueues.get(target.id)).toEqual([secondJob]);
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

  it('does not hand a cancellation to a worker that holds no job', async () => {
    // With no job queued, taking the head of the queue gave a jobless worker a
    // cancellation meant for whoever runs that job - and marked its session as
    // holding a job it never had.
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    internals.messageQueues.set(target.id, [cancelMessage]);
    internals.pendingTargetAssignments.push(target.id);
    const sessionId = await createSession();

    // Nothing is deliverable, so the handler long-polls rather than answering -
    // which is the point. Let it poll, assert the cancellation stayed put, then
    // end the poll the way it really ends, by a job arriving: that both cleans
    // the request up and shows the cancellation was skipped rather than eaten.
    const pending = request('GET', `/message?sessionId=${sessionId}`);
    await new Promise((r) => setTimeout(r, 60));

    expect(internals.messageQueues.get(target.id)).toEqual([cancelMessage]);
    expect(internals.localSessions.get(sessionId)?.currentJobId).toBeUndefined();

    internals.messageQueues.get(target.id)!.push(jobMessage);
    const res = await pending;

    expect(res.body).toBe(jobMessage);
    expect(internals.messageQueues.get(target.id)).toEqual([cancelMessage]);
  });

  it('does hand the cancellation to the worker actually running that job', async () => {
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    internals.messageQueues.set(target.id, [jobMessage]);
    internals.pendingTargetAssignments.push(target.id);
    const sessionId = await createSession();
    await request('GET', `/message?sessionId=${sessionId}`); // takes the job
    internals.messageQueues.set(target.id, [cancelMessage]);

    const res = await request('GET', `/message?sessionId=${sessionId}`);

    expect(res.body).toContain('Cancel');
    expect(internals.messageQueues.get(target.id)).toEqual([]);
  });

  it('drops a JobCancellation for a job that is neither queued nor running', async () => {
    // GitHub redelivers a cancellation for a while after the job ends. Queued
    // for a target with no worker, it would be handed to the next worker.
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    const state = internals.targets.get(target.id)!;

    await internals.processMessage(state, state.instances.get(1), cancelMessage);

    expect(internals.messageQueues.get(target.id) ?? []).toEqual([]);
  });

  it('does not let a queued cancellation keep itself alive across redeliveries', async () => {
    // GitHub redelivers a cancellation while the job is unfinished. A queued
    // cancellation names the job, so counting it as evidence the job is live
    // made every redelivery queue another copy - unbounded, and the next
    // worker to poll gets a cancellation instead of a job.
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    const state = internals.targets.get(target.id)!;
    internals.messageQueues.set(target.id, [cancelMessage]);

    await internals.processMessage(state, state.instances.get(1), cancelMessage);

    expect(internals.messageQueues.get(target.id)).toEqual([cancelMessage]);
  });

  it("answers the runner's own acknowledge locally", async () => {
    startWorker(1);
    const res = await request('POST', '/acknowledge?sessionId=abc', JSON.stringify({ runnerRequestId: 'req-1' }));

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{}');
  });

  it('rejects an oversized session request instead of buffering it', async () => {
    startWorker(1);
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

    it('consumes its own target assignment, never another target one', async () => {
      // The property this has always protected: a session must not take a
      // different target's assignment. It is now expressed through the
      // expectation - binding is by name, so ordering cannot get it wrong.
      const targetA = addTargetWithRunner('target-a', 'runner-a.1');
      const targetB = addTargetWithRunner('target-b', 'runner-b.1');
      internals.pendingTargetAssignments.push(targetA.id, targetB.id);
      service.expectWorkerForJob(targetB.id, 1);

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
