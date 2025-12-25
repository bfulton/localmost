/**
 * Tests for the runner state service.
 */

import {
  initRunnerStateMachine,
  stopRunnerStateMachine,
  sendRunnerEvent,
  onStateChange,
  getSnapshot,
  getRunnerActor,
  selectRunnerStatus,
  selectEffectivePauseState,
  selectIsPaused,
  selectIsUserPaused,
  selectIsResourcePaused,
  selectIsRunning,
  selectIsBusy,
  selectBusyInstances,
  selectCurrentJob,
  selectHasActiveSession,
  selectError,
  getRunnerStatus,
  getEffectivePauseState,
  isUserPaused,
  isResourcePaused,
  isRunning,
  isBusy,
  getBusyInstances,
} from './runner-state-service';

describe('runner-state-service', () => {
  beforeEach(() => {
    // Ensure clean state before each test
    stopRunnerStateMachine();
  });

  afterEach(() => {
    stopRunnerStateMachine();
  });

  describe('actor lifecycle', () => {
    it('should initialize the state machine', () => {
      const actor = initRunnerStateMachine();
      expect(actor).toBeDefined();
      expect(getRunnerActor()).toBe(actor);
    });

    it('should return existing actor on re-initialization', () => {
      const actor1 = initRunnerStateMachine();
      const actor2 = initRunnerStateMachine();
      expect(actor1).toBe(actor2);
    });

    it('should stop the state machine', () => {
      initRunnerStateMachine();
      expect(getRunnerActor()).not.toBeNull();

      stopRunnerStateMachine();
      expect(getRunnerActor()).toBeNull();
    });

    it('should get snapshot', () => {
      initRunnerStateMachine();
      const snapshot = getSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot?.value).toBe('idle');
    });

    it('should return null snapshot when not initialized', () => {
      const snapshot = getSnapshot();
      expect(snapshot).toBeNull();
    });
  });

  describe('sendRunnerEvent', () => {
    it('should send events to the actor', () => {
      initRunnerStateMachine();

      sendRunnerEvent({ type: 'START' });
      expect(getSnapshot()?.value).toBe('starting');

      sendRunnerEvent({ type: 'INITIALIZED' });
      expect(getSnapshot()?.value).toEqual({ running: 'listening' });
    });

    it('should not throw when actor is not initialized', () => {
      // Should not throw
      expect(() => sendRunnerEvent({ type: 'START' })).not.toThrow();
    });
  });

  describe('onStateChange', () => {
    it('should register callbacks', () => {
      initRunnerStateMachine();

      const callback = jest.fn();
      const unsubscribe = onStateChange(callback);

      sendRunnerEvent({ type: 'START' });

      expect(callback).toHaveBeenCalled();
      unsubscribe();
    });

    it('should unsubscribe callbacks', () => {
      initRunnerStateMachine();

      const callback = jest.fn();
      const unsubscribe = onStateChange(callback);
      unsubscribe();

      sendRunnerEvent({ type: 'START' });

      // Callback was called once during subscription, but not after unsubscribe
      expect(callback.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('should handle callback errors gracefully', () => {
      initRunnerStateMachine();

      const errorCallback = jest.fn(() => {
        throw new Error('Callback error');
      });
      const normalCallback = jest.fn();

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      onStateChange(errorCallback);
      onStateChange(normalCallback);

      // Should not throw and should continue to other callbacks
      expect(() => sendRunnerEvent({ type: 'START' })).not.toThrow();
      expect(normalCallback).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('selectors', () => {
    describe('selectRunnerStatus', () => {
      it('should return offline for idle state', () => {
        initRunnerStateMachine();
        const status = selectRunnerStatus(getSnapshot()!);
        expect(status.status).toBe('offline');
      });

      it('should return starting for starting state', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        const status = selectRunnerStatus(getSnapshot()!);
        expect(status.status).toBe('starting');
        expect(status.startedAt).toBeDefined();
      });

      it('should return listening for running.listening state', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        const status = selectRunnerStatus(getSnapshot()!);
        expect(status.status).toBe('listening');
      });

      it('should return busy for running.busy state', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        sendRunnerEvent({
          type: 'JOB_START',
          instanceNum: 1,
          job: { name: 'Build', repository: 'owner/repo', runnerName: 'runner-1' },
        });
        const status = selectRunnerStatus(getSnapshot()!);
        expect(status.status).toBe('busy');
        expect(status.jobName).toBe('Build');
        expect(status.repository).toBe('owner/repo');
      });

      it('should return listening for running.paused state', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        sendRunnerEvent({ type: 'USER_PAUSE' });
        const status = selectRunnerStatus(getSnapshot()!);
        expect(status.status).toBe('listening');
      });

      it('should return error for error state', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INSTANCE_ERROR', instanceNum: 1, error: 'Failed' });
        const status = selectRunnerStatus(getSnapshot()!);
        expect(status.status).toBe('error');
      });

      it('should return shutting_down for shuttingDown state', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        sendRunnerEvent({ type: 'STOP' });
        const status = selectRunnerStatus(getSnapshot()!);
        expect(status.status).toBe('shutting_down');
      });
    });

    describe('selectEffectivePauseState', () => {
      it('should return not paused when neither paused', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        const pause = selectEffectivePauseState(getSnapshot()!);
        expect(pause.isPaused).toBe(false);
        expect(pause.reason).toBeNull();
      });

      it('should return user paused', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        sendRunnerEvent({ type: 'USER_PAUSE' });
        const pause = selectEffectivePauseState(getSnapshot()!);
        expect(pause.isPaused).toBe(true);
        expect(pause.reason).toBe('Paused by user');
      });

      it('should return resource paused with reason', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        sendRunnerEvent({ type: 'RESOURCE_PAUSE', reason: 'Low battery' });
        const pause = selectEffectivePauseState(getSnapshot()!);
        expect(pause.isPaused).toBe(true);
        expect(pause.reason).toBe('Low battery');
      });

      it('should prioritize user pause over resource pause', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        sendRunnerEvent({ type: 'RESOURCE_PAUSE', reason: 'Low battery' });
        sendRunnerEvent({ type: 'USER_PAUSE' });
        const pause = selectEffectivePauseState(getSnapshot()!);
        expect(pause.isPaused).toBe(true);
        expect(pause.reason).toBe('Paused by user');
      });
    });

    describe('selectIsPaused', () => {
      it('should return false when not in paused substate', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        expect(selectIsPaused(getSnapshot()!)).toBe(false);
      });

      it('should return true when in paused substate', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        sendRunnerEvent({ type: 'USER_PAUSE' });
        expect(selectIsPaused(getSnapshot()!)).toBe(true);
      });
    });

    describe('selectIsUserPaused', () => {
      it('should return context.userPaused', () => {
        initRunnerStateMachine();
        expect(selectIsUserPaused(getSnapshot()!)).toBe(false);

        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        sendRunnerEvent({ type: 'USER_PAUSE' });
        expect(selectIsUserPaused(getSnapshot()!)).toBe(true);
      });
    });

    describe('selectIsResourcePaused', () => {
      it('should return context.resourcePaused', () => {
        initRunnerStateMachine();
        expect(selectIsResourcePaused(getSnapshot()!)).toBe(false);

        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        sendRunnerEvent({ type: 'RESOURCE_PAUSE', reason: 'Battery' });
        expect(selectIsResourcePaused(getSnapshot()!)).toBe(true);
      });
    });

    describe('selectIsRunning', () => {
      it('should return false for non-running states', () => {
        initRunnerStateMachine();
        expect(selectIsRunning(getSnapshot()!)).toBe(false);

        sendRunnerEvent({ type: 'START' });
        expect(selectIsRunning(getSnapshot()!)).toBe(false);
      });

      it('should return true for running states', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        expect(selectIsRunning(getSnapshot()!)).toBe(true);
      });
    });

    describe('selectIsBusy', () => {
      it('should return true when instances are busy', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        expect(selectIsBusy(getSnapshot()!)).toBe(false);

        sendRunnerEvent({
          type: 'JOB_START',
          instanceNum: 1,
          job: { name: 'Build', repository: 'owner/repo', runnerName: 'runner-1' },
        });
        expect(selectIsBusy(getSnapshot()!)).toBe(true);
      });
    });

    describe('selectBusyInstances', () => {
      it('should return set of busy instance numbers', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        expect(selectBusyInstances(getSnapshot()!).size).toBe(0);

        sendRunnerEvent({
          type: 'JOB_START',
          instanceNum: 1,
          job: { name: 'Build', repository: 'owner/repo', runnerName: 'runner-1' },
        });
        expect(selectBusyInstances(getSnapshot()!).has(1)).toBe(true);
      });
    });

    describe('selectCurrentJob', () => {
      it('should return current job info', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        expect(selectCurrentJob(getSnapshot()!)).toBeNull();

        sendRunnerEvent({
          type: 'JOB_START',
          instanceNum: 1,
          job: { name: 'Build', repository: 'owner/repo', runnerName: 'runner-1' },
        });
        const job = selectCurrentJob(getSnapshot()!);
        expect(job?.name).toBe('Build');
        expect(job?.repository).toBe('owner/repo');
        expect(job?.runnerName).toBe('runner-1');
        expect(job?.startedAt).toBeDefined();
      });
    });

    describe('selectHasActiveSession', () => {
      it('should return true when target has active session', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        expect(selectHasActiveSession(getSnapshot()!)).toBe(false);

        sendRunnerEvent({ type: 'TARGET_SESSION_ACTIVE', targetId: 'target-1' });
        expect(selectHasActiveSession(getSnapshot()!)).toBe(true);
      });
    });

    describe('selectError', () => {
      it('should return error message', () => {
        initRunnerStateMachine();
        expect(selectError(getSnapshot()!)).toBeNull();

        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INSTANCE_ERROR', instanceNum: 1, error: 'Connection failed' });
        expect(selectError(getSnapshot()!)).toBe('Connection failed');
      });
    });
  });

  describe('convenience functions', () => {
    describe('getRunnerStatus', () => {
      it('should return offline when not initialized', () => {
        const status = getRunnerStatus();
        expect(status.status).toBe('offline');
      });

      it('should return current status', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        const status = getRunnerStatus();
        expect(status.status).toBe('listening');
      });
    });

    describe('getEffectivePauseState', () => {
      it('should return not paused when not initialized', () => {
        const pause = getEffectivePauseState();
        expect(pause.isPaused).toBe(false);
        expect(pause.reason).toBeNull();
      });

      it('should return current pause state', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        sendRunnerEvent({ type: 'USER_PAUSE' });
        const pause = getEffectivePauseState();
        expect(pause.isPaused).toBe(true);
      });
    });

    describe('isUserPaused', () => {
      it('should return false when not initialized', () => {
        expect(isUserPaused()).toBe(false);
      });

      it('should return current user pause state', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        sendRunnerEvent({ type: 'USER_PAUSE' });
        expect(isUserPaused()).toBe(true);
      });
    });

    describe('isResourcePaused', () => {
      it('should return false when not initialized', () => {
        expect(isResourcePaused()).toBe(false);
      });

      it('should return current resource pause state', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        sendRunnerEvent({ type: 'RESOURCE_PAUSE', reason: 'Battery' });
        expect(isResourcePaused()).toBe(true);
      });
    });

    describe('isRunning', () => {
      it('should return false when not initialized', () => {
        expect(isRunning()).toBe(false);
      });

      it('should return current running state', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        expect(isRunning()).toBe(true);
      });
    });

    describe('isBusy', () => {
      it('should return false when not initialized', () => {
        expect(isBusy()).toBe(false);
      });

      it('should return current busy state', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        sendRunnerEvent({
          type: 'JOB_START',
          instanceNum: 1,
          job: { name: 'Build', repository: 'owner/repo', runnerName: 'runner-1' },
        });
        expect(isBusy()).toBe(true);
      });
    });

    describe('getBusyInstances', () => {
      it('should return empty set when not initialized', () => {
        expect(getBusyInstances().size).toBe(0);
      });

      it('should return current busy instances', () => {
        initRunnerStateMachine();
        sendRunnerEvent({ type: 'START' });
        sendRunnerEvent({ type: 'INITIALIZED' });
        sendRunnerEvent({
          type: 'JOB_START',
          instanceNum: 1,
          job: { name: 'Build', repository: 'owner/repo', runnerName: 'runner-1' },
        });
        expect(getBusyInstances().has(1)).toBe(true);
      });
    });
  });
});
