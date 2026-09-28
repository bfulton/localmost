import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { killOrphanedProcesses } from './runner-cleanup';

describe('killOrphanedProcesses', () => {
  const runnerDir = path.join(os.tmpdir(), `lm-cleanup-${process.pid}`);
  const sandboxBase = path.join(runnerDir, 'sandbox');
  const pidDir = path.join(runnerDir, 'pids');
  let realKill: typeof process.kill;
  let signalled: Array<[number, unknown]>;

  beforeEach(() => {
    fs.mkdirSync(pidDir, { recursive: true });
    fs.mkdirSync(path.join(sandboxBase, '1'), { recursive: true });
    signalled = [];
    realKill = process.kill;
    (process as unknown as { kill: unknown }).kill = ((pid: number, sig?: unknown) => {
      signalled.push([pid, sig]);
      return true;
    }) as never;
  });
  afterEach(() => {
    (process as unknown as { kill: unknown }).kill = realKill;
    fs.rmSync(runnerDir, { recursive: true, force: true });
  });

  it('reads the app-owned pids directory, not the job-writable sandbox pid file', async () => {
    // A job can write its own sandbox; a pid file there must not steer the kill.
    fs.writeFileSync(path.join(sandboxBase, '1', 'runner.pid'), '4242');
    fs.writeFileSync(path.join(pidDir, '1.pid'), '5555');

    await killOrphanedProcesses(sandboxBase, () => undefined);

    // Only the app-owned pid was signalled; the planted sandbox pid was not.
    expect(signalled.some(([p]) => p === 5555 || p === -5555)).toBe(true);
    expect(signalled.some(([p]) => p === 4242 || p === -4242)).toBe(false);
  });

  it('never signals this process, even if a stale pid file names it', async () => {
    fs.writeFileSync(path.join(pidDir, '1.pid'), String(process.pid));
    await killOrphanedProcesses(sandboxBase, () => undefined);
    expect(signalled).toEqual([]);
  });

  it('refuses to signal pid 1 or lower', async () => {
    fs.writeFileSync(path.join(pidDir, '1.pid'), '-1');
    fs.writeFileSync(path.join(pidDir, '2.pid'), '0');

    await killOrphanedProcesses(sandboxBase, () => undefined);

    expect(signalled).toEqual([]);
  });
});
