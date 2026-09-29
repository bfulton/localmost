import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseActionRef, resolveActionPath } from './action-fetcher';

describe('resolveActionPath', () => {
  let scratch: string;
  let actionDir: string;

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'action-path-')));
    actionDir = path.join(scratch, 'actions', 'owner', 'repo', 'v1');
    fs.mkdirSync(path.join(actionDir, 'save'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('is the repository, or a subdirectory of it', () => {
    expect(resolveActionPath(actionDir)).toBe(actionDir);
    expect(resolveActionPath(actionDir, 'save')).toBe(path.join(actionDir, 'save'));
  });

  it('refuses a subpath that climbs out of the repository', () => {
    // The subpath is the workflow's to write, and parseActionRef takes it
    // verbatim: owner/repo/../../../..@v1 would otherwise run from wherever
    // it lands, readable to the step.
    const ref = parseActionRef('owner/repo/../../../..@v1');
    expect(ref?.path).toBe('../../../..');
    expect(() => resolveActionPath(actionDir, ref?.path)).toThrow(/outside its repository/);
  });

  it('refuses a symlink the repository ships that leads out of it', () => {
    fs.symlinkSync(scratch, path.join(actionDir, 'escape'));
    expect(() => resolveActionPath(actionDir, 'escape')).toThrow(/outside its repository/);
  });
});
