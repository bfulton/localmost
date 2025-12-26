/**
 * XState state machine for runner state management.
 * Single source of truth for runner status, pause state, and instance tracking.
 */

import { setup, assign } from 'xstate';

// Instance state tracked per runner instance
export interface InstanceState {
  status: 'offline' | 'starting' | 'listening' | 'busy' | 'error';
  fatalError: boolean;
  currentJob: {
    name: string;
    repository: string;
    startedAt: string;
  } | null;
  jobsCompleted: number;
}

// Target session state for broker proxy connections
export interface TargetSessionState {
  sessionActive: boolean;
  lastPoll: string | null;
  error: string | null;
  jobsAssigned: number;
}

// Machine context - all mutable state
export interface RunnerContext {
  // Core runner state
  startedAt: string | null;
  error: string | null;

  // Pause state (tracked separately, combined for effective pause)
  userPaused: boolean;
  resourcePaused: boolean;
  resourcePauseReason: string | null;

  // Instance tracking
  instances: Map<number, InstanceState>;
  busyInstances: Set<number>;

  // Current job info (for display)
  currentJob: {
    name: string;
    repository: string;
    runnerName: string;
    startedAt: string;
  } | null;

  // Target/broker session state
  targetSessions: Map<string, TargetSessionState>;
}

// All possible events
export type RunnerEvent =
  // Lifecycle events
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'INITIALIZED' }
  | { type: 'SHUTDOWN_COMPLETE' }

  // Instance events
  | { type: 'INSTANCE_STARTING'; instanceNum: number }
  | { type: 'INSTANCE_LISTENING'; instanceNum: number }
  | { type: 'INSTANCE_BUSY'; instanceNum: number }
  | { type: 'INSTANCE_IDLE'; instanceNum: number }
  | { type: 'INSTANCE_ERROR'; instanceNum: number; error: string }
  | { type: 'INSTANCE_FATAL'; instanceNum: number; reason: string }
  | { type: 'INSTANCE_STOPPED'; instanceNum: number }

  // Pause events
  | { type: 'USER_PAUSE' }
  | { type: 'USER_RESUME' }
  | { type: 'RESOURCE_PAUSE'; reason: string }
  | { type: 'RESOURCE_RESUME' }

  // Job events
  | { type: 'JOB_START'; instanceNum: number; job: { name: string; repository: string; runnerName: string } }
  | { type: 'JOB_COMPLETE'; instanceNum: number; result: 'succeeded' | 'failed' | 'cancelled' }

  // Target/session events
  | { type: 'TARGET_SESSION_ACTIVE'; targetId: string }
  | { type: 'TARGET_SESSION_ERROR'; targetId: string; error: string }
  | { type: 'TARGET_SESSION_CLOSED'; targetId: string }
  | { type: 'JOB_RECEIVED'; targetId: string; jobId: string };

// Initial context
const initialContext: RunnerContext = {
  startedAt: null,
  error: null,
  userPaused: false,
  resourcePaused: false,
  resourcePauseReason: null,
  instances: new Map(),
  busyInstances: new Set(),
  currentJob: null,
  targetSessions: new Map(),
};

// Helper to create a default instance state
const createDefaultInstance = (): InstanceState => ({
  status: 'offline',
  fatalError: false,
  currentJob: null,
  jobsCompleted: 0,
});

// Define the state machine
export const runnerMachine = setup({
  types: {
    context: {} as RunnerContext,
    events: {} as RunnerEvent,
  },

  guards: {
    isUserPaused: ({ context }) => context.userPaused,
    isResourcePaused: ({ context }) => context.resourcePaused,
    isPaused: ({ context }) => context.userPaused || context.resourcePaused,
    notUserPaused: ({ context }) => !context.userPaused,
    notResourcePaused: ({ context }) => !context.resourcePaused,
    // Check if there will be busy instances AFTER this job completes
    // Guard is evaluated before the action removes the instance, so we check > 1
    anyInstanceBusy: ({ context, event }) => {
      const e = event as { instanceNum?: number };
      if (e.instanceNum !== undefined && context.busyInstances.has(e.instanceNum)) {
        // This instance is completing, check if others remain
        return context.busyInstances.size > 1;
      }
      return context.busyInstances.size > 0;
    },
    hasActiveSession: ({ context }) => {
      for (const session of context.targetSessions.values()) {
        if (session.sessionActive) return true;
      }
      return false;
    },
  },

  actions: {
    setStartedAt: assign({
      startedAt: () => new Date().toISOString(),
    }),

    clearStartedAt: assign({
      startedAt: () => null,
    }),

    setError: assign({
      error: ({ event }) => {
        if ('error' in event) return (event as { error: string }).error;
        if ('reason' in event) return (event as { reason: string }).reason;
        return 'Unknown error';
      },
    }),

    clearError: assign({
      error: () => null,
    }),

    setUserPaused: assign({
      userPaused: () => true,
    }),

    clearUserPaused: assign({
      userPaused: () => false,
    }),

    setResourcePaused: assign({
      resourcePaused: () => true,
      resourcePauseReason: ({ event }) =>
        (event as { type: 'RESOURCE_PAUSE'; reason: string }).reason,
    }),

    clearResourcePaused: assign({
      resourcePaused: () => false,
      resourcePauseReason: () => null,
    }),

    updateInstanceStarting: assign({
      instances: ({ context, event }) => {
        const e = event as { type: 'INSTANCE_STARTING'; instanceNum: number };
        const updated = new Map(context.instances);
        const instance = updated.get(e.instanceNum) || createDefaultInstance();
        updated.set(e.instanceNum, { ...instance, status: 'starting' });
        return updated;
      },
    }),

    updateInstanceListening: assign({
      instances: ({ context, event }) => {
        const e = event as { type: 'INSTANCE_LISTENING'; instanceNum: number };
        const updated = new Map(context.instances);
        const instance = updated.get(e.instanceNum) || createDefaultInstance();
        updated.set(e.instanceNum, { ...instance, status: 'listening', currentJob: null });
        return updated;
      },
      busyInstances: ({ context, event }) => {
        const e = event as { type: 'INSTANCE_LISTENING'; instanceNum: number };
        const updated = new Set(context.busyInstances);
        updated.delete(e.instanceNum);
        return updated;
      },
    }),

    updateInstanceBusy: assign({
      instances: ({ context, event }) => {
        const e = event as { type: 'INSTANCE_BUSY'; instanceNum: number };
        const updated = new Map(context.instances);
        const instance = updated.get(e.instanceNum) || createDefaultInstance();
        updated.set(e.instanceNum, { ...instance, status: 'busy' });
        return updated;
      },
      busyInstances: ({ context, event }) => {
        const e = event as { type: 'INSTANCE_BUSY'; instanceNum: number };
        const updated = new Set(context.busyInstances);
        updated.add(e.instanceNum);
        return updated;
      },
    }),

    updateInstanceError: assign({
      instances: ({ context, event }) => {
        const e = event as { type: 'INSTANCE_ERROR'; instanceNum: number; error: string };
        const updated = new Map(context.instances);
        const instance = updated.get(e.instanceNum) || createDefaultInstance();
        updated.set(e.instanceNum, { ...instance, status: 'error' });
        return updated;
      },
    }),

    updateInstanceFatal: assign({
      instances: ({ context, event }) => {
        const e = event as { type: 'INSTANCE_FATAL'; instanceNum: number };
        const updated = new Map(context.instances);
        const instance = updated.get(e.instanceNum) || createDefaultInstance();
        updated.set(e.instanceNum, { ...instance, status: 'error', fatalError: true });
        return updated;
      },
    }),

    updateInstanceStopped: assign({
      instances: ({ context, event }) => {
        const e = event as { type: 'INSTANCE_STOPPED'; instanceNum: number };
        const updated = new Map(context.instances);
        const instance = updated.get(e.instanceNum) || createDefaultInstance();
        updated.set(e.instanceNum, { ...instance, status: 'offline', currentJob: null });
        return updated;
      },
      busyInstances: ({ context, event }) => {
        const e = event as { type: 'INSTANCE_STOPPED'; instanceNum: number };
        const updated = new Set(context.busyInstances);
        updated.delete(e.instanceNum);
        return updated;
      },
    }),

    recordJobStart: assign({
      currentJob: ({ event }) => {
        const e = event as { type: 'JOB_START'; job: { name: string; repository: string; runnerName: string } };
        return {
          ...e.job,
          startedAt: new Date().toISOString(),
        };
      },
      instances: ({ context, event }) => {
        const e = event as { type: 'JOB_START'; instanceNum: number; job: { name: string; repository: string } };
        const updated = new Map(context.instances);
        const instance = updated.get(e.instanceNum) || createDefaultInstance();
        updated.set(e.instanceNum, {
          ...instance,
          status: 'busy',
          currentJob: { name: e.job.name, repository: e.job.repository, startedAt: new Date().toISOString() },
        });
        return updated;
      },
      busyInstances: ({ context, event }) => {
        const e = event as { type: 'JOB_START'; instanceNum: number };
        const updated = new Set(context.busyInstances);
        updated.add(e.instanceNum);
        return updated;
      },
    }),

    recordJobComplete: assign({
      currentJob: ({ context }) => {
        // Clear if this was the last busy instance
        if (context.busyInstances.size <= 1) {
          return null;
        }
        return context.currentJob;
      },
      instances: ({ context, event }) => {
        const e = event as { type: 'JOB_COMPLETE'; instanceNum: number };
        const updated = new Map(context.instances);
        const instance = updated.get(e.instanceNum) || createDefaultInstance();
        updated.set(e.instanceNum, {
          ...instance,
          status: 'listening',
          currentJob: null,
          jobsCompleted: instance.jobsCompleted + 1,
        });
        return updated;
      },
      busyInstances: ({ context, event }) => {
        const e = event as { type: 'JOB_COMPLETE'; instanceNum: number };
        const updated = new Set(context.busyInstances);
        updated.delete(e.instanceNum);
        return updated;
      },
    }),

    updateTargetSessionActive: assign({
      targetSessions: ({ context, event }) => {
        const e = event as { type: 'TARGET_SESSION_ACTIVE'; targetId: string };
        const updated = new Map(context.targetSessions);
        const existing = updated.get(e.targetId) || { sessionActive: false, lastPoll: null, error: null, jobsAssigned: 0 };
        updated.set(e.targetId, { ...existing, sessionActive: true, error: null, lastPoll: new Date().toISOString() });
        return updated;
      },
    }),

    updateTargetSessionError: assign({
      targetSessions: ({ context, event }) => {
        const e = event as { type: 'TARGET_SESSION_ERROR'; targetId: string; error: string };
        const updated = new Map(context.targetSessions);
        const existing = updated.get(e.targetId) || { sessionActive: false, lastPoll: null, error: null, jobsAssigned: 0 };
        updated.set(e.targetId, { ...existing, sessionActive: false, error: e.error });
        return updated;
      },
    }),

    updateTargetSessionClosed: assign({
      targetSessions: ({ context, event }) => {
        const e = event as { type: 'TARGET_SESSION_CLOSED'; targetId: string };
        const updated = new Map(context.targetSessions);
        const existing = updated.get(e.targetId) || { sessionActive: false, lastPoll: null, error: null, jobsAssigned: 0 };
        updated.set(e.targetId, { ...existing, sessionActive: false });
        return updated;
      },
    }),

    clearInstances: assign({
      instances: () => new Map(),
      busyInstances: () => new Set(),
      currentJob: () => null,
    }),
  },
}).createMachine({
  id: 'runner',
  initial: 'idle',
  context: initialContext,

  states: {
    idle: {
      on: {
        START: {
          target: 'starting',
          actions: 'setStartedAt',
        },
      },
    },

    starting: {
      on: {
        INITIALIZED: 'running',
        INSTANCE_LISTENING: {
          target: 'running',
          actions: 'updateInstanceListening',
        },
        INSTANCE_ERROR: {
          target: 'error',
          actions: ['updateInstanceError', 'setError'],
        },
        STOP: 'shuttingDown',
      },
    },

    running: {
      initial: 'listening',

      // Events that can happen in any running substate
      on: {
        STOP: 'shuttingDown',

        // Instance events
        INSTANCE_STARTING: { actions: 'updateInstanceStarting' },
        INSTANCE_LISTENING: { actions: 'updateInstanceListening' },
        INSTANCE_ERROR: { actions: 'updateInstanceError' },
        INSTANCE_FATAL: { actions: 'updateInstanceFatal' },
        INSTANCE_STOPPED: { actions: 'updateInstanceStopped' },

        // Target events
        TARGET_SESSION_ACTIVE: { actions: 'updateTargetSessionActive' },
        TARGET_SESSION_ERROR: { actions: 'updateTargetSessionError' },
        TARGET_SESSION_CLOSED: { actions: 'updateTargetSessionClosed' },
      },

      states: {
        listening: {
          on: {
            JOB_START: {
              target: 'busy',
              actions: 'recordJobStart',
            },
            INSTANCE_BUSY: {
              target: 'busy',
              actions: 'updateInstanceBusy',
            },
            USER_PAUSE: {
              target: 'paused',
              actions: 'setUserPaused',
            },
            RESOURCE_PAUSE: {
              target: 'paused',
              actions: 'setResourcePaused',
            },
          },
        },

        busy: {
          on: {
            JOB_START: {
              // Another job started (multi-instance)
              actions: 'recordJobStart',
            },
            JOB_COMPLETE: [
              {
                // More instances still busy
                guard: 'anyInstanceBusy',
                actions: 'recordJobComplete',
              },
              {
                // All instances now idle
                target: 'listening',
                actions: 'recordJobComplete',
              },
            ],
            USER_PAUSE: {
              target: 'paused',
              actions: 'setUserPaused',
            },
            RESOURCE_PAUSE: {
              target: 'paused',
              actions: 'setResourcePaused',
            },
          },
        },

        paused: {
          on: {
            USER_PAUSE: {
              // Already paused, just update flag
              actions: 'setUserPaused',
            },
            RESOURCE_PAUSE: {
              // Already paused, just update reason
              actions: 'setResourcePaused',
            },
            USER_RESUME: [
              {
                // Still resource paused
                guard: 'isResourcePaused',
                actions: 'clearUserPaused',
              },
              {
                // Fully resumed
                target: 'listening',
                actions: 'clearUserPaused',
              },
            ],
            RESOURCE_RESUME: [
              {
                // Still user paused
                guard: 'isUserPaused',
                actions: 'clearResourcePaused',
              },
              {
                // Fully resumed
                target: 'listening',
                actions: 'clearResourcePaused',
              },
            ],
            // Jobs can still complete while paused
            JOB_COMPLETE: {
              actions: 'recordJobComplete',
            },
          },
        },
      },
    },

    error: {
      on: {
        START: {
          target: 'starting',
          actions: ['clearError', 'setStartedAt'],
        },
        STOP: 'idle',
      },
    },

    shuttingDown: {
      entry: 'clearInstances',
      on: {
        SHUTDOWN_COMPLETE: {
          target: 'idle',
          actions: 'clearStartedAt',
        },
      },
    },
  },
});

// Export type for the machine
export type RunnerMachine = typeof runnerMachine;
