/**
 * Cleaning up workspaces on a real filesystem.
 *
 * A workspace's metadata file lives inside the workspace, which every step of
 * the run it holds can write. Cleanup used to take the directory to delete
 * from that file.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
    // A writer swaps d0 for a link to the user's files once the removal has
    // begun listing the tree - the race a real one would have to win, won
    // here every time.
    const realReaddir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    let swapped = false;
    jest.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: unknown[]) => {
      const d0 = path.join(String(args[0]), 'd0');
      if (!swapped && fs.existsSync(d0)) {
        fs.renameSync(d0, path.join(appData, 'd0.moved'));
        fs.symlinkSync(victim, d0);
        swapped = true;
      }
      return realReaddir(...args);
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
