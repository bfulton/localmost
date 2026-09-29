import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import * as containedPath from './contained-path';
import { parseActionRef, readActionMetadata, resolveActionPath } from './action-fetcher';

// Held so a test can act between the containment check and the read, as a
// process a step left running could.
jest.mock('./contained-path', () => {
  const actual = jest.requireActual<typeof import('./contained-path')>('./contained-path');
  return { ...actual, resolveWithin: jest.fn(actual.resolveWithin) };
});
const resolveWithin = jest.mocked(containedPath.resolveWithin);
const actualResolveWithin = jest.requireActual<typeof import('./contained-path')>('./contained-path').resolveWithin;

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

  it('reads the file it checked, not one swapped in after the check', () => {
    // A local action is in the workspace, where something an earlier step
    // left running can replace action.yml between the check and the read.
    const outside = path.join(scratch, 'credentials');
    fs.writeFileSync(outside, 'name: x\ninputs:\n  token:\n    default: secret\nruns:\n  using: node20\n  main: i.js\n');
    const action = path.join(scratch, 'action');
    fs.mkdirSync(action);
    const metadata = path.join(action, 'action.yml');
    const swaps: Array<[string, () => void]> = [
      ['symlink', () => fs.symlinkSync(outside, metadata)],
      ['hard link', () => fs.linkSync(outside, metadata)],
      ['directory link', () => {
        // The action directory itself becomes a link to a copy elsewhere.
        const decoy = path.join(scratch, 'decoy');
        fs.mkdirSync(decoy);
        fs.copyFileSync(outside, path.join(decoy, 'action.yml'));
        fs.renameSync(action, path.join(scratch, 'parked'));
        fs.symlinkSync(decoy, action);
      }],
    ];
    for (const [name, swap] of swaps) {
      fs.writeFileSync(metadata, 'name: mine\nruns:\n  using: composite\n  steps: []\n');
      let swapped = false;
      resolveWithin.mockImplementation((root, target, what, rootName) => {
        const real = actualResolveWithin(root, target, what, rootName);
        if (!swapped) {
          swapped = true;
          fs.rmSync(metadata);
          swap();
        }
        return real;
      });
      try {
        expect({ name, inputs: readActionMetadata(action)?.inputs }).toEqual({ name, inputs: undefined });
      } finally {
        resolveWithin.mockImplementation(actualResolveWithin);
        if (fs.lstatSync(action).isSymbolicLink()) {
          fs.rmSync(action);
          fs.rmSync(path.join(scratch, 'decoy'), { recursive: true });
          fs.renameSync(path.join(scratch, 'parked'), action);
        }
        fs.rmSync(metadata, { force: true });
      }
    }
  });

  it('does not hang on a FIFO swapped in for the metadata', () => {
    // Opening a FIFO for reading blocks until a writer appears, and this read
    // is synchronous: the whole run would stop, Ctrl-C included.
    const action = path.join(scratch, 'action');
    fs.mkdirSync(action);
    const metadata = path.join(action, 'action.yml');
    fs.writeFileSync(metadata, 'name: mine\nruns:\n  using: composite\n');
    resolveWithin.mockImplementationOnce((root, target, what, rootName) => {
      const real = actualResolveWithin(root, target, what, rootName);
      fs.rmSync(metadata);
      execFileSync('/usr/bin/mkfifo', [metadata]);
      // A writer, late, so the unfixed read returns rather than hanging forever.
      spawn('/bin/sh', ['-c', `sleep 3; echo 'name: late' > '${metadata}'`], { detached: true, stdio: 'ignore' }).unref();
      return real;
    });
    const started = Date.now();
    expect(readActionMetadata(action)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
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
