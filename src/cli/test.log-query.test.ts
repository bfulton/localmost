/**
 * Reading the sandbox's reports back from the unified log.
 *
 * Discovery used to write a bash script to /tmp/localmost-query-log-<ms>.sh
 * and run it. /tmp is writable from every sandboxed step and every runner
 * job, and the name was the clock: anything that planted that path first
 * had its script run unsandboxed, as the user. There is nothing to plant now.
 */

import { describe, it, expect, jest } from '@jest/globals';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import { querySandboxLogs } from './test';

jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  return { ...actual, execFileSync: jest.fn(), execSync: jest.fn() };
});

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, writeFileSync: jest.fn(actual.writeFileSync) };
});

const execFileSync = jest.mocked(childProcess.execFileSync);
const execSync = jest.mocked(childProcess.execSync);
const writeFileSync = jest.mocked(fs.writeFileSync);

describe('querySandboxLogs', () => {
  it('runs /usr/bin/log directly and writes nothing to run', () => {
    execFileSync.mockReturnValue(
      [
        '2026-09-29 10:59:06.046429-0400 0x1  Error 0x0 0 0 kernel: (Sandbox) Sandbox: touch(45805) deny(1) file-write-create /x',
        '2026-09-29 10:59:06.054430-0400 0x2  Default 0x0 0 0 kernel: (Sandbox) Sandbox: ls(45806) allow file-read-data /usr',
        'Timestamp               Thread     Type        Activity             PID    TTL',
      ].join('\n') as never
    );

    const output = querySandboxLogs(12);

    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [file, args] = execFileSync.mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe('/usr/bin/log');
    expect(args).toEqual(['show', '--last', '12s', '--predicate', 'sender == "Sandbox"']);
    expect(execSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();

    // Only the sandbox's own lines, whatever else the log prints.
    expect(output.split('\n')).toEqual([
      expect.stringContaining('touch(45805) deny(1)'),
      expect.stringContaining('ls(45806) allow'),
    ]);
  });

  it('returns nothing, rather than throwing, when the log cannot be read', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('log: not permitted');
    });
    expect(querySandboxLogs(5)).toBe('');
  });
});
