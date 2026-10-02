import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import type { BrowserWindow } from 'electron';

// Upstream calls: acquirejob answers with the job's details. Every host a
// request went to is recorded.
const mockHttpsRequest = jest.fn();
jest.mock('https', () => ({
  request: mockHttpsRequest,
}));

import { BrokerProxyService } from './broker-proxy-service';
import type { HeartbeatManager } from './heartbeat-manager';
import type { RunnerManager } from './runner-manager';
import type { ResourceMonitor } from './resource-monitor';
import {
  setAuthState,
  setHeartbeatManager,
  setMainWindow,
  setResourcePaused,
  setResourceMonitor,
  setRunnerManager,
  setUserPaused,
  setLogger,
  isUserPaused,
  isResourcePaused,
  getEffectivePauseState,
} from './app-state';
import type { Logger } from './logger';
import {
  getSnapshot,
  initRunnerStateMachine,
  selectEffectivePauseState,
  selectIsPaused,
  sendRunnerEvent,
  stopRunnerStateMachine,
} from './runner-state-service';
import {
  canAcceptJob,
  ensureRunnerInitialized,
  pauseForResource,
  pauseRunner,
  resumeForResource,
  resumeRunner,
  startHeartbeatUnlessPaused,
  wireResourceMonitor,
} from './runner-pause';
import type { AppConfig } from './config';
import { IPC_CHANNELS } from '../shared/types';
import type { Target } from '../shared/types';

const heartbeat = {
  stop: jest.fn(),
  clear: jest.fn(async () => {}),
  start: jest.fn(async () => true),
};
const runner = {
  isInitialized: jest.fn(() => true),
  initialize: jest.fn(async () => {}),
  stop: jest.fn(async () => {}),
  hasAvailableSlot: jest.fn(() => true),
  isRunning: jest.fn(() => false),
};
// Overriding stops it recommending the pause, as the real monitor does
// until the condition clears.
const resourceMonitor = {
  shouldPause: jest.fn(() => false),
  overrideUntilClear: jest.fn((): string | null => {
    if (!resourceMonitor.shouldPause()) return null;
    resourceMonitor.shouldPause.mockReturnValue(false);
    return 'Battery at 20%';
  }),
};
const rendererSend = jest.fn();
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

/** A promise and the function that settles it, for holding a call open. */
const deferred = (): { promise: Promise<void>; release: () => void } => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

/** The runner as the app leaves it after starting: listening, nothing paused. */
const startRunner = (): void => {
  initRunnerStateMachine();
  sendRunnerEvent({ type: 'START' });
  sendRunnerEvent({ type: 'INITIALIZED' });
};

beforeEach(() => {
  jest.clearAllMocks();
  runner.isInitialized.mockReturnValue(true);
  runner.hasAvailableSlot.mockReturnValue(true);
  runner.isRunning.mockReturnValue(false);
  resourceMonitor.shouldPause.mockReturnValue(false);
  setHeartbeatManager(heartbeat as unknown as HeartbeatManager);
  setRunnerManager(runner as unknown as RunnerManager);
  setResourceMonitor(resourceMonitor as unknown as ResourceMonitor);
  setAuthState({ accessToken: 'token', user: { login: 'someone' } } as never);
  setLogger(logger as unknown as Logger);
  setMainWindow({
    isDestroyed: () => false,
    webContents: { send: rendererSend },
  } as unknown as BrowserWindow);
});

afterEach(() => {
  stopRunnerStateMachine();
  setHeartbeatManager(null);
  setRunnerManager(null);
  setResourceMonitor(null);
  setAuthState(null);
  setLogger(null);
  setMainWindow(null);
});

describe('a paused runner takes no jobs', () => {
  const runService = 'https://run-actions-1-azure-eastus.actions.githubusercontent.com/';
  const details = JSON.stringify({
    jobId: 'plan-job',
    contextData: { github: { d: [{ k: 'repository', v: 'owner/repo' }, { k: 'sha', v: 'abc1234' }] } },
  });

  interface Internals {
    targets: Map<string, { instances: Map<number, { sessionId?: string; accessToken?: string; tokenExpiry?: number }> }>;
    processMessage(state: unknown, instance: unknown, body: string): Promise<void>;
  }

  let service: BrokerProxyService;
  let acquires: string[];

  /** GitHub's broker offers job req-1 to the target's listener. */
  const offer = async (): Promise<void> => {
    const internals = service as unknown as Internals;
    const state = internals.targets.get('target-a')!;
    const instance = state.instances.get(1)!;
    await internals.processMessage(state, instance, JSON.stringify({
      messageId: 2,
      messageType: 'RunnerJobRequest',
      body: JSON.stringify({ runner_request_id: 'req-1', run_service_url: runService, billing_owner_id: 'b' }),
    }));
  };

  beforeEach(() => {
    acquires = [];
    mockHttpsRequest.mockImplementation((...args: unknown[]) => {
      const options = args[0] as { path?: string };
      const callback = args[1] as (res: EventEmitter) => void;
      const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; write: () => void; end: () => void };
      req.setTimeout = () => {};
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number };
        res.statusCode = 200;
        callback(res);
        if (options.path?.startsWith('/acquirejob')) {
          acquires.push(options.path);
          res.emit('data', details);
        }
        res.emit('end');
      };
      return req;
    });

    service = new BrokerProxyService(8787);
    // Wired as the app wires it.
    service.setCanAcceptJobCallback(() => canAcceptJob({ resourceMonitor, runnerManager: runner }));
    const target: Target = {
      id: 'target-a',
      type: 'repo',
      owner: 'owner',
      repo: 'repo',
      displayName: 'owner/repo',
      url: 'https://github.com/owner/repo',
      proxyRunnerName: 'localmost.test.owner-repo',
      enabled: true,
      addedAt: '2024-01-01T00:00:00.000Z',
    };
    service.addTarget(target, [{
      instanceNum: 1,
      runner: {
        agentId: 1,
        agentName: 'localmost.test.owner-repo.1',
        poolId: 1,
        poolName: 'Default',
        serverUrl: 'https://pipelines.actions.githubusercontent.com',
        gitHubUrl: 'https://github.com',
        workFolder: '_work',
        useV2Flow: true,
        serverUrlV2: 'https://broker.actions.githubusercontent.com/',
      },
      credentials: { scheme: 'OAuth', data: { clientId: 'c', authorizationUrl: 'https://vstoken.actions.githubusercontent.com', requireFipsCryptography: 'false' } },
      rsaParams: { d: 'd', dp: 'dp', dq: 'dq', exponent: 'AQAB', inverseQ: 'iq', modulus: 'm', p: 'p', q: 'q' },
    }]);
    const instance = (service as unknown as Internals).targets.get('target-a')!.instances.get(1)!;
    instance.sessionId = 'upstream-session';
    instance.accessToken = 'token';
    instance.tokenExpiry = Date.now() + 3_600_000;

    startRunner();
  });

  it('leaves a job offered while paused with GitHub, and takes it when offered after resume', async () => {
    // The acceptance check consulted only the resource monitor and the slot
    // count, so a runner paused from the tray or the CLI went on acquiring
    // every job it was offered and admission spawned a worker for each.
    const received = jest.fn();
    service.on('job-received', received);

    expect(await pauseRunner()).toBe('paused');
    await offer();

    // Not acquired, so it is not ours: GitHub keeps it queued and offers it
    // again, here or to any other runner with its labels.
    expect(acquires).toEqual([]);
    expect(received).not.toHaveBeenCalled();

    expect(await resumeRunner()).toBe('resumed');
    await offer();

    expect(acquires).toHaveLength(1);
    expect(received).toHaveBeenCalledTimes(1);
  });
});

describe('canAcceptJob', () => {
  const deps = { resourceMonitor, runnerManager: runner };

  it('refuses while the user has paused', () => {
    startRunner();
    setUserPaused(true);

    expect(canAcceptJob(deps)).toBe(false);
  });

  it('refuses while a resource condition holds, or when no slot is free', () => {
    startRunner();
    expect(canAcceptJob(deps)).toBe(true);

    resourceMonitor.shouldPause.mockReturnValue(true);
    expect(canAcceptJob(deps)).toBe(false);

    resourceMonitor.shouldPause.mockReturnValue(false);
    runner.hasAvailableSlot.mockReturnValue(false);
    expect(canAcceptJob(deps)).toBe(false);
  });
});

describe('pauseRunner', () => {
  it('stops the heartbeat and leaves running jobs to finish', async () => {
    startRunner();

    expect(await pauseRunner()).toBe('paused');

    expect(runner.stop).not.toHaveBeenCalled();
    expect(heartbeat.stop).toHaveBeenCalled();
    expect(heartbeat.clear).toHaveBeenCalled();
    expect(rendererSend).toHaveBeenCalledWith(IPC_CHANNELS.RESOURCE_STATE_CHANGED, {
      isPaused: true,
      reason: 'Paused by user',
      conditions: [],
    });
    // What `localmost status` reads.
    expect(selectEffectivePauseState(getSnapshot()!)).toEqual({ isPaused: true, reason: 'Paused by user' });
  });

  it('says a runner the user already paused is paused, and does nothing', async () => {
    startRunner();
    await pauseRunner();
    jest.clearAllMocks();

    expect(await pauseRunner()).toBe('already-paused');
    expect(heartbeat.stop).not.toHaveBeenCalled();
  });

  it('holds a runner a resource condition paused until the user resumes it', async () => {
    // A resource pause lifts itself when the condition clears; the user's
    // does not, so pausing on top of one is not "already paused".
    startRunner();
    setResourcePaused(true, 'On battery');

    expect(await pauseRunner()).toBe('paused');
    expect(isUserPaused()).toBe(true);
  });

  it('says a runner that was never started is not started, records no pause, and logs it', async () => {
    initRunnerStateMachine();

    expect(await pauseRunner()).toBe('not-started');
    expect(isUserPaused()).toBe(false);
    expect(heartbeat.stop).not.toHaveBeenCalled();
    // A tray click that does nothing leaves a trace.
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('not started'));
  });

  it('pauses a runner that is still starting, and it comes up paused', async () => {
    // The broker is started, and offered jobs, before the runner reaches
    // running: the auto-start's delay and sweeps, or a start whose
    // initialize() failed and left it there. A pause in that window was
    // dropped.
    initRunnerStateMachine();
    sendRunnerEvent({ type: 'START' });

    expect(await pauseRunner()).toBe('paused');
    expect(canAcceptJob({ resourceMonitor, runnerManager: runner })).toBe(false);
    expect(heartbeat.stop).toHaveBeenCalled();

    sendRunnerEvent({ type: 'INITIALIZED' });
    expect(selectIsPaused(getSnapshot()!)).toBe(true);
    expect(canAcceptJob({ resourceMonitor, runnerManager: runner })).toBe(false);
  });
});

describe('resumeRunner', () => {
  it('lifts both pauses, restarts the heartbeat and tells the renderer', async () => {
    startRunner();
    setResourcePaused(true, 'On battery');
    setUserPaused(true);

    expect(await resumeRunner()).toBe('resumed');

    expect(isUserPaused()).toBe(false);
    expect(isResourcePaused()).toBe(false);
    expect(heartbeat.start).toHaveBeenCalled();
    expect(rendererSend).toHaveBeenCalledWith(IPC_CHANNELS.RESOURCE_STATE_CHANGED, {
      isPaused: false,
      reason: null,
      conditions: [],
    });
    expect(runner.initialize).not.toHaveBeenCalled();
  });

  it('does not start the heartbeat without an access token', async () => {
    startRunner();
    setUserPaused(true);
    setAuthState({ user: { login: 'someone' } } as never);

    expect(await resumeRunner()).toBe('resumed');
    expect(heartbeat.start).not.toHaveBeenCalled();
  });

  it('starts the pool again when a resource pause stopped it', async () => {
    // A resource pause that found workers stopped the pool, and nothing
    // started it again: the runner read offline from then on.
    startRunner();
    setUserPaused(true);
    runner.isInitialized.mockReturnValue(false);

    expect(await resumeRunner()).toBe('resumed');
    expect(runner.initialize).toHaveBeenCalledTimes(1);
  });

  it('leaves the runner paused when the pool cannot start', async () => {
    startRunner();
    setUserPaused(true);
    runner.isInitialized.mockReturnValue(false);
    runner.initialize.mockRejectedValueOnce(new Error('Could not determine runner version.'));

    await expect(resumeRunner()).rejects.toThrow('Could not determine runner version.');
    expect(isUserPaused()).toBe(true);
    expect(heartbeat.start).not.toHaveBeenCalled();
  });

  it('overrides a resource condition still holding, so the runner takes jobs until it clears', async () => {
    // The resume lifted the pause in the tray, but canAcceptJob asked the
    // monitor, which still said pause: the runner read resumed and took
    // nothing until the condition cleared.
    startRunner();
    resourceMonitor.shouldPause.mockReturnValue(true);
    await pauseForResource('Battery at 20%', 'finish');
    expect(canAcceptJob({ resourceMonitor, runnerManager: runner })).toBe(false);

    // A resume that cannot start the pool leaves the pause, and the
    // condition, in force.
    runner.isInitialized.mockReturnValue(false);
    runner.initialize.mockRejectedValueOnce(new Error('Could not determine runner version.'));
    await expect(resumeRunner()).rejects.toThrow('Could not determine runner version.');
    expect(resourceMonitor.overrideUntilClear).not.toHaveBeenCalled();
    expect(canAcceptJob({ resourceMonitor, runnerManager: runner })).toBe(false);

    runner.isInitialized.mockReturnValue(true);
    expect(await resumeRunner()).toBe('resumed');

    expect(resourceMonitor.overrideUntilClear).toHaveBeenCalledTimes(1);
    expect(canAcceptJob({ resourceMonitor, runnerManager: runner })).toBe(true);
    expect(selectIsPaused(getSnapshot()!)).toBe(false);
    expect(heartbeat.start).toHaveBeenCalledTimes(1);
  });

  it('overrides a resource pause made while starting, and the runner comes up taking jobs', async () => {
    initRunnerStateMachine();
    sendRunnerEvent({ type: 'START' });
    runner.isInitialized.mockReturnValue(false);
    resourceMonitor.shouldPause.mockReturnValue(true);
    setResourcePaused(true, 'Battery at 20%');

    expect(await resumeRunner()).toBe('resumed');
    expect(resourceMonitor.overrideUntilClear).toHaveBeenCalledTimes(1);
    expect(isResourcePaused()).toBe(false);
    // The start brings up the pool and the heartbeat.
    expect(runner.initialize).not.toHaveBeenCalled();
    expect(heartbeat.start).not.toHaveBeenCalled();

    sendRunnerEvent({ type: 'INITIALIZED' });
    expect(selectIsPaused(getSnapshot()!)).toBe(false);
    expect(canAcceptJob({ resourceMonitor, runnerManager: runner })).toBe(true);
  });

  it('says a started, unpaused runner is already running', async () => {
    startRunner();

    expect(await resumeRunner()).toBe('already-running');
    expect(runner.initialize).not.toHaveBeenCalled();
    expect(heartbeat.start).not.toHaveBeenCalled();
  });

  it('says a runner that was never started is not started', async () => {
    initRunnerStateMachine();

    expect(await resumeRunner()).toBe('not-started');
    expect(runner.initialize).not.toHaveBeenCalled();
  });

  it('lifts a pause made while starting, leaving the pool and heartbeat to the start', async () => {
    initRunnerStateMachine();
    sendRunnerEvent({ type: 'START' });
    runner.isInitialized.mockReturnValue(false);
    await pauseRunner();

    expect(await resumeRunner()).toBe('resumed');
    expect(isUserPaused()).toBe(false);
    expect(runner.initialize).not.toHaveBeenCalled();
    expect(heartbeat.start).not.toHaveBeenCalled();
  });

  it('says a starting runner nobody paused is starting', async () => {
    initRunnerStateMachine();
    sendRunnerEvent({ type: 'START' });
    runner.isInitialized.mockReturnValue(false);

    expect(await resumeRunner()).toBe('starting');
    expect(runner.initialize).not.toHaveBeenCalled();
  });

  it('lets a pause made while a resume starts the pool win', async () => {
    // The resume read the pause, then waited on initialize(), then lifted
    // it. A pause in that wait saw the runner still paused, answered
    // "already paused" and did nothing, and the resume went on to lift it.
    startRunner();
    setUserPaused(true);
    let initialized = false;
    runner.isInitialized.mockImplementation(() => initialized);
    const init = deferred();
    runner.initialize.mockImplementationOnce(async () => {
      await init.promise;
      initialized = true;
    });

    const resumed = resumeRunner();
    await Promise.resolve();
    const paused = pauseRunner();
    init.release();

    expect(await resumed).toBe('resumed');
    expect(await paused).toBe('paused');
    expect(isUserPaused()).toBe(true);
    expect(canAcceptJob({ resourceMonitor, runnerManager: runner })).toBe(false);
  });

  it('starts the pool once for two resumes at once', async () => {
    // initialize() with an empty pool does not notice a second call made
    // while the first is still sweeping.
    startRunner();
    setUserPaused(true);
    let initialized = false;
    runner.isInitialized.mockImplementation(() => initialized);
    const init = deferred();
    runner.initialize.mockImplementation(async () => {
      await init.promise;
      initialized = true;
    });

    const first = resumeRunner();
    const second = resumeRunner();
    init.release();

    expect(await first).toBe('resumed');
    expect(await second).toBe('already-running');
    expect(runner.initialize).toHaveBeenCalledTimes(1);
  });
});

describe('pauseForResource', () => {
  it('lets a running job finish by default, and stops the heartbeat', async () => {
    // A resource pause stopped the workers, and a job cut off that way
    // fails on GitHub: a laptop unplugged for a moment failed the job it
    // was running.
    startRunner();
    runner.isRunning.mockReturnValue(true);
    resourceMonitor.shouldPause.mockReturnValue(true);

    await pauseForResource('Battery at 20%', 'finish');

    expect(runner.stop).not.toHaveBeenCalled();
    expect(heartbeat.stop).toHaveBeenCalled();
    expect(heartbeat.clear).toHaveBeenCalled();
    expect(selectEffectivePauseState(getSnapshot()!)).toEqual({ isPaused: true, reason: 'Battery at 20%' });
    expect(canAcceptJob({ resourceMonitor, runnerManager: runner })).toBe(false);
  });

  it("stops the workers at once when set to 'stop'", async () => {
    startRunner();
    runner.isRunning.mockReturnValue(true);
    resourceMonitor.shouldPause.mockReturnValue(true);

    await pauseForResource('Video call detected', 'stop');

    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(heartbeat.stop).toHaveBeenCalled();
    expect(isResourcePaused()).toBe(true);
  });

  it("leaves an idle pool started when set to 'stop'", async () => {
    startRunner();
    resourceMonitor.shouldPause.mockReturnValue(true);

    await pauseForResource('Video call detected', 'stop');

    expect(runner.stop).not.toHaveBeenCalled();
  });

  it('does nothing when a resume queued ahead of it overrode its condition', async () => {
    // The pause runs after whatever is ahead of it. A user resume there
    // overrode the condition that queued it, so the monitor no longer
    // paused and would send no should-resume - and the pause went on to set
    // the flag and stop the heartbeat. The tray said paused, canAcceptJob
    // took jobs, and it stayed that way until the user resumed again.
    startRunner();
    const clear = deferred();
    heartbeat.clear.mockImplementationOnce(() => clear.promise);
    const paused = pauseRunner();
    const resumed = resumeRunner();
    // A condition begins while those wait on GitHub.
    resourceMonitor.shouldPause.mockReturnValue(true);
    const resourcePaused = pauseForResource('Battery at 20%', 'finish');
    clear.release();

    expect(await paused).toBe('paused');
    expect(await resumed).toBe('resumed');
    await resourcePaused;

    expect(resourceMonitor.overrideUntilClear).toHaveBeenCalledTimes(1);
    expect(resourceMonitor.shouldPause()).toBe(false);
    expect(selectEffectivePauseState(getSnapshot()!)).toEqual({ isPaused: false, reason: null });
    expect(canAcceptJob({ resourceMonitor, runnerManager: runner })).toBe(true);
    // The resume's heartbeat is the last word.
    expect(heartbeat.stop).toHaveBeenCalledTimes(1);
    expect(heartbeat.start).toHaveBeenCalledTimes(1);
  });

  it('does nothing when a resume starting the pool overrode its condition', async () => {
    // As above, with the resume waiting on initialize() after a 'stop'
    // pause left the pool down.
    startRunner();
    setUserPaused(true);
    let initialized = false;
    runner.isInitialized.mockImplementation(() => initialized);
    const init = deferred();
    runner.initialize.mockImplementationOnce(async () => {
      await init.promise;
      initialized = true;
    });

    const resumed = resumeRunner();
    await Promise.resolve();
    resourceMonitor.shouldPause.mockReturnValue(true);
    const resourcePaused = pauseForResource('Video call detected', 'stop');
    init.release();

    expect(await resumed).toBe('resumed');
    await resourcePaused;

    expect(resourceMonitor.shouldPause()).toBe(false);
    expect(isResourcePaused()).toBe(false);
    expect(canAcceptJob({ resourceMonitor, runnerManager: runner })).toBe(true);
    expect(heartbeat.stop).not.toHaveBeenCalled();
  });

  it('leaves a runner the user paused as it is', async () => {
    startRunner();
    runner.isRunning.mockReturnValue(true);
    resourceMonitor.shouldPause.mockReturnValue(true);
    await pauseRunner();
    jest.clearAllMocks();

    await pauseForResource('Battery at 20%', 'stop');

    expect(runner.stop).not.toHaveBeenCalled();
    expect(heartbeat.stop).not.toHaveBeenCalled();
    expect(isResourcePaused()).toBe(false);
  });
});

describe('resumeForResource', () => {
  it('lifts the pause, starts the pool a stop left down, and restarts the heartbeat', async () => {
    startRunner();
    resourceMonitor.shouldPause.mockReturnValue(true);
    await pauseForResource('Battery at 20%', 'stop');
    runner.isInitialized.mockReturnValue(false);
    resourceMonitor.shouldPause.mockReturnValue(false);

    await resumeForResource();

    expect(isResourcePaused()).toBe(false);
    expect(selectIsPaused(getSnapshot()!)).toBe(false);
    expect(runner.initialize).toHaveBeenCalledTimes(1);
    expect(heartbeat.start).toHaveBeenCalledTimes(1);
  });

  it('starts no heartbeat for a runner that is not started', async () => {
    // The monitor runs from launch; a condition clearing before the runner
    // starts is recorded, and the start brings up the heartbeat itself.
    initRunnerStateMachine();
    setResourcePaused(true, 'Battery at 20%');

    await resumeForResource();

    expect(isResourcePaused()).toBe(false);
    expect(heartbeat.start).not.toHaveBeenCalled();
    expect(runner.initialize).not.toHaveBeenCalled();
  });

  it('does nothing when the condition came back before it ran', async () => {
    // The pause that came back is queued behind it. Lifting the pause and
    // starting the heartbeat, for that pause to stop it again, routes a
    // workflow or two here in between.
    startRunner();
    const clear = deferred();
    heartbeat.clear.mockImplementationOnce(() => clear.promise);
    resourceMonitor.shouldPause.mockReturnValue(true);
    const paused = pauseForResource('Battery at 20%', 'finish');
    // While that waits on GitHub the condition clears, then comes back.
    resourceMonitor.shouldPause.mockReturnValue(false);
    const resumed = resumeForResource();
    resourceMonitor.shouldPause.mockReturnValue(true);
    const pausedAgain = pauseForResource('Battery at 18%', 'finish');
    clear.release();
    await paused;
    await resumed;
    await pausedAgain;

    expect(selectEffectivePauseState(getSnapshot()!)).toEqual({ isPaused: true, reason: 'Battery at 18%' });
    expect(heartbeat.start).not.toHaveBeenCalled();
  });

  it('leaves a runner the user paused paused', async () => {
    startRunner();
    resourceMonitor.shouldPause.mockReturnValue(true);
    await pauseForResource('Battery at 20%', 'finish');
    await pauseRunner();
    resourceMonitor.shouldPause.mockReturnValue(false);
    jest.clearAllMocks();

    await resumeForResource();

    expect(isUserPaused()).toBe(true);
    expect(heartbeat.start).not.toHaveBeenCalled();
  });
});

describe('wireResourceMonitor', () => {
  /** Let the handler a monitor event queued run to the end. */
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it("pauses with resourcePause.runningJobs as config.yaml has it at each pause, 'finish' when absent", async () => {
    // index.ts read the setting and passed it on, with nothing to catch a
    // hard-coded value or one read only at launch.
    startRunner();
    runner.isRunning.mockReturnValue(true);
    let section: AppConfig['resourcePause'] | undefined = { runningJobs: 'stop' };
    const events = new EventEmitter();
    wireResourceMonitor(events as unknown as ResourceMonitor, () => section);

    const pauseAndResume = async (): Promise<void> => {
      resourceMonitor.shouldPause.mockReturnValue(true);
      events.emit('should-pause', 'Battery at 20%');
      await settle();
      expect(isResourcePaused()).toBe(true);
      resourceMonitor.shouldPause.mockReturnValue(false);
      events.emit('should-resume');
      await settle();
      expect(isResourcePaused()).toBe(false);
    };

    await pauseAndResume();
    expect(runner.stop).toHaveBeenCalledTimes(1);

    section = { runningJobs: 'finish' };
    await pauseAndResume();
    expect(runner.stop).toHaveBeenCalledTimes(1);

    section = undefined;
    await pauseAndResume();
    expect(runner.stop).toHaveBeenCalledTimes(1);

    // A value it does not know is the default, and is logged.
    section = { runningJobs: 'kill' };
    await pauseAndResume();
    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('resourcePause.runningJobs'));
  });
});

describe('startHeartbeatUnlessPaused', () => {
  it('leaves the heartbeat stopped for a runner that comes up paused', async () => {
    // A start routes workflows here by starting the heartbeat once the
    // runner is up; one paused while starting must not.
    initRunnerStateMachine();
    sendRunnerEvent({ type: 'START' });
    await pauseRunner();
    sendRunnerEvent({ type: 'INITIALIZED' });

    await startHeartbeatUnlessPaused(heartbeat as unknown as HeartbeatManager);
    expect(heartbeat.start).not.toHaveBeenCalled();
  });

  it('shows a resource pause from before the start, and comes up paused without the heartbeat', async () => {
    // The monitor evaluates at launch, before the auto-start. The machine
    // dropped a pause sent while idle, so the tray and `localmost status`
    // said Listening, and the start routed workflows to a runner the monitor
    // refused jobs to.
    initRunnerStateMachine();
    setResourcePaused(true, 'Battery at 20%');

    // What the tray and `localmost status` read.
    expect(getEffectivePauseState()).toEqual({ isPaused: true, reason: 'Battery at 20%' });

    sendRunnerEvent({ type: 'START' });
    sendRunnerEvent({ type: 'INITIALIZED' });
    expect(selectIsPaused(getSnapshot()!)).toBe(true);
    expect(selectEffectivePauseState(getSnapshot()!)).toEqual({ isPaused: true, reason: 'Battery at 20%' });

    await startHeartbeatUnlessPaused(heartbeat as unknown as HeartbeatManager);
    expect(heartbeat.start).not.toHaveBeenCalled();
  });

  it('starts it for a runner that is not paused', async () => {
    startRunner();

    await startHeartbeatUnlessPaused(heartbeat as unknown as HeartbeatManager);
    expect(heartbeat.start).toHaveBeenCalledTimes(1);
  });
});

describe('ensureRunnerInitialized', () => {
  it('starts the pool a resource pause stopped', async () => {
    startRunner();
    runner.isInitialized.mockReturnValue(false);

    await ensureRunnerInitialized();

    expect(runner.initialize).toHaveBeenCalledTimes(1);
  });

  it('starts the pool once when the resource resume and a user resume race', async () => {
    startRunner();
    setUserPaused(true);
    let initialized = false;
    runner.isInitialized.mockImplementation(() => initialized);
    const init = deferred();
    runner.initialize.mockImplementation(async () => {
      await init.promise;
      initialized = true;
    });

    const fromMonitor = ensureRunnerInitialized();
    const fromUser = resumeRunner();
    init.release();
    await fromMonitor;

    expect(await fromUser).toBe('resumed');
    expect(runner.initialize).toHaveBeenCalledTimes(1);
  });

  it('leaves a started pool alone', async () => {
    startRunner();

    await ensureRunnerInitialized();

    expect(runner.initialize).not.toHaveBeenCalled();
  });

  it('starts no pool for a runner the app never started', async () => {
    // The resource monitor evaluates at launch, before the runner starts,
    // and runs whether or not it ever does; its resume must not bring up a
    // pool with no broker in front of it.
    initRunnerStateMachine();
    runner.isInitialized.mockReturnValue(false);

    await ensureRunnerInitialized();

    expect(runner.initialize).not.toHaveBeenCalled();
  });
});
