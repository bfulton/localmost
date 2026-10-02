/**
 * What `localmost status` prints, from the app's status reply.
 */

import { pauseReplacesStatus, resourcePauseOverriddenLine } from '../shared/resource-pause-text';
import type { StatusResponse } from '../shared/cli-protocol';

export function getStatusIcon(status: string): string {
  switch (status) {
    case 'listening': return '\u2713'; // checkmark
    case 'busy': return '\u25CF';    // filled circle
    case 'starting': return '\u25CB'; // empty circle
    case 'offline': return '\u25CB'; // empty circle
    case 'shutting_down': return '\u25CB'; // empty circle
    case 'error': return '\u2717';   // x mark
    case 'completed': return '\u2713';
    case 'failed': return '\u2717';
    case 'cancelled': return '-';
    default: return '?';
  }
}

/** The lines of `localmost status`, blank lines around them included. */
export function formatStatus(data: StatusResponse['data']): string[] {
  const { runner, runnerName, heartbeat, authenticated, authExpired, userName, resourcePause, runnerStarted } = data;
  const lines: string[] = [''];

  // GitHub status (matches Status Page order)
  if (authenticated) {
    lines.push(`GitHub:    Connected as @${userName || 'unknown'}`);
  } else if (authExpired) {
    lines.push(`GitHub:    Session expired for @${userName || 'unknown'}`);
    lines.push(`           Reconnect in the app: Settings > Reconnect`);
  } else {
    lines.push(`GitHub:    Not connected`);
  }

  // Runner status
  let runnerStatusText: string;
  let runnerIcon: string;
  const pauseText = `Paused (${resourcePause?.reason || 'resource constraint'})`;
  const pauseInPlace = pauseReplacesStatus(!!resourcePause?.isPaused, runnerStarted);

  if (pauseInPlace) {
    runnerIcon = '\u23F8'; // pause symbol
    runnerStatusText = pauseText;
  } else {
    runnerIcon = getStatusIcon(runner.status);
    // Capitalize status to match UI
    const statusMap: Record<string, string> = {
      'offline': 'Offline',
      'starting': 'Starting',
      'listening': 'Listening',
      'busy': 'Running job',
      'error': 'Error',
      'shutting_down': 'Shutting down',
    };
    runnerStatusText = statusMap[runner.status] || runner.status;
  }

  lines.push(`Runner:    ${runnerIcon} ${runnerStatusText}`);
  lines.push(`           ${runnerName}`);
  // A pause on a runner that is not started or starting, beside its status.
  if (resourcePause?.isPaused && !pauseInPlace) {
    lines.push(`           \u23F8 ${pauseText}`);
  }
  // A resume that overrode a resource pause, until its condition clears.
  const overriddenLine = resourcePauseOverriddenLine(resourcePause);
  if (overriddenLine) {
    lines.push(`           ${overriddenLine}`);
  }

  // Job status
  if (runner.status === 'busy' && runner.jobName) {
    lines.push(`Job:       Running`);
    lines.push(`           ${runner.jobName}`);
  } else {
    lines.push(`Job:       Inactive`);
  }

  // Heartbeat status
  lines.push(`Heartbeat: ${heartbeat.isRunning ? 'Active' : 'Inactive'}`);

  lines.push('');
  return lines;
}
