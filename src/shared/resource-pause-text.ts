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
