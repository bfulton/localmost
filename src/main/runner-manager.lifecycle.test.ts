/**
 * Runner lifecycle: reading the runner's output, cancelling a run, keeping
 * the job history, and sweeping a previous session's workers.
 *
 * Kept apart from runner-manager.test.ts so the mocks here can model a
 * little more of fs (an in-memory history file, rename) without touching the
 * shared setup.
 */

jest.mock('./process-sandbox', () => ({
  spawnSandboxed: jest.fn(),
}));

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
    getPolicyDeniedHosts: jest.fn(() => []),
    setLoopbackPolicy: jest.fn(),
    setPolicyLevel: jest.fn(),
    getPolicyLevel: jest.fn(() => 'strict'),
    getStats: jest.fn(() => ({ allowedCount: 0, blockedCount: 0, blockedHosts: new Set() })),
    rotateAuthToken: jest.fn(),
    resetStats: jest.fn(),
  })),
}));

// The sweep by profile mark runs python; stubbed, as nothing here runs sandboxed.
jest.mock('../shared/sandbox-reaper', () => ({
  reapMarkedProcessesAsync: jest.fn(async () => []),
  developerPython: jest.fn(async () => null),
}));

// Start times: the one recorded at spawn is 'START'. mockLookUpStartTime is
// what a lookup made at escalation time sees; mayEscalate is the real rule.
const mockLookUpStartTime = jest.fn((_pid: number): string | null | undefined => 'START');
jest.mock('./runner-cleanup', () => ({
  processStartTime: jest.fn(() => 'START'),
  lookUpStartTime: (pid: number) => mockLookUpStartTime(pid),
  mayEscalate: jest.requireActual('./runner-cleanup').mayEscalate,
  markerHolders: jest.fn(() => []),
  signalOrphanPids: jest.fn(async () => ({ signalled: false, remaining: [] })),
  parsePidRecord: jest.requireActual('./runner-cleanup').parsePidRecord,
}));

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

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
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

import * as fs from 'fs';
import * as path from 'path';
import { RunnerManager, JobEvent, lineReader, UNCLAIMED_WORKER_TIMEOUT_MS } from './runner-manager';
import { ProxyServer } from './proxy-server';
import { spawnSandboxed } from './process-sandbox';
import { getJobHistoryPath } from './paths';
import { GitHubClientError } from './github-client';
import { createMockProcess, RunnerManagerTestHelper } from './test-utils';

const mockSpawnSandboxed = spawnSandboxed as jest.MockedFunction<typeof spawnSandboxed>;

/** Let fire-and-forget work (output parsing, the backstop) settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * Fake timers for a block, so a test that fails part-way cannot leave a real
 * timer (a stop's SIGKILL, say) to fire inside a later test. Output parsing
 * settles on setImmediate, which stays real.
 */
function fakeTimersFor(): void {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });
}

/** Run to completion something that waits on (fake) timers along the way. */
async function withTimers<T>(work: Promise<T>): Promise<T> {
  let done = false;
  const result = work.finally(() => {
    done = true;
  });
  while (!done) await jest.advanceTimersByTimeAsync(1000);
  return result;
}

/** Replace process.kill for the duration of a test, recording every call. */
function stubKill(impl: (pid: number, sig?: string | number) => boolean = () => true) {
  const calls: Array<[number, string | number | undefined]> = [];
  const realKill = process.kill;
  (process as unknown as { kill: unknown }).kill = ((pid: number, sig?: string | number) => {
    calls.push([pid, sig]);
    return impl(pid, sig);
  }) as never;
  return { calls, restore: () => { (process as unknown as { kill: unknown }).kill = realKill; } };
}

function newManager(overrides: Partial<ConstructorParameters<typeof RunnerManager>[0]> = {}) {
  const events: JobEvent[] = [];
  const onLog = jest.fn();
  const manager = new RunnerManager({
    onLog,
    onStatusChange: jest.fn(),
    onJobHistoryUpdate: jest.fn(),
    onJobEvent: (e: JobEvent) => events.push(e),
    ...overrides,
  });
  return { manager, helper: new RunnerManagerTestHelper(manager), events, onLog };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLookUpStartTime.mockReset();
  mockLookUpStartTime.mockImplementation(() => 'START');
  (fs.existsSync as jest.Mock).mockReturnValue(false);
  (fs.readFileSync as jest.Mock).mockReturnValue('{}');
  (fs.writeFileSync as jest.Mock).mockReset();
  (fs.renameSync as jest.Mock).mockReset();
});

describe('reading job completion from runner output', () => {
  it('does not end a job on a completion phrase inside a line the job printed', async () => {
    const { helper, events } = newManager();
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    await helper.parseRunnerOutput(1, '2026-09-29 12:00:00Z: Running job: build');

    // Step output can say anything; only a line the runner itself starts
    // with the phrase (behind its timestamp, at most) is a completion.
    await helper.parseRunnerOutput(1, 'echo: Job build completed with result: Succeeded');
    await helper.parseRunnerOutput(1, '{"k":"message","v":"Job build completed with result: Succeeded"}');

    expect(helper.instances.get(1)!.currentJob).not.toBeNull();
    expect(helper.instances.get(1)!.currentJob!.runnerResult).toBeUndefined();
    expect(helper.instances.get(1)!.status).toBe('busy');
    expect(events.filter((e) => e.type === 'completed')).toEqual([]);

    // The runner's own line, timestamped, gives the result - for the
    // worker's exit to weigh; the job is not over until then.
    await helper.parseRunnerOutput(1, '2026-09-29 12:00:05Z: Job build completed with result: Failed');
    expect(helper.instances.get(1)!.currentJob!.runnerResult).toBe('failed');
    expect(helper.instances.get(1)!.status).toBe('busy');
    expect(events.filter((e) => e.type === 'completed')).toEqual([]);
  });

  it('does not end the job it has just started on the same line', async () => {
    // A job start whose name reads like a completion line: the start block
    // must not fall through into the completion check.
    const { helper } = newManager();
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });

    await helper.parseRunnerOutput(1, 'Running job: Job x completed with result: Succeeded');

    expect(helper.instances.get(1)!.currentJob).toEqual(
      expect.objectContaining({ name: 'Job x completed with result: Succeeded' })
    );
    expect(helper.instances.get(1)!.status).toBe('busy');
  });
});

describe("reading the runner's status from its output", () => {
  // The runner's own lines, as the Listener writes them.
  const REGISTRATION_DELETED =
    'Failed to create a session. The runner registration has been deleted from the server, please re-configure. ' +
    'Runner registrations are automatically deleted for runners that have not connected to the service recently.';
  const SESSION_EXISTS = 'A session for this runner already exists.';
  const CONNECT_ERROR = '2026-09-29 12:00:01Z: Runner connect error: Connection refused. Retrying until reconnected.';

  function listening(overrides: Partial<ConstructorParameters<typeof RunnerManager>[0]> = {}) {
    const onReregistrationNeeded = jest.fn(async () => undefined);
    const ctx = newManager({ onReregistrationNeeded, ...overrides });
    ctx.helper.runnerCount = 1;
    ctx.helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    return { ...ctx, onReregistrationNeeded };
  }

  it("a job named 'Runner connect error' stays busy and keeps its slot", async () => {
    // The job's name is the workflow's to choose, and the Listener prints it.
    const { manager, helper } = listening();

    await helper.parseRunnerOutput(1, '2026-09-29T00:00:00Z: Running job: Runner connect error');

    const instance = helper.instances.get(1)!;
    expect(instance.status).toBe('busy');
    expect(instance.currentJob?.name).toBe('Runner connect error');
    expect(manager.hasAvailableSlot()).toBe(false);
  });

  it("a job named 'please re-configure' does not re-register", async () => {
    const { helper, onReregistrationNeeded } = listening();

    await helper.parseRunnerOutput(1, '2026-09-29T00:00:00Z: Running job: please re-configure');

    expect(onReregistrationNeeded).not.toHaveBeenCalled();
    expect(helper.instances.get(1)!.fatalError).toBe(false);
    expect(helper.instances.get(1)!.currentJob?.name).toBe('please re-configure');
  });

  it("records a job whatever its name, even 'Listening for Jobs' or 'session for this runner already exists'", async () => {
    for (const name of ['Listening for Jobs', 'session for this runner already exists']) {
      const { helper } = listening();
      await helper.parseRunnerOutput(1, `2026-09-29T00:00:00Z: Running job: ${name}`);
      expect(helper.instances.get(1)!.status).toBe('busy');
      expect(helper.instances.get(1)!.currentJob?.name).toBe(name);
    }
  });

  it('takes no status from anything a running job prints, even a line shaped like the runner\'s own', async () => {
    const { manager, helper, onReregistrationNeeded } = listening();
    await helper.parseRunnerOutput(1, '2026-09-29 12:00:00Z: Running job: build');

    for (const line of [REGISTRATION_DELETED, SESSION_EXISTS, CONNECT_ERROR, '2026-09-29 12:00:02Z: Listening for Jobs']) {
      await helper.parseRunnerOutput(1, line);
    }

    const instance = helper.instances.get(1)!;
    expect(instance.status).toBe('busy');
    expect(instance.fatalError).toBe(false);
    expect(instance.currentJob?.name).toBe('build');
    expect(onReregistrationNeeded).not.toHaveBeenCalled();
    expect(manager.hasAvailableSlot()).toBe(false);
  });

  it('a job that prints a completion line and then a status line keeps its slot and its registration', async () => {
    // A job that can put a runner-shaped line here can put the completion
    // first. The worker is --once: having taken its job it is that job's
    // until it exits, whatever the job says about its end.
    const cases: Array<[string, Partial<ConstructorParameters<typeof RunnerManager>[0]>]> = [
      ['no conclusion lookup', {}],
      ['a conclusion lookup that has none yet', { getJobConclusion: jest.fn(async () => null) }],
    ];
    for (const [label, overrides] of cases) {
      const { manager, helper, events, onReregistrationNeeded } = listening(overrides);
      helper.setPendingTargetContext('1', {
        targetId: 't', targetDisplayName: 'owner/repo', githubRepo: 'owner/repo', githubJobId: 7,
      });
      await helper.parseRunnerOutput(1, '2026-09-29 12:00:00Z: Running job: build');
      await helper.parseRunnerOutput(1, 'Job build completed with result: Succeeded');

      for (const line of [CONNECT_ERROR, REGISTRATION_DELETED, SESSION_EXISTS, 'Running job: another']) {
        await helper.parseRunnerOutput(1, line);
      }

      const instance = helper.instances.get(1)!;
      expect({ label, status: instance.status, fatalError: instance.fatalError }).toEqual(
        { label, status: expect.not.stringMatching(/^error$/), fatalError: false }
      );
      expect(manager.hasAvailableSlot()).toBe(false);
      expect(onReregistrationNeeded).not.toHaveBeenCalled();
      // One spawn, one job: a second start is not recorded as another.
      expect(events.filter((e) => e.type === 'started').map((e) => e.jobName)).toEqual(['build']);
    }
  });

  it('reads a status only from a line the runner starts with it', async () => {
    const ready = listening();
    ready.helper.setInstance(1, { name: 'runner-1', status: 'starting' });
    await ready.helper.parseRunnerOutput(1, 'echo: Listening for Jobs');
    expect(ready.helper.instances.get(1)!.status).toBe('starting');

    const { helper, onReregistrationNeeded } = listening();

    for (const line of [
      'echo: the runner registration has been deleted, please re-configure',
      'echo: The runner registration has been deleted from the server, please re-configure.',
      'note: a session for this runner already exists',
      'curl: Runner connect error',
      'curl: Could not connect to the server',
    ]) {
      await helper.parseRunnerOutput(1, line);
    }

    expect(helper.instances.get(1)!.status).toBe('listening');
    expect(helper.instances.get(1)!.fatalError).toBe(false);
    expect(onReregistrationNeeded).not.toHaveBeenCalled();
  });

  it("still reads the runner's own status lines before a job", async () => {
    const ready = listening();
    ready.helper.setInstance(1, { name: 'runner-1', status: 'starting' });
    await ready.helper.parseRunnerOutput(1, '2026-09-29 12:00:00Z: Listening for Jobs');
    expect(ready.helper.instances.get(1)!.status).toBe('listening');

    const deleted = listening();
    await deleted.helper.parseRunnerOutput(1, REGISTRATION_DELETED);
    expect(deleted.helper.instances.get(1)!.status).toBe('error');
    expect(deleted.helper.instances.get(1)!.fatalError).toBe(true);
    expect(deleted.onReregistrationNeeded).toHaveBeenCalledWith(1, 'registration_deleted');

    for (const line of [SESSION_EXISTS, 'The session for this runner already exists.']) {
      const conflict = listening();
      await conflict.helper.parseRunnerOutput(1, line);
      expect(conflict.helper.instances.get(1)!.status).toBe('error');
      expect(conflict.helper.instances.get(1)!.fatalError).toBe(true);
    }

    for (const line of [CONNECT_ERROR, 'Could not connect to the server.']) {
      const unreachable = listening();
      await unreachable.helper.parseRunnerOutput(1, line);
      expect(unreachable.helper.instances.get(1)!.status).toBe('error');
      expect(unreachable.helper.instances.get(1)!.fatalError).toBe(false);
    }
  });
});

describe('reading a job start whatever its name holds', () => {
  const TS = '2026-09-29 12:00:00Z: ';
  const REREGISTER = 'The runner registration has been deleted from the server, please re-configure.';

  async function spawned() {
    const onReregistrationNeeded = jest.fn(async () => undefined);
    const ctx = newManager({ onReregistrationNeeded });
    ctx.helper.runnerCount = 1;
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const proc = createMockProcess(24680);
    mockSpawnSandboxed.mockReturnValue(proc);
    await ctx.helper.spawnForJob();
    ctx.helper.instances.get(1)!.status = 'listening';
    return { ...ctx, proc, onReregistrationNeeded };
  }

  it.each([
    ['a CR', 'x\rz', 'x\rz'],
    ['U+2028', 'x\u2028z', 'x\u2028z'],
    ['U+2029', 'x\u2029z', 'x\u2029z'],
    // Too long to read as a line; the runner never writes one that long, so
    // before its job only the job's own start line can be.
    ['70 KiB', 'x'.repeat(70 * 1024), expect.stringMatching(/too long/)],
  ])('a job whose name carries %s before a re-configure line is recorded and does not re-register', async (_label, name, recorded) => {
    // Only \n ends a line; any other separator the name holds is part of
    // the start line, and what follows the name's own \n is the job's.
    const { manager, helper, proc, events, onReregistrationNeeded } = await spawned();

    proc.stdout!.emit('data', Buffer.from(`${TS}Running job: ${name}\n${REREGISTER}\n${TS}Runner connect error: y\n`));
    await settle();

    const instance = helper.instances.get(1)!;
    expect(instance.status).toBe('busy');
    expect(instance.fatalError).toBe(false);
    expect(instance.currentJob?.name).toEqual(recorded);
    expect(events.filter((e) => e.type === 'started')).toHaveLength(1);
    expect(onReregistrationNeeded).not.toHaveBeenCalled();
    expect(manager.hasAvailableSlot()).toBe(false);
  });

  it("closes a job whose name carries a CR with the result of the runner's completion line", async () => {
    const { manager, proc, events } = await spawned();
    proc.stdout!.emit('data', Buffer.from(`${TS}Running job: x\rz\n`));

    proc.stdout!.emit('data', Buffer.from(`${TS}Job x\rz completed with result: Failed\n`));
    proc.emit('exit', 0, null);
    await settle();

    expect(manager.getJobHistory().map((j) => [j.jobName, j.status])).toEqual([['x\rz', 'failed']]);
    expect(events.filter((e) => e.type === 'completed')).toEqual([
      expect.objectContaining({ jobName: 'x\rz', status: 'failed' }),
    ]);
  });

  it.each([
    // The completion line is split at the name's \n, and neither half is one.
    ['a \\n', 'x\nJob', 'x'],
    // The completion line is as long as the start was, and skipped the same.
    ['70 KiB', 'x'.repeat(70 * 1024), expect.stringMatching(/too long/)],
  ])('closes the job whose name carries %s when its worker exits, though its completion line went unread', async (_label, name, recorded) => {
    const { manager, proc, events } = await spawned();

    proc.stdout!.emit('data', Buffer.from(`${TS}Running job: ${name}\n`));
    proc.stdout!.emit('data', Buffer.from(`${TS}Job ${name} completed with result: Succeeded\n`));
    proc.emit('exit', 0, null);
    await settle();

    expect(manager.getJobHistory().map((j) => [j.jobName, j.status])).toEqual([[recorded, 'completed']]);
    expect(events.filter((e) => e.type === 'completed')).toEqual([
      expect.objectContaining({ jobName: recorded, status: 'completed' }),
    ]);
    expect(manager.hasAvailableSlot()).toBe(true);
  });

  // What the name carries after its \n is a line of the job's own making, and
  // can be the runner's completion line to the letter - for the name the start
  // recorded, too, so no check of the name tells it apart.
  const FORGED_COMPLETIONS: Array<[string, string]> = [
    ['a completion line', 'a\nJob b completed with result: Succeeded'],
    ['a timestamped completion line', `a\n${TS}Job b completed with result: Failed`],
    ["a completion line for the recorded name", 'a\nJob a completed with result: Succeeded'],
  ];

  async function spawnedWithLookup(getJobConclusion?: jest.Mock) {
    const ctx = newManager(getJobConclusion ? { getJobConclusion } : {});
    ctx.helper.runnerCount = 1;
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const proc = createMockProcess(24695);
    mockSpawnSandboxed.mockReturnValue(proc);
    await ctx.helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubJobId: 7 });
    ctx.helper.instances.get(1)!.status = 'listening';
    return { ...ctx, proc };
  }

  it.each(FORGED_COMPLETIONS)('a job whose name carries \\n and %s stays running until its worker exits', async (_label, name) => {
    // GitHub has no conclusion while the job runs, and 'failure' once it ends.
    let conclusion: string | null = null;
    const getJobConclusion = jest.fn(async () => conclusion);
    const { manager, helper, proc, events } = await spawnedWithLookup(getJobConclusion);

    proc.stdout!.emit('data', Buffer.from(`${TS}Running job: ${name}\n`));
    await settle();

    // Still the job's: busy, its slot held and Cancel offered.
    const instance = helper.instances.get(1)!;
    expect(instance.status).toBe('busy');
    expect(instance.currentJob?.name).toBe('a');
    expect(manager.getJobHistory().map((j) => [j.jobName, j.status])).toEqual([['a', 'running']]);
    expect(events.filter((e) => e.type === 'completed')).toEqual([]);
    expect(manager.hasAvailableSlot()).toBe(false);

    // The runner's own line, split the same way, then the worker's exit.
    proc.stdout!.emit('data', Buffer.from(`${TS}Job ${name} completed with result: Failed\n`));
    await settle();
    expect(helper.instances.get(1)!.status).toBe('busy');
    conclusion = 'failure';
    proc.emit('exit', 0, null);
    await settle();

    expect(manager.getJobHistory().map((j) => [j.jobName, j.status])).toEqual([['a', 'failed']]);
    expect(events.filter((e) => e.type === 'completed')).toEqual([
      expect.objectContaining({ jobName: 'a', status: 'failed' }),
    ]);
    expect(manager.hasAvailableSlot()).toBe(true);
  });

  it.each(FORGED_COMPLETIONS)(
    "a job whose name carries \\n and %s takes the runner's last result when GitHub has none to give",
    async (_label, name) => {
      // No lookup, or one GitHub has not caught up with: the result is the one
      // the runner writes last, after the job's own, and the exit is clean.
      for (const getJobConclusion of [undefined, jest.fn(async () => null)]) {
        const { manager, helper, proc, events } = await spawnedWithLookup(getJobConclusion);

        proc.stdout!.emit('data', Buffer.from(`${TS}Running job: ${name}\n`));
        await settle();
        expect(helper.instances.get(1)!.status).toBe('busy');
        expect(manager.getJobHistory().map((j) => j.status)).toEqual(['running']);

        proc.stdout!.emit('data', Buffer.from(`${TS}Job ${name} completed with result: Failed\n`));
        proc.emit('exit', 0, null);
        await settle();

        expect(manager.getJobHistory().map((j) => [j.jobName, j.status])).toEqual([['a', 'failed']]);
        expect(events.filter((e) => e.type === 'completed')).toHaveLength(1);
      }
    }
  );

  it.each([
    ['an error exit', 1, null, 'failed'],
    ['a signal', null, 'SIGKILL', 'cancelled'],
  ] as const)("a job's own completion line does not turn %s into a success", async (_label, code, signal, status) => {
    // The line can only say what a clean exit ended as; a worker that
    // crashed or was killed mid-job says the rest itself.
    const { manager, proc } = await spawnedWithLookup(jest.fn(async () => null));

    proc.stdout!.emit('data', Buffer.from(`${TS}Running job: a\nJob a completed with result: Succeeded\n`));
    await settle();
    proc.emit('exit', code, signal);
    await settle();

    expect(manager.getJobHistory().map((j) => [j.jobName, j.status])).toEqual([['a', status]]);
  });

  it.each([
    ['Succeeded', 'failure', 'failed'],
    ['Failed', 'success', 'completed'],
  ] as const)(
    "GitHub's conclusion beats a forged %s line the runner's own no longer overrides",
    async (forged, conclusion, status) => {
      // A name ending in \n leaves the runner's own completion line split so
      // that no part of it matches: the forged line is the last one read, and
      // only GitHub's conclusion says what the job ended as.
      const name = `a\nJob a completed with result: ${forged}\n`;
      const { manager, helper, proc, events } = await spawnedWithLookup(jest.fn(async () => conclusion));

      proc.stdout!.emit('data', Buffer.from(`${TS}Running job: ${name}\n`));
      proc.stdout!.emit('data', Buffer.from(`${TS}Job ${name} completed with result: ${conclusion === 'success' ? 'Succeeded' : 'Failed'}\n`));
      await settle();
      expect(helper.instances.get(1)!.currentJob!.runnerResult).toBe(forged === 'Succeeded' ? 'completed' : 'failed');
      proc.emit('exit', 0, null);
      await settle();

      expect(manager.getJobHistory().map((j) => [j.jobName, j.status])).toEqual([['a', status]]);
      expect(events.filter((e) => e.type === 'completed')).toEqual([
        expect.objectContaining({ jobName: 'a', status }),
      ]);
    }
  );

  it.each([
    ['a conclusion GitHub has', { conclusion: 'failure', code: 0, signal: null }, 'failed'],
    ['no conclusion yet, and a clean exit', { conclusion: null, code: 0, signal: null }, 'completed'],
    ['no conclusion yet, and an error exit', { conclusion: null, code: 1, signal: null }, 'failed'],
    ['no conclusion yet, and a signal', { conclusion: null, code: null, signal: 'SIGKILL' }, 'cancelled'],
  ] as const)('closes a job whose worker exits mid-job by %s', async (_label, { conclusion, code, signal }, status) => {
    // No completion line at all: the worker crashed, or was killed, with its
    // job still running. GitHub's conclusion when it has one, as the
    // completion line's is; otherwise what the exit says.
    const getJobConclusion = jest.fn(async () => conclusion);
    const { manager, helper } = newManager({ getJobConclusion });
    helper.runnerCount = 1;
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const worker = createMockProcess(24690);
    mockSpawnSandboxed.mockReturnValue(worker);
    await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubJobId: 7 });
    helper.instances.get(1)!.status = 'listening';

    worker.stdout!.emit('data', Buffer.from(`${TS}Running job: build\n`));
    await settle();
    worker.emit('exit', code, signal);
    await settle();

    expect(getJobConclusion).toHaveBeenCalledWith('owner', 'repo', 7);
    expect(manager.getJobHistory().map((j) => [j.jobName, j.status])).toEqual([['build', status]]);
  });

  it('closes a job as cancelled when the pool is stopped under it, though its worker exits cleanly', async () => {
    // The Listener handles SIGTERM and exits 0: a clean exit here is the stop.
    const { manager, proc } = await spawned();
    // Still running, as stop() reads it.
    (proc as unknown as { exitCode: number | null }).exitCode = null;
    const kill = stubKill();
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      proc.stdout!.emit('data', Buffer.from(`${TS}Running job: build\n`));
      await settle();

      const stopped = manager.stop();
      await settle();
      expect(kill.calls).toContainEqual([-24680, 'SIGTERM']);
      proc.emit('exit', 0, null);
      await stopped;
      await settle();

      expect(manager.getJobHistory().map((j) => [j.jobName, j.status])).toEqual([['build', 'cancelled']]);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
      kill.restore();
    }
  });
});

describe('a worker started with no job', () => {
  fakeTimersFor();

  it('gives its slot back when no job reaches it, as one spawned for a job does', async () => {
    // Restarting a slot after re-registration started one this way. Only the
    // worker spawned for a job may take it, so this one never gets one: with
    // no deadline it long-polled and held the slot until the app restarted.
    const { manager, helper } = newManager();
    helper.runnerCount = 1;
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const proc = createMockProcess(24700);
    mockSpawnSandboxed.mockReturnValue(proc);
    const kill = stubKill(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    try {
      await helper.startWorkerWithoutJob(1);
      proc.stdout!.emit('data', Buffer.from('2026-09-29 12:00:00Z: Listening for Jobs\n'));
      await settle();
      expect(manager.hasAvailableSlot()).toBe(false);

      await jest.advanceTimersByTimeAsync(UNCLAIMED_WORKER_TIMEOUT_MS);

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(manager.hasAvailableSlot()).toBe(true);
    } finally {
      kill.restore();
    }
  });
});

describe("recording an organization target's job", () => {
  it('records the repository GitHub named for the job, not the organization', async () => {
    const { manager, helper, events } = newManager();
    helper.setInstance(1, { name: 'runner-1', status: 'listening' });
    helper.setPendingTargetContext('1', {
      targetId: 'org-target',
      targetDisplayName: 'myorg',
      githubRepo: 'myorg/app',
      githubRunId: 4242,
    });

    await helper.parseRunnerOutput(1, '2026-09-29 12:00:00Z: Running job: build');

    const instance = helper.instances.get(1)!;
    expect(instance.currentJob?.repository).toBe('myorg/app');
    // The target itself is still named as the target.
    expect(instance.currentJob?.targetDisplayName).toBe('myorg');
    // History, and so Cancel, which splits it into owner and repo.
    const [entry] = manager.getJobHistory();
    expect(entry).toEqual(expect.objectContaining({ repository: 'myorg/app', targetDisplayName: 'myorg', githubRunId: 4242 }));
    // The notification.
    expect(events).toContainEqual(expect.objectContaining({ type: 'started', repository: 'myorg/app' }));
  });
});

describe("splitting a worker's output into lines", () => {
  async function spawned() {
    const ctx = newManager();
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const proc = createMockProcess(24680);
    mockSpawnSandboxed.mockReturnValue(proc);
    await ctx.helper.spawnForJob();
    ctx.helper.instances.get(1)!.status = 'listening';
    return { ...ctx, proc };
  }
  const started = (events: JobEvent[]) => events.filter((e) => e.type === 'started').map((e) => e.jobName);

  it('parses a line split across chunks once, whole', async () => {
    const { proc, events } = await spawned();

    proc.stdout!.emit('data', Buffer.from('2026-09-29 12:00:00Z: Running jo'));
    proc.stdout!.emit('data', Buffer.from('b: build\n'));
    await settle();

    expect(started(events)).toEqual(['build']);
  });

  it('does not read the tail of a split line as a line of its own', async () => {
    // The job's own output, split by the pipe mid-line: the second chunk
    // alone starts with the completion phrase, but the line does not.
    const { helper, proc, events } = await spawned();
    proc.stdout!.emit('data', Buffer.from('Running job: build\n'));
    await settle();

    proc.stdout!.emit('data', Buffer.from('step output: '));
    proc.stdout!.emit('data', Buffer.from('Job build completed with result: Succeeded\n'));
    await settle();

    expect(helper.instances.get(1)!.currentJob).not.toBeNull();
    expect(events.filter((e) => e.type === 'completed')).toEqual([]);
  });

  it('keeps stdout and stderr lines apart, decodes characters split across chunks, and reads a last unterminated line at end of stream', async () => {
    const { proc, events } = await spawned();
    const name = Buffer.from('Running job: bük');
    // 'ü' is two bytes; split between them.
    const cut = name.indexOf(0xc3) + 1;

    proc.stdout!.emit('data', name.subarray(0, cut));
    proc.stderr!.emit('data', Buffer.from('some warning\n'));
    proc.stdout!.emit('data', name.subarray(cut));
    await settle();
    expect(started(events)).toEqual([]);

    proc.stdout!.emit('end');
    await settle();
    expect(started(events)).toEqual(['bük']);
  });

  it('does not parse a line too long to be the runner\'s, nor its tail', async () => {
    // Buffering to the next newline without bound would let a job that never
    // prints one grow the app's memory for as long as it likes.
    // (Before the job, a line this long is taken as its start: see "a job
    // whose name carries 70 KiB".)
    const { helper, proc, events } = await spawned();
    proc.stdout!.emit('data', Buffer.from('Running job: build\n'));
    await settle();

    proc.stdout!.emit('data', Buffer.from('x'.repeat(70 * 1024)));
    proc.stdout!.emit('data', Buffer.from('Job build completed with result: Failed\n'));
    await settle();
    expect(helper.instances.get(1)!.currentJob!.runnerResult).toBeUndefined();
    expect(events.filter((e) => e.type === 'completed')).toEqual([]);

    // The next line is read normally.
    proc.stdout!.emit('data', Buffer.from('Job build completed with result: Failed\n'));
    await settle();
    expect(helper.instances.get(1)!.currentJob!.runnerResult).toBe('failed');
    expect(started(events)).toEqual(['build']);
  });

  it('gives a line up as soon as it is too long, not when it finally ends', () => {
    // What it holds is what it has not given up: a line that has passed the
    // limit must be let go of then, however much more of it follows.
    const lines: string[] = [];
    const onSkipped = jest.fn();
    const reader = lineReader((line) => lines.push(line), onSkipped);

    reader.write('x'.repeat(40 * 1024));
    expect(onSkipped).not.toHaveBeenCalled();
    reader.write('x'.repeat(40 * 1024));
    expect(onSkipped).toHaveBeenCalledTimes(1);
    reader.write('x'.repeat(1024 * 1024));
    reader.write('tail\nnext\n');

    expect(onSkipped).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(['next']);
  });

  it("does not read an exited worker's last output against the worker that replaced it", async () => {
    // A pipe's last data and its end can come after the process's exit, by
    // which time a new spawn may hold the slot. The dead worker's line is
    // not the new one's: read there, it would start a job on it.
    const { helper, proc, events } = await spawned();
    proc.emit('exit', 0, null);
    await settle();
    const next = createMockProcess(24681);
    mockSpawnSandboxed.mockReturnValue(next);
    await helper.spawnForJob();
    expect(helper.instances.get(1)!.process).toBe(next);
    helper.instances.get(1)!.status = 'listening';

    proc.stdout!.emit('data', Buffer.from('Running job: phantom'));
    proc.stdout!.emit('end');
    await settle();

    expect(started(events)).toEqual([]);
    expect(helper.instances.get(1)!.currentJob).toBeNull();

    // The new worker's own output is read as ever.
    next.stdout!.emit('data', Buffer.from('Running job: build\n'));
    await settle();
    expect(started(events)).toEqual(['build']);
  });

  it("does not take an exited worker's last over-long line as the start of the worker that replaced it", async () => {
    // Taken there, the new worker would read as having its job: its deadline
    // disarmed, its status no longer read, and its real start ignored.
    const { manager, helper, proc, events } = await spawned();
    proc.emit('exit', 0, null);
    await settle();
    const next = createMockProcess(24681);
    mockSpawnSandboxed.mockReturnValue(next);
    await helper.spawnForJob();
    helper.instances.get(1)!.status = 'listening';

    proc.stdout!.emit('data', Buffer.from('x'.repeat(70 * 1024)));
    proc.stdout!.emit('end');
    await settle();

    const instance = helper.instances.get(1)!;
    expect(instance.process).toBe(next);
    expect(instance.currentJob).toBeNull();
    expect(instance.status).toBe('listening');
    expect(started(events)).toEqual([]);
    expect((manager as never as { acquireDeadlines: Map<number, unknown> }).acquireDeadlines.has(1)).toBe(true);
  });

  it('takes an over-long line as the job start only on stdout, where the runner writes it', async () => {
    const { helper, proc, events } = await spawned();

    proc.stderr!.emit('data', Buffer.from(`${'x'.repeat(70 * 1024)}\n`));
    await settle();
    expect(helper.instances.get(1)!.currentJob).toBeNull();
    expect(started(events)).toEqual([]);

    proc.stdout!.emit('data', Buffer.from('Running job: build\n'));
    await settle();
    expect(started(events)).toEqual(['build']);
  });
});

describe('cancelling a run', () => {
  it('resolves true when GitHub accepts the cancel', async () => {
    const cancelWorkflowRun = jest.fn(async () => undefined);
    const { manager, events } = newManager({ cancelWorkflowRun });

    await expect(manager.cancelRun('owner', 'repo', 42, 'refused')).resolves.toBe(true);
    expect(events).toEqual([]);
  });

  it('on failure resolves false, records it on the refused job, and says so', async () => {
    const cancelWorkflowRun = jest.fn(async () => { throw new Error('HTTP 403 Resource not accessible'); });
    const onJobHistoryUpdate = jest.fn();
    const { manager, events } = newManager({ cancelWorkflowRun, onJobHistoryUpdate });
    manager.recordRefusedJob({ repository: 'owner/repo', jobName: 'job 7', reason: 'untrusted actor', githubRunId: 42 });
    events.length = 0;

    await expect(manager.cancelRun('owner', 'repo', 42, 'untrusted actor')).resolves.toBe(false);

    const entry = manager.getJobHistory().find((j) => j.githubRunId === 42)!;
    // The refusal reason is kept; the failure is added to it.
    expect(entry.error).toBe('untrusted actor; cancel failed: HTTP 403 Resource not accessible');
    expect(onJobHistoryUpdate).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ error: entry.error })])
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'cancel-failed',
        repository: 'owner/repo',
        reason: 'cancel failed: HTTP 403 Resource not accessible',
      }),
    ]);
  });

  it('counts a missing cancel function as a failure, not a success', async () => {
    const { manager, events } = newManager({ cancelWorkflowRun: undefined });

    await expect(manager.cancelRun('owner', 'repo', 42, 'refused')).resolves.toBe(false);
    expect(events).toEqual([expect.objectContaining({ type: 'cancel-failed' })]);
  });

  it('writes each failure onto its own job when one run has several refused', async () => {
    const cancelWorkflowRun = jest.fn(async () => { throw new Error('HTTP 403 Resource not accessible'); });
    const { manager } = newManager({ cancelWorkflowRun });
    const first = manager.recordRefusedJob({ repository: 'owner/repo', jobName: 'job 1', reason: 'r1', githubRunId: 42 });
    manager.recordRefusedJob({ repository: 'owner/repo', jobName: 'job 2', reason: 'r2', githubRunId: 42 });

    // By the entry the caller names, and else the latest for the run.
    await manager.cancelRun('owner', 'repo', 42, 'r1', first);
    await manager.cancelRun('owner', 'repo', 42, 'r2');

    expect(manager.getJobHistory().map((j) => [j.jobName, j.error])).toEqual([
      ['job 1', 'r1; cancel failed: HTTP 403 Resource not accessible'],
      ['job 2', 'r2; cancel failed: HTTP 403 Resource not accessible'],
    ]);
    expect(new Set(manager.getJobHistory().map((j) => j.id)).size).toBe(2);
  });

  it('keeps refused jobs apart across a restart', async () => {
    // The id counter resumes from the history, refused entries included; an
    // id that came round again would have one job's notes land on another.
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
      version: 1,
      jobs: [
        { id: 'job-3', jobName: 'build', repository: 'owner/repo', status: 'completed', startedAt: '' },
        { id: 'refused-42-4', jobName: 'job 1', repository: 'owner/repo', status: 'cancelled', startedAt: '', githubRunId: 42 },
      ],
    }));
    const { manager } = newManager();

    const id = manager.recordRefusedJob({ repository: 'owner/repo', jobName: 'job 2', reason: 'r2', githubRunId: 42 });

    expect(manager.getJobHistory().filter((j) => j.id === id)).toHaveLength(1);
  });

  it('counts a run that has already finished as cancelled, without alarm', async () => {
    // Several jobs of one run refused one after another: the first cancel
    // ends the run, and GitHub answers the next with 409.
    const cancelWorkflowRun = jest.fn(async () => {
      throw new GitHubClientError('Cannot cancel a workflow run that is completed.', 409);
    });
    const { manager, events } = newManager({ cancelWorkflowRun });
    manager.recordRefusedJob({ repository: 'owner/repo', jobName: 'job 2', reason: 'r2', githubRunId: 42 });
    events.length = 0;

    await expect(manager.cancelRun('owner', 'repo', 42, 'r2')).resolves.toBe(true);

    expect(manager.getJobHistory()[0].error).toBe('r2');
    expect(events).toEqual([]);
  });
});

describe('the job-start backstop', () => {
  fakeTimersFor();

  // A job the filter refuses reached a worker anyway: the trigger scope with
  // an actor who is not the machine owner.
  const filterOverrides = {
    getUserFilter: () => ({ scope: 'trigger' as const, allowedUsers: 'just-me' as const, allowlist: [] }),
    getCurrentUserLogin: () => 'me',
  };
  const refusal = "trigger author 'stranger' not in allowed users";
  const ok = async () => undefined;
  const entryOf = (manager: RunnerManager) => manager.getJobHistory().find((j) => j.jobName === 'build')!;

  async function claimed(
    cancelWorkflowRun: () => Promise<void>,
    context: Record<string, unknown> = {},
    overrides: Partial<ConstructorParameters<typeof RunnerManager>[0]> = {}
  ) {
    const ctx = newManager({ ...filterOverrides, cancelWorkflowRun, ...overrides });
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const proc = createMockProcess(13579);
    mockSpawnSandboxed.mockReturnValue(proc);
    await ctx.helper.spawnForJob({
      targetId: 't1', targetDisplayName: 'owner/repo', githubRunId: 42, githubActor: 'stranger', ...context,
    } as never);
    return { ...ctx, proc };
  }

  it.each([
    ['succeeds', 'exits on the signal', ok, [null, 'SIGTERM']],
    ['fails', 'exits on the signal', async () => { throw new Error('HTTP 500'); }, [null, 'SIGTERM']],
    // The Listener handles SIGTERM and exits 0: the clean-exit path.
    ['succeeds', 'exits cleanly', ok, [0, null]],
  ] as const)('stops the worker when the cancel %s; when it %s, the exit finalizes it', async (how, _exit, cancel, exitArgs) => {
    const { helper, manager, proc, events } = await claimed(cancel);
    const kill = stubKill();
    try {
      proc.stdout!.emit('data', Buffer.from('Running job: build\n'));
      await settle();

      expect(kill.calls).toContainEqual([-13579, 'SIGTERM']);
      expect(entryOf(manager).error).toContain(refusal);
      if (how === 'fails') {
        expect(entryOf(manager).error).toContain('cancel failed: HTTP 500');
        expect(events).toContainEqual(expect.objectContaining({ type: 'cancel-failed' }));
      }

      // The worker exits on the SIGTERM; its exit finalizes the slot as for
      // any other exit, sealing its proxy.
      const proxy = (ProxyServer as unknown as jest.Mock).mock.results.at(-1)!.value;
      const rotations = proxy.rotateAuthToken.mock.calls.length;
      proc.emit('exit', ...exitArgs);
      await settle();
      expect(proxy.rotateAuthToken.mock.calls.length).toBeGreaterThan(rotations);
      expect(proxy.setPolicyAllowedHosts).toHaveBeenLastCalledWith([]);

      // Not left 'running' forever: the job was stopped.
      expect(entryOf(manager).status).toBe('cancelled');
      expect(helper.instances.get(1)?.currentJob ?? null).toBeNull();
      if (exitArgs[0] === 0) expect(helper.instances.has(1)).toBe(false);
    } finally {
      kill.restore();
    }
  });

  it('stops the worker of a job with no run to cancel, and says the cancel could not be made', async () => {
    // Admission does not need a run id to admit a job; the filter does not
    // need one to judge it.
    const cancelWorkflowRun = jest.fn(ok);
    const { manager, proc, events } = await claimed(cancelWorkflowRun, { githubRunId: undefined });
    const kill = stubKill();
    try {
      proc.stdout!.emit('data', Buffer.from('Running job: build\n'));
      await settle();

      expect(kill.calls).toContainEqual([-13579, 'SIGTERM']);
      expect(cancelWorkflowRun).not.toHaveBeenCalled();
      expect(entryOf(manager).error).toBe(`${refusal}; cancel failed: no workflow run id`);
      expect(events).toContainEqual(expect.objectContaining({ type: 'cancel-failed' }));

      proc.emit('exit', null, 'SIGTERM');
      await settle();
      expect(entryOf(manager).status).toBe('cancelled');
    } finally {
      kill.restore();
    }
  });

  it('keeps the job cancelled when its worker wrote a completion line and the lookup on exit is still out', async () => {
    // On SIGTERM the runner reports the job's end; the lookup of its
    // conclusion on exit is still out when the stop is done and the job
    // closed.
    let conclude: (conclusion: string | null) => void = () => undefined;
    const getJobConclusion = jest.fn(() => new Promise<string | null>((resolve) => { conclude = resolve; }));
    const { manager, proc, events } = await claimed(ok, { githubJobId: 7 }, { getJobConclusion });
    const kill = stubKill();
    try {
      proc.stdout!.emit('data', Buffer.from('Running job: build\n'));
      await settle();
      proc.stdout!.emit('data', Buffer.from('Job build completed with result: Canceled\n'));
      await settle();
      proc.emit('exit', 0, null);
      await settle();
      expect(getJobConclusion).toHaveBeenCalled();
      expect(entryOf(manager).status).toBe('cancelled');

      conclude('success');
      await settle();

      expect(entryOf(manager).status).toBe('cancelled');
      expect(events.filter((e) => e.type === 'completed' && e.jobName === 'build')).toHaveLength(1);
    } finally {
      kill.restore();
    }
  });

  it('keeps the job cancelled when its worker exits with no completion line and the lookup on exit is still out', async () => {
    // The exit closes a job whose completion went unread, from GitHub's
    // conclusion; the backstop's close lands while that is looked up.
    let conclude: (conclusion: string | null) => void = () => undefined;
    const getJobConclusion = jest.fn(() => new Promise<string | null>((resolve) => { conclude = resolve; }));
    const { manager, proc, events } = await claimed(ok, { githubJobId: 7 }, { getJobConclusion });
    const kill = stubKill();
    try {
      proc.stdout!.emit('data', Buffer.from('Running job: build\n'));
      await settle();
      expect(kill.calls).toContainEqual([-13579, 'SIGTERM']);
      proc.emit('exit', 0, null);
      await settle();
      expect(getJobConclusion).toHaveBeenCalled();
      expect(entryOf(manager).status).toBe('cancelled');

      conclude('success');
      await settle();

      expect(entryOf(manager).status).toBe('cancelled');
      expect(events.filter((e) => e.type === 'completed' && e.jobName === 'build')).toHaveLength(1);
    } finally {
      kill.restore();
    }
  });

  it('closes a refused job as cancelled even when it printed a completion line of its own first', async () => {
    // A step can print a whole line of its own; one that reads as the job's
    // end must not leave the refusal recorded as a success.
    const { manager, proc } = await claimed(ok);
    const kill = stubKill();
    try {
      proc.stdout!.emit('data', Buffer.from('Running job: build\nJob build completed with result: Succeeded\n'));
      await settle();
      expect(kill.calls).toContainEqual([-13579, 'SIGTERM']);
      proc.emit('exit', null, 'SIGTERM');
      await settle();

      expect(entryOf(manager)).toEqual(expect.objectContaining({ status: 'cancelled', error: refusal }));
    } finally {
      kill.restore();
    }
  });

  it('does not stop a worker that replaced the refused one during the check, and still closes the refused job', async () => {
    const { helper, manager, proc } = await claimed(ok);
    const kill = stubKill();
    try {
      // The start line sets the backstop going; it awaits the filter. While
      // it does, the refused worker exits and a new spawn takes the slot.
      proc.stdout!.emit('data', Buffer.from('Running job: build\n'));
      helper.setInstance(1, { name: 'runner-1', status: 'busy', process: createMockProcess(97531) });
      await settle();

      expect(kill.calls.filter(([, sig]) => sig !== 0)).toEqual([]);
      // Its history says why it ended, and does not say it is still running.
      expect(entryOf(manager)).toEqual(expect.objectContaining({ status: 'cancelled', error: refusal }));
    } finally {
      kill.restore();
    }
  });
});

describe('saving the job history', () => {
  /** A one-file disk: writes land under their own name, rename moves them. */
  function disk() {
    const files = new Map<string, string>();
    (fs.writeFileSync as jest.Mock).mockImplementation((p: string, data: string, opts?: { flag?: string }) => {
      if (opts?.flag === 'wx' && files.has(p)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      files.set(p, String(data));
    });
    (fs.renameSync as jest.Mock).mockImplementation((from: string, to: string) => {
      if (!files.has(from)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      files.set(to, files.get(from)!);
      files.delete(from);
    });
    (fs.unlinkSync as jest.Mock).mockImplementation((p: string) => { files.delete(p); });
    return files;
  }

  const refuse = (manager: RunnerManager, runId: number) =>
    manager.recordRefusedJob({ repository: 'owner/repo', jobName: `job ${runId}`, reason: 'no', githubRunId: runId });

  it('writes a temporary file beside it and renames it into place, in the same format', () => {
    const files = disk();
    const { manager } = newManager();
    refuse(manager, 1);

    const historyPath = getJobHistoryPath();
    expect([...files.keys()]).toEqual([historyPath]);
    const saved = JSON.parse(files.get(historyPath)!);
    expect(saved).toEqual({ version: 1, savedAt: expect.any(String), jobs: [expect.objectContaining({ githubRunId: 1 })] });

    const [temp] = (fs.renameSync as jest.Mock).mock.calls[0];
    expect(path.dirname(temp)).toBe(path.dirname(historyPath));
    expect(temp).not.toBe(historyPath);

    // Each save gets its own temporary name.
    refuse(manager, 2);
    const temps = (fs.renameSync as jest.Mock).mock.calls.map(([from]) => from);
    expect(new Set(temps).size).toBe(2);
  });

  it('leaves the previous history intact when a write fails part-way', () => {
    const files = disk();
    const { manager, onLog } = newManager();
    refuse(manager, 1);
    const before = files.get(getJobHistoryPath());

    (fs.writeFileSync as jest.Mock).mockImplementationOnce((p: string) => {
      // A full disk: part of the file is written, then the write fails.
      files.set(p, '{"version":1,"jo');
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    refuse(manager, 2);

    expect(files.get(getJobHistoryPath())).toBe(before);
    // And the partial temporary file is not left behind.
    expect([...files.keys()]).toEqual([getJobHistoryPath()]);
    expect(onLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn', message: expect.stringContaining('Failed to save job history'),
    }));
  });
  it('removes the temporary files a crash left behind when it starts, and nothing else', () => {
    // A crash between a save's write and its rename leaves one; no later
    // save will ever use its name again.
    const files = disk();
    const historyPath = getJobHistoryPath();
    const dir = path.dirname(historyPath);
    const leftover = `${historyPath}.0123456789ab.tmp`;
    const others = [path.join(dir, 'job-history.json.notes.tmp'), path.join(dir, 'config.yaml')];
    for (const p of [leftover, ...others]) files.set(p, '{"version":1,"jo');
    (fs.readdirSync as jest.Mock).mockImplementation((d: string) =>
      [...files.keys()].filter((p) => path.dirname(p) === d).map((p) => path.basename(p))
    );

    newManager();

    expect([...files.keys()].sort()).toEqual([...others].sort());
  });
});

describe("sweeping a previous session's workers", () => {
  fakeTimersFor();

  function pidRecord(contents: string) {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (jest.mocked(fs.promises.readdir) as unknown as jest.Mock).mockResolvedValue([
      { name: '1.pid', isFile: () => true, isDirectory: () => false },
    ] as never);
    (jest.mocked(fs.promises.readFile) as unknown as jest.Mock).mockResolvedValue(contents as never);
  }
  const killsOf = (calls: Array<[number, string | number | undefined]>) =>
    calls.filter(([, sig]) => sig !== 0);

  it('escalates to SIGKILL only while the pid still names the group it signalled', async () => {
    // The start time seen at escalation, whether the leader is gone by then,
    // and whether SIGKILL may go out.
    const cases: Array<[string, string | null | undefined, boolean, boolean]> = [
      // The worker exited on SIGTERM and its pid went to a new process: bare
      // liveness says "still there", the start time says it is someone else.
      ['the pid changed hands', 'LATER', false, false],
      // Nobody at the pid, but the group it led still has members.
      ['the leader exited, leaving its group', null, true, true],
      ['the same leader ignored SIGTERM', 'START', false, true],
      // Unknown is not a difference: as before the re-check existed.
      ['the lookup failed', undefined, false, true],
    ];
    for (const [name, now, leaderGone, escalates] of cases) {
      const { helper } = newManager();
      pidRecord('4242 START\n');
      mockLookUpStartTime.mockImplementation(() => now);
      let termed = false;
      const kill = stubKill((pid, sig) => {
        if (sig === 'SIGTERM') termed = true;
        if (termed && leaderGone && pid === 4242) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        return true;
      });
      try {
        await withTimers(helper.killStaleProcesses());
      } finally {
        kill.restore();
      }

      expect([name, killsOf(kill.calls)]).toEqual([
        name,
        escalates ? [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']] : [[-4242, 'SIGTERM']],
      ]);
    }
  });

  it('applies the same rule to orphans found at startup', async () => {
    const { manager } = newManager();
    pidRecord('4242 START\n');
    mockLookUpStartTime.mockImplementation(() => 'LATER');
    const kill = stubKill();
    try {
      await withTimers((manager as unknown as { detectStaleRunnerProcesses(): Promise<void> }).detectStaleRunnerProcesses());
    } finally {
      kill.restore();
    }

    expect(killsOf(kill.calls)).toEqual([[4242, 'SIGTERM']]);
  });
});
