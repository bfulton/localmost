/**
 * How a repository's approved policy reaches a worker: its proxy (hosts,
 * denied hosts, loopback, level), its sandbox profile (paths, denied paths,
 * loopback, the proxy's port) and its docker socket - for the job the worker
 * actually claimed, under the name GitHub gives the repository, and never
 * for a worker that has since finished.
 */

jest.mock('./process-sandbox', () => ({
  spawnSandboxed: jest.fn(),
}));

jest.mock('./runner-downloader', () => ({
  RunnerDownloader: jest.fn().mockImplementation(() => ({
    getToolCacheDir: jest.fn().mockImplementation((targetId: string) => `/Users/test/.localmost/runner/caches/${targetId}/tool-cache`),
    getTargetCacheDir: jest.fn().mockImplementation((targetId: string) => `/Users/test/.localmost/runner/caches/${targetId}`),
    buildSandbox: jest.fn().mockImplementation((instance: number) => Promise.resolve(`/Users/test/.localmost/runner/sandbox/${instance}`)),
    isDownloaded: jest.fn().mockReturnValue(true),
    isConfigured: jest.fn().mockReturnValue(true),
    hasAnyProxyCredentials: jest.fn().mockReturnValue(true),
    copyProxyCredentials: jest.fn().mockResolvedValue(undefined),
    getInstalledVersion: jest.fn().mockReturnValue('2.330.0'),
  })),
}));

jest.mock('./proxy-server', () => ({
  ProxyServer: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(12345),
    stop: jest.fn().mockResolvedValue(undefined),
    getProxyUrl: jest.fn().mockReturnValue('http://127.0.0.1:12345'),
    getPort: jest.fn().mockReturnValue(12345),
    setPolicyAllowedHosts: jest.fn(),
    setPolicyDeniedHosts: jest.fn(),
    setLoopbackPolicy: jest.fn(),
    setPolicyLevel: jest.fn(),
    rotateAuthToken: jest.fn(),
  })),
}));

jest.mock('./runner-cleanup', () => ({
  processStartTime: jest.fn(() => 'START'),
  lookUpStartTime: jest.fn(() => 'START'),
  mayEscalate: jest.requireActual('./runner-cleanup').mayEscalate,
  markerHolders: jest.fn(() => []),
  signalOrphanPids: jest.fn(async () => ({ signalled: true, remaining: [] })),
  parsePidRecord: jest.requireActual('./runner-cleanup').parsePidRecord,
}));

jest.mock('./docker/docker-filter-proxy', () => ({
  DockerFilterProxy: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    bind: jest.fn(),
  })),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
  openSync: jest.fn(() => 42),
  closeSync: jest.fn(),
  promises: {
    mkdir: jest.fn(),
    chmod: jest.fn(),
    unlink: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
    readdir: jest.fn().mockResolvedValue([]),
    readFile: jest.fn().mockResolvedValue(''),
  },
}));

import * as fs from 'fs';
import { RunnerManager, RepoPolicyRuntime } from './runner-manager';
import { ProxyServer } from './proxy-server';
import { spawnSandboxed } from './process-sandbox';
import { createMockProcess, RunnerManagerTestHelper } from './test-utils';

const mockSpawnSandboxed = spawnSandboxed as jest.MockedFunction<typeof spawnSandboxed>;

const BROKER_PORT = 9100;

const policy = (overrides: Partial<RepoPolicyRuntime> = {}): RepoPolicyRuntime => ({
  hosts: [], level: 'strict', readPaths: [], writePaths: [], docker: {}, ...overrides,
});

/** A stand-in for a worker's proxy, recording every part of the policy it is given. */
const fakeProxy = () => ({
  setPolicyAllowedHosts: jest.fn(),
  setPolicyDeniedHosts: jest.fn(),
  setLoopbackPolicy: jest.fn(),
  setPolicyLevel: jest.fn(),
  rotateAuthToken: jest.fn(),
  getPort: jest.fn(() => 12345),
});
type FakeProxy = ReturnType<typeof fakeProxy>;

const fakeSocket = () => ({ bind: jest.fn(), stop: jest.fn().mockResolvedValue(undefined) });

function managerWith(options: Partial<ConstructorParameters<typeof RunnerManager>[0]> = {}) {
  const manager = new RunnerManager({
    onLog: jest.fn(),
    onStatusChange: jest.fn(),
    onJobHistoryUpdate: jest.fn(),
    getBrokerPort: () => BROKER_PORT,
    ...options,
  });
  return { manager, helper: new RunnerManagerTestHelper(manager) };
}

/** A proxy created as a spawn creates it, so the claim callback is the real one. */
async function realProxyFor(helper: RunnerManagerTestHelper, instanceNum: number) {
  await helper.startInstanceProxy(instanceNum);
  const options = jest.mocked(ProxyServer).mock.calls.at(-1)![0] as { onJobAcquired: (jobId: string) => Promise<void> };
  const proxy = jest.mocked(ProxyServer).mock.results.at(-1)!.value as FakeProxy;
  return { onJobAcquired: options.onJobAcquired, proxy };
}

/** A promise the test resolves when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  (fs.existsSync as jest.Mock).mockReturnValue(false);
  (fs.readFileSync as jest.Mock).mockReturnValue('{}');
});

describe("a claimed job's denied hosts and loopback on its proxy", () => {
  it('installs them with the hosts, and loopback with the real broker port', async () => {
    const { helper } = managerWith({
      getRepoPolicy: async () => policy({ hosts: ['ok.example'], deniedHosts: ['bad.example'], loopback: [5432] }),
    });
    const proxy = fakeProxy();
    helper.setProxy(1, proxy);
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' });

    await helper.applyPolicyOnClaim(1, 'owner/repo', 'abc1234');

    expect(proxy.setPolicyAllowedHosts).toHaveBeenLastCalledWith(['ok.example']);
    expect(proxy.setPolicyDeniedHosts).toHaveBeenLastCalledWith(['bad.example']);
    expect(proxy.setLoopbackPolicy).toHaveBeenLastCalledWith(BROKER_PORT, [5432]);
  });

  it('closes them when the worker is finished, so the next job on the slot starts without them', async () => {
    const { helper } = managerWith({
      getRepoPolicy: async () => policy({ deniedHosts: ['bad.example'], loopback: true }),
    });
    const proxy = fakeProxy();
    helper.setProxy(1, proxy);
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' });
    await helper.applyPolicyOnClaim(1, 'owner/repo', 'abc1234');

    helper.releaseInstanceSlot(1);

    expect(proxy.setPolicyDeniedHosts).toHaveBeenLastCalledWith([]);
    expect(proxy.setLoopbackPolicy).toHaveBeenLastCalledWith(BROKER_PORT, undefined);
  });

  it("does not leave one job's deny list on the next job's claim", async () => {
    let next = policy({ deniedHosts: ['first.example'] });
    const { helper } = managerWith({ getRepoPolicy: async () => next });
    const proxy = fakeProxy();
    helper.setProxy(1, proxy);
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    await helper.applyPolicyOnClaim(1, 'owner/first', 'abc1234');

    next = policy();
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    await helper.applyPolicyOnClaim(1, 'owner/second', 'def5678');

    expect(proxy.setPolicyDeniedHosts).toHaveBeenLastCalledWith([]);
  });

  it('closes them for a claim it cannot identify', async () => {
    const { helper } = managerWith({ getJobTarget: () => undefined });
    helper.setInstance(3, { name: 'runner-3', status: 'listening' });
    const { onJobAcquired, proxy } = await realProxyFor(helper, 3);

    await onJobAcquired('req-other');

    expect(proxy.setPolicyDeniedHosts).toHaveBeenLastCalledWith([]);
    expect(proxy.setLoopbackPolicy).toHaveBeenLastCalledWith(BROKER_PORT, undefined);
  });

  it('keeps denied hosts when drift cuts a claim back to infrastructure', async () => {
    const { helper } = managerWith({
      getRepoPolicy: async () => policy({ hosts: ['ok.example'], deniedHosts: ['bad.example'], loopback: true }),
    });
    const proxy = fakeProxy();
    helper.setProxy(1, proxy);
    helper.setInstance(1, { name: 'runner-1', status: 'listening', policyStamp: 'stale' });

    await helper.applyPolicyOnClaim(1, 'owner/repo', 'abc1234');

    expect(proxy.setPolicyAllowedHosts).toHaveBeenLastCalledWith([]);
    expect(proxy.setPolicyDeniedHosts).toHaveBeenLastCalledWith(['bad.example']);
    expect(proxy.setLoopbackPolicy).toHaveBeenLastCalledWith(BROKER_PORT, undefined);
  });
});

describe("a spawned worker's profile", () => {
  const spawn = async (runtime: RepoPolicyRuntime, context: Record<string, unknown> = {}) => {
    const getRepoPolicy = jest.fn(async (..._args: unknown[]) => runtime);
    const { manager, helper } = managerWith({ getRepoPolicy: getRepoPolicy as never });
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    mockSpawnSandboxed.mockReturnValue(createMockProcess(4242));
    await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234', ...context });
    return { manager, helper, getRepoPolicy, options: mockSpawnSandboxed.mock.calls.at(-1)![2]! };
  };

  it("is given this worker's proxy port, or its job would reach nothing on loopback", async () => {
    const { options } = await spawn(policy());
    expect(options.proxyPort).toBe(12345);
  });

  it('carries the denied paths and the loopback grant the policy declares', async () => {
    const { options } = await spawn(policy({ denyPaths: ['~/secret'], loopback: [5432] }));
    expect(options.filesystemPolicy).toMatchObject({ deny: ['~/secret'], loopback: [5432] });
  });

  it('closes the proxy it is reusing, loopback and denies included, before the runner exists', async () => {
    await spawn(policy());
    const proxy = jest.mocked(ProxyServer).mock.results.at(-1)!.value as FakeProxy;
    expect(proxy.setPolicyDeniedHosts).toHaveBeenCalledWith([]);
    expect(proxy.setLoopbackPolicy).toHaveBeenCalledWith(BROKER_PORT, undefined);
    expect(proxy.setLoopbackPolicy.mock.invocationCallOrder[0]).toBeLessThan(mockSpawnSandboxed.mock.invocationCallOrder[0]);
  });

  it("resolves an organization target's policy by the repository GitHub named", async () => {
    const { getRepoPolicy } = await spawn(policy(), { targetDisplayName: 'myorg', githubRepo: 'myorg/app' });
    expect(getRepoPolicy).toHaveBeenCalledWith('myorg', 'app', 'abc1234', '');
  });
});

describe('the stamp a worker is built under', () => {
  const stampFor = (manager: RunnerManager, runtime: RepoPolicyRuntime): string =>
    (manager as unknown as { stampFor(p: RepoPolicyRuntime): string }).stampFor(runtime);

  it('moves when the denied paths or the loopback grant move', () => {
    const { manager } = managerWith();
    const base = stampFor(manager, policy());
    expect(stampFor(manager, policy({ denyPaths: ['~/secret'] }))).not.toBe(base);
    expect(stampFor(manager, policy({ loopback: true }))).not.toBe(base);
    expect(stampFor(manager, policy({ loopback: [5432] }))).not.toBe(stampFor(manager, policy({ loopback: [5433] })));
    // A policy that declares neither stamps as before, so an upgrade is not drift.
    expect(stampFor(manager, policy({ denyPaths: [] }))).toBe(base);
  });

  it('refuses a claim whose approved deny list changed since the worker was built', async () => {
    const { manager, helper } = managerWith({
      getRepoPolicy: async () => policy({ hosts: ['ok.example'], denyPaths: ['~/secret'] }),
    });
    const proxy = fakeProxy();
    helper.setProxy(1, proxy);
    helper.setInstance(1, { name: 'runner-1', status: 'listening', policyStamp: stampFor(manager, policy({ hosts: ['ok.example'] })) });
    jest.spyOn(manager, 'stopInstance').mockResolvedValue(undefined as never);

    await helper.applyPolicyOnClaim(1, 'owner/repo', 'abc1234');

    expect(proxy.setPolicyAllowedHosts).toHaveBeenLastCalledWith([]);
  });
});

describe('the job a policy is resolved for', () => {
  it("applies the claimed job's workflow at the claim and at job start, not the spawn job's", async () => {
    const seen: string[] = [];
    const { helper } = managerWith({
      getRepoPolicy: async (_o, _r, _s, workflow) => { seen.push(workflow); return policy(); },
      getJobTarget: () => ({ targetDisplayName: 'owner/repo', githubSha: 'abc1234', githubWorkflow: 'deploy' }),
    });
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234', githubWorkflow: 'build' });
    const { onJobAcquired } = await realProxyFor(helper, 1);

    await onJobAcquired('req-1');
    expect(seen).toEqual(['deploy']);

    await helper.parseRunnerOutput(1, 'Running job: Build and test');
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual(['deploy', 'deploy']);
  });

  it('does not refresh at job start for a worker with no claim on record', async () => {
    const getRepoPolicy = jest.fn(async () => policy({ hosts: ['spawn-job.example'] }));
    const { helper } = managerWith({ getRepoPolicy: getRepoPolicy as never });
    const proxy = fakeProxy();
    helper.setProxy(1, proxy);
    helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234', githubWorkflow: 'build' });
    helper.setInstance(1, {
      name: 'runner-1',
      currentJob: { name: 'build', repository: 'owner/repo', startedAt: 'now', id: 'job-1', targetDisplayName: 'owner/repo', githubSha: 'abc1234', githubWorkflow: 'build' },
    });

    await helper.applyRepoPolicy(1);

    expect(getRepoPolicy).not.toHaveBeenCalled();
    expect(proxy.setPolicyAllowedHosts).not.toHaveBeenCalled();
  });

  it("applies an organization target's claim under the repository GitHub named, and opens its socket", async () => {
    const docker = { run: { images: ['alpine:3'] } };
    const getRepoPolicy = jest.fn(async (..._args: unknown[]) => policy({ hosts: ['ok.example'], docker }));
    const { helper } = managerWith({
      getRepoPolicy: getRepoPolicy as never,
      getJobTarget: () => ({ targetDisplayName: 'myorg', githubSha: 'abc1234', repository: 'MyOrg/App' }),
    });
    const socket = fakeSocket();
    helper.setDockerProxy(1, socket);
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'myorg', githubSha: 'abc1234', githubRepo: 'myorg/app' });
    const { onJobAcquired, proxy } = await realProxyFor(helper, 1);

    await onJobAcquired('req-1');

    expect(getRepoPolicy).toHaveBeenCalledWith('MyOrg', 'App', 'abc1234', '');
    expect(proxy.setPolicyAllowedHosts).toHaveBeenLastCalledWith(['ok.example']);
    expect(socket.bind).toHaveBeenCalledWith('MyOrg/App', docker);
  });

  it('retires a worker by repository whatever the case it was named in', async () => {
    const { manager, helper } = managerWith();
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'BFulton/Localmost', githubSha: 'abc1234' });
    const stopInstance = jest.spyOn(manager, 'stopInstance').mockResolvedValue(undefined as never);

    await manager.retireWorkersForRepository('bfulton/localmost');

    expect(stopInstance).toHaveBeenCalledWith(1);
  });

  it("retires an organization target's worker by the repository GitHub named", async () => {
    const { manager, helper } = managerWith();
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'myorg', githubSha: 'abc1234', githubRepo: 'myorg/app' });
    const stopInstance = jest.spyOn(manager, 'stopInstance').mockResolvedValue(undefined as never);

    await manager.retireWorkersForRepository('myorg/app');

    expect(stopInstance).toHaveBeenCalledWith(1);
  });

  it("checks an organization target's job against the repository GitHub named", async () => {
    const cancelWorkflowRun = jest.fn(async () => undefined);
    const { helper } = managerWith({
      getUserFilter: () => ({ scope: 'trigger', allowedUsers: 'just-me', allowlist: [] }),
      getCurrentUserLogin: () => 'me',
      cancelWorkflowRun,
    });
    helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'myorg', githubSha: 'abc1234', githubRepo: 'myorg/app' });
    helper.setInstance(1, {
      name: 'runner-1',
      currentJob: { name: 'build', repository: 'myorg', startedAt: 'now', id: 'job-1', targetDisplayName: 'myorg', githubRunId: 77, githubActor: 'stranger' },
    });

    await helper.checkJobUserFilter(1, 'runner-1');

    expect(cancelWorkflowRun).toHaveBeenCalledWith('myorg', 'app', 77);
  });
});

describe('a policy lookup that outlives its worker', () => {
  // The claim and the job start both await the repository's policy and then
  // install it on the slot's proxy and docker socket. The proxy is reused by
  // the slot's next worker, and the slot can be finished and refilled while
  // the lookup is in flight.
  const setup = () => {
    const pending = deferred<RepoPolicyRuntime>();
    const { manager, helper } = managerWith({ getRepoPolicy: () => pending.promise });
    const proxy = fakeProxy();
    const socket = fakeSocket();
    helper.setProxy(1, proxy);
    helper.setDockerProxy(1, socket);
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' });
    const late = policy({ hosts: ['old-job.example'], deniedHosts: [], loopback: true, level: 'permissive', docker: { run: { images: ['alpine:3'] } } });
    const untouched = () => {
      for (const fn of [proxy.setPolicyAllowedHosts, proxy.setPolicyDeniedHosts, proxy.setLoopbackPolicy, proxy.setPolicyLevel, socket.bind]) {
        expect(fn).not.toHaveBeenCalled();
      }
    };
    return { manager, helper, proxy, socket, pending, late, untouched };
  };

  const refill = (helper: RunnerManagerTestHelper, proxy: FakeProxy, socket: ReturnType<typeof fakeSocket>) => {
    // The worker exits and the slot goes to the next job's worker, same
    // repository, another commit - on the same proxy, with its own socket.
    helper.releaseInstanceSlot(1);
    helper.setInstance(1, { name: 'runner-1', status: 'starting' });
    helper.setPendingTargetContext('1', { targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'def5678' });
    helper.setProxy(1, proxy);
    helper.setDockerProxy(1, socket);
    jest.clearAllMocks();
  };

  it('does not install a claim on the worker that replaced it', async () => {
    const { helper, proxy, socket, pending, late, untouched } = setup();
    const claim = helper.applyPolicyOnClaim(1, 'owner/repo', 'abc1234');
    refill(helper, proxy, socket);

    pending.resolve(late);
    await claim;

    untouched();
  });

  it('does not reopen the proxy of a worker that finished while it was in flight', async () => {
    const { manager, helper, pending, late, untouched } = setup();
    const claim = helper.applyPolicyOnClaim(1, 'owner/repo', 'abc1234');
    // Exited and finalized, still the slot's instance: stopped or errored
    // workers stay in the map until the slot is reused.
    (manager as unknown as { finalizeInstance(n: number): void }).finalizeInstance(1);
    jest.clearAllMocks();

    pending.resolve(late);
    await claim;

    untouched();
  });

  it('does not install a job-start refresh on the worker that replaced it', async () => {
    const { helper, proxy, socket, pending, late, untouched } = setup();
    helper.setInstance(1, {
      name: 'runner-1',
      status: 'busy',
      claimedJob: { repository: 'owner/repo', sha: 'abc1234', workflow: 'ci' },
      currentJob: { name: 'build', repository: 'owner/repo', startedAt: 'now', id: 'job-1', targetDisplayName: 'owner/repo', githubSha: 'abc1234' },
    });
    const refresh = helper.applyRepoPolicy(1);
    refill(helper, proxy, socket);

    pending.resolve(late);
    await refresh;

    untouched();
  });
});
