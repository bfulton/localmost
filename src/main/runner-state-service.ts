/**
 * Runner state service - manages the XState actor and provides selectors.
 * This is the interface between the state machine and the rest of the app.
 */

import { createActor, type SnapshotFrom } from 'xstate';
import { runnerMachine, type RunnerContext, type RunnerEvent } from './runner-state-machine';
import { RunnerState } from '../shared/types';

// The actor instance (singleton)
let runnerActor: ReturnType<typeof createActor<typeof runnerMachine>> | null = null;

// Callbacks for state change notifications
type StateChangeCallback = (snapshot: SnapshotFrom<typeof runnerMachine>) => void;
const stateChangeCallbacks: StateChangeCallback[] = [];

/**
 * Get the runner actor instance.
 */
export function getRunnerActor() {
  return runnerActor;
}

/**
 * Initialize the runner state machine.
 * Should be called once during app startup.
 */
export function initRunnerStateMachine(): ReturnType<typeof createActor<typeof runnerMachine>> {
  if (runnerActor) {
    return runnerActor;
  }

  runnerActor = createActor(runnerMachine);

  // Subscribe to state changes
  runnerActor.subscribe((snapshot) => {
    // Notify all registered callbacks
    for (const callback of stateChangeCallbacks) {
      try {
        callback(snapshot);
      } catch (error) {
        console.error('State change callback error:', error);
      }
    }
  });

  runnerActor.start();
  return runnerActor;
}

/**
 * Stop the runner state machine.
 * Should be called during app shutdown.
 */
export function stopRunnerStateMachine(): void {
  if (runnerActor) {
    runnerActor.stop();
    runnerActor = null;
  }
  // Clear all callbacks since the actor is gone
  stateChangeCallbacks.length = 0;
}

/**
 * Send an event to the state machine.
 */
export function sendRunnerEvent(event: RunnerEvent): void {
  runnerActor?.send(event);
}

/**
 * Subscribe to state changes.
 * Returns an unsubscribe function.
 */
export function onStateChange(callback: StateChangeCallback): () => void {
  stateChangeCallbacks.push(callback);
  return () => {
    const index = stateChangeCallbacks.indexOf(callback);
    if (index >= 0) {
      stateChangeCallbacks.splice(index, 1);
    }
  };
}

/**
 * Get the current snapshot.
 */
export function getSnapshot(): SnapshotFrom<typeof runnerMachine> | null {
  return runnerActor?.getSnapshot() ?? null;
}

// ============================================================================
// Selectors - compute derived state from the machine snapshot
// ============================================================================

/**
 * Compute the effective runner status for display.
 * Maps machine state to the existing RunnerState type.
 */
export function selectRunnerStatus(snapshot: SnapshotFrom<typeof runnerMachine>): RunnerState {
  const { context, value } = snapshot;

  // Determine status from nested state value
  let status: RunnerState['status'];

  if (typeof value === 'string') {
    // Top-level states: idle, starting, error, shuttingDown
    switch (value) {
      case 'idle':
        status = 'offline';
        break;
      case 'starting':
        status = 'starting';
        break;
      case 'error':
        status = 'error';
        break;
      case 'shuttingDown':
        status = 'shutting_down';
        break;
      default:
        status = 'offline';
    }
  } else if ('running' in value) {
    // Nested running states
    const runningState = value.running as string;
    switch (runningState) {
      case 'listening':
        status = 'listening';
        break;
      case 'busy':
        status = 'busy';
        break;
      case 'paused':
        // Paused is an overlay - show as listening but paused flag is set
        status = 'listening';
        break;
      default:
        status = 'listening';
    }
  } else {
    status = 'offline';
  }

  return {
    status,
    startedAt: context.startedAt ?? undefined,
    jobName: context.currentJob?.name,
    repository: context.currentJob?.repository,
  };
}

/**
 * Get the effective pause state (combines user and resource pause).
 */
export function selectEffectivePauseState(snapshot: SnapshotFrom<typeof runnerMachine>): {
  isPaused: boolean;
  reason: string | null;
} {
  const { context } = snapshot;

  if (context.userPaused) {
    return { isPaused: true, reason: 'Paused by user' };
  }
  if (context.resourcePaused) {
    return { isPaused: true, reason: context.resourcePauseReason };
  }
  return { isPaused: false, reason: null };
}

/**
 * Check if we're in the running.paused state.
 */
export function selectIsPaused(snapshot: SnapshotFrom<typeof runnerMachine>): boolean {
  const { value } = snapshot;
  if (typeof value === 'object' && 'running' in value) {
    return value.running === 'paused';
  }
  return false;
}

/**
 * Check if user has manually paused.
 */
export function selectIsUserPaused(snapshot: SnapshotFrom<typeof runnerMachine>): boolean {
  return snapshot.context.userPaused;
}

/**
 * Check if resource monitor has paused.
 */
export function selectIsResourcePaused(snapshot: SnapshotFrom<typeof runnerMachine>): boolean {
  return snapshot.context.resourcePaused;
}

/**
 * Check if the runner is in a running state (listening, busy, or paused).
 */
export function selectIsRunning(snapshot: SnapshotFrom<typeof runnerMachine>): boolean {
  const { value } = snapshot;
  return typeof value === 'object' && 'running' in value;
}

/**
 * Check if any instance is currently busy.
 */
export function selectIsBusy(snapshot: SnapshotFrom<typeof runnerMachine>): boolean {
  return snapshot.context.busyInstances.size > 0;
}

/**
 * Get the set of busy instance numbers.
 */
export function selectBusyInstances(snapshot: SnapshotFrom<typeof runnerMachine>): Set<number> {
  return snapshot.context.busyInstances;
}

/**
 * Get the current job info.
 */
export function selectCurrentJob(snapshot: SnapshotFrom<typeof runnerMachine>): RunnerContext['currentJob'] {
  return snapshot.context.currentJob;
}

/**
 * Check if any target has an active session.
 */
export function selectHasActiveSession(snapshot: SnapshotFrom<typeof runnerMachine>): boolean {
  for (const session of snapshot.context.targetSessions.values()) {
    if (session.sessionActive) return true;
  }
  return false;
}

/**
 * Get the error message if in error state.
 */
export function selectError(snapshot: SnapshotFrom<typeof runnerMachine>): string | null {
  return snapshot.context.error;
}

// ============================================================================
// Convenience functions that get snapshot and select in one call
// ============================================================================

/**
 * Get current runner status.
 */
export function getRunnerStatus(): RunnerState {
  const snapshot = getSnapshot();
  if (!snapshot) {
    return { status: 'offline' };
  }
  return selectRunnerStatus(snapshot);
}

/**
 * Get effective pause state.
 */
export function getEffectivePauseState(): { isPaused: boolean; reason: string | null } {
  const snapshot = getSnapshot();
  if (!snapshot) {
    return { isPaused: false, reason: null };
  }
  return selectEffectivePauseState(snapshot);
}

/**
 * Check if user has paused.
 */
export function isUserPaused(): boolean {
  const snapshot = getSnapshot();
  return snapshot ? selectIsUserPaused(snapshot) : false;
}

/**
 * Check if resource monitor has paused.
 */
export function isResourcePaused(): boolean {
  const snapshot = getSnapshot();
  return snapshot ? selectIsResourcePaused(snapshot) : false;
}

/**
 * Check if runner is running (in running state hierarchy).
 */
export function isRunning(): boolean {
  const snapshot = getSnapshot();
  return snapshot ? selectIsRunning(snapshot) : false;
}

/**
 * Check if any instance is busy.
 */
export function isBusy(): boolean {
  const snapshot = getSnapshot();
  return snapshot ? selectIsBusy(snapshot) : false;
}

/**
 * Get busy instances.
 */
export function getBusyInstances(): Set<number> {
  const snapshot = getSnapshot();
  return snapshot ? selectBusyInstances(snapshot) : new Set();
}
