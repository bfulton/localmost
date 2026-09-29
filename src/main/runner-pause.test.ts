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
import {
  setAuthState,
  setHeartbeatManager,
  setMainWindow,
  setResourcePaused,
  setRunnerManager,
  setUserPaused,
  isUserPaused,
  isResourcePaused,
} from './app-state';
import {
  getSnapshot,
  initRunnerStateMachine,
  selectEffectivePauseState,
  sendRunnerEvent,
  stopRunnerStateMachine,
} from './runner-state-service';
import { canAcceptJob, ensureRunnerInitialized, pauseRunner, resumeRunner } from './runner-pause';
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
};
const resourceMonitor = { shouldPause: jest.fn(() => false) };
const rendererSend = jest.fn();

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
  resourceMonitor.shouldPause.mockReturnValue(false);
  setHeartbeatManager(heartbeat as unknown as HeartbeatManager);
  setRunnerManager(runner as unknown as RunnerManager);
  setAuthState({ accessToken: 'token', user: { login: 'someone' } } as never);
  setMainWindow({
    isDestroyed: () => false,
    webContents: { send: rendererSend },
  } as unknown as BrowserWindow);
});

afterEach(() => {
  stopRunnerStateMachine();
  setHeartbeatManager(null);
  setRunnerManager(null);
  setAuthState(null);
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

  it('says a runner that was never started is not started, and records no pause', async () => {
    initRunnerStateMachine();

    expect(await pauseRunner()).toBe('not-started');
    expect(isUserPaused()).toBe(false);
    expect(heartbeat.stop).not.toHaveBeenCalled();
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
});

describe('ensureRunnerInitialized', () => {
  it('starts the pool a resource pause stopped', async () => {
    startRunner();
    runner.isInitialized.mockReturnValue(false);

    await ensureRunnerInitialized();

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
