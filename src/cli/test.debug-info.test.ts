import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { saveDebugInfo } from './test';

describe('saveDebugInfo', () => {
  let scratch: string;
  let appData: string;
  const savedConfigDir = process.env.LOCALMOST_CONFIG_DIR;

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'debug-info-')));
    appData = path.join(scratch, 'appdata');
    process.env.LOCALMOST_CONFIG_DIR = appData;
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
    else process.env.LOCALMOST_CONFIG_DIR = savedConfigDir;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('writes where no step can reach, not into the workspace', () => {
    // The steps have finished by now, but something they left running may not
    // have: in the workspace it could swap the new directory for a link
    // between its creation and these writes. The app data directory is closed
    // to every step.
    const dir = saveDebugInfo('log line\n', new Set([1234]));

    expect(path.dirname(path.dirname(dir))).toBe(appData);
    expect(fs.lstatSync(dir).isDirectory()).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(dir, 'sandbox-log.txt'), 'utf-8')).toBe('log line\n');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'collected-pids.json'), 'utf-8'))).toEqual([1234]);
  });
});
