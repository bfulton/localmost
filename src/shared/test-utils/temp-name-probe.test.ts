import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { mkdtempChars, probeTempDirName } from './temp-name-probe';

describe('probeTempDirName', () => {
  // A stand-in per-user temp under the build output, so the real one - where
  // SwiftPM's and swift-driver's own TemporaryDirectory.XXXXXX live - is
  // never in play.
  const scratch = path.join(process.cwd(), 'build');
  let temp: string;

  beforeEach(() => {
    fs.mkdirSync(scratch, { recursive: true });
    temp = fs.mkdtempSync(path.join(scratch, 'localmost-temp-probe-'));
  });

  afterEach(() => {
    if (!temp.startsWith(path.join(scratch, 'localmost-temp-probe-'))) throw new Error(`not a scratch directory: ${temp}`);
    fs.rmSync(temp, { recursive: true, force: true });
  });

  /** Run a probe's shell command here, as an unsandboxed stand-in for a profile. */
  const unsandboxed = (command: string): boolean => {
    try {
      execFileSync('/bin/sh', ['-c', command], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  };

  it('makes the directory and a file inside, and removes exactly what it made', () => {
    const name = `TemporaryDirectory.${mkdtempChars(6)}`;
    expect(probeTempDirName(unsandboxed, temp, name)).toBe(true);
    expect(fs.readdirSync(temp)).toEqual([]);
  });

  it('refuses a name that is already there, and leaves it as it was', () => {
    // A directory of that shape may be the user's own - a manifest SwiftPM is
    // about to run - which a probe must never remove.
    const name = `TemporaryDirectory.${mkdtempChars(6)}`;
    fs.mkdirSync(path.join(temp, name));
    fs.writeFileSync(path.join(temp, name, 'hello-manifest'), 'theirs');
    expect(() => probeTempDirName(unsandboxed, temp, name)).toThrow(/already exists/);
    expect(fs.readFileSync(path.join(temp, name, 'hello-manifest'), 'utf-8')).toBe('theirs');
  });

  it('leaves alone a directory it did not make, though one appeared there while it ran', () => {
    // Its mkdir failed - refused, or beaten to the name - so what is there
    // now is someone else's.
    const name = `TemporaryDirectory.${mkdtempChars(6)}`;
    const raced = (command: string): boolean => {
      if (command.startsWith('/bin/mkdir')) {
        fs.mkdirSync(path.join(temp, name));
        fs.writeFileSync(path.join(temp, name, 'hello-manifest'), 'theirs');
        return false;
      }
      return unsandboxed(command);
    };
    expect(probeTempDirName(raced, temp, name)).toBe(false);
    expect(fs.readFileSync(path.join(temp, name, 'hello-manifest'), 'utf-8')).toBe('theirs');
  });

  it('removes the directory it made when the file inside is refused, and nothing it did not put there', () => {
    const name = `TemporaryDirectory.${mkdtempChars(6)}`;
    const noFiles = (command: string): boolean => (command.startsWith('/bin/mkdir') ? unsandboxed(command) : false);
    expect(probeTempDirName(noFiles, temp, name)).toBe(false);
    expect(fs.readdirSync(temp)).toEqual([]);

    // Something else's file in the directory it made stops the removal
    // rather than going with it.
    const other = `TemporaryDirectory.${mkdtempChars(6)}`;
    const planted = (command: string): boolean => {
      const ok = unsandboxed(command);
      if (command.startsWith('/bin/mkdir')) fs.writeFileSync(path.join(temp, other, 'keep'), 'theirs');
      return ok;
    };
    expect(() => probeTempDirName(planted, temp, other)).toThrow();
    expect(fs.readFileSync(path.join(temp, other, 'keep'), 'utf-8')).toBe('theirs');
  });

  it('takes the per-user temp as getconf prints it, with its trailing slash', () => {
    const name = `TemporaryDirectory.${mkdtempChars(6)}`;
    expect(probeTempDirName(unsandboxed, `${temp}/`, name)).toBe(true);
    expect(fs.readdirSync(temp)).toEqual([]);
  });

  it('refuses a name that is not a single entry of the probed shapes', () => {
    for (const name of ['../escape', 'a/b', 'xcrun_db', '', 'TemporaryDirectory.ab/../..']) {
      expect(() => probeTempDirName(unsandboxed, temp, name)).toThrow(/not a probe name/);
    }
    expect(fs.readdirSync(temp)).toEqual([]);
  });
});

describe('mkdtempChars', () => {
  it("draws only from mkdtemp's 62 characters", () => {
    expect(mkdtempChars(500)).toMatch(/^[A-Za-z0-9]{500}$/);
  });
});
