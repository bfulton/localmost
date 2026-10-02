/**
 * `localmost test` ends what a job's steps left running when the job ends,
 * as GitHub does, and again when the run ends.
 *
 * Each step's own processes are reaped when the step exits; these reaps are
 * for the rest - a server a step started in the background, or anything that
 * left its group - which would otherwise carry into the next job's steps, or
 * outlive the run holding the workspace and its loopback ports.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as stepExecutor from '../shared/step-executor';
import type { StepResult } from '../shared/step-executor';
import { runTest } from './test';

// Stands in for the steps and the reaper, recording the order they ran in;
// everything else a run does is the real thing.
jest.mock('../shared/step-executor', () => {
  const actual = jest.requireActual<typeof import('../shared/step-executor')>('../shared/step-executor');
  return { ...actual, executeStep: jest.fn(), reapStepProcesses: jest.fn() };
});
const executeStepMock = jest.mocked(stepExecutor.executeStep);
const reapMock = jest.mocked(stepExecutor.reapStepProcesses);

let scratch: string;
let checkout: string;
let events: string[];
const originalCwd = process.cwd();
const savedConfigDir = process.env.LOCALMOST_CONFIG_DIR;

// The steps and the reaper are stood in for, but the rest of a run is real:
// git for the checkout's identity and its listing, and a copy of it as the
// workspace, each a process of its own. On a loaded machine - CI runs this
// suite inside a job, beside other jobs - that takes seconds, the first git
// of a job longest, while xcrun fills the cache it looks git up through.
const RUN_TIMEOUT_MS = 60_000;

function writeWorkflow(name: string, content: string): void {
  fs.writeFileSync(path.join(checkout, '.github', 'workflows', name), content);
}

beforeEach(() => {
  const build = path.join(originalCwd, 'build');
  fs.mkdirSync(build, { recursive: true });
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(build, 'job-reap-')));
  process.env.LOCALMOST_CONFIG_DIR = path.join(scratch, 'appdata');
  checkout = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(checkout, '.github', 'workflows'), { recursive: true });
  process.chdir(checkout);
  jest.spyOn(console, 'log').mockImplementation(() => {});

  events = [];
  reapMock.mockImplementation(() => {
    events.push('reap');
  });
  executeStepMock.mockImplementation(async (step) => {
    const name = step.name ?? '';
    events.push(name);
    if (name.startsWith('throws')) throw new Error(`${name} threw`);
    const result: StepResult = { name, status: name.startsWith('fails') ? 'failure' : 'success', duration: 0, outputs: {} };
    return result;
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  jest.mocked(console.log).mockRestore();
  executeStepMock.mockReset();
  reapMock.mockReset();
  if (savedConfigDir === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
  else process.env.LOCALMOST_CONFIG_DIR = savedConfigDir;
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('runTest reaping at the end of each job', () => {
  it('reaps after each job, each job a reusable workflow calls, and the run', async () => {
    writeWorkflow(
      'ci.yml',
      [
        'name: CI',
        'on: push',
        'jobs:',
        '  first:',
        '    runs-on: macos-latest',
        '    steps:',
        '      - name: first-1',
        '        run: "true"',
        '      - name: first-2',
        '        run: "true"',
        '  called:',
        '    needs: first',
        '    uses: ./.github/workflows/called.yml',
        '',
      ].join('\n')
    );
    writeWorkflow(
      'called.yml',
      [
        'name: Called',
        'on: workflow_call',
        'jobs:',
        '  one:',
        '    runs-on: macos-latest',
        '    steps:',
        '      - name: one-1',
        '        run: "true"',
        '  two:',
        '    needs: one',
        '    runs-on: macos-latest',
        '    steps:',
        '      - name: two-1',
        '        run: "true"',
        '',
      ].join('\n')
    );

    expect((await runTest({ assumeYes: true })).success).toBe(true);
    // Nothing a job left running is there when the next job's first step starts.
    expect(events).toEqual(['first-1', 'first-2', 'reap', 'one-1', 'reap', 'two-1', 'reap', 'reap']);
  }, RUN_TIMEOUT_MS);

  it('reaps after a job whose step failed or threw, before anything else runs', async () => {
    writeWorkflow(
      'ci.yml',
      [
        'name: CI',
        'on: push',
        'jobs:',
        '  first:',
        '    runs-on: macos-latest',
        '    steps:',
        '      - name: fails-1',
        '        run: "false"',
        '  second:',
        '    runs-on: macos-latest',
        '    steps:',
        '      - name: throws-1',
        '        run: "true"',
        '      - name: never',
        '        run: "true"',
        '',
      ].join('\n')
    );

    await expect(runTest({ assumeYes: true })).rejects.toThrow('throws-1 threw');
    // The job's own reap, then the run's on the way out.
    expect(events).toEqual(['fails-1', 'reap', 'throws-1', 'reap', 'reap']);
  }, RUN_TIMEOUT_MS);

  it('reaps after a called job whose step threw', async () => {
    writeWorkflow(
      'ci.yml',
      'name: CI\non: push\njobs:\n  called:\n    uses: ./.github/workflows/called.yml\n'
    );
    writeWorkflow(
      'called.yml',
      [
        'name: Called',
        'on: workflow_call',
        'jobs:',
        '  one:',
        '    runs-on: macos-latest',
        '    steps:',
        '      - name: throws-1',
        '        run: "true"',
        '',
      ].join('\n')
    );

    await expect(runTest({ assumeYes: true })).rejects.toThrow('throws-1 threw');
    expect(events).toEqual(['throws-1', 'reap', 'reap']);
  }, RUN_TIMEOUT_MS);
});
