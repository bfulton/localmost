// =============================================================================
// Result Type - Consistent error handling for IPC operations
// =============================================================================

/**
 * Represents a successful result with optional data.
 */
export interface SuccessResult<T = void> {
  success: true;
  data?: T;
}

/**
 * Represents a failed result with an error message.
 */
export interface ErrorResult {
  success: false;
  error: string;
}

/**
 * A discriminated union type for IPC operation results.
 * Use this for consistent error handling across all IPC calls.
 *
 * @example
 * // In main process:
 * ipcMain.handle('my-operation', async (): Promise<Result<MyData>> => {
 *   try {
 *     const data = await doSomething();
 *     return { success: true, data };
 *   } catch (error) {
 *     return { success: false, error: (error as Error).message };
 *   }
 * });
 *
 * // In renderer:
 * const result = await window.localmost.myOperation();
 * if (result.success) {
 *   console.log(result.data);
 * } else {
 *   console.error(result.error);
 * }
 */
export type Result<T = void> = SuccessResult<T> | ErrorResult;

/**
 * Helper to create a success result.
 */
export const success = <T>(data?: T): SuccessResult<T> => ({ success: true, data });

/**
 * Helper to create an error result.
 */
export const failure = (error: string | Error): ErrorResult => ({
  success: false,
  error: typeof error === 'string' ? error : error.message,
});

// =============================================================================
// Runner Types
// =============================================================================

// Runner status types
// - 'offline': Runner not started or fully stopped
// - 'starting': Runner process is starting up
// - 'listening': Runner is connected and waiting for jobs
// - 'busy': Runner is actively processing a job
// - 'error': Runner encountered an error
// - 'shutting_down': Runner is in the process of stopping
export type RunnerStatus = 'offline' | 'starting' | 'listening' | 'busy' | 'error' | 'shutting_down';

export interface RunnerState {
  status: RunnerStatus;
  jobName?: string;
  repository?: string;
  startedAt?: string;
  error?: string;
}

export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobHistoryEntry {
  id: string;
  jobName: string;
  repository: string;
  status: JobStatus;
  startedAt: string;
  completedAt?: string;
  runTimeSeconds?: number;
  actionsUrl?: string;
  githubJobId?: number;
  runnerName?: string;
  /** For multi-target: which target this job came from */
  targetId?: string;
  targetDisplayName?: string;
}

export interface RunnerConfig {
  url: string;
  token: string;
  name: string;
  labels: string[];
  workFolder: string;
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

// Setup state
export type SetupStep = 'welcome' | 'auth' | 'download' | 'configure' | 'complete';

export interface SetupState {
  step: SetupStep;
  isRunnerDownloaded: boolean;
  isRunnerConfigured: boolean;
  user?: GitHubUser;
  error?: string;
}

export interface DownloadProgress {
  phase: 'downloading' | 'extracting' | 'complete' | 'error';
  percent: number;
  message: string;
}

export interface RunnerRelease {
  version: string;
  url: string;
  publishedAt: string;
}

// IPC channel names
export const IPC_CHANNELS = {
  // Runner control
  RUNNER_START: 'runner:start',
  RUNNER_STOP: 'runner:stop',
  RUNNER_STATUS: 'runner:status',
  RUNNER_STATUS_UPDATE: 'runner:status-update',
  RUNNER_IS_CONFIGURED: 'runner:is-configured',
  RUNNER_GET_DISPLAY_NAME: 'runner:get-display-name',

  // Logs
  LOG_ENTRY: 'log:entry',
  LOG_WRITE: 'log:write',
  LOG_CLEAR: 'log:clear',
  LOG_GET_PATH: 'log:get-path',

  // Job history
  JOB_HISTORY_GET: 'job:history-get',
  JOB_HISTORY_SET_MAX: 'job:history-set-max',
  JOB_HISTORY_UPDATE: 'job:history-update',

  // GitHub auth (Device Flow)
  GITHUB_AUTH_START: 'github:auth-start',
  GITHUB_AUTH_DEVICE_FLOW: 'github:auth-device-flow',
  GITHUB_AUTH_POLL: 'github:auth-poll',
  GITHUB_AUTH_CANCEL: 'github:auth-cancel',
  GITHUB_DEVICE_CODE: 'github:device-code',
  GITHUB_AUTH_STATUS: 'github:auth-status',
  GITHUB_AUTH_LOGOUT: 'github:auth-logout',
  GITHUB_GET_REPOS: 'github:get-repos',
  GITHUB_GET_ORGS: 'github:get-orgs',
  GITHUB_GET_REGISTRATION_TOKEN: 'github:get-registration-token',
  GITHUB_SEARCH_USERS: 'github:search-users',

  // Runner setup
  RUNNER_DOWNLOAD: 'runner:download',
  RUNNER_DOWNLOAD_PROGRESS: 'runner:download-progress',
  RUNNER_IS_DOWNLOADED: 'runner:is-downloaded',
  RUNNER_CONFIGURE: 'runner:configure',
  RUNNER_GET_VERSION: 'runner:get-version',
  RUNNER_GET_AVAILABLE_VERSIONS: 'runner:get-available-versions',
  RUNNER_SET_DOWNLOAD_VERSION: 'runner:set-download-version',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // App
  APP_QUIT: 'app:quit',
  APP_MINIMIZE_TO_TRAY: 'app:minimize-to-tray',
  APP_GET_SETUP_STATE: 'app:get-setup-state',
  APP_GET_HOSTNAME: 'app:get-hostname',
  APP_GET_CPU_COUNT: 'app:get-cpu-count',

  // Heartbeat
  HEARTBEAT_GET_STATUS: 'heartbeat:get-status',

  // Network status
  NETWORK_GET_STATUS: 'network:get-status',
  NETWORK_STATUS_CHANGED: 'network:status-changed',

  // Auto-update
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  UPDATE_GET_STATUS: 'update:get-status',
  UPDATE_STATUS: 'update:status',

  // Targets (multi-target runner support)
  TARGETS_LIST: 'targets:list',
  TARGETS_ADD: 'targets:add',
  TARGETS_REMOVE: 'targets:remove',
  TARGETS_UPDATE: 'targets:update',
  TARGETS_GET_STATUS: 'targets:get-status',
  TARGETS_STATUS_UPDATE: 'targets:status-update',

  // Resource-aware scheduling
  RESOURCE_GET_STATE: 'resource:get-state',
  RESOURCE_STATE_CHANGED: 'resource:state-changed',
} as const;

export interface GitHubUser {
  login: string;
  avatar_url: string;
  name: string | null;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  private: boolean;
  html_url: string;
  owner: {
    login: string;
    type: string;
  };
}

export interface GitHubOrg {
  id: number;
  login: string;
  avatar_url: string;
}

export interface ConfigureOptions {
  level: 'repo' | 'org';
  repoUrl?: string;  // Required for repo level
  orgName?: string;  // Required for org level
  runnerName: string;
  labels: string[];
  runnerCount?: number;  // Number of parallel runners (1-16), defaults to 1
}

export type SleepProtection = 'never' | 'when-busy' | 'always';

/** Log level - controls what gets displayed/saved. Lower = more verbose */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type PreserveWorkDir = 'never' | 'session' | 'always';

/** Tool cache location - controls where actions like setup-node cache downloaded tools */
export type ToolCacheLocation = 'persistent' | 'per-sandbox';

/** Log level priority for filtering (lower number = more verbose) */
export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface AppSettings {
  githubClientId?: string;
  maxLogScrollback?: number;
  sleepProtection?: SleepProtection;
  /** Whether user has consented to sleep protection feature. Defaults to false */
  sleepProtectionConsented?: boolean;
  /** Minimum log level for localmost app logs. Defaults to 'info' */
  logLevel?: LogLevel;
  /** Minimum log level for runner output logs. Defaults to 'warn' */
  runnerLogLevel?: LogLevel;
  /** Preserve workflow _work directory. Defaults to 'never' */
  preserveWorkDir?: PreserveWorkDir;
  /** Tool cache location. Defaults to 'persistent' (shared across restarts) */
  toolCacheLocation?: ToolCacheLocation;
}

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
}

export interface HeartbeatStatus {
  /** Whether the heartbeat is currently running */
  isRunning: boolean;
}

// =============================================================================
// User Filter Types
// =============================================================================

/** Mode for filtering jobs by triggering user */
export type UserFilterMode = 'everyone' | 'just-me' | 'allowlist';

/** A GitHub user for the filter allowlist */
export interface AllowlistUser {
  login: string;
  avatar_url: string;
  name: string | null;
}

/** User filter configuration */
export interface UserFilterConfig {
  mode: UserFilterMode;
  /** List of allowed users (only used when mode is 'allowlist') */
  allowlist: AllowlistUser[];
}

/** Search result for GitHub users */
export interface GitHubUserSearchResult {
  login: string;
  avatar_url: string;
  name: string | null;
}

// =============================================================================
// Auto-Update Types
// =============================================================================

/** Status of the auto-updater */
export type UpdateStatusType =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

/** Current state of the auto-updater */
export interface UpdateStatus {
  status: UpdateStatusType;
  currentVersion: string;
  availableVersion?: string;
  releaseNotes?: string;
  releaseDate?: string;
  downloadProgress?: number;
  bytesPerSecond?: number;
  totalBytes?: number;
  transferredBytes?: number;
  error?: string;
}

/** User preferences for auto-updates */
export interface UpdateSettings {
  /** Whether to automatically check for updates on startup (default: true) */
  autoCheck: boolean;
  /** Hours between automatic update checks (default: 24) */
  checkIntervalHours: number;
}

// =============================================================================
// Multi-Target Types
// =============================================================================

/**
 * A target represents a GitHub repo or org where runners can be registered.
 * Each target gets its own runner proxy registration with GitHub.
 */
export interface Target {
  /** Unique identifier for this target */
  id: string;
  /** Whether this is a repo or org level target */
  type: 'repo' | 'org';
  /** GitHub owner (user or org name) */
  owner: string;
  /** Repository name (only for type='repo') */
  repo?: string;
  /** Display name (e.g., "owner/repo" or "org-name") */
  displayName: string;
  /** Full GitHub URL */
  url: string;
  /** Runner proxy name registered with GitHub (e.g., "localmost.hostname.repo-name") */
  proxyRunnerName: string;
  /** Whether this target is enabled for job polling */
  enabled: boolean;
  /** ISO timestamp when target was added */
  addedAt: string;
}

/**
 * Status for a runner proxy (phantom registration with GitHub).
 */
export interface RunnerProxyStatus {
  /** Target this proxy is for */
  targetId: string;
  /** Whether runner is registered with GitHub */
  registered: boolean;
  /** Whether broker session is active */
  sessionActive: boolean;
  /** Last successful poll timestamp */
  lastPoll: string | null;
  /** Total jobs assigned from this target */
  jobsAssigned: number;
  /** Error message if something went wrong */
  error?: string;
}

/**
 * Status for a worker (execution environment).
 */
export interface WorkerStatus {
  /** Worker instance number */
  id: number;
  /** Current state */
  status: 'idle' | 'starting' | 'running' | 'busy' | 'error';
  /** Current job info if busy */
  currentJob?: {
    targetId: string;
    targetDisplayName: string;
    jobName: string;
    startedAt: string;
  };
  /** Total jobs completed by this worker */
  jobsCompleted: number;
}

/**
 * Aggregate state for multi-target runner system.
 */
export interface MultiTargetRunnerState {
  /** Overall system status */
  status: 'idle' | 'starting' | 'running' | 'error';
  /** When the system was started */
  startedAt?: string;
  /** Status of each runner proxy */
  targets: RunnerProxyStatus[];
  /** Status of each worker */
  workers: WorkerStatus[];
  /** Number of currently active jobs */
  activeJobs: number;
  /** Maximum concurrent jobs allowed */
  maxConcurrentJobs: number;
}

// =============================================================================
// Resource-Aware Scheduling Types
// =============================================================================

/** Battery threshold for auto-pause. 'no' means never pause for battery. */
export type BatteryPauseThreshold = 'no' | '<25%' | '<50%' | '<75%';

/** Resource condition that can trigger auto-pause */
export interface ResourceCondition {
  type: 'battery' | 'video-call';
  active: boolean;
  reason: string;
  since?: string; // ISO timestamp
}

/** Resource-aware scheduling configuration */
export interface ResourceAwareConfig {
  /** Pause when on battery power below threshold */
  pauseOnBattery: BatteryPauseThreshold;
  /** Pause during video calls (camera detection) */
  pauseOnVideoCall: boolean;
  /** Seconds to wait after call ends before resuming */
  videoCallGracePeriod: number;
  /** Show notifications when auto-pausing/resuming */
  notifyOnPause: boolean;
}

/** Default resource-aware configuration */
export const DEFAULT_RESOURCE_CONFIG: ResourceAwareConfig = {
  pauseOnBattery: 'no',
  pauseOnVideoCall: false,
  videoCallGracePeriod: 60,
  notifyOnPause: false,
};

/** Resource pause state for UI display */
export interface ResourcePauseState {
  /** Whether the runner is currently paused due to resource conditions */
  isPaused: boolean;
  /** The reason for the pause (highest priority condition) */
  reason: string | null;
  /** All active conditions */
  conditions: ResourceCondition[];
}
