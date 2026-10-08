import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { cleanupSandboxDirectories } from './runner-cleanup';

describe('cleanupSandboxDirectories', () => {
  let root: string;
  let sandboxBase: string;
  let victim: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sweep-'));
    sandboxBase = path.join(root, 'sandbox');
    victim = path.join(root, 'victim');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'keep'), 'kept');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const sandbox = (name: string): string => {
    const dir = path.join(sandboxBase, name);
    fs.mkdirSync(path.join(dir, '_work'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_work', 'output'), 'job');
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

  /**
   * That nothing walked a tree by path: apart from moving a sandbox aside,
   * no call used a path more than one entry below a directory named for
   * removal in the sandbox base, which only the app writes - so no link
   * swapped in anywhere in the tree could be followed.
   */
  const expectNoWalkByPath = (calls: Array<{ op: string; paths: string[] }>, base: string) => {
    for (const { op, paths } of calls) {
      expect(op).not.toBe('rm');
      for (const p of paths) {
        const rel = path.relative(base, p).split(path.sep);
        if (rel[0] === '') continue;
        if (rel[0].startsWith('.removing-')) {
          expect(rel.length).toBeLessThanOrEqual(2);
        } else {
          expect([op, rel.length]).toEqual(['rename', 1]);
        }
      }
    }
  };

  it('moves each sandbox out of its path before removing it', async () => {
    // Whatever of an earlier run's jobs outlived the kill before this sweep
    // still writes its sandbox's path; see removeSandbox.
    const dirs = [sandbox('1-abc123'), sandbox('2-def456')];
    for (const dir of dirs) fs.mkdirSync(path.join(dir, '_work', 'repo', 'src'), { recursive: true });
    const calls = recordRemovalCalls();

    await cleanupSandboxDirectories(sandboxBase, () => undefined);

    for (const dir of dirs) {
      const touching = calls.filter(({ paths }) => paths.some((p) => p === dir || p.startsWith(`${dir}/`)));
      expect(touching).toHaveLength(1);
      expect(touching[0].op).toBe('rename');
      const to = touching[0].paths[1];
      expect(path.dirname(to)).toBe(sandboxBase);
      expect(path.basename(to).startsWith('.removing-')).toBe(true);
    }
    expectNoWalkByPath(calls, sandboxBase);
    expect(fs.readdirSync(sandboxBase)).toEqual([]);
  });

  it('leaves a sandbox where it is when it cannot be moved out of its path', async () => {
    const dir = sandbox('1-abc123');
    const calls = recordRemovalCalls();
    jest.spyOn(fs.promises, 'rename').mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    );
    const logged: string[] = [];

    await cleanupSandboxDirectories(sandboxBase, (message) => logged.push(message));

    expect(calls.filter(({ paths }) => paths.some((p) => p === dir || p.startsWith(`${dir}/`)))).toEqual([]);
    expect(fs.readFileSync(path.join(dir, '_work', 'output'), 'utf-8')).toBe('job');
    // Startup is the only caller: nothing retries sooner than the next launch
    expect(logged.some((message) => message.includes('1-abc123') && /next launch/.test(message))).toBe(true);
    expect(logged.some((message) => /retry/.test(message))).toBe(false);
  });

  it('finishes a removal an earlier run left part done', async () => {
    const aside = path.join(sandboxBase, '.removing-1-abc123.0a1b2c3d');
    fs.mkdirSync(path.join(aside, '_work'), { recursive: true });
    fs.writeFileSync(path.join(aside, '_work', 'output'), 'job');

    await cleanupSandboxDirectories(sandboxBase, () => undefined);

    expect(fs.readdirSync(sandboxBase)).toEqual([]);
  });

  it('never follows a link planted at or in a sandbox', async () => {
    const linkedFrom = sandbox('1-abc123');
    fs.symlinkSync(victim, path.join(linkedFrom, '_work', 'link'));
    fs.symlinkSync(victim, path.join(sandboxBase, '2-def456'));

    await cleanupSandboxDirectories(sandboxBase, () => undefined);

    expect(fs.readFileSync(path.join(victim, 'keep'), 'utf-8')).toBe('kept');
    expect(fs.existsSync(linkedFrom)).toBe(false);
  });

  it('removes an empty directory in a sandbox that it cannot move out of the tree', async () => {
    // Moving a directory to another parent needs write on it, which a job
    // can take away; an empty one is still removed where it is.
    const dir = sandbox('1-abc123');
    fs.mkdirSync(path.join(dir, '_work', 'sealed'));
    fs.chmodSync(path.join(dir, '_work', 'sealed'), 0o555);

    await cleanupSandboxDirectories(sandboxBase, () => undefined);

    expect(fs.readdirSync(sandboxBase)).toEqual([]);
  });

  it('never follows a link a writer outside every job profile swaps in while it removes a sandbox', async () => {
    // A container a job started writes the workspace it bind-mounts through
    // its Docker VM's virtiofs share, under no job's profile, so moving the
    // sandbox aside does not stop it. Here a shell working in the sandbox,
    // which follows the tree wherever it is moved, stands in for it: it
    // swaps each directory there for a link to the user's files, and back,
    // as fast as it can. A walk by path loses that race most times it runs;
    // one that never follows a link cannot lose it at all.
    for (let k = 0; k < 50; k++) fs.writeFileSync(path.join(victim, `v${k}`), 'x');
    for (let attempt = 0; attempt < 20; attempt++) {
      const dir = sandbox(`${attempt + 1}-abc123`);
      for (let j = 0; j < 20; j++) {
        fs.mkdirSync(path.join(dir, '_work', `d${j}`));
        for (let k = 0; k < 50; k++) fs.writeFileSync(path.join(dir, '_work', `d${j}`, `v${k}`), 'x');
      }
      const writer = spawn('/bin/bash', ['-c', `
        cd '${path.join(dir, '_work')}' || exit 1
        echo ready
        while :; do
          for j in $(seq 0 19); do
            mv d$j t$j 2>/dev/null && ln -s '${victim}' d$j 2>/dev/null; rm -f d$j 2>/dev/null; mv t$j d$j 2>/dev/null
          done
        done`], { stdio: ['ignore', 'pipe', 'ignore'] });
      const exited = new Promise((resolve) => writer.on('exit', resolve));
      try {
        await new Promise<void>((resolve, reject) => {
          writer.stdout!.on('data', () => resolve());
          exited.then(() => reject(new Error('the writer exited before it was in place')));
        });
        await cleanupSandboxDirectories(sandboxBase, () => undefined);
      } finally {
        writer.kill('SIGKILL');
        await exited;
      }

      expect(fs.readdirSync(victim)).toHaveLength(51);
      expect(fs.existsSync(dir)).toBe(false);
    }
    // With the writer gone, whatever it kept from being removed goes.
    await cleanupSandboxDirectories(sandboxBase, () => undefined);
    expect(fs.readdirSync(sandboxBase)).toEqual([]);
  }, 60000);
});
