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
    githubSha?: string;
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
  checkJobUserFilter(instanceNum: number, runnerName: string): Promise<void>;
  parseRunnerOutput(instanceNum: number, line: string): Promise<void>;
  releaseInstanceSlot(instanceNum: number): void;
  reserveSlot(): number | null;
  releaseSlotReservation(instanceNum: number): void;
  runnerCount: number;
  applyRepoPolicy(instanceNum: number): Promise<void>;
  proxyServers: Map<number, unknown>;
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

  /**
   * Run the job user filter check for an instance.
   */
  checkJobUserFilter(instanceNum: number, runnerName: string): Promise<void> {
    return this.internals.checkJobUserFilter(instanceNum, runnerName);
  }

  /**
   * Feed a line of runner output through the parser.
   */
  parseRunnerOutput(instanceNum: number, line: string): Promise<void> {
    return this.internals.parseRunnerOutput(instanceNum, line);
  }

  /**
   * Release an instance slot as the process-exit handler does.
   */
  releaseInstanceSlot(instanceNum: number): void {
    this.internals.releaseInstanceSlot(instanceNum);
  }

  /**
   * Apply the repository's .localmostrc policy to an instance's proxy.
   */
  applyRepoPolicy(instanceNum: number): Promise<void> {
    return this.internals.applyRepoPolicy(instanceNum);
  }

  /** Register a stub proxy for an instance. */
  setProxy(instanceNum: number, proxy: unknown): void {
    this.internals.proxyServers.set(instanceNum, proxy);
  }

  /** Reserve a worker slot as spawnWorkerForJob does. */
  reserveSlot(): number | null {
    return this.internals.reserveSlot();
  }

  /** Release a slot reservation. */
  releaseSlotReservation(instanceNum: number): void {
    this.internals.releaseSlotReservation(instanceNum);
  }

  set runnerCount(value: number) {
    this.internals.runnerCount = value;
  }
}
