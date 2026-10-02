import { describe, it, expect } from '@jest/globals';
import { formatStatus } from './status';
import type { StatusResponse } from '../shared/cli-protocol';

const data = (overrides: Partial<StatusResponse['data']> = {}): StatusResponse['data'] => ({
  runner: { status: 'listening' },
  runnerName: 'localmost.test',
  heartbeat: { isRunning: false },
  authenticated: true,
  userName: 'someone',
  runnerStarted: true,
  ...overrides,
});

/** The runner's lines: its status and the lines under it. */
const runnerLines = (lines: string[]): string[] => {
  const start = lines.findIndex((line) => line.startsWith('Runner:'));
  const end = lines.findIndex((line) => line.startsWith('Job:'));
  return lines.slice(start, end);
};

describe('formatStatus', () => {
  it('shows a pause in place of the status of a started runner', () => {
    const lines = formatStatus(data({
      resourcePause: { isPaused: true, reason: 'Battery at 20%', conditions: [] },
    }));

    expect(runnerLines(lines)).toEqual([
      'Runner:    \u23F8 Paused (Battery at 20%)',
      '           localmost.test',
    ]);
  });

  it('shows the error of a runner that failed to start, with a pause beside it', () => {
    // The monitor records a pause whatever state the runner is in, and a
    // pause read first hid the error: a start that failed on battery said
    // "Paused (Battery at 20%)" until the Mac was plugged in.
    const lines = formatStatus(data({
      runner: { status: 'error' },
      runnerStarted: false,
      resourcePause: { isPaused: true, reason: 'Battery at 20%', conditions: [] },
    }));

    expect(runnerLines(lines)).toEqual([
      'Runner:    \u2717 Error',
      '           localmost.test',
      '           \u23F8 Paused (Battery at 20%)',
    ]);
  });

  it('shows a runner that is not started as offline, with a pause beside it', () => {
    const lines = formatStatus(data({
      runner: { status: 'offline' },
      runnerStarted: false,
      resourcePause: { isPaused: true, reason: 'Video call detected', conditions: [] },
    }));

    expect(runnerLines(lines)).toEqual([
      'Runner:    \u25CB Offline',
      '           localmost.test',
      '           \u23F8 Paused (Video call detected)',
    ]);
  });

  it('shows the pause in place of the status for an app that does not say whether the runner is started', () => {
    const lines = formatStatus(data({
      runnerStarted: undefined,
      resourcePause: { isPaused: true, reason: 'Battery at 20%', conditions: [] },
    }));

    expect(runnerLines(lines)[0]).toBe('Runner:    \u23F8 Paused (Battery at 20%)');
  });

  it('shows a resource pause a resume overrode under the runner', () => {
    const lines = formatStatus(data({
      resourcePause: { isPaused: false, reason: null, conditions: [], overridden: 'battery power' },
    }));

    expect(runnerLines(lines)).toEqual([
      'Runner:    \u2713 Listening',
      '           localmost.test',
      '           Resumed (resource pause overridden until battery power clears)',
    ]);
  });
});
