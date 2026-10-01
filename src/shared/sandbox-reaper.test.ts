/**
 * Finding the developer tools' python3 the profile-mark sweep runs with.
 *
 * Every finished job is swept, and a startup sweeps every mark an earlier
 * run left, so the lookup runs once per app run, not once per sweep: on a
 * Mac without the developer tools a busy runner leaves marks by the
 * thousand, and a startup that asked xcode-select for each would wait on
 * as many processes, one after another.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockExecFile = jest.fn();
const mockExecFileSync = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: (...args: unknown[]) => mockExecFile(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import { reapMarkedProcessesAsync } from './sandbox-reaper';

const marker = (n: number) => ({ granted: `/pids/${n}-ab.granted`, withheld: `/pids/${n}-ab.withheld` });

describe("the sweep's python3", () => {
  it('is looked up once for every sweep, and not run when there is none', async () => {
    // xcode-select -p fails without the developer tools.
    mockExecFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (err: Error | null) => void) =>
      callback(Object.assign(new Error('xcode-select: error: unable to get active developer directory'), { code: 2 }))
    );

    for (let n = 1; n <= 5; n++) {
      expect(await reapMarkedProcessesAsync(marker(n))).toBeNull();
    }

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0][0]).toBe('/usr/bin/xcode-select');
  });
});

describe("the blocking sweep's python3, for localmost test", () => {
  // A module of its own per test, so each starts with nothing looked up.
  const freshReaper = (): typeof import('./sandbox-reaper') => {
    let reaper: typeof import('./sandbox-reaper') | undefined;
    jest.isolateModules(() => {
      reaper = jest.requireActual<typeof import('./sandbox-reaper')>('./sandbox-reaper');
    });
    return reaper!;
  };

  let developerDir: string;

  beforeEach(() => {
    developerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-developer-')));
    fs.mkdirSync(path.join(developerDir, 'usr', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(developerDir, 'usr', 'bin', 'python3'), '');
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    fs.rmSync(developerDir, { recursive: true, force: true });
  });

  it("is the developer tools' own, never the /usr/bin/python3 shim, and is looked up once", () => {
    // /usr/bin/python3 runs xcrun first, which resolves the tool through a
    // cache in the per-user temp directory. A job's profile denies that
    // directory and the sweep's environment carries no xcrun_db to move it,
    // so inside a job every sweep paid a cold lookup - seconds, and on a
    // loaded machine past the sweep's own timeout, which then found nothing.
    mockExecFileSync.mockImplementation((file: unknown) =>
      file === '/usr/bin/xcode-select' ? `${developerDir}\n` : ''
    );
    const { reapMarkedProcesses } = freshReaper();

    expect(reapMarkedProcesses(marker(1))).toBe(true);
    expect(reapMarkedProcesses(marker(2))).toBe(true);

    const files = mockExecFileSync.mock.calls.map((call) => call[0]);
    expect(files).toEqual([
      '/usr/bin/xcode-select',
      path.join(developerDir, 'usr', 'bin', 'python3'),
      path.join(developerDir, 'usr', 'bin', 'python3'),
    ]);
    expect(mockExecFileSync.mock.calls[1][1]).toEqual(expect.arrayContaining([marker(1).granted, marker(1).withheld]));
  });

  it('runs nothing, and says it could not look, without the developer tools', () => {
    mockExecFileSync.mockImplementation((file: unknown) => {
      if (file === '/usr/bin/xcode-select') throw new Error('xcode-select: error: unable to get active developer directory');
      return '';
    });
    const { reapMarkedProcesses } = freshReaper();

    expect(reapMarkedProcesses(marker(1))).toBe(false);
    expect(reapMarkedProcesses(marker(2))).toBe(false);

    expect(mockExecFileSync.mock.calls.map((call) => call[0])).toEqual(['/usr/bin/xcode-select']);
  });

  it('says it could not look when the sweep itself fails', () => {
    mockExecFileSync.mockImplementation((file: unknown) => {
      if (file === '/usr/bin/xcode-select') return `${developerDir}\n`;
      throw Object.assign(new Error('spawnSync python3 ETIMEDOUT'), { code: 'ETIMEDOUT' });
    });
    const { reapMarkedProcesses } = freshReaper();

    expect(reapMarkedProcesses(marker(1))).toBe(false);
  });
});

describe('a lookup of the developer tools that ran out of time', () => {
  // On a loaded machine xcode-select can outlast its own timeout. That says
  // nothing about whether the tools are there, so it is not remembered: kept,
  // it would have stopped every later sweep of the process from looking.
  const freshReaper = (): typeof import('./sandbox-reaper') => {
    let reaper: typeof import('./sandbox-reaper') | undefined;
    jest.isolateModules(() => {
      reaper = jest.requireActual<typeof import('./sandbox-reaper')>('./sandbox-reaper');
    });
    return reaper!;
  };

  let developerDir: string;
  let python: string;

  beforeEach(() => {
    developerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-developer-')));
    python = path.join(developerDir, 'usr', 'bin', 'python3');
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, '');
    mockExecFile.mockReset();
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    fs.rmSync(developerDir, { recursive: true, force: true });
  });

  it('is asked again by the next blocking sweep', () => {
    let lookups = 0;
    mockExecFileSync.mockImplementation((file: unknown) => {
      if (file !== '/usr/bin/xcode-select') return '';
      if (++lookups === 1) throw Object.assign(new Error('spawnSync /usr/bin/xcode-select ETIMEDOUT'), { code: 'ETIMEDOUT' });
      return `${developerDir}\n`;
    });
    const { reapMarkedProcesses } = freshReaper();

    expect(reapMarkedProcesses(marker(1))).toBe(false);
    expect(reapMarkedProcesses(marker(2))).toBe(true);
    expect(reapMarkedProcesses(marker(3))).toBe(true);

    expect(mockExecFileSync.mock.calls.map((call) => call[0])).toEqual([
      '/usr/bin/xcode-select',
      '/usr/bin/xcode-select',
      python,
      python,
    ]);
  });

  it("is asked again by the app's next sweep", async () => {
    let lookups = 0;
    mockExecFile.mockImplementation(
      (file: string, _args: string[], _options: unknown, callback: (err: Error | null, stdout?: string) => void) => {
        if (file !== '/usr/bin/xcode-select') return callback(null, '');
        if (++lookups === 1) {
          return callback(Object.assign(new Error('Command failed: /usr/bin/xcode-select -p'), { killed: true, signal: 'SIGTERM' }));
        }
        return callback(null, `${developerDir}\n`);
      }
    );
    const { developerPython } = freshReaper();

    expect(await developerPython()).toBeNull();
    expect(await developerPython()).toBe(python);
    expect(await developerPython()).toBe(python);

    expect(mockExecFile.mock.calls.map((call) => call[0])).toEqual(['/usr/bin/xcode-select', '/usr/bin/xcode-select']);
  });
});
