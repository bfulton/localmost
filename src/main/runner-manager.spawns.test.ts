/**
 * How a worker is run: every one in a macOS VM of its own, through the
 * isolation backend (a fake here), and what one start leaves to the next
 * start of its slot - its VM released and its sandbox removed. Also how many
 * run at once, and what the pool does while no golden image is ready. Kept
 * apart from runner-manager.test.ts so the downloader here builds a new
 * sandbox for every start, as the real one does.
 */

// A sandbox of its own for every start, named as the real downloader names them.
let mockSandboxesBuilt = 0;
const mockRemoveSandbox = jest.fn(async (_dir: string): Promise<void> => undefined);
jest.mock('./runner-downloader', () => ({
  RunnerDownloader: jest.fn().mockImplementation(() => ({
    getBaseDir: jest.fn().mockReturnValue('/Users/test/.localmost/runner'),
    getArcDir: jest.fn().mockReturnValue('/Users/test/.localmost/runner/arc/v2.330.0'),
    getConfigDir: jest.fn().mockImplementation((i: number) => `/Users/test/.localmost/runner/config/${i}`),
    writeShareNonce: jest.fn(() => 'a'.repeat(32)),
    buildSandbox: jest.fn().mockImplementation((i: number) =>
      Promise.resolve(`/Users/test/.localmost/runner/sandbox/${i}-${(++mockSandboxesBuilt).toString(16).padStart(12, '0')}`)
    ),
    removeSandbox: (dir: string) => mockRemoveSandbox(dir),
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
    getProxyUrl: jest.fn().mockReturnValue('http://localmost:token@127.0.0.1:12345'),
    getPort: jest.fn().mockReturnValue(12345),
    setPolicyAllowedHosts: jest.fn(),
    setPolicyDeniedHosts: jest.fn(),
    setBrokerPort: jest.fn(),
    setPolicyLevel: jest.fn(),
    rotateAuthToken: jest.fn(),
    getStats: jest.fn(() => ({ allowedCount: 0, blockedCount: 0, blockedHosts: new Set() })),
    getPolicyLevel: jest.fn(() => 'strict'),
    resetStats: jest.fn(),
  })),
}));

jest.mock('./docker/docker-filter-proxy', () => ({
  DockerFilterProxy: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    bind: jest.fn(),
  })),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(() => '{}'),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  unlinkSync: jest.fn(),
  readdirSync: jest.fn(() => []),
  mkdirSync: jest.fn(),
  promises: {
    mkdir: jest.fn(),
    unlink: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
    readdir: jest.fn().mockResolvedValue([]),
    readFile: jest.fn().mockResolvedValue(''),
  },
}));

import * as fs from 'fs';
import * as path from 'path';
import { DockerFilterProxy } from './docker/docker-filter-proxy';
import { RunnerManager } from './runner-manager';
import type { IsolationJob } from './isolation/macos-vm/types';
import type { LogEntry, RunnerState } from '../shared/types';
import { createMockWorker, fakeIsolation, type FakeIsolation, RunnerManagerTestHelper } from './test-utils';

/** The macOS VM backend every manager here runs its workers on; a new one for each test. */
let isolation: FakeIsolation;

type RunnerManagerOptions = ConstructorParameters<typeof RunnerManager>[0];

/** Let promise chains and the fire-and-forget work after an event run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

function newManager(options: Partial<RunnerManagerOptions> = {}, runnerCount = 1) {
  const logs: LogEntry[] = [];
  const statuses: RunnerState[] = [];
  const manager = new RunnerManager({
    isolation,
    onLog: (entry: LogEntry) => logs.push(entry),
    onStatusChange: (state: RunnerState) => statuses.push(state),
    onJobHistoryUpdate: jest.fn(),
    ...options,
  } as RunnerManagerOptions);
  const helper = new RunnerManagerTestHelper(manager);
  helper.runnerCount = runnerCount;
  return { manager, helper, logs, statuses };
}

/** Start a worker for a job, as a guest pid of our choosing; the job the backend was handed. */
async function spawnWorker(helper: RunnerManagerTestHelper, pid: number, jobId = 'A') {
  const worker = createMockWorker(pid);
  isolation.spawnWorker.mockResolvedValueOnce(worker);
  expect(await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', jobId })).toBe(true);
  const [job, argv, env] = isolation.spawnWorker.mock.calls[isolation.spawnWorker.mock.calls.length - 1];
  return { worker, job, argv, env };
}

beforeEach(() => {
  isolation = fakeIsolation();
  mockRemoveSandbox.mockClear();
  jest.mocked(fs.writeFileSync).mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('a worker started for a job', () => {
  it("prepares a macOS VM for it, then starts the runner there with --once and the worker's environment", async () => {
    const { helper } = newManager();
    const { job, argv, env } = await spawnWorker(helper, 501);

    expect(job).toEqual({
      key: expect.stringMatching(/^1-1-[0-9a-f]{12}$/),
      proxyPort: 12345,
      brokerPort: 8787,
      sandboxDir: expect.stringMatching(/\/runner\/sandbox\/1-[0-9a-f]{12}$/),
      runnerVersion: '2.330.0',
    });
    // The wait for a VM slot is bounded: GitHub has handed the job over, and
    // one that cannot get a VM fails promptly rather than hang.
    expect(isolation.prepare).toHaveBeenCalledWith(job, expect.any(AbortSignal), 60_000);
    expect(isolation.prepare.mock.invocationCallOrder[0]).toBeLessThan(isolation.spawnWorker.mock.invocationCallOrder[0]);
    expect(argv).toEqual(['--once']);
    // The runner's settings and the proxy, which the guest reaches through
    // its relay at the same address; nothing of the Mac's own PATH or HOME.
    expect(env).toEqual(
      expect.objectContaining({
        ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT: 'true',
        HTTPS_PROXY: 'http://localmost:token@127.0.0.1:12345',
        https_proxy: 'http://localmost:token@127.0.0.1:12345',
      })
    );
    expect(env).not.toHaveProperty('PATH');
    expect(env).not.toHaveProperty('HOME');
    expect(env).not.toHaveProperty('DOCKER_HOST');
    expect(helper.instances.get(1)!.worker).not.toBeNull();
  });

  it("has its runner files written to its sandbox before its VM is prepared, which hands them to the guest", async () => {
    const { helper } = newManager({
      issueBrokerUrl: () => 'http://127.0.0.1:8787/w/key',
      issueWorkerCredential: async () => ({
        credentials: { scheme: 'OAuth', data: {} },
        rsaParams: { d: 'D' },
      }) as never,
    });
    const { job } = await spawnWorker(helper, 501);

    const credentials = jest.mocked(fs.writeFileSync).mock.calls.findIndex(([file]) => file === path.join(job.sandboxDir, '.credentials'));
    expect(credentials).toBeGreaterThanOrEqual(0);
    expect(jest.mocked(fs.writeFileSync).mock.invocationCallOrder[credentials]).toBeLessThan(isolation.prepare.mock.invocationCallOrder[0]);
  });

  it("reads the runner's status from the lines its worker hands over", async () => {
    const { helper } = newManager();
    const { worker } = await spawnWorker(helper, 501);

    worker.emit('stdout', '2026-10-05 10:00:00Z: Listening for Jobs');
    expect(helper.instances.get(1)!.status).toBe('listening');
    worker.emit('stdout', '2026-10-05 10:00:01Z: Running job: build');
    expect(helper.instances.get(1)!.status).toBe('busy');
    expect(helper.instances.get(1)!.currentJob?.name).toBe('build');
  });

  it('gets a VM, a sandbox and a docker socket of its own at every start', async () => {
    const { helper } = newManager();
    const first = await spawnWorker(helper, 501, 'A');
    first.worker.emit('exit', 0, null);
    await settle();
    const second = await spawnWorker(helper, 502, 'B');

    expect(second.job.key).not.toBe(first.job.key);
    expect(second.job.sandboxDir).not.toBe(first.job.sandboxDir);
    const served = (DockerFilterProxy as unknown as jest.Mock).mock.results
      .slice(-2)
      .map(({ value }) => (value.start as jest.Mock).mock.calls[0][0]);
    expect(served).toEqual([path.join(first.job.sandboxDir, 'docker.sock'), path.join(second.job.sandboxDir, 'docker.sock')]);
  });

  it("names the policy's filesystem grants, which a VM job is not given, when it starts", async () => {
    const { manager, helper, logs } = newManager({
      getRepoPolicy: async () => ({
        hosts: [], level: 'strict', docker: {}, readPaths: ['~/data'], writePaths: ['./out'], denyPaths: ['~/.ssh'],
      }),
    });
    await manager.initialize();
    helper.setPendingTargetContext('next', { targetId: 't1', targetDisplayName: 'owner/repo', githubSha: 'abc' });
    isolation.spawnWorker.mockResolvedValueOnce(createMockWorker(501));
    expect(await manager.spawnWorkerForJob()).toBe(true);

    const warnings = logs.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(warnings).toContain('[instance 1] Filesystem grants are not provided in the macOS VM yet; this job runs without: read ~/data, write ./out');
  });
});

describe("a finished worker's VM and sandbox", () => {
  it('are released and removed, in that order, when the worker exits', async () => {
    const { helper } = newManager();
    const { worker, job } = await spawnWorker(helper, 501);

    worker.emit('exit', 0, null);
    await settle();

    expect(isolation.release).toHaveBeenCalledWith(job);
    expect(mockRemoveSandbox).toHaveBeenCalledWith(job.sandboxDir);
    expect(isolation.release.mock.invocationCallOrder[0]).toBeLessThan(mockRemoveSandbox.mock.invocationCallOrder[0]);
  });

  it('are released at once for a worker reaped for never taking its job, and its slot is free', async () => {
    const { manager, helper } = newManager();
    const { job } = await spawnWorker(helper, 501);

    helper.reapUnclaimedWorker(1);
    await settle();

    expect(isolation.release).toHaveBeenCalledWith(job);
    expect(mockRemoveSandbox).toHaveBeenCalledWith(job.sandboxDir);
    expect(manager.hasAvailableSlot()).toBe(true);
  });

  it('are released once, however many paths finish the same worker', async () => {
    const { helper } = newManager();
    const { worker } = await spawnWorker(helper, 501);

    worker.emit('exit', 0, null);
    helper.releaseInstanceSlot(1);
    await settle();

    expect(isolation.release).toHaveBeenCalledTimes(1);
    expect(mockRemoveSandbox).toHaveBeenCalledTimes(1);
  });

  it('go at once for a start whose VM could not be prepared, and nothing is started', async () => {
    const { manager, helper, logs } = newManager();
    isolation.prepare.mockRejectedValueOnce(new Error('the macOS VM did not start: no slot'));

    expect(await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'A' })).toBe(false);
    await settle();

    expect(isolation.spawnWorker).not.toHaveBeenCalled();
    const [job] = isolation.prepare.mock.calls[0];
    expect(isolation.release).toHaveBeenCalledWith(job);
    expect(mockRemoveSandbox).toHaveBeenCalledWith(job.sandboxDir);
    expect(manager.hasAvailableSlot()).toBe(true);
    expect(logs.some((l) => l.level === 'error' && /the macOS VM did not start: no slot/.test(l.message))).toBe(true);
  });

  it('go at once for a start whose runner could not be started in its VM', async () => {
    const { helper } = newManager();
    isolation.spawnWorker.mockRejectedValueOnce(new Error('the guest agent refused the job'));

    expect(await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'A' })).toBe(false);
    await settle();

    const [job] = isolation.prepare.mock.calls[0];
    expect(isolation.release).toHaveBeenCalledWith(job);
    expect(mockRemoveSandbox).toHaveBeenCalledWith(job.sandboxDir);
    expect(helper.instances.get(1)?.worker ?? null).toBeNull();
  });

  it('go, and no runner starts, when the pool is stopped while the VM is still being prepared', async () => {
    // A cold boot or a wait for one of the two VM slots can take minutes;
    // a stop meanwhile aborts it rather than start a job nobody waits for.
    const { manager, helper } = newManager();
    let preparing!: { job: IsolationJob; signal?: AbortSignal; resolve: () => void };
    isolation.prepare.mockImplementationOnce((job, signal) => new Promise<void>((resolve) => { preparing = { job, signal, resolve }; }));

    const started = helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'A' });
    await settle();
    expect(preparing).toBeDefined();
    await manager.stop();

    expect(preparing.signal?.aborted).toBe(true);
    expect(isolation.release).toHaveBeenCalledWith(preparing.job);
    preparing.resolve();
    expect(await started).toBe(false);
    expect(isolation.spawnWorker).not.toHaveBeenCalled();
    // Not put back in the pool the stop cleared.
    expect(helper.instances.size).toBe(0);
    expect(manager.getStatus().status).toBe('offline');
  });

  it('are never used by a start whose slot was let go while its docker socket started', async () => {
    const { manager, helper } = newManager();
    let serve!: () => void;
    (DockerFilterProxy as unknown as jest.Mock).mockImplementationOnce(() => ({
      start: jest.fn(() => new Promise<void>((resolve) => { serve = resolve; })),
      stop: jest.fn().mockResolvedValue(undefined),
      bind: jest.fn(),
    }));

    const started = helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'A' });
    await settle();
    expect(serve).toBeDefined();
    await manager.stop();
    serve();

    expect(await started).toBe(false);
    expect(isolation.prepare).not.toHaveBeenCalled();
    expect(isolation.spawnWorker).not.toHaveBeenCalled();
  });

  it('are never used by a start whose slot was let go while its runner started', async () => {
    // A stop while the guest agent starts the runner released the VM; the
    // worker it hands back is not armed with an acquire deadline for a slot
    // that is no longer its.
    const { manager, helper } = newManager();
    let spawned!: (worker: ReturnType<typeof createMockWorker>) => void;
    isolation.spawnWorker.mockImplementationOnce(() => new Promise((resolve) => { spawned = resolve; }));

    const started = helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'A' });
    await settle();
    expect(spawned).toBeDefined();
    await manager.stop();
    spawned(createMockWorker(501));

    expect(await started).toBe(false);
    expect(helper.instances.size).toBe(0);
    expect((manager as unknown as { acquireDeadlines: Map<number, unknown> }).acquireDeadlines.size).toBe(0);
  });
});

describe('stopping a worker', () => {
  it("sends its runner SIGTERM through the backend, and is done when the runner exits", async () => {
    const { manager, helper } = newManager();
    const { worker, job } = await spawnWorker(helper, 501);
    isolation.signal.mockImplementationOnce(async () => {
      setImmediate(() => worker.emit('exit', null, 'SIGTERM'));
    });

    await manager.stopInstance(1);

    expect(isolation.signal).toHaveBeenCalledWith(job, 'SIGTERM');
    await settle();
    expect(isolation.release).toHaveBeenCalledWith(job);
  });

  it('stops its VM under it when the runner does not exit within the grace', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const { manager, helper } = newManager();
    const { job } = await spawnWorker(helper, 501);

    const stopped = manager.stopInstance(1);
    await jest.advanceTimersByTimeAsync(5000);
    await stopped;

    expect(isolation.signal).toHaveBeenCalledWith(job, 'SIGTERM');
    expect(isolation.release).toHaveBeenCalledWith(job);
  });
});

describe('how many workers run at once', () => {
  it('is never more than the two macOS VMs a Mac may run, whatever the runner count', async () => {
    const { manager, helper } = newManager({}, 4);
    const a = await spawnWorker(helper, 501, 'A');
    const b = await spawnWorker(helper, 502, 'B');
    a.worker.emit('stdout', 'Running job: one');
    b.worker.emit('stdout', 'Running job: two');

    expect(helper.instances.size).toBe(2);
    expect(manager.hasAvailableSlot()).toBe(false);
    expect(helper.reserveSlot()).toBeNull();

    a.worker.emit('exit', 0, null);
    await settle();
    expect(manager.hasAvailableSlot()).toBe(true);
    expect(helper.reserveSlot()).toBe(1);
  });

  it('is one on a Mac whose memory fits only one macOS VM', async () => {
    const { manager, helper } = newManager({}, 4);
    isolation.vmLimit.mockReturnValue(1);
    const a = await spawnWorker(helper, 501, 'A');
    a.worker.emit('stdout', 'Running job: one');

    expect(manager.hasAvailableSlot()).toBe(false);
    expect(helper.reserveSlot()).toBeNull();
  });

  it('leaves out a VM the golden image or a localmost test run holds', async () => {
    // Offered anyway, the job would be taken from GitHub only to wait for a
    // VM that the save-state or the test run holds.
    const { manager, helper } = newManager({}, 2);
    isolation.jobCapacity.mockReturnValue(1);
    const a = await spawnWorker(helper, 501, 'A');
    a.worker.emit('stdout', 'Running job: one');
    expect(manager.hasAvailableSlot()).toBe(false);
    expect(helper.reserveSlot()).toBeNull();

    a.worker.emit('exit', 0, null);
    await settle();
    isolation.jobCapacity.mockReturnValue(0);
    expect(manager.hasAvailableSlot()).toBe(false);
    isolation.jobCapacity.mockReturnValue(2);
    expect(manager.hasAvailableSlot()).toBe(true);
  });

  it('is the runner count when that is fewer', async () => {
    const { manager, helper } = newManager({}, 1);
    const a = await spawnWorker(helper, 501, 'A');
    a.worker.emit('stdout', 'Running job: one');

    expect(manager.hasAvailableSlot()).toBe(false);
  });
});

describe('the pool while no golden image is ready', () => {
  const NOT_BUILT = { ok: false, reason: 'no golden macOS image has been built: build one in Settings' };

  it('takes no job, and its status says why, rather than start workers that cannot run', async () => {
    isolation.available.mockReturnValue(NOT_BUILT);
    const { manager, helper, logs } = newManager();
    await manager.initialize();

    expect(manager.hasAvailableSlot()).toBe(false);
    expect(manager.hasAvailableSlot()).toBe(false);
    expect(manager.getStatus()).toEqual({
      status: 'offline',
      startedAt: expect.any(String),
      error: 'Taking no jobs: no golden macOS image has been built: build one in Settings',
    });
    // Said once, not at every capacity check.
    expect(logs.filter((l) => l.message.startsWith('Taking no jobs')).map((l) => l.level)).toEqual(['warn']);

    helper.setPendingTargetContext('next', { targetId: 't1', targetDisplayName: 'owner/repo' });
    expect(await manager.spawnWorkerForJob()).toBe(false);
    expect(isolation.prepare).not.toHaveBeenCalled();
    expect(helper.instances.size).toBe(0);
  });

  it('takes jobs again once an image is ready, and says so', async () => {
    isolation.available.mockReturnValue(NOT_BUILT);
    const { manager, logs, statuses } = newManager();
    await manager.initialize();

    isolation.available.mockReturnValue({ ok: true });
    manager.refreshAvailability();

    expect(manager.hasAvailableSlot()).toBe(true);
    expect(statuses[statuses.length - 1]).toEqual(expect.objectContaining({ status: 'listening' }));
    expect(logs.some((l) => l.message === 'A macOS VM can be started for a job; taking jobs')).toBe(true);
  });

  it('is what a manager without a backend is in', async () => {
    const manager = new RunnerManager({ onLog: jest.fn(), onStatusChange: jest.fn(), onJobHistoryUpdate: jest.fn() });
    await manager.initialize();

    expect(manager.hasAvailableSlot()).toBe(false);
    expect(manager.getStatus().error).toBe('Taking no jobs: this runner was started without a macOS VM backend');
  });
});
