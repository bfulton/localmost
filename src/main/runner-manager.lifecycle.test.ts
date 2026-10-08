/**
 * Runner lifecycle: reading the runner's output, cancelling a run, and
 * keeping the job history.
 *
 * Kept apart from runner-manager.test.ts so the mocks here can model a
 * little more of fs (an in-memory history file, rename) without touching the
 * shared setup.
 */


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
    setBrokerPort: jest.fn(),
    setPolicyLevel: jest.fn(),
    getPolicyLevel: jest.fn(() => 'strict'),
    getStats: jest.fn(() => ({ allowedCount: 0, blockedCount: 0, blockedHosts: new Set() })),
    rotateAuthToken: jest.fn(),
    resetStats: jest.fn(),
  })),
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
import { RunnerManager, JobEvent, UNCLAIMED_WORKER_TIMEOUT_MS } from './runner-manager';
import { ProxyServer } from './proxy-server';
import { getJobHistoryPath } from './paths';
import { GitHubClientError } from './github-client';
import { createMockWorker, fakeIsolation, type FakeIsolation, type MockWorker, RunnerManagerTestHelper } from './test-utils';

/** The macOS VM backend every manager here runs its workers on; a new one for each test. */
let isolation: FakeIsolation;
beforeEach(() => {
  isolation = fakeIsolation();
});


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

/**
 * What a worker hands over for `text`: one event per line, as the guest
 * agent splits the runner's output on \n.
 */
function out(worker: MockWorker, text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
  for (const line of text.split('\n')) if (line) worker.emit(stream, line);
}

function newManager(overrides: Partial<ConstructorParameters<typeof RunnerManager>[0]> = {}) {
  const events: JobEvent[] = [];
  const onLog = jest.fn();
  const manager = new RunnerManager({
    isolation,
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
    const proc = createMockWorker(24680);
    isolation.spawnWorker.mockResolvedValue(proc);
    await ctx.helper.spawnForJob();
    ctx.helper.instances.get(1)!.status = 'listening';
    return { ...ctx, proc, onReregistrationNeeded };
  }

  it.each([
    ['a CR', 'x\rz', 'x\rz'],
    ['U+2028', 'x\u2028z', 'x\u2028z'],
    ['U+2029', 'x\u2029z', 'x\u2029z'],
  ])('a job whose name carries %s before a re-configure line is recorded and does not re-register', async (_label, name, recorded) => {
    // Only \n ends a line; any other separator the name holds is part of
    // the start line, and what follows the name's own \n is the job's.
    const { manager, helper, proc, events, onReregistrationNeeded } = await spawned();

    out(proc, `${TS}Running job: ${name}\n${REREGISTER}\n${TS}Runner connect error: y\n`);
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
    out(proc, `${TS}Running job: x\rz\n`);

    out(proc, `${TS}Job x\rz completed with result: Failed\n`);
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
  ])('closes the job whose name carries %s when its worker exits, though its completion line went unread', async (_label, name, recorded) => {
    const { manager, proc, events } = await spawned();

    out(proc, `${TS}Running job: ${name}\n`);
    out(proc, `${TS}Job ${name} completed with result: Succeeded\n`);
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
    const proc = createMockWorker(24695);
    isolation.spawnWorker.mockResolvedValue(proc);
    await ctx.helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubJobId: 7 });
    ctx.helper.instances.get(1)!.status = 'listening';
    return { ...ctx, proc };
  }

  it.each(FORGED_COMPLETIONS)('a job whose name carries \\n and %s stays running until its worker exits', async (_label, name) => {
    // GitHub has no conclusion while the job runs, and 'failure' once it ends.
    let conclusion: string | null = null;
    const getJobConclusion = jest.fn(async () => conclusion);
    const { manager, helper, proc, events } = await spawnedWithLookup(getJobConclusion);

    out(proc, `${TS}Running job: ${name}\n`);
    await settle();

    // Still the job's: busy, its slot held and Cancel offered.
    const instance = helper.instances.get(1)!;
    expect(instance.status).toBe('busy');
    expect(instance.currentJob?.name).toBe('a');
    expect(manager.getJobHistory().map((j) => [j.jobName, j.status])).toEqual([['a', 'running']]);
    expect(events.filter((e) => e.type === 'completed')).toEqual([]);
    expect(manager.hasAvailableSlot()).toBe(false);

    // The runner's own line, split the same way, then the worker's exit.
    out(proc, `${TS}Job ${name} completed with result: Failed\n`);
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

        out(proc, `${TS}Running job: ${name}\n`);
        await settle();
        expect(helper.instances.get(1)!.status).toBe('busy');
        expect(manager.getJobHistory().map((j) => j.status)).toEqual(['running']);

        out(proc, `${TS}Job ${name} completed with result: Failed\n`);
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

    out(proc, `${TS}Running job: a\nJob a completed with result: Succeeded\n`);
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

      out(proc, `${TS}Running job: ${name}\n`);
      out(proc, `${TS}Job ${name} completed with result: ${conclusion === 'success' ? 'Succeeded' : 'Failed'}\n`);
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
    const worker = createMockWorker(24690);
    isolation.spawnWorker.mockResolvedValue(worker);
    await helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubJobId: 7 });
    helper.instances.get(1)!.status = 'listening';

    out(worker, `${TS}Running job: build\n`);
    await settle();
    worker.emit('exit', code, signal);
    await settle();

    expect(getJobConclusion).toHaveBeenCalledWith('owner', 'repo', 7);
    expect(manager.getJobHistory().map((j) => [j.jobName, j.status])).toEqual([['build', status]]);
  });

  it('closes a job as cancelled when the pool is stopped under it, though its worker exits cleanly', async () => {
    // The Listener handles SIGTERM and exits 0: a clean exit here is the stop.
    const { manager, proc } = await spawned();
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      out(proc, `${TS}Running job: build\n`);
      await settle();

      const stopped = manager.stop();
      await settle();
      expect(isolation.signal).toHaveBeenCalledWith(expect.anything(), 'SIGTERM');
      proc.emit('exit', 0, null);
      await stopped;
      await settle();

      expect(manager.getJobHistory().map((j) => [j.jobName, j.status])).toEqual([['build', 'cancelled']]);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
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
    const proc = createMockWorker(24700);
    isolation.spawnWorker.mockResolvedValue(proc);
    await helper.startWorkerWithoutJob(1);
    out(proc, '2026-09-29 12:00:00Z: Listening for Jobs\n');
    await settle();
    expect(manager.hasAvailableSlot()).toBe(false);

    await jest.advanceTimersByTimeAsync(UNCLAIMED_WORKER_TIMEOUT_MS);

    // Its VM goes with the slot, the listener in it.
    expect(isolation.release).toHaveBeenCalled();
    expect(manager.hasAvailableSlot()).toBe(true);
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

describe("a worker's output after its exit", () => {
  async function spawned() {
    const ctx = newManager();
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const proc = createMockWorker(24680);
    isolation.spawnWorker.mockResolvedValue(proc);
    await ctx.helper.spawnForJob();
    ctx.helper.instances.get(1)!.status = 'listening';
    return { ...ctx, proc };
  }
  const started = (events: JobEvent[]) => events.filter((e) => e.type === 'started').map((e) => e.jobName);

  it("is not read against the worker that replaced it", async () => {
    // A worker's last lines can come after its exit, by which time a new
    // spawn may hold the slot. The dead worker's line is not the new one's:
    // read there, it would start a job on it.
    const { helper, proc, events } = await spawned();
    proc.emit('exit', 0, null);
    await settle();
    const next = createMockWorker(24681);
    isolation.spawnWorker.mockResolvedValue(next);
    await helper.spawnForJob();
    expect(helper.instances.get(1)!.worker).toBe(next);
    helper.instances.get(1)!.status = 'listening';

    out(proc, 'Running job: phantom');
    await settle();

    expect(started(events)).toEqual([]);
    expect(helper.instances.get(1)!.currentJob).toBeNull();

    // The new worker's own output is read as ever.
    out(next, 'Running job: build\n');
    await settle();
    expect(started(events)).toEqual(['build']);
  });

  it('keeps stdout and stderr apart, reading a start only where the runner writes it', async () => {
    const { helper, proc, events } = await spawned();

    out(proc, 'some warning', 'stderr');
    await settle();
    expect(helper.instances.get(1)!.currentJob).toBeNull();

    out(proc, 'Running job: bük');
    await settle();
    expect(started(events)).toEqual(['bük']);
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
    const proc = createMockWorker(13579);
    isolation.spawnWorker.mockResolvedValue(proc);
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
    out(proc, 'Running job: build\n');
    await settle();

    expect(isolation.signal).toHaveBeenCalledWith(expect.anything(), 'SIGTERM');
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
  });

  it('stops the worker of a job with no run to cancel, and says the cancel could not be made', async () => {
    // Admission does not need a run id to admit a job; the filter does not
    // need one to judge it.
    const cancelWorkflowRun = jest.fn(ok);
    const { manager, proc, events } = await claimed(cancelWorkflowRun, { githubRunId: undefined });
    out(proc, 'Running job: build\n');
    await settle();

    expect(isolation.signal).toHaveBeenCalledWith(expect.anything(), 'SIGTERM');
    expect(cancelWorkflowRun).not.toHaveBeenCalled();
    expect(entryOf(manager).error).toBe(`${refusal}; cancel failed: no workflow run id`);
    expect(events).toContainEqual(expect.objectContaining({ type: 'cancel-failed' }));

    proc.emit('exit', null, 'SIGTERM');
    await settle();
    expect(entryOf(manager).status).toBe('cancelled');
  });

  it('keeps the job cancelled when its worker wrote a completion line and the lookup on exit is still out', async () => {
    // On SIGTERM the runner reports the job's end; the lookup of its
    // conclusion on exit is still out when the stop is done and the job
    // closed.
    let conclude: (conclusion: string | null) => void = () => undefined;
    const getJobConclusion = jest.fn(() => new Promise<string | null>((resolve) => { conclude = resolve; }));
    const { manager, proc, events } = await claimed(ok, { githubJobId: 7 }, { getJobConclusion });
    out(proc, 'Running job: build\n');
    await settle();
    out(proc, 'Job build completed with result: Canceled\n');
    await settle();
    proc.emit('exit', 0, null);
    await settle();
    expect(getJobConclusion).toHaveBeenCalled();
    expect(entryOf(manager).status).toBe('cancelled');

    conclude('success');
    await settle();

    expect(entryOf(manager).status).toBe('cancelled');
    expect(events.filter((e) => e.type === 'completed' && e.jobName === 'build')).toHaveLength(1);
  });

  it('keeps the job cancelled when its worker exits with no completion line and the lookup on exit is still out', async () => {
    // The exit closes a job whose completion went unread, from GitHub's
    // conclusion; the backstop's close lands while that is looked up.
    let conclude: (conclusion: string | null) => void = () => undefined;
    const getJobConclusion = jest.fn(() => new Promise<string | null>((resolve) => { conclude = resolve; }));
    const { manager, proc, events } = await claimed(ok, { githubJobId: 7 }, { getJobConclusion });
    out(proc, 'Running job: build\n');
    await settle();
    expect(isolation.signal).toHaveBeenCalledWith(expect.anything(), 'SIGTERM');
    proc.emit('exit', 0, null);
    await settle();
    expect(getJobConclusion).toHaveBeenCalled();
    expect(entryOf(manager).status).toBe('cancelled');

    conclude('success');
    await settle();

    expect(entryOf(manager).status).toBe('cancelled');
    expect(events.filter((e) => e.type === 'completed' && e.jobName === 'build')).toHaveLength(1);
  });

  it('closes a refused job as cancelled even when it printed a completion line of its own first', async () => {
    // A step can print a whole line of its own; one that reads as the job's
    // end must not leave the refusal recorded as a success.
    const { manager, proc } = await claimed(ok);
    out(proc, 'Running job: build\nJob build completed with result: Succeeded\n');
    await settle();
    expect(isolation.signal).toHaveBeenCalledWith(expect.anything(), 'SIGTERM');
    proc.emit('exit', null, 'SIGTERM');
    await settle();

    expect(entryOf(manager)).toEqual(expect.objectContaining({ status: 'cancelled', error: refusal }));
  });

  it('does not stop a worker that replaced the refused one during the check, and still closes the refused job', async () => {
    const { helper, manager, proc } = await claimed(ok);
    // The start line sets the backstop going; it awaits the filter. While
    // it does, the refused worker exits and a new spawn takes the slot.
    out(proc, 'Running job: build\n');
    helper.setInstance(1, { name: 'runner-1', status: 'busy', worker: createMockWorker(97531) });
    await settle();

    expect(isolation.signal).not.toHaveBeenCalled();
    // Its history says why it ended, and does not say it is still running.
    expect(entryOf(manager)).toEqual(expect.objectContaining({ status: 'cancelled', error: refusal }));
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
