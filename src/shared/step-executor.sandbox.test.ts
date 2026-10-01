/**
 * The cache intercept copying for real, through sandboxed tar.
 *
 * The unit tests hold the spawn; these let tar run under the profile it is
 * given, so what a symlink in the workspace can make it read or write is what
 * the kernel says, not what the test assumes. As in the other sandbox tests,
 * constructing a profile is impossible inside a localmost job; there the
 * assertion is that the cache fails closed rather than copying unsandboxed.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ChildProcess, execFileSync, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeStep, ExecutionContext, reapStepProcesses } from './step-executor';
import { generateSandboxProfile, MACOS_BASELINE_READ_PATHS } from './sandbox-profile';
import type { WorkflowJob, WorkflowStep } from './workflow-parser';

const canConstruct = (): boolean => {
  if (process.platform !== 'darwin') return false;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-probe-')));
  const probe = path.join(dir, 'probe.sb');
  fs.writeFileSync(
    probe,
    generateSandboxProfile({ workDir: dir, proxyPort: 1, policy: { filesystem: { read: MACOS_BASELINE_READ_PATHS } } })
  );
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-f', probe, '/usr/bin/true'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

let scratch: string;
let workDir: string;
let secret: string;

beforeEach(() => {
  // Under build/, not the temp directories every profile may read and write.
  const build = path.join(process.cwd(), 'build');
  fs.mkdirSync(build, { recursive: true });
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(build, 'cache-roundtrip-')));
  process.env.LOCALMOST_CONFIG_DIR = path.join(scratch, 'appdata');
  workDir = path.join(scratch, 'appdata', 'workspaces', 'ws-a-1');
  fs.mkdirSync(path.join(workDir, 'deps', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'deps', 'lib', 'index.js'), 'module.exports = 42;\n');
  secret = path.join(scratch, 'secrets');
  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, 'token'), 'PRIVATE KEY\n');
  // A step left a link out of the workspace inside what it caches.
  fs.symlinkSync(secret, path.join(workDir, 'deps', 'escape'));
});

afterEach(() => {
  delete process.env.LOCALMOST_CONFIG_DIR;
  fs.rmSync(scratch, { recursive: true, force: true });
});

const ctx = (): ExecutionContext => ({
  workDir,
  proxyPort: 1,
  workflowEnv: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_REF: 'refs/heads/main' },
  cacheScope: { sourceDir: '/src/checkout', repository: 'owner/repo', ref: 'refs/heads/main' },
  jobEnv: {},
  matrix: {},
  secrets: {},
  stepOutputs: {},
});
const job = { 'runs-on': 'self-hosted', steps: [] } as unknown as WorkflowJob;
const run = (step: WorkflowStep) => executeStep(step, ctx(), job);

const archives = (): string[] => {
  const root = path.join(scratch, 'appdata', 'workflow-cache');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((d) =>
    fs.readdirSync(path.join(root, d)).map((f) => path.join(root, d, f)));
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const gone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 250 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  return !alive(pid);
};

/**
 * A `ps` field of `pid`, asked again until `done` accepts it or ten seconds
 * pass, and the last answer either way. What a process does once started -
 * exec, setsid() - it does in its own time, which on a loaded machine can be
 * well after its parent has reported it started.
 */
const psUntil = async (pid: number, field: string, done: (value: string) => boolean): Promise<string> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = (spawnSync('/bin/ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf-8' }).stdout ?? '').trim();
    if (done(value) || Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** A process that is not a step's: this suite's own child, under `profile` if given. */
const bystander = (profile?: string): ChildProcess => {
  if (!profile) return spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  const profilePath = path.join(scratch, `bystander-${Date.now()}.sb`);
  fs.writeFileSync(profilePath, profile);
  return spawn('/usr/bin/sandbox-exec', ['-f', profilePath, '/bin/sleep', '60'], { stdio: 'ignore' });
};

// Everything below runs real processes - sandbox-exec, tar under it, the
// python3 sweep over every process on the machine - and waits for them. On a
// loaded machine (CI runs this suite inside a job, beside other jobs) each
// takes seconds to start, not milliseconds.
const REAL_PROCESS_TIMEOUT_MS = 60_000;

if (canConstruct()) {
  describe('what a step leaves running', () => {
    const withReads = (): ExecutionContext => ({ ...ctx(), policy: { filesystem: { read: MACOS_BASELINE_READ_PATHS } } });

    it('is killed at the end of the job even once it has left the step\'s process group', async () => {
      // setsid() takes a process out of the group the step leads, so a kill
      // of that group misses it, and it keeps its sandbox - the workspace,
      // loopback ports - for as long as it likes. Its sandbox is what it
      // cannot leave.
      const others = [bystander(), bystander('(version 1)\n(allow default)\n')];
      let survivor = 0;
      try {
        const result = await executeStep(
          { run: "/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); sleep 60' >/dev/null 2>&1 &\necho $! > survivor.pid" },
          withReads(),
          job
        );
        expect(result.status).toBe('success');
        survivor = parseInt(fs.readFileSync(path.join(workDir, 'survivor.pid'), 'utf-8'), 10);
        // Out of the step's group, and still running after the step. The
        // step reports the survivor before it has necessarily called
        // setsid(), and until it has, the kill of the step's group would take
        // it, so that is waited for; and the others are waited for until they
        // run /bin/sleep, which sandbox-exec starts only once its profile is on.
        const pgid = Number(await psUntil(survivor, 'pgid', (value) => Number(value) === survivor));
        expect(alive(survivor)).toBe(true);
        expect({ survivor, pgid }).toEqual({ survivor, pgid: survivor });
        for (const other of others) {
          const command = await psUntil(other.pid!, 'comm', (value) => value === '/bin/sleep');
          expect({ pid: other.pid, command }).toEqual({ pid: other.pid, command: '/bin/sleep' });
        }

        reapStepProcesses();

        expect(await gone(survivor)).toBe(true);
        // Nothing else: not this suite's own children, sandboxed or not.
        for (const other of others) expect(alive(other.pid!)).toBe(true);
      } finally {
        if (survivor && alive(survivor)) process.kill(survivor, 'SIGKILL');
        for (const other of others) other.kill('SIGKILL');
      }
    }, 30000);
  });

  describe('the cache intercept through sandboxed tar', () => {
    it('saves and restores the workspace paths it names, and never what a link leads to', async () => {
      await run({ uses: 'actions/cache/save@v4', with: { key: 'deps-1', path: 'deps' } });
      const [archive] = archives();
      expect(archive).toMatch(/deps-1\.tar$/);
      expect(fs.readFileSync(archive).includes('PRIVATE KEY')).toBe(false);

      fs.rmSync(path.join(workDir, 'deps'), { recursive: true });
      const result = await run({ id: 'c', uses: 'actions/cache@v4', with: { key: 'deps-1', path: 'deps' } });

      expect(result.outputs['cache-hit']).toBe('true');
      expect(fs.readFileSync(path.join(workDir, 'deps', 'lib', 'index.js'), 'utf-8')).toBe('module.exports = 42;\n');
      expect(fs.lstatSync(path.join(workDir, 'deps', 'escape')).isSymbolicLink()).toBe(true);
    }, REAL_PROCESS_TIMEOUT_MS);

    it('cannot restore through a link a step left in the workspace', async () => {
      await run({ uses: 'actions/cache/save@v4', with: { key: 'deps-2', path: 'deps' } });
      expect(archives()).toHaveLength(1);
      // Before the restore, a step swaps the directory for a link out.
      fs.rmSync(path.join(workDir, 'deps'), { recursive: true });
      fs.symlinkSync(secret, path.join(workDir, 'deps'));

      await run({ uses: 'actions/cache@v4', with: { key: 'deps-2', path: 'deps' } });

      expect(fs.readdirSync(secret)).toEqual(['token']);
    }, REAL_PROCESS_TIMEOUT_MS);
  });
} else {
  describe('the cache intercept inside a localmost job', () => {
    it('saves nothing rather than copying without a sandbox', async () => {
      await run({ uses: 'actions/cache/save@v4', with: { key: 'deps-1', path: 'deps' } });
      expect(archives()).toEqual([]);
    }, REAL_PROCESS_TIMEOUT_MS);
  });

  describe('reaping inside a localmost job', () => {
    it('never takes the job\'s own sandbox for a step\'s', async () => {
      // Here every process, this suite included, runs under the job's
      // profile, which can read the app's data under the checkout. A step
      // cannot be started, but the reap that follows must still find nothing.
      const other = bystander();
      try {
        await executeStep({ run: 'true' }, ctx(), job);
        reapStepProcesses();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(alive(other.pid!)).toBe(true);
        expect(alive(process.pid)).toBe(true);
      } finally {
        other.kill('SIGKILL');
      }
    }, REAL_PROCESS_TIMEOUT_MS);
  });
}
