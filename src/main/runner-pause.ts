/**
 * Pausing and resuming the runner.
 *
 * The tray and the CLI both offer pause and resume, and both go through
 * here. They used to have their own: the CLI decided whether the runner was
 * paused by whether it had any workers, which with workers spawned per job is
 * never while idle. It answered "already paused" for a runner that was
 * listening, set no pause, and when a job was running killed it.
 *
 * A pause is the user's pause flag on the state machine. What it stops is the
 * broker acquiring jobs - canAcceptJob() refuses while it is set - and the
 * heartbeat that routes workflows here. Jobs already running are left to
 * finish.
 */

import { IPC_CHANNELS } from '../shared/types';
import type { RunnerManager } from './runner-manager';
import type { ResourceMonitor } from './resource-monitor';
import {
  getAuthState,
  getEffectivePauseState,
  getHeartbeatManager,
  getIsQuitting,
  getLogger,
  getMainWindow,
  getRunnerManager,
  isUserPaused,
  setResourcePaused,
  setUserPaused,
} from './app-state';
import { isRunning as isRunnerStarted } from './runner-state-service';

export type PauseOutcome = 'paused' | 'already-paused' | 'not-started';
export type ResumeOutcome = 'resumed' | 'already-running' | 'not-started';

export interface CanAcceptJobDeps {
  resourceMonitor: Pick<ResourceMonitor, 'shouldPause'>;
  runnerManager: Pick<RunnerManager, 'hasAvailableSlot'>;
}

/**
 * Whether the broker may acquire the job GitHub is offering.
 *
 * A job refused here is not acquired, so GitHub keeps it queued and offers it
 * again on a later poll - to this runner once it takes jobs again, or to any
 * other runner with the job's labels.
 */
export const canAcceptJob = ({ resourceMonitor, runnerManager }: CanAcceptJobDeps): boolean => {
  if (isUserPaused()) {
    return false;
  }
  if (resourceMonitor.shouldPause()) {
    return false;
  }
  return runnerManager.hasAvailableSlot();
};

const notifyRenderer = (isPaused: boolean): void => {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed() && !getIsQuitting()) {
    mainWindow.webContents.send(IPC_CHANNELS.RESOURCE_STATE_CHANGED, {
      isPaused,
      reason: isPaused ? 'Paused by user' : null,
      conditions: [],
    });
  }
};

/**
 * Start the runner manager's pool if the runner is started and its pool is
 * not.
 *
 * A resource pause that found workers running stopped the pool, and nothing
 * started it again, so the runner read offline once it resumed - while the
 * broker went on acquiring jobs and spawning workers for them. A runner the
 * app never started is left alone: the pool is no use without the broker.
 */
export const ensureRunnerInitialized = async (): Promise<void> => {
  if (!isRunnerStarted()) {
    return;
  }
  const runnerManager = getRunnerManager();
  if (runnerManager && !runnerManager.isInitialized()) {
    await runnerManager.initialize();
  }
};

/**
 * Stop taking jobs until the user resumes. Running jobs finish.
 *
 * The runner has to be started: the state machine only holds a pause while
 * it is running, and outside that the flag would not be set at all.
 */
export const pauseRunner = async (): Promise<PauseOutcome> => {
  if (!isRunnerStarted()) {
    return 'not-started';
  }
  if (isUserPaused()) {
    return 'already-paused';
  }

  getLogger()?.info('User paused runner');
  setUserPaused(true);

  // Stop heartbeat timer first, then clear variables
  const heartbeatManager = getHeartbeatManager();
  heartbeatManager?.stop();
  await heartbeatManager?.clear();

  notifyRenderer(true);
  return 'paused';
};

/**
 * Take jobs again. Clears the resource pause as well as the user's, as the
 * tray always has. While a resource condition itself still holds, new jobs
 * are refused regardless: canAcceptJob asks the monitor, not the flag.
 */
export const resumeRunner = async (): Promise<ResumeOutcome> => {
  if (!isRunnerStarted()) {
    return 'not-started';
  }
  const wasPaused = getEffectivePauseState().isPaused;
  const runnerManager = getRunnerManager();
  if (!wasPaused && (!runnerManager || runnerManager.isInitialized())) {
    return 'already-running';
  }

  getLogger()?.info('User resumed runner');
  // Before the pause is lifted, so a pool that cannot start leaves the
  // runner paused rather than advertised with nothing behind it.
  await ensureRunnerInitialized();

  if (wasPaused) {
    setUserPaused(false);
    setResourcePaused(false);

    // Restart heartbeat to signal availability
    const heartbeatManager = getHeartbeatManager();
    if (heartbeatManager && getAuthState()?.accessToken) {
      try {
        await heartbeatManager.start();
      } catch (err) {
        getLogger()?.error(`Failed to restart heartbeat: ${(err as Error).message}`);
      }
    }

    notifyRenderer(false);
  }
  return 'resumed';
};
