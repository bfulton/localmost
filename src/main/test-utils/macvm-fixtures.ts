/**
 * Fixtures for the macOS VM mode's tests: the fake helper's spawn, a data
 * directory laid out as the image manager makes it, and what the fake
 * recorded.
 */

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { shortTempDir } from './vm-fixtures';

/** test/fakes/fake-localmost-macvm.mjs, the helper's stand-in. */
export const FAKE_MACVM = path.resolve(__dirname, '..', '..', '..', 'test', 'fakes', 'fake-localmost-macvm.mjs');

/** Spawns the fake helper with `script`, recording what reaches it into `recordFile` when given. */
export function fakeMacVmSpawn(script: Record<string, unknown> = {}, recordFile?: string) {
  return (_helper: string, args: string[], env: Record<string, string>): ChildProcess =>
    spawn(process.execPath, [FAKE_MACVM, ...args], {
      env: {
        ...env,
        FAKE_MACVM_SCRIPT: JSON.stringify(script),
        ...(recordFile !== undefined ? { FAKE_MACVM_RECORD: recordFile } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
}

/** What the fake recorded, one object per line. */
export function readRecord(recordFile: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(recordFile)) return [];
  return fs
    .readFileSync(recordFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * A short real data directory with macos-vm/{ipsw,images,vms,slots}, short
 * enough that `<data>/macos-vm/vms/<vmId>/agent.sock` fits a unix socket's path.
 */
export function macVmDataDir(): string {
  const data = shortTempDir();
  for (const dir of ['ipsw', 'images', 'vms', 'slots', 'bootstrap']) {
    fs.mkdirSync(path.join(data, 'macos-vm', dir), { recursive: true, mode: 0o700 });
  }
  return data;
}
