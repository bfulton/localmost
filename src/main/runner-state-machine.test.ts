/**
 * Tests for the runner state machine.
 */

import { createActor } from 'xstate';
import { runnerMachine } from './runner-state-machine';

describe('runnerMachine', () => {
  // Helper to create a fresh actor for each test
  const createTestActor = () => {
    const actor = createActor(runnerMachine);
    actor.start();
    return actor;
  };

  describe('initial state', () => {
    it('should start in idle state', () => {
      const actor = createTestActor();
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    });

    it('should have correct initial context', () => {
      const actor = createTestActor();
      const { context } = actor.getSnapshot();

      expect(context.startedAt).toBeNull();
      expect(context.error).toBeNull();
      expect(context.userPaused).toBe(false);
      expect(context.resourcePaused).toBe(false);
      expect(context.resourcePauseReason).toBeNull();
      expect(context.instances.size).toBe(0);
      expect(context.busyInstances.size).toBe(0);
      expect(context.currentJob).toBeNull();
      expect(context.targetSessions.size).toBe(0);

      actor.stop();
    });
  });

  describe('lifecycle transitions', () => {
    it('should transition from idle to starting on START', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });

      expect(actor.getSnapshot().value).toBe('starting');
      expect(actor.getSnapshot().context.startedAt).not.toBeNull();

      actor.stop();
    });

    it('should transition from starting to running on INITIALIZED', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });

      expect(actor.getSnapshot().value).toEqual({ running: 'listening' });

      actor.stop();
    });

    it('should transition from starting to running on INSTANCE_LISTENING', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INSTANCE_LISTENING', instanceNum: 1 });

      expect(actor.getSnapshot().value).toEqual({ running: 'listening' });

      actor.stop();
    });

    it('should transition from starting to error on INSTANCE_ERROR', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INSTANCE_ERROR', instanceNum: 1, error: 'Failed to start' });

      expect(actor.getSnapshot().value).toBe('error');
      expect(actor.getSnapshot().context.error).toBe('Failed to start');

      actor.stop();
    });

    it('should transition from running to shuttingDown on STOP', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });
      actor.send({ type: 'STOP' });

      expect(actor.getSnapshot().value).toBe('shuttingDown');

      actor.stop();
    });

    it('should transition from shuttingDown to idle on SHUTDOWN_COMPLETE', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });
      actor.send({ type: 'STOP' });
      actor.send({ type: 'SHUTDOWN_COMPLETE' });

      expect(actor.getSnapshot().value).toBe('idle');
      expect(actor.getSnapshot().context.startedAt).toBeNull();

      actor.stop();
    });

    it('should recover from error state on START', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INSTANCE_ERROR', instanceNum: 1, error: 'Failed' });
      expect(actor.getSnapshot().value).toBe('error');

      actor.send({ type: 'START' });
      expect(actor.getSnapshot().value).toBe('starting');
      expect(actor.getSnapshot().context.error).toBeNull();

      actor.stop();
    });
  });

  describe('pause state management', () => {
    it('should transition to paused on USER_PAUSE', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });
      actor.send({ type: 'USER_PAUSE' });

      expect(actor.getSnapshot().value).toEqual({ running: 'paused' });
      expect(actor.getSnapshot().context.userPaused).toBe(true);

      actor.stop();
    });

    it('should transition to paused on RESOURCE_PAUSE', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });
      actor.send({ type: 'RESOURCE_PAUSE', reason: 'Low battery' });

      expect(actor.getSnapshot().value).toEqual({ running: 'paused' });
      expect(actor.getSnapshot().context.resourcePaused).toBe(true);
      expect(actor.getSnapshot().context.resourcePauseReason).toBe('Low battery');

      actor.stop();
    });

    it('should resume to listening on USER_RESUME when not resource paused', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });
      actor.send({ type: 'USER_PAUSE' });
      actor.send({ type: 'USER_RESUME' });

      expect(actor.getSnapshot().value).toEqual({ running: 'listening' });
      expect(actor.getSnapshot().context.userPaused).toBe(false);

      actor.stop();
    });

    it('should stay paused on USER_RESUME when resource paused', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });
      actor.send({ type: 'USER_PAUSE' });
      actor.send({ type: 'RESOURCE_PAUSE', reason: 'Video call' });
      actor.send({ type: 'USER_RESUME' });

      expect(actor.getSnapshot().value).toEqual({ running: 'paused' });
      expect(actor.getSnapshot().context.userPaused).toBe(false);
      expect(actor.getSnapshot().context.resourcePaused).toBe(true);

      actor.stop();
    });

    it('should stay paused on RESOURCE_RESUME when user paused', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });
      actor.send({ type: 'RESOURCE_PAUSE', reason: 'Video call' });
      actor.send({ type: 'USER_PAUSE' });
      actor.send({ type: 'RESOURCE_RESUME' });

      expect(actor.getSnapshot().value).toEqual({ running: 'paused' });
      expect(actor.getSnapshot().context.userPaused).toBe(true);
      expect(actor.getSnapshot().context.resourcePaused).toBe(false);

      actor.stop();
    });

    it('should require both resumes to exit paused state', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });
      actor.send({ type: 'USER_PAUSE' });
      actor.send({ type: 'RESOURCE_PAUSE', reason: 'Video call' });

      // Resume resource first
      actor.send({ type: 'RESOURCE_RESUME' });
      expect(actor.getSnapshot().value).toEqual({ running: 'paused' });

      // Resume user second
      actor.send({ type: 'USER_RESUME' });
      expect(actor.getSnapshot().value).toEqual({ running: 'listening' });

      actor.stop();
    });
  });

  describe('job management', () => {
    it('should transition to busy on JOB_START', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });
      actor.send({
        type: 'JOB_START',
        instanceNum: 1,
        job: { name: 'Build', repository: 'owner/repo', runnerName: 'runner-1' },
      });

      expect(actor.getSnapshot().value).toEqual({ running: 'busy' });
      expect(actor.getSnapshot().context.busyInstances.has(1)).toBe(true);
      expect(actor.getSnapshot().context.currentJob?.name).toBe('Build');

      actor.stop();
    });

    it('should transition to listening on JOB_COMPLETE when no other busy instances', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });
      actor.send({
        type: 'JOB_START',
        instanceNum: 1,
        job: { name: 'Build', repository: 'owner/repo', runnerName: 'runner-1' },
      });
      actor.send({ type: 'JOB_COMPLETE', instanceNum: 1, result: 'succeeded' });

      expect(actor.getSnapshot().value).toEqual({ running: 'listening' });
      expect(actor.getSnapshot().context.busyInstances.size).toBe(0);
      expect(actor.getSnapshot().context.currentJob).toBeNull();

      actor.stop();
    });

    it('should stay busy when other instances are still busy', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });

      // Start two jobs
      actor.send({
        type: 'JOB_START',
        instanceNum: 1,
        job: { name: 'Build 1', repository: 'owner/repo', runnerName: 'runner-1' },
      });
      actor.send({
        type: 'JOB_START',
        instanceNum: 2,
        job: { name: 'Build 2', repository: 'owner/repo', runnerName: 'runner-2' },
      });

      expect(actor.getSnapshot().context.busyInstances.size).toBe(2);

      // Complete first job
      actor.send({ type: 'JOB_COMPLETE', instanceNum: 1, result: 'succeeded' });

      expect(actor.getSnapshot().value).toEqual({ running: 'busy' });
      expect(actor.getSnapshot().context.busyInstances.size).toBe(1);
      expect(actor.getSnapshot().context.busyInstances.has(2)).toBe(true);

      actor.stop();
    });

    it('should increment jobsCompleted on job complete', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });

      // First job
      actor.send({
        type: 'JOB_START',
        instanceNum: 1,
        job: { name: 'Build', repository: 'owner/repo', runnerName: 'runner-1' },
      });
      actor.send({ type: 'JOB_COMPLETE', instanceNum: 1, result: 'succeeded' });

      expect(actor.getSnapshot().context.instances.get(1)?.jobsCompleted).toBe(1);

      // Second job
      actor.send({
        type: 'JOB_START',
        instanceNum: 1,
        job: { name: 'Test', repository: 'owner/repo', runnerName: 'runner-1' },
      });
      actor.send({ type: 'JOB_COMPLETE', instanceNum: 1, result: 'succeeded' });

      expect(actor.getSnapshot().context.instances.get(1)?.jobsCompleted).toBe(2);

      actor.stop();
    });

    it('should allow jobs to complete while paused', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });
      actor.send({
        type: 'JOB_START',
        instanceNum: 1,
        job: { name: 'Build', repository: 'owner/repo', runnerName: 'runner-1' },
      });
      actor.send({ type: 'USER_PAUSE' });

      // Job completes while paused
      actor.send({ type: 'JOB_COMPLETE', instanceNum: 1, result: 'succeeded' });

      expect(actor.getSnapshot().value).toEqual({ running: 'paused' });
      expect(actor.getSnapshot().context.busyInstances.size).toBe(0);

      actor.stop();
    });
  });

  describe('instance management', () => {
    it('should track instance states', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });

      actor.send({ type: 'INSTANCE_STARTING', instanceNum: 1 });
      expect(actor.getSnapshot().context.instances.get(1)?.status).toBe('starting');

      actor.send({ type: 'INSTANCE_LISTENING', instanceNum: 1 });
      expect(actor.getSnapshot().context.instances.get(1)?.status).toBe('listening');

      actor.send({ type: 'INSTANCE_BUSY', instanceNum: 1 });
      expect(actor.getSnapshot().context.instances.get(1)?.status).toBe('busy');
      expect(actor.getSnapshot().context.busyInstances.has(1)).toBe(true);

      actor.send({ type: 'INSTANCE_STOPPED', instanceNum: 1 });
      expect(actor.getSnapshot().context.instances.get(1)?.status).toBe('offline');
      expect(actor.getSnapshot().context.busyInstances.has(1)).toBe(false);

      actor.stop();
    });

    it('should handle fatal instance errors', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });
      actor.send({ type: 'INSTANCE_FATAL', instanceNum: 1, reason: 'Crashed' });

      const instance = actor.getSnapshot().context.instances.get(1);
      expect(instance?.status).toBe('error');
      expect(instance?.fatalError).toBe(true);

      actor.stop();
    });

    it('should clear instances on shutdown', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });
      actor.send({ type: 'INSTANCE_STARTING', instanceNum: 1 });
      actor.send({ type: 'INSTANCE_LISTENING', instanceNum: 1 });

      expect(actor.getSnapshot().context.instances.size).toBe(1);

      actor.send({ type: 'STOP' });

      expect(actor.getSnapshot().context.instances.size).toBe(0);
      expect(actor.getSnapshot().context.busyInstances.size).toBe(0);

      actor.stop();
    });
  });

  describe('target session management', () => {
    it('should track target session state', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });

      actor.send({ type: 'TARGET_SESSION_ACTIVE', targetId: 'target-1' });

      const session = actor.getSnapshot().context.targetSessions.get('target-1');
      expect(session?.sessionActive).toBe(true);
      expect(session?.lastPoll).not.toBeNull();
      expect(session?.error).toBeNull();

      actor.stop();
    });

    it('should track session errors', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });
      actor.send({ type: 'TARGET_SESSION_ACTIVE', targetId: 'target-1' });
      actor.send({ type: 'TARGET_SESSION_ERROR', targetId: 'target-1', error: 'Connection failed' });

      const session = actor.getSnapshot().context.targetSessions.get('target-1');
      expect(session?.sessionActive).toBe(false);
      expect(session?.error).toBe('Connection failed');

      actor.stop();
    });

    it('should track session closed', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });
      actor.send({ type: 'TARGET_SESSION_ACTIVE', targetId: 'target-1' });
      actor.send({ type: 'TARGET_SESSION_CLOSED', targetId: 'target-1' });

      const session = actor.getSnapshot().context.targetSessions.get('target-1');
      expect(session?.sessionActive).toBe(false);

      actor.stop();
    });
  });

  describe('guards', () => {
    it('anyInstanceBusy should return true when instances are busy', () => {
      const actor = createTestActor();

      actor.send({ type: 'START' });
      actor.send({ type: 'INITIALIZED' });

      // Start two jobs
      actor.send({
        type: 'JOB_START',
        instanceNum: 1,
        job: { name: 'Build 1', repository: 'owner/repo', runnerName: 'runner-1' },
      });
      actor.send({
        type: 'JOB_START',
        instanceNum: 2,
        job: { name: 'Build 2', repository: 'owner/repo', runnerName: 'runner-2' },
      });

      // Complete one job - should stay busy due to guard
      actor.send({ type: 'JOB_COMPLETE', instanceNum: 1, result: 'succeeded' });
      expect(actor.getSnapshot().value).toEqual({ running: 'busy' });

      // Complete second job - should transition to listening
      actor.send({ type: 'JOB_COMPLETE', instanceNum: 2, result: 'succeeded' });
      expect(actor.getSnapshot().value).toEqual({ running: 'listening' });

      actor.stop();
    });
  });
});
