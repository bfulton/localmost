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
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeStep, ExecutionContext } from './step-executor';
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

if (canConstruct()) {
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
    });

    it('cannot restore through a link a step left in the workspace', async () => {
      await run({ uses: 'actions/cache/save@v4', with: { key: 'deps-2', path: 'deps' } });
      expect(archives()).toHaveLength(1);
      // Before the restore, a step swaps the directory for a link out.
      fs.rmSync(path.join(workDir, 'deps'), { recursive: true });
      fs.symlinkSync(secret, path.join(workDir, 'deps'));

      await run({ uses: 'actions/cache@v4', with: { key: 'deps-2', path: 'deps' } });

      expect(fs.readdirSync(secret)).toEqual(['token']);
    });
  });
} else {
  describe('the cache intercept inside a localmost job', () => {
    it('saves nothing rather than copying without a sandbox', async () => {
      await run({ uses: 'actions/cache/save@v4', with: { key: 'deps-1', path: 'deps' } });
      expect(archives()).toEqual([]);
    });
  });
}
