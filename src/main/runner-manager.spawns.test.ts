/**
 * What one start of a worker leaves to the next start of its slot: its
 * sandbox, its process group, and anything of its job still running.
 *
 * A worker's profile grants its sandbox directory and docker socket by path,
 * and a process its job started can outlive it - one that traps SIGTERM, or
 * leaves its process group with setsid(). Kept apart from
 * runner-manager.test.ts so the downloader here builds a new sandbox for every
 * start, as the real one does, and process.kill can be answered per group.
 */

jest.mock('./process-sandbox', () => ({
  spawnSandboxed: jest.fn(),
}));

// A sandbox of its own for every start, named as the real downloader names them.
let mockSandboxesBuilt = 0;
const mockRemoveSandbox = jest.fn(async (_dir: string): Promise<void> => undefined);
jest.mock('./runner-downloader', () => ({
  RunnerDownloader: jest.fn().mockImplementation(() => ({
    getBaseDir: jest.fn().mockReturnValue('/Users/test/.localmost/runner'),
    getArcDir: jest.fn().mockReturnValue('/Users/test/.localmost/runner/arc/v2.330.0'),
    getConfigDir: jest.fn().mockImplementation((i: number) => `/Users/test/.localmost/runner/config/${i}`),
    getToolCacheDir: jest.fn().mockImplementation((t: string) => `/Users/test/.localmost/runner/caches/${t}/tool-cache`),
    getTargetCacheDir: jest.fn().mockImplementation((t: string) => `/Users/test/.localmost/runner/caches/${t}`),
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
    getProxyUrl: jest.fn().mockReturnValue('http://127.0.0.1:12345'),
    getPort: jest.fn().mockReturnValue(12345),
    setPolicyAllowedHosts: jest.fn(),
    setPolicyDeniedHosts: jest.fn(),
    setLoopbackPolicy: jest.fn(),
    setPolicyLevel: jest.fn(),
    rotateAuthToken: jest.fn(),
  })),
}));

// Start times always match, so an escalation is never spared for a reused
// pid; nothing holds a marker, so the marker sweep signals no one.
jest.mock('./runner-cleanup', () => ({
  processStartTime: jest.fn(() => 'START'),
  lookUpStartTime: jest.fn(() => 'START'),
  mayEscalate: jest.requireActual('./runner-cleanup').mayEscalate,
  markerHolders: jest.fn(async () => []),
  signalOrphanPids: jest.fn(async () => ({ signalled: false, remaining: [] })),
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
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(() => '{}'),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  unlinkSync: jest.fn(),
  readdirSync: jest.fn(() => []),
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

import { RunnerManager } from './runner-manager';

type RunnerManagerOptions = ConstructorParameters<typeof RunnerManager>[0];
import { GRACE_MS } from './process-group';
import { spawnSandboxed } from './process-sandbox';
import { createMockProcess, RunnerManagerTestHelper } from './test-utils';

const mockSpawnSandboxed = spawnSandboxed as jest.MockedFunction<typeof spawnSandboxed>;

/** Past the exit sweep's SIGKILL, when a finished start is settled. */
const SETTLE_MS = GRACE_MS + 2000;

/** Let promise chains and the fire-and-forget work after an event run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * process.kill as the OS would answer it: a signal to a group in `live`
 * succeeds, and a SIGKILL empties the group unless it is in `unkillable`.
 * Anything else is ESRCH. Every call is recorded.
 */
function stubKill(live: Set<number>, unkillable: Set<number> = new Set()) {
  const calls: Array<[number, string | number | undefined]> = [];
  const spy = jest.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    calls.push([pid, signal]);
    const group = Math.abs(pid);
    if (!live.has(group)) {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    }
    if (signal === 'SIGKILL' && !unkillable.has(group)) live.delete(group);
    return true;
  }) as typeof process.kill);
  return { calls, spy };
}

function newManager(options: Partial<RunnerManagerOptions> = {}) {
  const manager = new RunnerManager({
    onLog: jest.fn(),
    onStatusChange: jest.fn(),
    onJobHistoryUpdate: jest.fn(),
    ...options,
  } as RunnerManagerOptions);
  const helper = new RunnerManagerTestHelper(manager);
  helper.runnerCount = 1;
  return { manager, helper };
}

/** Start a worker for a job in slot 1, as a pid of our choosing. */
async function spawnWorker(helper: RunnerManagerTestHelper, pid: number, jobId = 'A') {
  const proc = createMockProcess(pid);
  mockSpawnSandboxed.mockReturnValueOnce(proc);
  expect(await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', jobId })).toBe(true);
  const [, , options] = mockSpawnSandboxed.mock.calls[mockSpawnSandboxed.mock.calls.length - 1];
  return { proc, sandboxDir: options!.cwd as string };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  mockSpawnSandboxed.mockReset();
  mockRemoveSandbox.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("a finished worker's sandbox", () => {
  it('is removed once the worker is done and nothing of its job runs', async () => {
    stubKill(new Set());
    const { helper } = newManager();
    const { proc, sandboxDir } = await spawnWorker(helper, 24680);

    proc.emit('exit', 0, null);
    await settle();
    // Not before the exit sweep has had its grace period and its SIGKILL.
    expect(mockRemoveSandbox).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(SETTLE_MS);
    await settle();

    expect(mockRemoveSandbox).toHaveBeenCalledWith(sandboxDir);
  });

  it('is kept while something of its job is still running in its process group', async () => {
    // SIGKILL cannot be refused, but a process in uninterruptible sleep dies
    // only when it wakes. Until then its sandbox is still in use.
    stubKill(new Set([24680]), new Set([24680]));
    const { helper } = newManager();
    await spawnWorker(helper, 24680);

    helper.instances.get(1)!.process!.emit('exit', 0, null);
    await jest.advanceTimersByTimeAsync(SETTLE_MS);
    await settle();

    expect(mockRemoveSandbox).not.toHaveBeenCalled();
  });

  it('is removed at once for a start that never ran its worker', async () => {
    stubKill(new Set());
    const { helper } = newManager({
      issueBrokerUrl: () => 'http://127.0.0.1:8787/w/key',
      issueWorkerCredential: async () => undefined,
    });

    expect(await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', jobId: 'A' })).toBe(false);
    await settle();

    expect(mockSpawnSandboxed).not.toHaveBeenCalled();
    expect(mockRemoveSandbox).toHaveBeenCalledTimes(1);
    expect(mockRemoveSandbox.mock.calls[0][0]).toMatch(/\/sandbox\/1-[0-9a-f]+$/);
  });
});

describe("a slot whose last worker's job may still be running", () => {
  it("is not reserved while the previous worker's process group still answers", async () => {
    // A step that traps SIGTERM keeps the group alive through the grace
    // period, with the profile of the job it belongs to.
    const { calls } = stubKill(new Set([24680]));
    const { manager, helper } = newManager();
    const { proc } = await spawnWorker(helper, 24680);

    proc.emit('exit', 0, null);
    await settle();
    expect(calls).toContainEqual([-24680, 'SIGTERM']);

    expect(manager.hasAvailableSlot()).toBe(false);
    expect(helper.reserveSlot()).toBeNull();

    await jest.advanceTimersByTimeAsync(GRACE_MS);
    expect(calls).toContainEqual([-24680, 'SIGKILL']);
    expect(manager.hasAvailableSlot()).toBe(true);
    expect(helper.reserveSlot()).toBe(1);
  });

  it('is free at once when nothing of the job outlived its worker', async () => {
    stubKill(new Set());
    const { manager, helper } = newManager();
    const { proc } = await spawnWorker(helper, 24680);

    proc.emit('exit', 0, null);
    await settle();

    expect(manager.hasAvailableSlot()).toBe(true);
  });

  it('starts the next job only once the previous group has been killed', async () => {
    const { calls } = stubKill(new Set([24680]));
    const { helper } = newManager();
    const { proc } = await spawnWorker(helper, 24680, 'A');
    proc.emit('exit', 0, null);
    await settle();

    const next = createMockProcess(24690);
    let signalsBeforeSpawn: typeof calls = [];
    mockSpawnSandboxed.mockImplementationOnce(() => {
      signalsBeforeSpawn = [...calls];
      return next;
    });
    const started = helper.spawnForJob({ targetId: 't2', targetDisplayName: 'other/repo', jobId: 'B' });
    await settle();
    expect(mockSpawnSandboxed).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(GRACE_MS + 1000);

    expect(await started).toBe(true);
    expect(helper.instances.get(1)!.process).toBe(next);
    expect(signalsBeforeSpawn).toContainEqual([-24680, 'SIGKILL']);
  });

  it("is not reserved while a reaped worker's group waits out its grace period", async () => {
    const { calls } = stubKill(new Set([24680]));
    const { manager, helper } = newManager();
    await spawnWorker(helper, 24680);

    helper.reapUnclaimedWorker(1);

    expect(calls).toContainEqual([-24680, 'SIGTERM']);
    expect(manager.hasAvailableSlot()).toBe(false);
    expect(helper.reserveSlot()).toBeNull();
    await jest.advanceTimersByTimeAsync(GRACE_MS);
    expect(manager.hasAvailableSlot()).toBe(true);
  });

  it('is not reserved, nor started over, while its worker runs with an error status', async () => {
    // The status says error; the process has not exited, so its job goes on
    // in its sandbox with its proxy and broker key.
    stubKill(new Set([24680]));
    const { manager, helper } = newManager();
    const { proc } = await spawnWorker(helper, 24680);

    proc.emit('error', new Error('kill EPERM'));
    expect(helper.instances.get(1)!.status).toBe('error');

    expect(manager.hasAvailableSlot()).toBe(false);
    expect(helper.reserveSlot()).toBeNull();
    await manager.startInstance(1);
    expect(mockSpawnSandboxed).toHaveBeenCalledTimes(1);
    expect(helper.instances.get(1)!.process).toBe(proc);
  });
});
