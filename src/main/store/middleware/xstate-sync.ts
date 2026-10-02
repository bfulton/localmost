/**
 * XState synchronization middleware for Zustand store.
 *
 * Subscribes to the XState runner machine and syncs to the Zustand store, so
 * the app has one view of its state.
 *
 * The machine is NOT the source of truth for runner lifecycle. It is only ever
 * sent pause and resume events - JOB_START and JOB_COMPLETE are declared on it
 * and dispatched by nobody - so it knows nothing about jobs. A machine
 * transition is a good moment to refresh, but the runner state published here
 * comes from RunnerManager, which is where the job is. Pause is the machine's,
 * and it does track that.
 */

import {
  onStateChange,
  getEffectivePauseState,
  selectEffectivePauseState,
} from '../../runner-state-service';
import { getRunnerState } from '../../app-state';
import { store } from '../index';
import type { RunnerState } from '../../../shared/types';

/**
 * Put the runner's state in the store, with pause from the machine.
 *
 * Called on machine transitions and on every RunnerManager status change. The
 * renderer reads the store once zubridge is ready, so a job starting or ending
 * has to land here, not only in the IPC status event.
 */
export function publishRunnerState(
  runnerState: RunnerState = getRunnerState(),
  pauseState: { isPaused: boolean; reason: string | null } = getEffectivePauseState()
): void {
  store.getState().setRunnerState({
    ...runnerState,
    ...(pauseState.isPaused && { error: pauseState.reason ?? undefined }),
  });
}

/**
 * Set up synchronization between XState machine and Zustand store.
 * Returns an unsubscribe function.
 */
export function setupXStateSync(): () => void {
  return onStateChange((snapshot) => {
    publishRunnerState(getRunnerState(), selectEffectivePauseState(snapshot));
  });
}
