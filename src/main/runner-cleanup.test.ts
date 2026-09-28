import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { killOrphanedProcesses, processStartTime } from './runner-cleanup';

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

  it('signals a real orphan whose recorded start time still matches', async () => {
    // Use a real process so the ps-based identity check actually passes.
    const child = spawn('/bin/sleep', ['30'], { detached: true });
    try {
      const pid = child.pid!;
      fs.writeFileSync(path.join(pidDir, '1.pid'), `${pid} ${processStartTime(pid)}`);

      await killOrphanedProcesses(sandboxBase, () => undefined);

      expect(signalled.some(([p]) => p === pid || p === -pid)).toBe(true);
    } finally {
      try { realKill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
      try { realKill(child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('reads the app-owned pids directory, not the job-writable sandbox pid file', async () => {
    // A job can write its own sandbox; a pid file there must not steer the kill.
    // (No app-owned file, so nothing to signal - the sandbox file is ignored.)
    fs.writeFileSync(path.join(sandboxBase, '1', 'runner.pid'), '4242');

    await killOrphanedProcesses(sandboxBase, () => undefined);

    expect(signalled.some(([p]) => p === 4242 || p === -4242)).toBe(false);
  });

  it('does not signal a pid whose start time no longer matches (reuse)', async () => {
    // A live pid, but the recorded start time is stale - the pid was reused.
    const child = spawn('/bin/sleep', ['30'], { detached: true });
    try {
      fs.writeFileSync(path.join(pidDir, '1.pid'), `${child.pid} Thu Jan  1 00:00:00 2000`);

      await killOrphanedProcesses(sandboxBase, () => undefined);

      expect(signalled).toEqual([]);
    } finally {
      try { realKill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
      try { realKill(child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }
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
