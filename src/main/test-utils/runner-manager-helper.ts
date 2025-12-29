/**
 * Runner Manager Test Helper
 *
 * Provides type-safe access to RunnerManager internals for testing.
 */

import { RunnerManager } from '../runner-manager';
import type { RunnerStatus } from '../../shared/types';
import { ChildProcess } from 'child_process';

/**
 * Internal runner instance state (mirrors private type).
 */
interface RunnerInstance {
  process: ChildProcess | null;
  status: RunnerStatus;
  currentJob: {
    name: string;
    repository: string;
    startedAt: string;
    id: string;
    targetId?: string;
    targetDisplayName?: string;
    actionsUrl?: string;
    githubRunId?: number;
    githubJobId?: number;
    githubActor?: string;
  } | null;
  name: string;
  jobsCompleted: number;
  fatalError: boolean;
}

/**
 * Extended RunnerManager type that exposes internals for testing.
 */
interface RunnerManagerInternals {
  instances: Map<number, RunnerInstance>;
  stopping: boolean;
  startedAt: string | null;
  isUserAllowed(actorLogin: string): boolean;
}

/**
 * Helper class for testing RunnerManager.
 * Provides type-safe access to private members.
 */
export class RunnerManagerTestHelper {
  private manager: RunnerManager;
  private internals: RunnerManagerInternals;

  constructor(manager: RunnerManager) {
    this.manager = manager;
    // Cast once to access internals
    this.internals = manager as unknown as RunnerManagerInternals;
  }

  /**
   * Get the internal instances map.
   */
  get instances(): Map<number, RunnerInstance> {
    return this.internals.instances;
  }

  /**
   * Set an instance in the map.
   */
  setInstance(num: number, instance: Partial<RunnerInstance>): void {
    const full: RunnerInstance = {
      process: null,
      status: 'offline',
      currentJob: null,
      name: `runner-${num}`,
      jobsCompleted: 0,
      fatalError: false,
      ...instance,
    };
    this.internals.instances.set(num, full);
  }

  /**
   * Set the stopping flag.
   */
  set stopping(value: boolean) {
    this.internals.stopping = value;
  }

  /**
   * Set the startedAt timestamp.
   */
  set startedAt(value: string | null) {
    this.internals.startedAt = value;
  }

  /**
   * Call the private isUserAllowed method.
   */
  isUserAllowed(actorLogin: string): boolean {
    return this.internals.isUserAllowed(actorLogin);
  }
}
