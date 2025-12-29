/**
 * XState synchronization middleware for Zustand store.
 *
 * Subscribes to the XState runner machine and syncs its state to the Zustand store.
 * This provides a unified view of all app state through Zustand while keeping
 * the XState machine as the source of truth for runner lifecycle.
 */

import { onStateChange, selectRunnerStatus, selectEffectivePauseState } from '../../runner-state-service';
import { store } from '../index';

/**
 * Set up synchronization between XState machine and Zustand store.
 * Returns an unsubscribe function.
 */
export function setupXStateSync(): () => void {
  const unsubscribe = onStateChange((snapshot) => {
    // Get the runner state from the machine
    const runnerState = selectRunnerStatus(snapshot);
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
