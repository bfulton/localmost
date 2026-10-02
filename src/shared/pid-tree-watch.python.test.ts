/**
 * The python3 the discovery run's process-tree watcher runs on.
 *
 * Not the /usr/bin/python3 shim, which asks xcrun where the developer tools
 * are before python starts. Inside a job that lookup starts from nothing -
 * the job's profile denies the per-user cache, and the job's own cache is
 * empty until its first tool fills it - and on a loaded machine took
 * seconds, which the step being watched spent forking unseen.
 */

import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockSpawn = jest.fn();
const mockExecFileSync = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

/** A module of its own per test, so each starts with nothing looked up. */
const freshWatcher = (): typeof import('./pid-tree-watch') => {
  let watcher: typeof import('./pid-tree-watch') | undefined;
  jest.isolateModules(() => {
    watcher = jest.requireActual<typeof import('./pid-tree-watch')>('./pid-tree-watch');
  });
  return watcher!;
};

const fakeHelper = () => {
  const child = new EventEmitter();
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: jest.fn() });
  return child;
};

let developerDir: string;

beforeEach(() => {
  developerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-developer-')));
  fs.mkdirSync(path.join(developerDir, 'usr', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(developerDir, 'usr', 'bin', 'python3'), '');
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(fakeHelper);
  mockExecFileSync.mockReset();
});

afterEach(() => {
  fs.rmSync(developerDir, { recursive: true, force: true });
});

describe("the process-tree watcher's python3", () => {
  it("is the developer tools' own, never the xcrun shim, and is looked up once", () => {
    mockExecFileSync.mockImplementation((file: unknown) => {
      if (file === '/usr/bin/xcode-select') return `${developerDir}\n`;
      throw new Error(`unexpected ${String(file)}`);
    });
    const { PidTreeWatcher } = freshWatcher();

    for (const pid of [101, 102]) {
      const watcher = new PidTreeWatcher();
      expect(watcher.start(pid)).toBe(true);
      watcher.stop();
    }

    expect(mockExecFileSync.mock.calls.map((call) => call[0])).toEqual(['/usr/bin/xcode-select']);
    const python = path.join(developerDir, 'usr', 'bin', 'python3');
    expect(mockSpawn.mock.calls.map((call) => call[0])).toEqual([python, python]);
    expect(mockSpawn.mock.calls[0][1]).toEqual(['-c', expect.any(String), '101']);
  });

  it('is whatever python3 is on PATH without the developer tools', () => {
    // As before: a discovery run on a Mac with only, say, Homebrew's python3
    // still watches its steps.
    mockExecFileSync.mockImplementation(() => {
      throw new Error('xcode-select: error: unable to get active developer directory');
    });
    const { PidTreeWatcher } = freshWatcher();

    const watcher = new PidTreeWatcher();
    expect(watcher.start(101)).toBe(true);
    watcher.stop();

    expect(mockSpawn.mock.calls[0][0]).toBe('/usr/bin/env');
    expect(mockSpawn.mock.calls[0][1]).toEqual(['python3', '-c', expect.any(String), '101']);
  });
});

describe('PidTreeWatcher.watching', () => {
  beforeEach(() => {
    mockExecFileSync.mockImplementation(() => `${developerDir}\n`);
  });

  it("resolves once the helper has looked at the root's children, with them collected", async () => {
    const { PidTreeWatcher } = freshWatcher();
    const watcher = new PidTreeWatcher();
    watcher.start(101);
    const helper = mockSpawn.mock.results[0].value as { stdout: PassThrough };

    let settled = false;
    const watching = watcher.watching().then((value) => {
      settled = true;
      return value;
    });
    // A line may arrive in pieces.
    helper.stdout.write('fork 101 1');
    helper.stdout.write('02\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    helper.stdout.write('watching 101\n');

    expect(await watching).toBe(true);
    expect([...watcher.getPids()].sort()).toEqual([101, 102]);
    watcher.stop();
  });

  it('resolves false when the helper cannot start or exits before it watches', async () => {
    const { PidTreeWatcher } = freshWatcher();

    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failed = new PidTreeWatcher();
    failed.start(101);
    (mockSpawn.mock.results[0].value as EventEmitter).emit('error', new Error('spawn python3 ENOENT'));
    expect(await failed.watching()).toBe(false);
    quiet.mockRestore();

    const exited = new PidTreeWatcher();
    exited.start(102);
    (mockSpawn.mock.results[1].value as EventEmitter).emit('close', 1, null);
    expect(await exited.watching()).toBe(false);

    const stopped = new PidTreeWatcher();
    stopped.start(103);
    stopped.stop();
    expect(await stopped.watching()).toBe(false);
  });
});
