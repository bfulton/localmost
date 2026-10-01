/**
 * The discovery run's process-tree watcher, which the unsandboxed CLI runs
 * beside each step of `localmost test --updaterc`.
 */

import { describe, it, expect, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { PidTreeWatcher } from './pid-tree-watch';

// Jest hands a test a copy of process.env, which os.homedir() never reads.
let mockHome: string | undefined;
jest.mock('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os');
  return { ...actual, homedir: () => mockHome ?? actual.homedir() };
});

describe('PidTreeWatcher', () => {
  it('writes nothing to disk, so a home it cannot write does not stop a discovery run', () => {
    // It wrote its helper to ~/.localmost/bin and ran it from there. Inside a
    // job that directory is denied, so the write threw and every step of a
    // discovery run failed.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-tree-home-'));
    fs.chmodSync(home, 0o500);
    mockHome = home;
    const watcher = new PidTreeWatcher();
    try {
      expect(() => watcher.start(process.pid)).not.toThrow();
      expect(fs.readdirSync(home)).toEqual([]);
      expect([...watcher.getPids()]).toContain(process.pid);
    } finally {
      watcher.stop();
      mockHome = undefined;
      fs.chmodSync(home, 0o700);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('collects the pid of a process the watched one starts', async () => {
    const root = spawn('/bin/sh', ['-c', '/bin/sleep 30 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const childPid = await new Promise<number>((resolve) =>
      root.stdout?.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())))
    );
    const watcher = new PidTreeWatcher();
    try {
      expect(watcher.start(root.pid as number)).toBe(true);
      // The child was running before the watch began, so the watcher's first
      // look at the root's children, which it reports before it says it is
      // watching, has it: there is nothing to poll for.
      expect(await watcher.watching()).toBe(true);
      expect([...watcher.getPids()]).toEqual(expect.arrayContaining([root.pid, childPid]));
    } finally {
      watcher.stop();
      process.kill(childPid, 'SIGKILL');
      root.kill('SIGKILL');
    }
    // A shell, its child and python3 started for real, and the watcher's
    // first line waited for. On a loaded machine - CI runs this suite inside
    // a job, beside other jobs - python3 alone can take seconds to start.
  }, 60_000);
});
