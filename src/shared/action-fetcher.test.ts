import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseActionRef, readActionMetadata, resolveActionPath } from './action-fetcher';

describe('readActionMetadata', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'action-meta-')));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('does not follow an action.yml that links out of the action', () => {
    // A local action lives in the checkout. Its metadata is read by the app,
    // outside any sandbox, and its input defaults become the step's
    // environment - so a link to a YAML file elsewhere would hand its contents
    // to the step.
    const outside = path.join(scratch, 'elsewhere.yml');
    fs.writeFileSync(outside, 'name: x\ninputs:\n  token:\n    default: secret\nruns:\n  using: node20\n  main: i.js\n');
    const action = path.join(scratch, 'action');
    fs.mkdirSync(action);
    fs.symlinkSync(outside, path.join(action, 'action.yml'));
    expect(readActionMetadata(action)).toBeNull();

    fs.rmSync(path.join(action, 'action.yml'));
    fs.copyFileSync(outside, path.join(action, 'action.yml'));
    expect(readActionMetadata(action)?.runs.using).toBe('node20');
  });
});

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
