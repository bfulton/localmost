/**
 * `localmost test` gives a run's steps a home of their own, as the runner
 * gives a job: the workspace's `.home`, holding the hermetic git config, an
 * empty ssh config, and a link for each path the checkout's confirmed policy
 * grants under the real home - set up before any step runs in it.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as stepExecutor from '../shared/step-executor';
import type { StepResult } from '../shared/step-executor';
import { JOB_GIT_CONFIG } from '../shared/job-home';
import { runTest } from './test';

// Stands in for the steps, which record what their home held when they ran;
// everything else a run does is the real thing.
jest.mock('../shared/step-executor', () => {
  const actual = jest.requireActual<typeof import('../shared/step-executor')>('../shared/step-executor');
  return { ...actual, executeStep: jest.fn(), reapStepProcesses: jest.fn() };
});
const executeStepMock = jest.mocked(stepExecutor.executeStep);

let scratch: string;
let checkout: string;
const originalCwd = process.cwd();
const savedConfigDir = process.env.LOCALMOST_CONFIG_DIR;
// A run copies the checkout and asks git about it, each a process of its
// own; on a loaded machine that takes seconds.
const RUN_TIMEOUT_MS = 60_000;

/** Names under the real home nothing on this machine has: linked, never created. */
const readGrant = '.localmost-test-home-probe-read';
const writeGrant = '.localmost-test-home-probe-write';

beforeEach(() => {
  const build = path.join(originalCwd, 'build');
  fs.mkdirSync(build, { recursive: true });
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(build, 'job-home-')));
  process.env.LOCALMOST_CONFIG_DIR = path.join(scratch, 'appdata');
  checkout = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(checkout, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(
    path.join(checkout, '.github', 'workflows', 'ci.yml'),
    ['name: CI', 'on: push', 'jobs:', '  only:', '    runs-on: macos-latest', '    steps:', '      - name: look', '        run: "true"', ''].join('\n')
  );
  fs.writeFileSync(
    path.join(checkout, '.localmostrc'),
    ['version: 1', 'shared:', '  filesystem:', `    read: ["~/${readGrant}"]`, `    write: ["~/${writeGrant}"]`, ''].join('\n')
  );
  process.chdir(checkout);
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  jest.mocked(console.log).mockRestore();
  executeStepMock.mockReset();
  if (savedConfigDir === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
  else process.env.LOCALMOST_CONFIG_DIR = savedConfigDir;
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("a localmost test run's home", () => {
  it('is set up before the first step, with the hermetic git config and the grants linked in', async () => {
    let seen: { gitConfig: string; sshConfig: string; links: Record<string, string> } | undefined;
    executeStepMock.mockImplementation(async (step, ctx) => {
      const home = path.join(ctx.workDir, '.home');
      seen = {
        gitConfig: fs.readFileSync(path.join(home, '.gitconfig'), 'utf-8'),
        sshConfig: fs.readFileSync(path.join(home, '.ssh', 'config'), 'utf-8'),
        links: Object.fromEntries(
          [readGrant, writeGrant].map((name) => [name, fs.readlinkSync(path.join(home, name))])
        ),
      };
      const result: StepResult = { name: step.name ?? '', status: 'success', duration: 0, outputs: {} };
      return result;
    });

    expect((await runTest({ assumeYes: true })).success).toBe(true);

    expect(seen).toEqual({
      gitConfig: JOB_GIT_CONFIG,
      sshConfig: '',
      links: {
        [readGrant]: path.join(os.homedir(), readGrant),
        [writeGrant]: path.join(os.homedir(), writeGrant),
      },
    });
    // Linked, not created: the real home is not touched.
    expect(fs.existsSync(path.join(os.homedir(), writeGrant))).toBe(false);
  }, RUN_TIMEOUT_MS);
});
