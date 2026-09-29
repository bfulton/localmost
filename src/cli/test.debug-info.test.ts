import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { saveDebugInfo } from './test';

describe('saveDebugInfo', () => {
  let scratch: string;
  let workspace: string;
  let elsewhere: string;

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'debug-info-')));
    workspace = path.join(scratch, 'ws');
    elsewhere = path.join(scratch, 'elsewhere');
    fs.mkdirSync(workspace);
    fs.mkdirSync(elsewhere);
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('writes inside the workspace even when a step made .debug a link out of it', () => {
    // The steps have finished by now, but what they left in the workspace has
    // not: a .debug symlink would take these writes wherever it pointed.
    fs.symlinkSync(elsewhere, path.join(workspace, '.debug'));

    const dir = saveDebugInfo(workspace, 'log line\n', new Set([1234]));

    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(path.dirname(dir)).toBe(workspace);
    expect(fs.lstatSync(dir).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'sandbox-log.txt'), 'utf-8')).toBe('log line\n');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'collected-pids.json'), 'utf-8'))).toEqual([1234]);
  });
});
