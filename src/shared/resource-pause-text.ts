/**
 * How the tray, `localmost resume` and `localmost status` say that a manual
 * resume overrode a resource pause, in the same words.
 */

import type { ResourceCondition, ResourcePauseState } from './types';

const CONDITION_NAMES: Record<ResourceCondition['type'], string> = {
  battery: 'battery power',
  'video-call': 'the video call',
};

/**
 * The overridden conditions as ResourcePauseState.overridden gives them, or
 * null for none. They are named by kind: a condition's reason changes while
 * it holds - "Battery at 75%" as the level falls, "Video call ended
 * recently" through the call's grace period - and is not what clears.
 */
export const resourceConditionsOverridden = (types: ResourceCondition['type'][]): string | null =>
  types.length > 0 ? types.map((type) => CONDITION_NAMES[type]).join(' and ') : null;

/** `overridden` is the condition, as ResourcePauseState.overridden gives it. */
export const resourcePauseOverriddenText = (overridden: string): string =>
  `Resumed (resource pause overridden until ${overridden} ${overridden.includes(' and ') ? 'clear' : 'clears'})`;

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
