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

import { onStateChange, selectEffectivePauseState } from '../../runner-state-service';
import { getRunnerState } from '../../app-state';
import { store } from '../index';

/**
 * Set up synchronization between XState machine and Zustand store.
 * Returns an unsubscribe function.
 */
export function setupXStateSync(): () => void {
  const unsubscribe = onStateChange((snapshot) => {
    // Runner state from the runner; pause from the machine, which owns it.
    const runnerState = getRunnerState();
    const pauseState = selectEffectivePauseState(snapshot);

    // Update the Zustand store
    store.setState((state) => ({
      runner: {
        ...state.runner,
        runnerState: {
          ...runnerState,
          // Add pause info to the runner state if paused
          ...(pauseState.isPaused && { error: pauseState.reason ?? undefined }),
        },
      },
    }));
  });

  return unsubscribe;
}
