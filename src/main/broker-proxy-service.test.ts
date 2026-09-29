 
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
import { getLogger } from './app-state';
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

  it("reads github.repository_id, which stays the repository's through renames and transfers", () => {
    const info = extractGitHubJobInfo({ github: { d: [
      { k: 'repository', v: 'owner/repo' },
      { k: 'repository_id', v: '123456789' },
    ] } });

    expect(info).toEqual({ githubRepo: 'owner/repo', repositoryId: 123456789 });
  });

  it('takes a repository id only as the positive integer GitHub sends', () => {
    const idOf = (value: string) => extractGitHubJobInfo({ github: { d: [{ k: 'repository_id', v: value }] } }).repositoryId;

    expect(idOf('42')).toBe(42);
    for (const value of ['', '0', '-5', '12abc', '1e3', '99999999999999999999']) {
      expect(idOf(value)).toBeUndefined();
    }
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
    // The positional assignments this replaced were a list of target ids, so
    // with several instances on one target arrival order was the only thing
    // telling them apart. Whichever session polled first consumed the
    // assignment and the worker actually spawned for the job came back unbound
    // - permanently, and since queues are per-target every later worker then
    // drained the oldest message. Naming the worker removes ordering from the
    // decision.
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    internals.messageQueues.set(target.id, [jobMessage]);
    service.expectWorkerForJob(target.id, 1, 'req-1');

    const sessionId = await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }));
    const res = await request('GET', `/message?sessionId=${sessionId}`);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).messageType).toBe('RunnerJobRequest');
  });

  it("does not let two targets that share a runner name cross-bind", async () => {
    // target-manager can produce the same agentName for an org and a repo. The
    // expectation is keyed by (target, instance) via the broker key, so a worker
    // for one target cannot bind the other's job even with an identical name.
    const a = createMockTarget({ id: 'target-a', displayName: 'target-a' });
    const b = createMockTarget({ id: 'target-b', displayName: 'target-b' });
    const credA = createMockInstanceCredentials(1);
    const credB = createMockInstanceCredentials(1);
    service.addTarget(a, [{ ...credA, runner: { ...credA.runner, agentName: 'dup-name.1' } }]);
    service.addTarget(b, [{ ...credB, runner: { ...credB.runner, agentName: 'dup-name.1' } }]);
    internals.targets.get('target-a')!.instances.get(1)!.sessionId = 'up-a';
    internals.targets.get('target-b')!.instances.get(1)!.sessionId = 'up-b';
    internals.messageQueues.set('target-b', [jobMessage]);
    // Only target-b's worker is expected for the job.
    service.expectWorkerForJob('target-b', 1, 'req-1');
    const keyA = prefixOf(service.issueWorkerKey(1, 'target-a'));

    // A session from target-a's worker (same name) must not take target-b's job.
    const sid = await createSession(JSON.stringify({ agent: { name: 'dup-name.1' } }), keyA);

    expect(internals.localSessions.get(sid)?.targetId).not.toBe('target-b');
    expect(internals.messageQueues.get('target-b')).toHaveLength(1);
  });

  it('gives each same-target worker its own job, never whichever is queued first', async () => {
    // Two jobs for one target. Each worker was spawned for a specific job and
    // built its sandbox from that job's commit; handing worker 1 job 2 would run
    // it under the wrong per-SHA policy. Worker 1 must get req-1, worker 2 req-2,
    // whatever the queue order or poll order.
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    const cred = createMockInstanceCredentials(2);
    internals.targets.get('target-a')!.instances.set(2, {
      ...cred, runner: { ...cred.runner, agentName: 'runner-a.2' }, instanceNum: 2, sessionId: 'upstream-a2',
    } as never);
    const job2 = JSON.stringify({ messageId: 4, messageType: 'RunnerJobRequest', body: JSON.stringify({ runner_request_id: 'req-2' }) });
    // Queue job 2 first, then job 1 - poll order must not decide.
    internals.messageQueues.set(target.id, [job2, jobMessage]);
    service.expectWorkerForJob(target.id, 1, 'req-1');
    service.expectWorkerForJob(target.id, 2, 'req-2');
    const w1 = startWorker(1, 'target-a');
    const w2 = startWorker(2, 'target-a');

    const s1 = await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }), w1);
    const r1 = await request('GET', `/message?sessionId=${s1}`, undefined, w1);
    const s2 = await createSession(JSON.stringify({ agent: { name: 'runner-a.2' } }), w2);
    const r2 = await request('GET', `/message?sessionId=${s2}`, undefined, w2);

    expect(JSON.parse(JSON.parse(r1.body).body).runner_request_id).toBe('req-1');
    expect(JSON.parse(JSON.parse(r2.body).body).runner_request_id).toBe('req-2');
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

  it('keeps a key bound after its session is deleted, so a job cannot delete and re-create to take a second job', async () => {
    // The one-session guard used to be derived from live sessions. A job
    // holds its worker key (it rides in the run-service URL), so it could
    // DELETE its session and POST a new one: the key's expectation was
    // already consumed, the arrival-order fallback took another pending
    // assignment for the same repository, and the new session could poll a
    // second queued job and acquire its payload.
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    const job2 = JSON.stringify({ messageId: 4, messageType: 'RunnerJobRequest', body: JSON.stringify({ runner_request_id: 'req-2' }) });
    internals.messageQueues.set(target.id, [jobMessage, job2]);
    internals.acquiredJobDetails.set('req-2', '{"secret":"job2"}');
    internals.acquiredJobDetails.set('4', '{"secret":"job2"}');
    service.expectWorkerForJob(target.id, 1, 'req-1');

    const first = await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }));
    const taken = await request('GET', `/message?sessionId=${first}`);
    expect(JSON.parse(JSON.parse(taken.body).body).runner_request_id).toBe('req-1');

    expect((await request('DELETE', `/session?sessionId=${first}`)).statusCode).toBe(200);
    const second = await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }));

    expect(internals.localSessions.get(second)?.targetId).toBeUndefined();
    expect(internals.messageQueues.get(target.id)).toEqual([job2]);
    const steal = await request('POST', '/acquirejob', JSON.stringify({ jobMessageId: 4 }));
    expect(steal.statusCode).toBe(403);
  });

  it('binds only one session per worker key, so a job cannot open a second and take another job', async () => {
    // The key is in the run-service URL the job holds. A second /session with
    // the same key must not reach the arrival-order fallback and bind another
    // queued job.
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    service.expectWorkerForJob(target.id, 1, 'req-1');

    const first = await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }));
    const second = await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }));

    expect(internals.localSessions.get(first)?.targetId).toBe(target.id);
    expect(internals.localSessions.get(second)?.targetId).toBeUndefined();
  });

  it('expects a worker only once, so a later listener cannot reuse the binding', async () => {
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    service.expectWorkerForJob(target.id, 1, 'req-1');

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
      service.expectWorkerForJob(targetA.id, 1, 'req-1');
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
      service.expectWorkerForJob(target.id, 1, 'req-1');

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
      service.expectWorkerForJob(target.id, 1, 'req-1');

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
      service.expectWorkerForJob(target.id, 1, 'req-1');

      internals.acquiredJobDetails.set('req-1', JSON.stringify({ secret: 'in here' }));

      service.forgetExpectedWorker(target.id, 1, 'req-1');

      expect(internals.messageQueues.get(target.id)).toEqual([]);
      // The acquired payload holds the job's secrets; it must not outlive a
      // job no worker will run.
      expect(internals.acquiredJobDetails.has('req-1')).toBe(false);
    });

    it('clears the acquired payload even when the worker already polled the message', () => {
      // The deadline/exit path: the worker dequeued its job message, then died
      // before acquirejob. The queue entry is gone, but the acquired payload
      // (its secrets) and run-service routing are still resident and must go.
      const target = addTargetWithRunner('target-a', 'runner-a.1');
      internals.messageQueues.set(target.id, []); // already polled - nothing queued
      // As processMessage stores them: each alias set from one value.
      const payload = JSON.stringify({ secret: 's' });
      internals.acquiredJobDetails.set('req-1', payload);
      internals.acquiredJobDetails.set('9', payload);
      const jobTarget = { targetDisplayName: 'target-a' };
      (internals as unknown as { jobTargets: Map<string, unknown> }).jobTargets.set('req-1', jobTarget);
      (internals as unknown as { jobTargets: Map<string, unknown> }).jobTargets.set('9', jobTarget);
      (internals as unknown as { jobRunServiceUrls: Map<string, string> }).jobRunServiceUrls.set('req-1', 'https://run/');
      (internals as unknown as { jobRunServiceUrls: Map<string, string> }).jobRunServiceUrls.set('9', 'https://run/');
      service.expectWorkerForJob(target.id, 1, 'req-1');

      service.forgetExpectedWorker(target.id, 1, 'req-1');

      expect(internals.acquiredJobDetails.has('req-1')).toBe(false);
      expect(internals.acquiredJobDetails.has('9')).toBe(false);
      const urls = (internals as unknown as { jobRunServiceUrls: Map<string, string> }).jobRunServiceUrls;
      expect(urls.has('req-1')).toBe(false);
      expect(urls.has('9')).toBe(false);
    });

    it('clears the job target under both of its id aliases', () => {
      // jobTargets holds one object under the request id and the message id,
      // and the cleanup finds aliases by identity - exact only while both keys
      // are set from one object, as the single insertion site does.
      const target = addTargetWithRunner('target-a', 'runner-a.1');
      internals.messageQueues.set(target.id, []);
      const jobTargets = (internals as unknown as { jobTargets: Map<string, unknown> }).jobTargets;
      const jobTarget = { targetDisplayName: 'o/r', githubSha: 'abc' };
      jobTargets.set('req-1', jobTarget);
      jobTargets.set('9', jobTarget);
      service.expectWorkerForJob(target.id, 1, 'req-1');

      service.forgetExpectedWorker(target.id, 1, 'req-1');

      expect(jobTargets.has('req-1')).toBe(false);
      expect(jobTargets.has('9')).toBe(false);
    });

    it('leaves the other jobs queued for the same repository alone', () => {
      const target = addTargetWithRunner('target-a', 'runner-a.1');
      internals.messageQueues.set(target.id, [jobMessage, secondJob]);
      service.expectWorkerForJob(target.id, 1, 'req-1');

      service.forgetExpectedWorker(target.id, 1, 'req-1');

      expect(internals.messageQueues.get(target.id)).toEqual([secondJob]);
    });

    it("leaves another worker's announcement for the same repository in place", async () => {
      // Withdrawing worker 1 must not cost worker 2 its binding: it would come
      // back unbound and its job would be stranded.
      const target = addTargetWithRunner('target-a', 'runner-a.1');
      internals.messageQueues.set(target.id, [jobMessage, secondJob]);
      service.expectWorkerForJob(target.id, 1, 'req-1');
      service.expectWorkerForJob(target.id, 2, 'req-2');
      const second = startWorker(2, target.id);

      service.forgetExpectedWorker(target.id, 1, 'req-1');
      const sessionId = await createSession(undefined, second);
      const res = await request('GET', `/message?sessionId=${sessionId}`, undefined, second);

      expect(JSON.parse(JSON.parse(res.body).body).runner_request_id).toBe('req-2');
    });
  });

  it('delivers the queued job before a stale RunnerRefreshConfig', async () => {
    // GitHub pushes RunnerRefreshConfig between jobs. If the next worker's first
    // poll returns that instead of its job, the runner rewrites its config and
    // restarts its session, and the job is never delivered.
    const target = addTargetWithRunner('target-a', 'runner-a.1');
    internals.messageQueues.set(target.id, [refreshMessage, jobMessage]);
    service.expectWorkerForJob(target.id, 1, 'req-1');

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
    service.expectWorkerForJob(target.id, 1, 'req-1');
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
    service.expectWorkerForJob(target.id, 1, 'req-1');
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
    service.expectWorkerForJob(target.id, 1, 'req-1');
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

  describe('request bodies a worker sends', () => {
    /** A worker bound to target-a that has been handed job req-1 (message 2). */
    const boundWorker = async () => {
      const target = addTargetWithRunner('target-a', 'runner-a.1');
      const instance = internals.targets.get(target.id)!.instances.get(1)! as Instance & { accessToken?: string; tokenExpiry?: number };
      instance.accessToken = 'token';
      instance.tokenExpiry = Date.now() + 3_600_000;
      internals.messageQueues.set(target.id, [jobMessage]);
      service.expectWorkerForJob(target.id, 1, 'req-1');
      const sessionId = await createSession();
      await request('GET', `/message?sessionId=${sessionId}`);
      return sessionId;
    };

    // The ids the runner's run-service client reports a job under: the plan
    // and job GUIDs of the details acquirejob handed it.
    const acquiredIds = { planId: '0ab9c2d4-6e1f-4a7b-9c3d-5e8f1a2b3c4d', jobId: '81329c47-199d-518c-bd1b-66b2e718ab64' };
    /** A bound worker that has acquired job req-1, whose details carry acquiredIds. */
    const acquiredWorker = async () => {
      const details = JSON.stringify({ plan: { planId: acquiredIds.planId }, jobId: acquiredIds.jobId, requestId: 0 });
      internals.acquiredJobDetails.set('req-1', details);
      internals.acquiredJobDetails.set('2', details);
      const sessionId = await boundWorker();
      expect((await request('POST', '/acquirejob', JSON.stringify({ jobMessageId: 2 }))).statusCode).toBe(200);
      return sessionId;
    };

    describe('reporting on a job', () => {
      // completejob, and renewjob as the runner's run-service client sends it,
      // name the job only by its plan and job ids. They go upstream on the
      // runner's credentials, so they are forwarded only for the job this
      // worker acquired: a job holding its worker's key could otherwise renew,
      // or complete with outputs of its choosing, any job it knows the ids of.
      it.each(['/completejob', '/renewjob'])('forwards %s only for the job this worker acquired', async (op) => {
        const sessionId = await acquiredWorker();
        mockHttpsRequest.mockClear();
        const report = (ids: object) => request('POST', `${op}?sessionId=${sessionId}`, JSON.stringify({ ...ids, conclusion: 'succeeded' }));

        expect((await report(acquiredIds)).statusCode).toBe(200);
        // GUIDs, which the runner writes in whatever case it likes.
        expect((await report({ planId: acquiredIds.planId.toUpperCase(), jobId: acquiredIds.jobId.toUpperCase() })).statusCode).toBe(200);
        expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
        mockHttpsRequest.mockClear();

        for (const ids of [
          { planId: acquiredIds.planId, jobId: 'bb1176a1-d7d1-5f81-b037-75e4a947e5f2' },
          { planId: 'another-plan', jobId: acquiredIds.jobId },
          { jobId: acquiredIds.jobId },
          { planId: acquiredIds.planId },
          {},
        ]) {
          expect({ ids, status: (await report(ids)).statusCode }).toEqual({ ids, status: 403 });
        }
        expect((await request('POST', `${op}?sessionId=${sessionId}`, 'not json')).statusCode).toBe(403);
        expect((await request('POST', `${op}?sessionId=${sessionId}`)).statusCode).toBe(403);
        expect(mockHttpsRequest).not.toHaveBeenCalled();
      });

      it.each(['/completejob', '/renewjob'])("checks every job %s names, not only the worker's request id", async (op) => {
        // The request id the worker was delivered is a small sequential
        // number, easy to guess. Paired with another job's plan and job ids it
        // vouched for the pair too, which is what the operation acts on.
        const sessionId = await acquiredWorker();
        mockHttpsRequest.mockClear();
        const foreign = { planId: 'victim-plan', jobId: 'victim-job' };
        const report = (ids: object) => request('POST', `${op}?sessionId=${sessionId}`, JSON.stringify({ ...ids, conclusion: 'succeeded' }));

        for (const ids of [
          { jobMessageId: 2, ...foreign },
          { requestId: 'req-1', ...foreign },
          { requestId: 'req-1', planId: acquiredIds.planId, jobId: foreign.jobId },
          { jobMessageId: 2, jobId: acquiredIds.jobId },
          { requestId: 'req-9', ...acquiredIds },
          { requestId: 'req-1', jobMessageId: 9, ...acquiredIds },
          // Upstream decoders match keys whatever their case, so a key this
          // check does not read by its exact spelling still names a job there.
          { requestId: 'req-1', PlanId: foreign.planId, JobId: foreign.jobId },
          { requestId: 'req-1', ...acquiredIds, PlanId: foreign.planId, JobId: foreign.jobId },
          { requestId: 'req-1', ...acquiredIds, RequestId: 999, JobRequestId: 999 },
          { jobMessageId: 2, ...acquiredIds, JobMessageId: 9 },
          { REQUESTID: 'req-9', ...acquiredIds },
          { requestId: 'req-1', ...acquiredIds, Runner_Request_Id: 'req-9' },
          // Go's decoder folds beyond ASCII case: its U+017F long s matches s,
          // so each of these is read there as the key it resembles.
          { requestId: 'req-1', ...acquiredIds, 'requeſtId': 'req-9' },
          { 'requeſtId': 'req-9', ...acquiredIds },
          { jobMessageId: 2, ...acquiredIds, 'jobMeſſageId': 9 },
        ]) {
          expect({ ids, status: (await report(ids)).statusCode }).toEqual({ ids, status: 403 });
        }
        expect(mockHttpsRequest).not.toHaveBeenCalled();

        expect((await report({ requestId: 'req-1', ...acquiredIds })).statusCode).toBe(200);
        expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
      });

      it.each(['/CompleteJob', '/RENEWJOB', '/%63ompletejob', '//renewjob', '/_apis/completejob', '/%E0completejob',
        '/fini%C5%BFhjob', '/f%C4%B1nishjob'])(
        'binds %s like the job operation it names upstream', async (path) => {
          // Upstream routing ignores case and decodes the path; a gate that
          // matched only the exact spelling forwarded these on the runner's
          // token without a look at the job they name. A path that does not
          // decode is refused rather than guessed at.
          const sessionId = await acquiredWorker();
          mockHttpsRequest.mockClear();

          const res = await request('POST', `${path}?sessionId=${sessionId}`,
            JSON.stringify({ planId: 'victim-plan', jobId: 'victim-job', conclusion: 'succeeded' }));

          expect(res.statusCode).toBe(403);
          expect(mockHttpsRequest).not.toHaveBeenCalled();
        });

      it.each([
        ['GET', '/%6dessage'],
        ['GET', '/Message'],
        ['GET', '/message/'],
        ['GET', '//message'],
        ['DELETE', '/Session'],
        ['DELETE', '/%73ession'],
        ['DELETE', '/%C5%BFession'],
        ['GET', '/me%C5%BF%C5%BFage'],
        ['POST', '/%61cknowledge'],
        ['POST', '/AcquireJob'],
        ['POST', '/_apis/OAuth2/Token'],
        ['PUT', '/session'],
      ])('refuses another spelling of a locally served endpoint: %s %s', async (method, path) => {
        // These are answered here and never upstream. Spelled any other way
        // they missed the local routes and went to the broker on the runner's
        // token with the target's real session id, so a job could long-poll
        // the target's session, taking messages from admission, or delete it.
        const sessionId = await acquiredWorker();
        mockHttpsRequest.mockClear();

        const res = await request(method, `${path}?sessionId=${sessionId}`, JSON.stringify({ jobMessageId: 2 }));

        expect(res.statusCode).toBe(403);
        expect(mockHttpsRequest).not.toHaveBeenCalled();
      });

      it.each([
        ['beside it, in another case', (id: string) => `sessionId=${id}&SessionId=forged`],
        ['on its own, in another case', () => 'SESSIONID=forged'],
        ['with a long s, which Go reads as s', (id: string) => `sessionId=${id}&%C5%BFessionId=forged`],
        ['in any name outside ASCII', (id: string) => `sessionId=${id}&st%C3%A4tus=x`],
      ])('refuses a query naming a session id %s', async (_, query) => {
        // The upstream session id is put in place of the sessionId a request
        // carries, by that exact name. Upstream reads query names whatever
        // their case, and a folding decoder past ASCII, so a second spelling
        // would reach it beside or instead of the id put there.
        const sessionId = await acquiredWorker();
        mockHttpsRequest.mockClear();

        const res = await request('GET', `/runnerversion?${query(sessionId)}`);

        expect(res.statusCode).toBe(403);
        expect(mockHttpsRequest).not.toHaveBeenCalled();
      });

      it('forwards a query it can read, with the upstream session id in place of the local one', async () => {
        const sessionId = await acquiredWorker();
        mockHttpsRequest.mockClear();

        const res = await request('GET', `/runnerversion?sessionId=${sessionId}&status=Online`);

        expect(res.statusCode).toBe(200);
        expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
        const { path } = mockHttpsRequest.mock.calls[0][0] as { path: string };
        expect(new URLSearchParams(path.split('?')[1]).getAll('sessionId')).toEqual(['upstream-target-a']);
        expect(path).toContain('status=Online');
      });

      it('forwards nothing for a job that was delivered but not yet acquired', async () => {
        // Its ids are in the details acquirejob hands out; before that, the
        // worker has no business knowing them.
        const details = JSON.stringify({ plan: { planId: acquiredIds.planId }, jobId: acquiredIds.jobId });
        internals.acquiredJobDetails.set('req-1', details);
        internals.acquiredJobDetails.set('2', details);
        const sessionId = await boundWorker();
        mockHttpsRequest.mockClear();

        const res = await request('POST', `/completejob?sessionId=${sessionId}`, JSON.stringify(acquiredIds));

        expect(res.statusCode).toBe(403);
        expect(mockHttpsRequest).not.toHaveBeenCalled();
      });

      it("refuses another worker's job, on the same target", async () => {
        await acquiredWorker();
        const cred = createMockInstanceCredentials(2);
        internals.targets.get('target-a')!.instances.set(2, {
          ...cred, runner: { ...cred.runner, agentName: 'runner-a.2' }, instanceNum: 2, sessionId: 'upstream-a2',
          accessToken: 'token', tokenExpiry: Date.now() + 3_600_000,
        } as never);
        internals.messageQueues.set('target-a', [
          JSON.stringify({ messageId: 4, messageType: 'RunnerJobRequest', body: JSON.stringify({ runner_request_id: 'req-2' }) }),
        ]);
        service.expectWorkerForJob('target-a', 2, 'req-2');
        const other = startWorker(2, 'target-a');
        const otherSession = await createSession(JSON.stringify({ agent: { name: 'runner-a.2' } }), other);
        await request('GET', `/message?sessionId=${otherSession}`, undefined, other);
        mockHttpsRequest.mockClear();

        for (const op of ['/completejob', '/renewjob']) {
          const res = await request('POST', `${op}?sessionId=${otherSession}`, JSON.stringify(acquiredIds), other);
          expect({ op, status: res.statusCode }).toEqual({ op, status: 403 });
        }
        expect(mockHttpsRequest).not.toHaveBeenCalled();
      });
    });

    it('rejects an oversized acquirejob instead of buffering it', async () => {
      await boundWorker();

      const res = await request('POST', '/acquirejob', JSON.stringify({ jobMessageId: 2, pad: 'x'.repeat(65 * 1024) }));

      expect(res.statusCode).toBe(413);
    });

    it('rejects a forwarded job operation above its cap, and sends nothing upstream', async () => {
      const sessionId = await boundWorker();
      mockHttpsRequest.mockClear();

      const res = await request('POST', `/renewjob?sessionId=${sessionId}`, 'x'.repeat(8 * 1024 * 1024 + 1));

      expect(res.statusCode).toBe(413);
      expect(mockHttpsRequest).not.toHaveBeenCalled();
    });

    it("still forwards a completejob far larger than the runner's other requests", async () => {
      // completejob carries the job's outputs, step results and annotations.
      // The cap on the runner's other requests would fail every job with
      // sizeable outputs at its very end.
      const sessionId = await acquiredWorker();
      mockHttpsRequest.mockClear();
      const body = JSON.stringify({ ...acquiredIds, conclusion: 'succeeded', outputs: { big: 'x'.repeat(1024 * 1024) } });

      const res = await request('POST', `/completejob?sessionId=${sessionId}`, body);

      expect(res.statusCode).toBe(200);
      expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
    });

    describe('in the log', () => {
      // The log file writes messages verbatim, and a worker's request bodies
      // are job code's to write: they carry outputs, and whatever lines it
      // would like the log to show.
      type Logger = Record<'info' | 'warn' | 'error' | 'debug', jest.Mock>;
      let logger: Logger;
      const lines = (...levels: Array<keyof Logger>) =>
        levels.flatMap(level => logger[level].mock.calls.map(call => String(call[0])));
      const original = jest.mocked(getLogger).getMockImplementation()!;

      beforeEach(() => {
        logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
        jest.mocked(getLogger).mockImplementation(() => logger as unknown as ReturnType<typeof getLogger>);
      });

      afterEach(() => {
        jest.mocked(getLogger).mockImplementation(original);
      });

      it("keeps a job operation's body out of the info log", async () => {
        const sessionId = await boundWorker();

        await request('POST', `/renewjob?sessionId=${sessionId}`,
          JSON.stringify({ planId: 'p', jobId: 'j', jobRequestId: 'req-1', note: 'PRIVATE' }));

        expect(lines('info', 'warn', 'error').filter(line => line.includes('PRIVATE'))).toEqual([]);
        expect(lines('info').some(line => line.includes('/renewjob') && line.includes('req-1'))).toBe(true);
      });

      it('keeps an acquirejob body out of the info log', async () => {
        await boundWorker();

        await request('POST', '/acquirejob', JSON.stringify({ jobMessageId: 2, note: 'PRIVATE' }));

        expect(lines('info', 'warn', 'error').filter(line => line.includes('PRIVATE'))).toEqual([]);
      });

      it('writes no line break a request carries into the log', async () => {
        const sessionId = await boundWorker();
        const forged = 'x\n2026-01-01 [INFO] forged';

        await request('POST', `/renewjob?sessionId=${sessionId}`, JSON.stringify({ planId: 'p', jobRequestId: forged }));
        await request('POST', `/renewjob?sessionId=${sessionId}`, `not json ${forged}`);
        await request('POST', '/acquirejob', JSON.stringify({ jobMessageId: forged }));
        await request('POST', '/acquirejob', `not json ${forged}`);
        await request('POST', '/session', JSON.stringify({ agent: { name: forged } }), startWorker(2));
        await request('POST', '/session', JSON.stringify({ agent: { name: forged } }), startWorker(1, 'target-a'));

        expect(lines('info', 'warn', 'error', 'debug').filter(line => /[\r\n]/.test(line))).toEqual([]);
      });
    });
  });

  describe('a job as GitHub delivers it', () => {
    const runService = 'https://run-actions-1-azure-eastus.actions.githubusercontent.com/';
    // The job details acquirejob answers with. An organization target's
    // display name is the organization; the job names its repository.
    const details = JSON.stringify({
      jobId: 'plan-job',
      contextData: { github: { d: [
        { k: 'repository', v: 'Some-Org/Some-Repo' },
        { k: 'repository_id', v: '123456789' },
        { k: 'sha', v: 'abc1234' },
        { k: 'workflow', v: 'Continuous Integration' },
        { k: 'workflow_ref', v: 'Some-Org/Some-Repo/.github/workflows/build.yml@refs/heads/main' },
      ] } },
    });
    /** Every host the broker sent a request to. */
    let upstreamHosts: string[];

    beforeEach(() => {
      upstreamHosts = [];
      mockHttpsRequest.mockImplementation((...args: unknown[]) => {
        const options = args[0] as { hostname?: string; path?: string };
        upstreamHosts.push(options.hostname ?? '');
        const callback = args[1] as (res: EventEmitter) => void;
        const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; write: () => void; end: () => void };
        req.setTimeout = () => {};
        req.write = () => {};
        req.end = () => {
          const res = new EventEmitter() as EventEmitter & { statusCode: number };
          res.statusCode = 200;
          callback(res);
          if (options.path?.startsWith('/acquirejob')) res.emit('data', details);
          res.emit('end');
        };
        return req;
      });
    });

    /** The broker's poll receives job req-1 (message 2) for the organization target. */
    const receive = async (runServiceUrl: string) => {
      addTargetWithRunner('some-org', 'runner.1');
      const state = internals.targets.get('some-org')!;
      const instance = state.instances.get(1)! as Instance & { accessToken?: string; tokenExpiry?: number };
      instance.accessToken = 'token';
      instance.tokenExpiry = Date.now() + 3_600_000;
      await internals.processMessage(state, instance, JSON.stringify({
        messageId: 2,
        messageType: 'RunnerJobRequest',
        body: JSON.stringify({ runner_request_id: 'req-1', run_service_url: runServiceUrl, billing_owner_id: 'b' }),
      }));
    };

    it.each([
      ['over plain http', 'http://run-actions-1-azure-eastus.actions.githubusercontent.com/'],
      ['on another host', 'https://run.example/'],
      ['on a host that only starts like GitHub', 'https://run.actions.githubusercontent.com.example/'],
      ['on a port of its own', 'https://run-actions-1-azure-eastus.actions.githubusercontent.com:8443/'],
      ['with a user in it', 'https://user:pass@run-actions-1-azure-eastus.actions.githubusercontent.com/'],
      // The request paths are appended to the run service's path, so it has
      // to be a directory, with nothing after it that would swallow them.
      ['whose path is not a directory', 'https://run-actions-1-azure-eastus.actions.githubusercontent.com/123'],
      ['with a query', 'https://run-actions-1-azure-eastus.actions.githubusercontent.com/123/?x=1'],
      ['with a fragment', 'https://run-actions-1-azure-eastus.actions.githubusercontent.com/123/#x'],
    ])("sends the runner's token to no run service %s", async (_, runServiceUrl) => {
      // The acquire goes out with the runner's bearer token, and the job's
      // operations are forwarded to the same place later.
      const received = jest.fn();
      service.on('job-received', received);

      await receive(runServiceUrl);

      expect(upstreamHosts).toEqual([]);
      expect(received).not.toHaveBeenCalled();
    });

    it("acquires a job from GitHub's own run service", async () => {
      const received = jest.fn();
      service.on('job-received', received);

      await receive(runService);

      expect(upstreamHosts).toEqual(['run-actions-1-azure-eastus.actions.githubusercontent.com']);
      expect(received).toHaveBeenCalledTimes(1);
    });

    it('acquires from the host that was checked when the run service has no path', async () => {
      // The request path used to be glued onto the URL as sent, which without
      // a trailing slash made it part of the host name.
      await receive('https://run-actions-1-azure-eastus.actions.githubusercontent.com');

      expect(upstreamHosts).toEqual(['run-actions-1-azure-eastus.actions.githubusercontent.com']);
    });

    it('records the repository, its id and the workflow the job names, for its own worker', async () => {
      // The policy a worker's proxy installs at acquirejob is keyed on these.
      // For an organization target the display name names no repository, and
      // the workflow a spawn guessed may not be the one that was claimed.
      await receive(runService);
      service.expectWorkerForJob('some-org', 1, 'req-1');
      const sessionId = await createSession();
      await request('GET', `/message?sessionId=${sessionId}`);

      const expected = {
        targetDisplayName: 'some-org',
        githubSha: 'abc1234',
        githubWorkflow: 'build',
        repository: 'Some-Org/Some-Repo',
        repositoryId: 123456789,
      };
      expect(service.getJobTargetForWorker(1, 'req-1')).toEqual(expected);
      expect(service.getJobTargetForWorker(1, '2')).toEqual(expected);
    });
  });

  describe('a job no worker was spawned for', () => {
    // A job message as the broker receives it upstream, with the routing the
    // acquire needs, and the payload acquirejob hands back: the job's secrets.
    // Jobs of one target share a run service, as they commonly do upstream.
    const upstreamJob = (requestId: string, messageId: number) => JSON.stringify({
      messageId,
      messageType: 'RunnerJobRequest',
      body: JSON.stringify({
        runner_request_id: requestId,
        run_service_url: 'https://run-actions-1-azure-eastus.actions.githubusercontent.com/',
        billing_owner_id: 'b',
      }),
    });
    const payloadFor = (requestId: string) => JSON.stringify({
      jobId: requestId,
      secret: `secret-of-${requestId}`,
      contextData: { github: { d: [{ k: 'repository', v: 'target-a' }, { k: 'actor', v: 'stranger' }, { k: 'sha', v: 'abc1234' }] } },
    });

    type Internals = RoutingInternals & {
      isShuttingDown: boolean;
      jobTargets: Map<string, unknown>;
      jobRunServiceUrls: Map<string, string>;
      jobInfo: Map<string, unknown>;
      jobAssignments: Map<string, unknown>;
    };
    const deep = () => internals as unknown as Internals;

    /** Acquire upstream answers with the job's payload; anything else succeeds empty. */
    const upstreamAcquires = () => {
      mockHttpsRequest.mockImplementation((...args: unknown[]) => {
        const options = args[0] as { path?: string };
        const callback = args[1] as (res: EventEmitter) => void;
        let sent = '';
        const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; write: (b: string) => void; end: () => void };
        req.setTimeout = () => {};
        req.write = (b: string) => { sent += b; };
        req.end = () => {
          const res = new EventEmitter() as EventEmitter & { statusCode: number };
          res.statusCode = 200;
          callback(res);
          if (options.path?.startsWith('/acquirejob')) res.emit('data', payloadFor(JSON.parse(sent).jobMessageId));
          res.emit('end');
        };
        return req;
      });
    };

    /** The broker receives and acquires a job for target-a, as its poll loop does. */
    const receive = async (requestId: string, messageId: number) => {
      const state = internals.targets.get('target-a')!;
      const instance = state.instances.get(1)! as Instance & { accessToken?: string; tokenExpiry?: number };
      instance.accessToken = 'token';
      instance.tokenExpiry = Date.now() + 3_600_000;
      await internals.processMessage(state, instance, upstreamJob(requestId, messageId));
    };

    /** Poll once and give up when nothing is deliverable, the way a shutdown ends a long poll. */
    const pollOnce = async (sessionId: string, prefix: string) => {
      const pending = request('GET', `/message?sessionId=${sessionId}`, undefined, prefix);
      await new Promise((r) => setTimeout(r, 30));
      deep().isShuttingDown = true;
      const res = await pending;
      deep().isShuttingDown = false;
      return res;
    };

    beforeEach(() => {
      upstreamAcquires();
    });

    it('never hands a refused job to an idle listener that names the runner it was meant for', async () => {
      // The admission refused the job and returned, touching nothing here. The
      // job stayed queued, acquired, with its assignment pending. A listener
      // started later with no job of its own - a scale-up, or a CLI resume -
      // named the target's runner, bound the leftover assignment, polled the
      // refused job and acquired its payload.
      addTargetWithRunner('target-a', 'runner-a.1');
      service.on('job-received', () => { /* refused: nothing is spawned */ });
      await receive('req-1', 2);
      const listener = startWorker(2);

      const sessionId = await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }), listener);
      const polled = await pollOnce(sessionId, listener);
      const acquired = await request('POST', '/acquirejob', JSON.stringify({ jobMessageId: 2 }), listener);

      expect(internals.localSessions.get(sessionId)?.targetId).toBeUndefined();
      expect(polled.statusCode).toBe(202);
      expect(acquired.statusCode).not.toBe(200);
      expect(acquired.body ?? '').not.toContain('secret-of-req-1');
    });

    it("does not bind a target's worker that no job was announced for", async () => {
      // A worker keyed to the target but with no expectation - a re-registration
      // restart of a slot - used to fall back to the target's oldest pending
      // assignment and take whichever job was queued first.
      addTargetWithRunner('target-a', 'runner-a.1');
      await receive('req-1', 2);
      const unannounced = startWorker(2, 'target-a');

      const sessionId = await createSession(undefined, unannounced);
      const polled = await pollOnce(sessionId, unannounced);

      expect(internals.localSessions.get(sessionId)?.targetId).toBeUndefined();
      expect(polled.statusCode).toBe(202);
    });

    it('takes no job on an announcement that names none', async () => {
      // A session takes the job it was spawned for and nothing else; an
      // announcement without a job gives it nothing to take.
      addTargetWithRunner('target-a', 'runner-a.1');
      await receive('req-1', 2);
      service.expectWorkerForJob('target-a', 1);

      const sessionId = await createSession();
      const polled = await pollOnce(sessionId, workerPrefix);

      // Not bound at all, not merely handed nothing: a bound session with no
      // job is what the delivery guard alone would then have to catch.
      expect(internals.localSessions.get(sessionId)?.targetId).toBeUndefined();
      expect(polled.statusCode).toBe(202);
      expect(internals.messageQueues.get('target-a')).toHaveLength(1);
    });

    it('hands nothing to a session that has a target but no job of its own', async () => {
      // Binding always carries a job today, so this session cannot arise; the
      // delivery guard is what keeps it harmless if one ever does. A job
      // message without an id would otherwise match its missing job.
      addTargetWithRunner('target-a', 'runner-a.1');
      await receive('req-1', 2);
      internals.messageQueues.get('target-a')!.push(
        JSON.stringify({ messageId: 5, messageType: 'RunnerJobRequest', body: JSON.stringify({}) })
      );
      const keyed = startWorker(2, 'target-a');
      const sessionId = await createSession(undefined, keyed);
      internals.localSessions.get(sessionId)!.targetId = 'target-a';

      const polled = await pollOnce(sessionId, keyed);

      expect(polled.statusCode).toBe(202);
      expect(internals.messageQueues.get('target-a')).toHaveLength(2);
    });

    it('does not offer a refused job to admission again when GitHub redelivers it', async () => {
      // Job messages are never acknowledged upstream, so GitHub may offer an
      // acquired job again, and its acquire may answer again. A refusal that
      // also forgot the job's dedup entry refused it a second time: another
      // history row, another notification, another cancel.
      addTargetWithRunner('target-a', 'runner-a.1');
      const received = jest.fn((targetId: string, jobId: string) => service.refuseJob(targetId, jobId));
      service.on('job-received', received);

      await receive('req-1', 2);
      await receive('req-1', 2);

      expect(received).toHaveBeenCalledTimes(1);
      expect(internals.messageQueues.get('target-a')).toEqual([]);
      expect(internals.acquiredJobDetails.size).toBe(0);
      expect(deep().jobTargets.size).toBe(0);
    });

    it('offers a dropped job again, since nothing decided it may not run', async () => {
      // A job dropped because no worker could be started for it was not
      // judged. Its redelivery is the retry.
      addTargetWithRunner('target-a', 'runner-a.1');
      const received = jest.fn((targetId: string, jobId: string) => service.dropJob(targetId, jobId));
      service.on('job-received', received);

      await receive('req-1', 2);
      await receive('req-1', 2);

      expect(received).toHaveBeenCalledTimes(2);
    });

    it('drops every trace of a refused job, and nothing of another', async () => {
      addTargetWithRunner('target-a', 'runner-a.1');
      await receive('req-1', 2);
      await receive('req-2', 4);
      const drop = (service as unknown as { dropJob: (targetId: string, jobId: string) => void }).dropJob;

      drop.call(service, 'target-a', 'req-1');

      const i = deep();
      expect(i.messageQueues.get('target-a')!.map((m) => JSON.parse(JSON.parse(m).body).runner_request_id)).toEqual(['req-2']);
      for (const id of ['req-1', '2']) {
        expect(i.acquiredJobDetails.has(id)).toBe(false);
        expect(i.jobTargets.has(id)).toBe(false);
        expect(i.jobRunServiceUrls.has(id)).toBe(false);
        expect(i.jobInfo.has(id)).toBe(false);
      }
      expect(i.jobAssignments.has('req-1')).toBe(false);
      // The other job is untouched: its worker can still bind and take it.
      for (const id of ['req-2', '4']) {
        expect(i.acquiredJobDetails.has(id)).toBe(true);
        expect(i.jobTargets.has(id)).toBe(true);
        expect(i.jobRunServiceUrls.has(id)).toBe(true);
      }
      expect(i.jobInfo.has('4')).toBe(true);
      expect(i.jobAssignments.has('req-2')).toBe(true);
      service.expectWorkerForJob('target-a', 1, 'req-2');
      const sessionId = await createSession();
      const polled = await request('GET', `/message?sessionId=${sessionId}`);
      expect(JSON.parse(JSON.parse(polled.body).body).runner_request_id).toBe('req-2');
    });

    it('drops a queued cancellation for the dropped job with it', async () => {
      addTargetWithRunner('target-a', 'runner-a.1');
      await receive('req-1', 2);
      internals.messageQueues.get('target-a')!.push(
        JSON.stringify({ messageId: 3, messageType: 'JobCancellation', body: JSON.stringify({ jobId: 'req-1' }) })
      );

      (service as unknown as { dropJob: (t: string, j: string) => void }).dropJob('target-a', 'req-1');

      expect(internals.messageQueues.get('target-a')).toEqual([]);
    });

    it('offers nothing to admission for a job it could not acquire', async () => {
      // With no stored payload the worker's acquirejob is answered 404, so a
      // worker spawned for it could never run it; and admission now refuses a
      // job it cannot identify. Offered anyway, every redelivery - GitHub keeps
      // offering a job nobody claimed - would be refused and recorded again.
      // Left alone, the next redelivery is acquired and admitted properly.
      addTargetWithRunner('target-a', 'runner-a.1');
      mockHttpsRequest.mockImplementation((...args: unknown[]) => {
        const callback = args[1] as (res: EventEmitter) => void;
        const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; write: () => void; end: () => void };
        req.setTimeout = () => {};
        req.write = () => {};
        req.end = () => {
          const res = new EventEmitter() as EventEmitter & { statusCode: number };
          res.statusCode = 503;
          callback(res);
          res.emit('end');
        };
        return req;
      });
      const received = jest.fn();
      service.on('job-received', received);

      await receive('req-1', 2);

      expect(received).not.toHaveBeenCalled();
      expect(internals.messageQueues.get('target-a') ?? []).toEqual([]);
      expect(deep().jobAssignments.has('req-1')).toBe(false);
      expect(deep().jobRunServiceUrls.size).toBe(0);
      expect(deep().jobInfo.size).toBe(0);
    });
  });

  describe("which job's repository a worker may claim", () => {
    const deliver = async (instanceNum: number, requestId: string, messageId: number) => {
      const prefix = startWorker(instanceNum, 'target-a');
      internals.messageQueues.get('target-a')!.push(JSON.stringify({
        messageId, messageType: 'RunnerJobRequest', body: JSON.stringify({ runner_request_id: requestId }),
      }));
      const jobTarget = { targetDisplayName: `repo-of-${requestId}`, githubSha: 'abc' };
      const jobTargets = (internals as unknown as { jobTargets: Map<string, unknown> }).jobTargets;
      jobTargets.set(requestId, jobTarget);
      jobTargets.set(String(messageId), jobTarget);
      service.expectWorkerForJob('target-a', instanceNum, requestId);
      const sessionId = await createSession(undefined, prefix);
      await request('GET', `/message?sessionId=${sessionId}`, undefined, prefix);
    };
    type ForWorker = { getJobTargetForWorker: (instanceNum: number, jobId: string) => unknown };

    it('names a job only to the worker it was delivered to', async () => {
      // The proxy's acquirejob hook installs the policy of whatever job id the
      // request body names. A job could name another repository's job and take
      // its hosts; only the job this worker was actually handed is its own.
      addTargetWithRunner('target-a', 'runner-a.1');
      internals.messageQueues.set('target-a', []);
      await deliver(1, 'req-1', 2);
      await deliver(2, 'req-7', 9);
      const lookup = (service as unknown as ForWorker).getJobTargetForWorker.bind(service);

      expect(lookup(1, 'req-1')).toEqual({ targetDisplayName: 'repo-of-req-1', githubSha: 'abc' });
      expect(lookup(1, '2')).toEqual({ targetDisplayName: 'repo-of-req-1', githubSha: 'abc' });
      expect(lookup(1, 'req-7')).toBeUndefined();
      expect(lookup(1, '9')).toBeUndefined();
      expect(lookup(3, 'req-1')).toBeUndefined();
    });

    it("forgets a job's repository once its worker is finished", async () => {
      // jobTargets was pruned only for a withdrawn worker, so every job ever run
      // stayed resolvable by id for the life of the process.
      addTargetWithRunner('target-a', 'runner-a.1');
      internals.messageQueues.set('target-a', []);
      await deliver(1, 'req-1', 2);
      const jobTargets = (internals as unknown as { jobTargets: Map<string, unknown> }).jobTargets;

      service.revokeWorkerKey(1);

      expect(jobTargets.has('req-1')).toBe(false);
      expect(jobTargets.has('2')).toBe(false);
    });
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

    it("never binds a session to another target's announced job, whatever it is called", async () => {
      // The property this has always protected: a session must not take a
      // different target's job. Target B's worker names target A's runner.
      const targetA = addTargetWithRunner('target-a', 'runner-a.1');
      addTargetWithRunner('target-b', 'runner-b.1');
      service.expectWorkerForJob(targetA.id, 1, 'req-1');

      const sessionId = await createSession(JSON.stringify({ agent: { name: 'runner-a.1' } }));

      expect(internals.localSessions.get(sessionId)?.targetId).toBeUndefined();
      // Target A's own worker still finds its announcement.
      const own = await createSession(undefined, startWorker(1, targetA.id));
      expect(internals.localSessions.get(own)?.targetId).toBe(targetA.id);
    });

    it('binds an unnamed request by its key alone', async () => {
      // The name in the request never decided anything for a keyed worker, so
      // its absence does not either.
      const targetA = addTargetWithRunner('target-a', 'runner-a.1');
      service.expectWorkerForJob(targetA.id, 1, 'req-1');

      const sessionId = await createSession();

      expect(internals.localSessions.get(sessionId)?.targetId).toBe(targetA.id);
    });
  });
});
