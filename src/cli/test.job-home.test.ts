/**
 * `localmost test` gives a run's steps a home of their own, as the runner
 * gives a job: the workspace's `.home`, holding the hermetic git config, an
 * empty ssh config, and a link for each path the checkout's confirmed policy
 * grants under the real home - set up before any step runs in it, and never
 * the checkout's own `.home`.
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
// A stand-in real home per test, so nothing here reads or links the user's.
jest.mock('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os');
  return { ...actual, homedir: jest.fn(actual.homedir) };
});

let scratch: string;
let checkout: string;
let realHome: string;
const originalCwd = process.cwd();
const savedConfigDir = process.env.LOCALMOST_CONFIG_DIR;
// A run copies the checkout and asks git about it, each a process of its
// own; on a loaded machine that takes seconds.
const RUN_TIMEOUT_MS = 60_000;

/** A read grant there is something at in the stand-in home, and a write grant there is not. */
const readGrant = '.localmost-test-home-probe-read';
const writeGrant = '.localmost-test-home-probe-write';

beforeEach(() => {
  const build = path.join(originalCwd, 'build');
  fs.mkdirSync(build, { recursive: true });
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(build, 'job-home-')));
  process.env.LOCALMOST_CONFIG_DIR = path.join(scratch, 'appdata');
  // The real home, as the run sees it, is a stand-in: what a grant links to
  // is there or not as each test needs, and nothing of the user's is read.
  realHome = path.join(scratch, 'realhome');
  fs.mkdirSync(path.join(realHome, readGrant), { recursive: true });
  jest.mocked(os.homedir).mockReturnValue(realHome);
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
  jest.mocked(os.homedir).mockReset();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** What a step finds in its home, recorded as it runs. */
interface SeenHome {
  isOwnDirectory: boolean;
  gitConfig: string;
  sshConfig: string;
  entries: string[];
  links: Record<string, string>;
}

const recordHome = (): { seen: () => SeenHome | undefined } => {
  let seen: SeenHome | undefined;
  executeStepMock.mockImplementation(async (step, ctx) => {
    const home = path.join(ctx.workDir, '.home');
    const stat = fs.lstatSync(home);
    const entries = fs.readdirSync(home).sort();
    seen = {
      isOwnDirectory: stat.isDirectory() && !stat.isSymbolicLink(),
      gitConfig: fs.readFileSync(path.join(home, '.gitconfig'), 'utf-8'),
      sshConfig: fs.readFileSync(path.join(home, '.ssh', 'config'), 'utf-8'),
      entries,
      links: Object.fromEntries(
        entries.filter((name) => fs.lstatSync(path.join(home, name)).isSymbolicLink()).map((name) => [name, fs.readlinkSync(path.join(home, name))])
      ),
    };
    const result: StepResult = { name: step.name ?? '', status: 'success', duration: 0, outputs: {} };
    return result;
  });
  return { seen: () => seen };
};

describe("a localmost test run's home", () => {
  it('is set up before the first step, with the hermetic git config and what is granted linked in', async () => {
    const { seen } = recordHome();

    expect((await runTest({ assumeYes: true })).success).toBe(true);

    expect(seen()).toEqual({
      isOwnDirectory: true,
      gitConfig: JOB_GIT_CONFIG,
      sshConfig: '',
      entries: ['.gitconfig', readGrant, '.ssh'].sort(),
      // The write grant names nothing yet, so the name is left to the step.
      links: { [readGrant]: path.join(realHome, readGrant) },
    });
    // Nor is it created: it may name a file.
    expect(fs.existsSync(path.join(realHome, writeGrant))).toBe(false);
  }, RUN_TIMEOUT_MS);

  it("is never the checkout's .home, a link to elsewhere", async () => {
    // Filled unsandboxed, the checkout's link had .gitconfig, .ssh/config
    // and the grant links written wherever it led - the user's home, say.
    const victim = path.join(scratch, 'victim');
    fs.mkdirSync(victim);
    fs.symlinkSync(victim, path.join(checkout, '.home'));
    const { seen } = recordHome();

    expect((await runTest({ assumeYes: true })).success).toBe(true);

    expect(fs.readdirSync(victim)).toEqual([]);
    expect(seen()).toMatchObject({ isOwnDirectory: true, gitConfig: JOB_GIT_CONFIG });
  }, RUN_TIMEOUT_MS);

  it("is never the checkout's .home, a directory holding a .gitconfig", async () => {
    // Copied in, its .gitconfig took the name, and every run failed with EEXIST.
    fs.mkdirSync(path.join(checkout, '.home'));
    fs.writeFileSync(path.join(checkout, '.home', '.gitconfig'), '[core]\n\tsshCommand = evil\n');
    const { seen } = recordHome();

    expect((await runTest({ assumeYes: true })).success).toBe(true);

    expect(seen()).toMatchObject({ isOwnDirectory: true, gitConfig: JOB_GIT_CONFIG });
  }, RUN_TIMEOUT_MS);
});
