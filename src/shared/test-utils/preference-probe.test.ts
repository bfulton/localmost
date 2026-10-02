import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { sweepStaleThrowawayDomains } from './preference-probe';

describe('sweepStaleThrowawayDomains', () => {
  // A stand-in preferences directory under the build output, so the
  // developer's own ~/Library/Preferences is never in play.
  const scratch = path.join(process.cwd(), 'build');
  let dir: string;

  beforeAll(() => {
    fs.mkdirSync(scratch, { recursive: true });
    dir = fs.mkdtempSync(path.join(scratch, 'localmost-prefs-'));
  });

  afterAll(() => {
    if (!dir.startsWith(path.join(scratch, 'localmost-prefs-'))) throw new Error(`not a scratch directory: ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes the plists a killed run left behind, and nothing of a live run's or anyone else's", () => {
    // A run killed between planting its throwaway domain and removing it left
    // the plist in your real preferences for good.
    const exited = spawnSync('/usr/bin/true');
    expect(exited.status).toBe(0);
    const deadPid = exited.pid;
    const plist = (pid: number, hex: string) => path.join(dir, `com.localmost.prefs-test-${pid}-${hex}.plist`);
    const stale = plist(deadPid, '0123abcd');
    const live = plist(process.ppid, '0123abcd');
    const own = plist(process.pid, '0123abcd');
    const others = [
      path.join(dir, 'com.apple.finder.plist'),
      path.join(dir, `com.localmost.prefs-test-${deadPid}-0123abc.plist`),
      path.join(dir, `com.localmost.prefs-test-${deadPid}-0123abcd.plist.bak`),
      path.join(dir, `xcom.localmost.prefs-test-${deadPid}-0123abcd.plist`),
    ];
    for (const file of [stale, live, own, ...others]) fs.writeFileSync(file, 'planted');
    // Only a plain file: a directory or a link of that name stays, and the
    // link's target with it.
    const directory = plist(deadPid, '4567cdef');
    fs.mkdirSync(directory);
    const target = path.join(dir, 'target');
    fs.writeFileSync(target, 'target');
    const link = plist(deadPid, '89abcdef');
    fs.symlinkSync(target, link);

    sweepStaleThrowawayDomains(dir);

    expect(fs.existsSync(stale)).toBe(false);
    for (const kept of [live, own, ...others, directory, target]) {
      expect([kept, fs.existsSync(kept)]).toEqual([kept, true]);
    }
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
