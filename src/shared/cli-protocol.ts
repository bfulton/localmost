/**
 * CLI Protocol
 *
 * The wire format spoken over the Unix domain socket between the `localmost`
 * CLI and the running app. Shared by both ends so the two can't drift.
 */

import type { RunnerState, JobHistoryEntry, ResourcePauseState } from './types';

/** Commands the CLI can send to the app. */
export type CliCommand =
  | 'status'
  | 'pause'
  | 'resume'
  | 'jobs'
  | 'quit'
  | 'targets-list'
  | 'targets-add'
  | 'targets-remove'
  | 'targets-update';

/** Arguments carried by target commands. */
export interface CliRequestArgs {
  /** targets-add: repo or org target. */
  type?: 'repo' | 'org';
  /** targets-add: repo/org owner. */
  owner?: string;
  /** targets-add: repo name (repo targets only). */
  repo?: string;
  /** targets-remove / targets-update: owner/repo, bare owner, or target id. */
  ref?: string;
  /** targets-update: desired enabled state. */
  enabled?: boolean;
}

/** CLI command request. */
export interface CliRequest {
  command: CliCommand;
  args?: CliRequestArgs;
}

/** A configured target plus the runner proxies registered for it. */
export interface TargetSummary {
  id: string;
  displayName: string;
  type: 'repo' | 'org';
  url: string;
  enabled: boolean;
  proxyRunnerName: string;
  runnerCount: number;
  addedAt: string;
}

/** CLI response for status command */
export interface StatusResponse {
  success: true;
  command: 'status';
  data: {
    runner: RunnerState;
    runnerName: string;
    heartbeat: {
      isRunning: boolean;
    };
    authenticated: boolean;
    userName?: string;
    resourcePause?: ResourcePauseState;
  };
}

/** CLI response for jobs command */
export interface JobsResponse {
  success: true;
  command: 'jobs';
  data: {
    jobs: JobHistoryEntry[];
  };
}

/** CLI response for pause/resume/quit commands */
export interface ActionResponse {
  success: true;
  command: 'pause' | 'resume' | 'quit';
  message: string;
}

/** CLI response for targets-list */
export interface TargetsListResponse {
  success: true;
  command: 'targets-list';
  data: {
    targets: TargetSummary[];
  };
}

/** CLI response for targets-add/remove/update */
export interface TargetMutationResponse {
  success: true;
  command: 'targets-add' | 'targets-remove' | 'targets-update';
  data: {
    target: TargetSummary;
  };
}

/** CLI error response */
export interface ErrorResponse {
  success: false;
  error: string;
}

export type CliResponse =
  | StatusResponse
  | JobsResponse
  | ActionResponse
  | TargetsListResponse
  | TargetMutationResponse
  | ErrorResponse;
