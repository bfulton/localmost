import { jest, describe, it, expect, beforeEach } from '@jest/globals';

let runnerState: { status: string; jobName?: string } = { status: 'listening' };
jest.mock('../../app-state', () => ({ getRunnerState: () => runnerState }));
jest.mock('../../runner-state-service', () => ({
  onStateChange: () => () => undefined,
  getEffectivePauseState: () => ({ isPaused: false, reason: null }),
  selectEffectivePauseState: () => ({ isPaused: false, reason: null }),
}));

import { store } from '../index';
import { publishRunnerState } from './xstate-sync';

describe('publishRunnerState', () => {
  beforeEach(() => {
    runnerState = { status: 'listening' };
    publishRunnerState();
  });

  it('puts a job start in the store without waiting for a machine transition', () => {
    // Review: RunnerManager status changes reached the renderer only as an IPC
    // event, while the renderer reads the store once zubridge is ready - so
    // the store kept the last machine-transition snapshot through a job.
    runnerState = { status: 'busy', jobName: 'build' };

    publishRunnerState();

    expect(store.getState().runner.runnerState).toMatchObject({ status: 'busy', jobName: 'build' });
  });

  it('writes nothing when nothing changed, since every store write is a broadcast', () => {
    const before = store.getState().runner;

    publishRunnerState();

    expect(store.getState().runner).toBe(before);
  });
});
