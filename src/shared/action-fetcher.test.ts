import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as childProcess from 'child_process';
import { execFileSync, spawn } from 'child_process';
import * as containedPath from './contained-path';
import {
  parseActionRef,
  readActionMetadata,
  resolveActionPath,
  fetchAction,
  getCachedAction,
  cleanActionCache,
  listCachedActions,
  getActionsCacheDir,
} from './action-fetcher';

// Held so a test can act between the containment check and the read, as a
// process a step left running could.
jest.mock('./contained-path', () => {
  const actual = jest.requireActual<typeof import('./contained-path')>('./contained-path');
  return { ...actual, resolveWithin: jest.fn(actual.resolveWithin) };
});
const resolveWithin = jest.mocked(containedPath.resolveWithin);

// Held so a test can stand in for curl and tar: fetching never touches the
// network here, and what the fetcher asks of them can be read back.
jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: jest.fn(actual.spawn) };
});
const spawnMock = jest.mocked(childProcess.spawn);
const actualSpawn = jest.requireActual<typeof import('child_process')>('child_process').spawn;
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
    // parseActionRef now refuses it too; this is the second line of defence.
    expect(() => resolveActionPath(actionDir, '../../../..')).toThrow(/outside its repository/);
  });

  it('refuses a symlink the repository ships that leads out of it', () => {
    fs.symlinkSync(scratch, path.join(actionDir, 'escape'));
    expect(() => resolveActionPath(actionDir, 'escape')).toThrow(/outside its repository/);
  });
});

/**
 * Stand-ins for curl and tar, recording how they were called. tar "extracts"
 * by running `extract` on its -C directory; without one it fails, as it does
 * when the download was not an archive.
 */
function fakeDownloads(extract?: (dest: string) => void): string[][] {
  const calls: string[][] = [];
  spawnMock.mockImplementation(((command: string, args: string[]) => {
    calls.push([command, ...args]);
    const proc = Object.assign(new EventEmitter(), {
      stdout: { pipe: () => undefined },
      stderr: new EventEmitter(),
      stdin: {},
    });
    if (command === 'tar') {
      setImmediate(() => {
        if (extract) extract(args[args.indexOf('-C') + 1]);
        proc.emit('close', extract ? 0 : 1);
      });
    }
    return proc;
  }) as unknown as typeof childProcess.spawn);
  return calls;
}

const extractAction = (sub = '') => (dest: string) => {
  fs.mkdirSync(path.join(dest, sub), { recursive: true });
  fs.writeFileSync(path.join(dest, sub, 'action.yml'), 'name: x\nruns:\n  using: node20\n');
};

describe('action references and the action cache', () => {
  let configDir: string;
  const savedConfigDir = process.env.LOCALMOST_CONFIG_DIR;
  const indexPath = () => path.join(getActionsCacheDir(), 'index.json');

  beforeEach(() => {
    configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'action-cache-')));
    process.env.LOCALMOST_CONFIG_DIR = configDir;
    fs.writeFileSync(path.join(configDir, 'sentinel'), 'keep me\n');
  });

  afterEach(() => {
    spawnMock.mockImplementation(actualSpawn);
    if (savedConfigDir === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
    else process.env.LOCALMOST_CONFIG_DIR = savedConfigDir;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('refuses a reference whose parts could name a directory outside the cache', () => {
    // The owner, repo and version each become a directory under the cache,
    // and that directory is removed before a fetch.
    for (const uses of [
      'a/..@..',
      'a/../..@..',
      '..x/repo@v1',
      'a/.@v1',
      'a/repo@../../..',
      'a/repo@v1/..',
      'a/repo@.',
      'a/repo@-v1',
      'a/repo@v1//x',
      'a/repo/../..@v1',
      'a/repo/sub/./x@v1',
      'a/repo/sub/@v1',
      'a/repo@v1 x',
      'a/repo@v1?x=1',
    ]) {
      expect({ uses, ref: parseActionRef(uses) }).toEqual({ uses, ref: null });
    }
  });

  it('still parses the references workflows use', () => {
    expect(parseActionRef('actions/checkout@v4')).toEqual({ owner: 'actions', repo: 'checkout', version: 'v4', path: undefined });
    expect(parseActionRef('actions/cache/save@v3')).toMatchObject({ repo: 'cache', path: 'save' });
    expect(parseActionRef('owner/.github/actions/lint@releases/v1.2.0')).toMatchObject({
      repo: '.github',
      path: 'actions/lint',
      version: 'releases/v1.2.0',
    });
    expect(parseActionRef(`owner/repo@${'a'.repeat(40)}`)).toMatchObject({ version: 'a'.repeat(40) });
  });

  it('never removes anything outside the cache, however the reference was built', async () => {
    // cache/a/../.. is the app data directory itself; one more .. is $HOME.
    const calls = fakeDownloads(extractAction());
    fs.mkdirSync(path.join(getActionsCacheDir(), 'a'), { recursive: true });
    for (const ref of [
      { owner: 'a', repo: '..', version: '..' },
      { owner: 'a', repo: 'r', version: '../../..' },
      { owner: '..', repo: '..', version: 'v1' },
      { owner: 'a', repo: 'r', version: 'v1', path: '..' },
    ]) {
      await expect(fetchAction(ref)).rejects.toThrow();
    }
    expect(fs.readFileSync(path.join(configDir, 'sentinel'), 'utf-8')).toBe('keep me\n');
    expect(calls).toEqual([]);
  });

  it('fetches into the cache and serves the entry it wrote', async () => {
    fakeDownloads(extractAction());
    const ref = { owner: 'o', repo: 'r', version: 'v1' };
    const fetched = await fetchAction(ref);
    expect(fetched.localPath.startsWith(fs.realpathSync(getActionsCacheDir()) + path.sep)).toBe(true);
    expect(getCachedAction(ref)?.localPath).toBe(fetched.localPath);
    expect(listCachedActions().map((c) => c.localPath)).toEqual([fetched.localPath]);
  });

  it('believes nothing in the index but a fetch time that has passed', async () => {
    // The index is a file. Where an entry says its action lives is not
    // taken from it, and a fetch time in the future would keep an entry
    // fresh forever.
    fakeDownloads(extractAction());
    const ref = { owner: 'o', repo: 'r', version: 'v1' };
    const fetched = await fetchAction(ref);
    const outside = path.join(configDir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'action.yml'), 'name: planted\n');
    const forge = (entry: Record<string, unknown>) =>
      fs.writeFileSync(indexPath(), JSON.stringify({ 'o/r@v1': { ref, fetchedAt: new Date().toISOString(), ...entry } }));

    forge({ localPath: outside });
    expect(getCachedAction(ref)?.localPath).toBe(fetched.localPath);
    expect((await fetchAction(ref)).localPath).toBe(fetched.localPath);
    expect(listCachedActions().map((c) => c.localPath)).toEqual([fetched.localPath]);

    forge({ localPath: fetched.localPath, fetchedAt: '2999-01-01T00:00:00Z' });
    expect(getCachedAction(ref)).toBeNull();
    forge({ localPath: fetched.localPath, fetchedAt: 'not a date' });
    expect(getCachedAction(ref)).toBeNull();
  });

  it('cleans only inside the cache, whatever the index says', () => {
    const outside = path.join(configDir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'x');
    fs.mkdirSync(getActionsCacheDir(), { recursive: true });
    const old = '2000-01-01T00:00:00Z';
    fs.writeFileSync(
      indexPath(),
      JSON.stringify({
        'o/r@v1': { ref: { owner: 'o', repo: 'r', version: 'v1' }, localPath: outside, fetchedAt: old },
        'a/..@..': { ref: { owner: 'a', repo: '..', version: '..' }, localPath: configDir, fetchedAt: old },
        'x/y@v1': { ref: { owner: 'x', repo: '..', version: 'v1' }, localPath: outside, fetchedAt: old },
      })
    );
    cleanActionCache();
    expect(fs.readFileSync(path.join(outside, 'keep'), 'utf-8')).toBe('x');
    expect(fs.readFileSync(path.join(configDir, 'sentinel'), 'utf-8')).toBe('keep me\n');
    expect(JSON.parse(fs.readFileSync(indexPath(), 'utf-8'))).toEqual({});
  });

  it('fetches a SHA-pinned action from the archive of that commit', async () => {
    // refs/<sha>.tar.gz is not a URL GitHub serves, so pinning an action to
    // a commit - the form supply-chain guidance recommends - could not run.
    const sha = 'a'.repeat(40);
    const calls = fakeDownloads(extractAction());
    await fetchAction({ owner: 'o', repo: 'r', version: sha });
    const urls = calls.filter(([command]) => command === 'curl').map((call) => call[call.length - 1]);
    expect(urls).toEqual([`https://github.com/o/r/archive/${sha}.tar.gz`]);
  });

  it('tries a tag, then a branch, over HTTPS only and failing on an error page', async () => {
    const calls = fakeDownloads();
    await expect(fetchAction({ owner: 'o', repo: 'r', version: 'releases/v1' })).rejects.toThrow();
    const curls = calls.filter(([command]) => command === 'curl');
    expect(curls.map((call) => call[call.length - 1])).toEqual([
      'https://github.com/o/r/archive/refs/tags/releases/v1.tar.gz',
      'https://github.com/o/r/archive/refs/heads/releases/v1.tar.gz',
    ]);
    for (const call of curls) {
      // -f: an error page is not an archive; --proto: a redirect cannot
      // downgrade the fetch to plain HTTP.
      expect(call.slice(1, -1)).toEqual(['-sSfL', '--proto', '=https', '--proto-redir', '=https', '--']);
    }
  });

  it('removes the whole of an expired action from the cache', async () => {
    fakeDownloads(extractAction('sub'));
    const fetched = await fetchAction({ owner: 'o', repo: 'r', version: 'v1', path: 'sub' });
    const index = JSON.parse(fs.readFileSync(indexPath(), 'utf-8'));
    for (const entry of Object.values(index) as Array<{ fetchedAt: string }>) entry.fetchedAt = '2000-01-01T00:00:00Z';
    fs.writeFileSync(indexPath(), JSON.stringify(index));

    expect(cleanActionCache()).toEqual({ removed: 1, kept: 0 });
    // The extracted repository goes, not only the action's subdirectory in it.
    expect(fs.existsSync(path.dirname(fetched.localPath))).toBe(false);
  });
});
