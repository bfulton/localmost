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
 *
 * The resource monitor's pause, on battery or in a video call, comes through
 * here too. It stops the same two things, and by default also leaves running
 * jobs to finish; resourcePause.runningJobs set to 'stop' stops them. A
 * resume lifts it and overrides the condition behind it until that clears.
 */

import { IPC_CHANNELS } from '../shared/types';
import type { RunnerManager } from './runner-manager';
import type { ResourceMonitor } from './resource-monitor';
import type { HeartbeatManager } from './heartbeat-manager';
import { resolveResourcePauseConfig, type AppConfig, type ResourcePauseConfig } from './config';
import {
  getAuthState,
  getEffectivePauseState,
  getHeartbeatManager,
  getIsQuitting,
  getLogger,
  getMainWindow,
  getResourceMonitor,
  getRunnerManager,
  isUserPaused,
  setResourcePaused,
  setUserPaused,
} from './app-state';
import { isRunning as isRunnerStarted, isStarting as isRunnerStarting } from './runner-state-service';

export type PauseOutcome = 'paused' | 'already-paused' | 'not-started';
export type ResumeOutcome = 'resumed' | 'already-running' | 'starting' | 'not-started';

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
  // The monitor leaves out a condition a manual resume overrode, until it
  // clears and recurs.
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
 * One pause or resume at a time, in the order asked, the resource monitor's
 * among them. A resume can wait on initialize() between reading the pause
 * and lifting it; a pause made in that wait read the runner as still
 * paused, did nothing, and was then lifted by the resume.
 */
let pending: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = pending.then(operation);
  pending = result.catch(() => {});
  return result;
};

/** The initialize() in progress, which every caller waits on. */
let initializing: Promise<void> | null = null;

/**
 * Start the runner manager's pool if the runner is started and its pool is
 * not.
 *
 * A resource pause that found workers running stopped the pool, and nothing
 * started it again, so the runner read offline once it resumed - while the
 * broker went on acquiring jobs and spawning workers for them. A runner the
 * app never started is left alone: the pool is no use without the broker.
 *
 * The resource monitor's resume and the user's can both get here at once,
 * and initialize() with an empty pool does not notice a second call made
 * while the first is still sweeping, so they share one.
 */
export const ensureRunnerInitialized = async (): Promise<void> => {
  if (!isRunnerStarted()) {
    return;
  }
  const runnerManager = getRunnerManager();
  if (!runnerManager || runnerManager.isInitialized()) {
    return;
  }
  if (!initializing) {
    initializing = runnerManager.initialize().finally(() => {
      initializing = null;
    });
  }
  await initializing;
};

/**
 * Start the heartbeat that routes workflows here, unless the runner is
 * paused. For starting the runner: one paused while it started comes up
 * paused, and its resume starts the heartbeat.
 */
export const startHeartbeatUnlessPaused = async (
  heartbeatManager: Pick<HeartbeatManager, 'start'>
): Promise<void> => {
  if (getEffectivePauseState().isPaused) {
    getLogger()?.info('Runner is paused, so the heartbeat waits for resume');
    return;
  }
  await heartbeatManager.start();
};

/**
 * Stop taking jobs until the user resumes. Running jobs finish.
 *
 * The runner has to be started, or starting: the broker takes jobs from
 * before the runner is up, and the state machine holds a pause from then.
 * Outside those the flag would not be set at all.
 */
export const pauseRunner = (): Promise<PauseOutcome> => oneAtATime(async () => {
  if (!isRunnerStarted() && !isRunnerStarting()) {
    getLogger()?.info('Pause ignored: the runner is not started');
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
});

/**
 * A resource condition began to hold: refuse new jobs and stop routing
 * workflows here. New jobs are held back by canAcceptJob, which asks the
 * monitor. The user's pause outranks this one: a runner they paused is left
 * as it is, and they decide when it resumes.
 *
 * It runs after whatever pause or resume is ahead of it, so it goes by what
 * the monitor says when it runs, not when it was queued. A user resume
 * ahead of it overrode the condition; pausing anyway left the runner shown
 * paused, with no heartbeat, while canAcceptJob took jobs - and the monitor,
 * no longer paused, would send no should-resume to undo it.
 */
export const pauseForResource = (
  reason: string,
  runningJobs: ResourcePauseConfig['runningJobs']
): Promise<void> => oneAtATime(async () => {
  if (isUserPaused() || !getResourceMonitor()?.shouldPause()) return;

  getLogger()?.info(`Resource pause triggered: ${reason}`);
  // The state machine updates the tray and renderer through its subscription.
  setResourcePaused(true, reason);

  const heartbeatManager = getHeartbeatManager();
  heartbeatManager?.stop();
  await heartbeatManager?.clear();

  // By default running jobs finish, as under the user's pause. Set to
  // 'stop', this also stops the workers, and with them any job they are
  // running: stop() signals each worker's process group, and a job cut off
  // that way fails on GitHub. isRunning() is whether there are workers; an
  // idle pool has none, and is left started. A stopped pool is started
  // again on resume.
  if (runningJobs !== 'stop') return;
  const runnerManager = getRunnerManager();
  if (runnerManager?.isRunning()) {
    getLogger()?.info('Stopping running jobs for the resource pause (resourcePause.runningJobs: stop)');
    await runnerManager.stop();
  }
});

/**
 * The resource condition cleared: take jobs again, unless the user paused.
 * Like the pause, it goes by the monitor when it runs: a condition that came
 * back meanwhile has its pause queued behind this.
 */
export const resumeForResource = (): Promise<void> => oneAtATime(async () => {
  if (isUserPaused() || getResourceMonitor()?.shouldPause()) return;

  getLogger()?.info('Resource pause cleared - resuming runner');
  setResourcePaused(false);

  // Start the pool again if the pause stopped it, or the runner reads
  // offline while it takes jobs.
  try {
    await ensureRunnerInitialized();
  } catch (err) {
    getLogger()?.error(`Failed to restart runner: ${(err as Error).message}`);
  }

  // A runner that is not started yet starts its own heartbeat once it is
  // up, now that nothing holds it.
  if (!isRunnerStarted()) return;
  const heartbeatManager = getHeartbeatManager();
  if (heartbeatManager && getAuthState()?.accessToken) {
    try {
      await heartbeatManager.start();
    } catch (err) {
      getLogger()?.error(`Failed to restart heartbeat: ${(err as Error).message}`);
    }
  }
});

/**
 * Send the monitor's pause and resume here. resourcePause is read through
 * `readResourcePause` at each pause, so a change made in Settings applies to
 * the next one.
 */
export const wireResourceMonitor = (
  monitor: Pick<ResourceMonitor, 'on'>,
  readResourcePause: () => AppConfig['resourcePause'] | undefined
): void => {
  monitor.on('should-pause', (reason: string) => {
    const { runningJobs } = resolveResourcePauseConfig(readResourcePause(), (message) => getLogger()?.warn(message));
    pauseForResource(reason, runningJobs).catch((err) => {
      getLogger()?.error(`Resource pause failed: ${(err as Error).message}`);
    });
  });
  monitor.on('should-resume', () => {
    resumeForResource().catch((err) => {
      getLogger()?.error(`Resource resume failed: ${(err as Error).message}`);
    });
  });
};

/**
 * Lift both pauses, and override the resource conditions holding now.
 */
const liftPauses = (): void => {
  const overridden = getResourceMonitor()?.overrideUntilClear() ?? null;
  if (overridden) {
    getLogger()?.info(`Resource pause overridden until this clears: ${overridden}`);
  }
  setUserPaused(false);
  setResourcePaused(false);
};

/**
 * Take jobs again. Clears the resource pause as well as the user's, as the
 * tray always has, and overrides the resource conditions still holding: the
 * runner takes jobs, canAcceptJob included, until each clears, and a
 * condition that recurs after that, or a new one, pauses it again.
 */
export const resumeRunner = (): Promise<ResumeOutcome> => oneAtATime(async () => {
  if (isRunnerStarting()) {
    if (!getEffectivePauseState().isPaused && !getResourceMonitor()?.shouldPause()) {
      return 'starting';
    }
    // The start brings up the pool and, with nothing holding it, the
    // heartbeat. Unlike the started case below, the override is applied
    // before the pool is up: if the start then fails, the condition stays
    // overridden until it clears, and a later start takes jobs despite it.
    getLogger()?.info('User resumed runner');
    liftPauses();
    notifyRenderer(false);
    return 'resumed';
  }
  if (!isRunnerStarted()) {
    getLogger()?.info('Resume ignored: the runner is not started');
    return 'not-started';
  }
  // A condition the monitor still holds counts, though the user paused first
  // and the monitor's pause was never recorded.
  const wasPaused = getEffectivePauseState().isPaused || !!getResourceMonitor()?.shouldPause();
  const runnerManager = getRunnerManager();
  if (!wasPaused && (!runnerManager || runnerManager.isInitialized())) {
    return 'already-running';
  }

  getLogger()?.info('User resumed runner');
  // Before the pause is lifted, so a pool that cannot start leaves the
  // runner paused rather than advertised with nothing behind it.
  await ensureRunnerInitialized();

  if (wasPaused) {
    liftPauses();

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
});
