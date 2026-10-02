/**
 * How the tray, `localmost resume` and `localmost status` say that a manual
 * resume overrode a resource pause, in the same words.
 */

import type { ResourcePauseState } from './types';

/** `overridden` is the condition, as ResourcePauseState.overridden gives it. */
export const resourcePauseOverriddenText = (overridden: string): string =>
  `Resumed (resource pause overridden until ${overridden} clears)`;

/**
 * The line to show for a resource pause a resume overrode, while its
 * condition holds; null when there is none, or while the runner is paused
 * anyway and the pause is what to show.
 */
export const resourcePauseOverriddenLine = (state: ResourcePauseState | undefined): string | null =>
  state && !state.isPaused && state.overridden ? resourcePauseOverriddenText(state.overridden) : null;

/**
 * Whether a pause is shown in place of the runner's status, as it is while
 * the runner is started or starting: that is the runner it holds, and what
 * Resume acts on. The monitor's pause is recorded in any state, and read
 * first it hid a runner in error behind "Battery at 20%" until the Mac was
 * plugged in; outside those states the status is shown, and the pause beside
 * it. `runnerStarted` absent, from an app that does not say, counts as
 * started.
 */
export const pauseReplacesStatus = (isPaused: boolean, runnerStarted: boolean | undefined): boolean =>
  isPaused && runnerStarted !== false;
