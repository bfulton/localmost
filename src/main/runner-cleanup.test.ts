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

  // A stub for the process start-time lookup, so the test does not depend on a
  // real process or on `ps` (which behaves differently inside the sandbox).
  const startTimeOf = (want: Record<number, string>) => (pid: number) => want[pid] ?? null;

  it('signals an orphan whose recorded start time still matches', async () => {
    fs.writeFileSync(path.join(pidDir, '1.pid'), '4242 STARTED-AT');

    await killOrphanedProcesses(sandboxBase, () => undefined, startTimeOf({ 4242: 'STARTED-AT' }));

    expect(signalled.some(([p]) => p === 4242 || p === -4242)).toBe(true);
  });

  it('reads the app-owned pids directory, not the job-writable sandbox pid file', async () => {
    // A job can write its own sandbox; a pid file there must not steer the kill.
    fs.writeFileSync(path.join(sandboxBase, '1', 'runner.pid'), '4242 STARTED-AT');

    await killOrphanedProcesses(sandboxBase, () => undefined, startTimeOf({ 4242: 'STARTED-AT' }));

    expect(signalled.some(([p]) => p === 4242 || p === -4242)).toBe(false);
  });

  it('does not signal a pid whose start time no longer matches (reuse)', async () => {
    fs.writeFileSync(path.join(pidDir, '1.pid'), '4242 OLD-START');

    await killOrphanedProcesses(sandboxBase, () => undefined, startTimeOf({ 4242: 'NEW-START' }));

    expect(signalled).toEqual([]);
  });

  it('never signals this process, even if a stale pid file names it', async () => {
    fs.writeFileSync(path.join(pidDir, '1.pid'), String(process.pid));
    await killOrphanedProcesses(sandboxBase, () => undefined);
    expect(signalled).toEqual([]);
  });

  it('ignores a pid file with trailing junk, not treating it as a bare number', async () => {
    fs.writeFileSync(path.join(pidDir, '1.pid'), '4242junk');
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
