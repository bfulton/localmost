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
import { RunnerManager, JobEvent, lineReader } from './runner-manager';
import { spawnSandboxed } from './process-sandbox';
import { createMockProcess, RunnerManagerTestHelper } from './test-utils';

const mockSpawnSandboxed = spawnSandboxed as jest.MockedFunction<typeof spawnSandboxed>;

/** Let fire-and-forget work (output parsing, the backstop) settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

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
