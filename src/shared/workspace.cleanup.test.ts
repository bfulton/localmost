/**
 * Cleaning up workspaces on a real filesystem.
 *
 * A workspace's metadata file lives inside the workspace, which every step of
 * the run it holds can write. Cleanup used to take the directory to delete
 * from that file.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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
  it('deletes the workspace directory it found, never a path its metadata names', () => {
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

    const { removed } = cleanupWorkspaces({ maxAgeHours: 24, maxCount: 10 });

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

  it('refuses to remove anything that is not a workspace directory', () => {
    const outside = path.join(appData, 'appdata', 'policies');
    fs.mkdirSync(outside, { recursive: true });
    for (const id of ['../policies', '..', '.', '', 'ws-../../policies']) {
      expect(removeWorkspace(id)).toBe(false);
    }
    expect(fs.existsSync(outside)).toBe(true);
  });
});
