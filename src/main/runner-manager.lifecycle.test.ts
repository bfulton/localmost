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
    getSandboxDir: jest.fn().mockImplementation((instance: number) => `/Users/test/.localmost/runner/sandbox/${instance}`),
    getToolCacheDir: jest.fn().mockImplementation((targetId: string) => `/Users/test/.localmost/runner/caches/${targetId}/tool-cache`),
    getTargetCacheDir: jest.fn().mockImplementation((targetId: string) => `/Users/test/.localmost/runner/caches/${targetId}`),
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
    setPolicyLevel: jest.fn(),
    getPolicyLevel: jest.fn(() => 'strict'),
    getStats: jest.fn(() => ({ allowedCount: 0, blockedCount: 0, blockedHosts: new Set() })),
    rotateAuthToken: jest.fn(),
  })),
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
import { RunnerManager, JobEvent, lineReader } from './runner-manager';
import { ProxyServer } from './proxy-server';
import { spawnSandboxed } from './process-sandbox';
import { getJobHistoryPath } from './paths';
import { createMockProcess, RunnerManagerTestHelper } from './test-utils';

const mockSpawnSandboxed = spawnSandboxed as jest.MockedFunction<typeof spawnSandboxed>;

/** Let fire-and-forget work (output parsing, the backstop) settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

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
    expect(helper.instances.get(1)!.status).toBe('busy');
    expect(events.filter((e) => e.type === 'completed')).toEqual([]);

    // The runner's own line, timestamped, still ends the job, with its result.
    await helper.parseRunnerOutput(1, '2026-09-29 12:00:05Z: Job build completed with result: Failed');
    expect(helper.instances.get(1)!.currentJob).toBeNull();
    expect(events.filter((e) => e.type === 'completed')).toEqual([
      expect.objectContaining({ jobName: 'build', status: 'failed' }),
    ]);
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
    const { proc, events } = await spawned();

    proc.stdout!.emit('data', Buffer.from('x'.repeat(70 * 1024)));
    proc.stdout!.emit('data', Buffer.from('Running job: evil\n'));
    await settle();
    expect(started(events)).toEqual([]);

    // The next line is read normally.
    proc.stdout!.emit('data', Buffer.from('Running job: build\n'));
    await settle();
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
});

describe('the job-start backstop', () => {
  // A job the filter refuses reached a worker anyway: the trigger scope with
  // an actor who is not the machine owner.
  const filterOverrides = {
    getUserFilter: () => ({ scope: 'trigger' as const, allowedUsers: 'just-me' as const, allowlist: [] }),
    getCurrentUserLogin: () => 'me',
  };

  async function claimed(cancelWorkflowRun: () => Promise<void>) {
    const ctx = newManager({ ...filterOverrides, cancelWorkflowRun });
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const proc = createMockProcess(13579);
    mockSpawnSandboxed.mockReturnValue(proc);
    await ctx.helper.spawnForJob({ targetId: 't1', targetDisplayName: 'owner/repo', githubRunId: 42, githubActor: 'stranger' } as never);
    return { ...ctx, proc };
  }

  it.each([
    ['succeeds', async () => undefined],
    ['fails', async () => { throw new Error('HTTP 500'); }],
  ])('stops the worker when the cancel %s, and the exit finalizes it', async (how, cancel) => {
    const { helper, manager, proc, events } = await claimed(cancel);
    const kill = stubKill();
    try {
      proc.stdout!.emit('data', Buffer.from('Running job: build\n'));
      await settle();

      expect(kill.calls).toContainEqual([-13579, 'SIGTERM']);
      const entry = manager.getJobHistory().find((j) => j.jobName === 'build')!;
      expect(entry.error).toContain("trigger author 'stranger' not in allowed users");
      if (how === 'fails') {
        expect(entry.error).toContain('cancel failed: HTTP 500');
        expect(events).toContainEqual(expect.objectContaining({ type: 'cancel-failed' }));
      }

      // The worker exits on the SIGTERM; its exit finalizes the slot as for
      // any other exit, sealing its proxy.
      const proxy = (ProxyServer as unknown as jest.Mock).mock.results.at(-1)!.value;
      const rotations = proxy.rotateAuthToken.mock.calls.length;
      proc.emit('exit', null, 'SIGTERM');
      await settle();
      expect(proxy.rotateAuthToken.mock.calls.length).toBeGreaterThan(rotations);
      expect(proxy.setPolicyAllowedHosts).toHaveBeenLastCalledWith([]);

      // Not left 'running' forever: the job was stopped.
      expect(manager.getJobHistory().find((j) => j.jobName === 'build')!.status).toBe('cancelled');
      expect(helper.instances.get(1)!.currentJob).toBeNull();
    } finally {
      kill.restore();
    }
  });

  it('does not stop a worker that replaced the refused one during the check, and still closes the refused job', async () => {
    const { helper, manager, proc } = await claimed(async () => undefined);
    const kill = stubKill();
    try {
      // The start line sets the backstop going; it awaits the filter. While
      // it does, the refused worker exits and a new spawn takes the slot.
      proc.stdout!.emit('data', Buffer.from('Running job: build\n'));
      helper.setInstance(1, { name: 'runner-1', status: 'busy', process: createMockProcess(97531) });
      await settle();

      expect(kill.calls.filter(([, sig]) => sig !== 0)).toEqual([]);
      // Its history says why it ended, and does not say it is still running.
      expect(manager.getJobHistory().find((j) => j.jobName === 'build')).toEqual(expect.objectContaining({
        status: 'cancelled',
        error: "trigger author 'stranger' not in allowed users",
      }));
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
});

describe("sweeping a previous session's workers", () => {
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
        await helper.killStaleProcesses();
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
      await (manager as unknown as { detectStaleRunnerProcesses(): Promise<void> }).detectStaleRunnerProcesses();
    } finally {
      kill.restore();
    }

    expect(killsOf(kill.calls)).toEqual([[4242, 'SIGTERM']]);
  });
});
