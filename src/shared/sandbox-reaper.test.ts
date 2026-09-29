/**
 * Finding the developer tools' python3 the profile-mark sweep runs with.
 *
 * Every finished job is swept, and a startup sweeps every mark an earlier
 * run left, so the lookup runs once per app run, not once per sweep: on a
 * Mac without the developer tools a busy runner leaves marks by the
 * thousand, and a startup that asked xcode-select for each would wait on
 * as many processes, one after another.
 */

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: (...args: unknown[]) => mockExecFile(...args),
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
