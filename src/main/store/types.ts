/**
 * Zustand store types - single source of truth for app state.
 */

import {
  LogEntry,
  LogLevel,
  SleepProtection,
  ToolCacheLocation,
  UserFilterConfig,
  PowerConfig,
  NotificationsConfig,
  GitHubUser,
  GitHubRepo,
  GitHubOrg,
  DeviceCodeInfo,
  RunnerState,
  JobHistoryEntry,
  DownloadProgress,
  RunnerRelease,
  Target,
  RunnerProxyStatus,
  UpdateStatus,
  UpdateSettings,
  DEFAULT_POWER_CONFIG,
  DEFAULT_NOTIFICATIONS_CONFIG,
} from '../../shared/types';

// =============================================================================
// Theme Types
// =============================================================================

export type ThemeSetting = 'light' | 'dark' | 'auto';

// =============================================================================
// Config Slice - Settings that persist to disk
// =============================================================================

export interface ConfigSlice {
  // Theme
  theme: ThemeSetting;

  // Logging
  logLevel: LogLevel;
  runnerLogLevel: LogLevel;
  maxLogScrollback: number;

  // Job history
  maxJobHistory: number;

  // Sleep protection
  sleepProtection: SleepProtection;
  sleepProtectionConsented: boolean;

  // Runner settings
  preserveWorkDir: 'never' | 'session' | 'always';
  toolCacheLocation: ToolCacheLocation;

  // User filter
  userFilter: UserFilterConfig;

  // Power settings
  power: PowerConfig;

  // Notifications
  notifications: NotificationsConfig;

  // App launch settings
  launchAtLogin: boolean;
  hideOnStart: boolean;

  // Runner configuration
  runnerConfig: {
    level: 'repo' | 'org';
    repoUrl: string;
    orgName: string;
    runnerName: string;
    labels: string;
    runnerCount: number;
  };

  // Multi-target configuration
  targets: Target[];
  maxConcurrentJobs: number;
}

// =============================================================================
// Auth Slice - Authentication state
// =============================================================================

export interface AuthSlice {
  user: GitHubUser | null;
  isAuthenticated: boolean;
  isAuthenticating: boolean;
  deviceCode: DeviceCodeInfo | null;
}

// =============================================================================
// Runner Slice - Runner runtime state (mostly from XState)
// =============================================================================

export interface RunnerSlice {
  // Runner status (from XState machine)
  runnerState: RunnerState;

  // Binary state
  isDownloaded: boolean;
  isConfigured: boolean;
  runnerVersion: { version: string | null; url: string | null };
  availableVersions: RunnerRelease[];
  selectedVersion: string;
  downloadProgress: DownloadProgress | null;
  isLoadingVersions: boolean;
  runnerDisplayName: string | null;

  // Target status (runtime)
  targetStatus: RunnerProxyStatus[];
}

// =============================================================================
// Jobs Slice - Job history
// =============================================================================

export interface JobsSlice {
  history: JobHistoryEntry[];
}

// =============================================================================
// GitHub Slice - Repos and orgs data
// =============================================================================

export interface GitHubSlice {
  repos: GitHubRepo[];
  orgs: GitHubOrg[];
}

// =============================================================================
// Update Slice - Auto-update state
// =============================================================================

export interface UpdateSlice {
  status: UpdateStatus;
  settings: UpdateSettings;
  isChecking: boolean;
  isDismissed: boolean;
  lastChecked: string | null;
}

// =============================================================================
// UI Slice - Transient UI state (not persisted)
// =============================================================================

export interface UISlice {
  isOnline: boolean;
  isLoading: boolean;
  isInitialLoading: boolean;
  error: string | null;
  logs: LogEntry[];
}

// =============================================================================
// Combined Store State
// =============================================================================

export interface AppState {
  config: ConfigSlice;
  auth: AuthSlice;
  runner: RunnerSlice;
  jobs: JobsSlice;
  github: GitHubSlice;
  update: UpdateSlice;
  ui: UISlice;
}

// =============================================================================
// Store Actions
// =============================================================================

export interface ConfigActions {
  setTheme: (theme: ThemeSetting) => void;
  setLogLevel: (level: LogLevel) => void;
  setRunnerLogLevel: (level: LogLevel) => void;
  setMaxLogScrollback: (max: number) => void;
  setMaxJobHistory: (max: number) => void;
  setSleepProtection: (setting: SleepProtection) => void;
  consentToSleepProtection: () => void;
  setPreserveWorkDir: (setting: 'never' | 'session' | 'always') => void;
  setToolCacheLocation: (setting: ToolCacheLocation) => void;
  setUserFilter: (filter: UserFilterConfig) => void;
  setPower: (config: PowerConfig) => void;
  setNotifications: (config: NotificationsConfig) => void;
  setLaunchAtLogin: (enabled: boolean) => void;
  setHideOnStart: (enabled: boolean) => void;
  updateRunnerConfig: (updates: Partial<ConfigSlice['runnerConfig']>) => void;
  setTargets: (targets: Target[]) => void;
  setMaxConcurrentJobs: (max: number) => void;
}

export interface AuthActions {
  setUser: (user: GitHubUser | null) => void;
  setIsAuthenticating: (isAuthenticating: boolean) => void;
  setDeviceCode: (deviceCode: DeviceCodeInfo | null) => void;
  logout: () => void;
}

export interface RunnerActions {
  setRunnerState: (state: RunnerState) => void;
  setIsDownloaded: (isDownloaded: boolean) => void;
  setIsConfigured: (isConfigured: boolean) => void;
  setRunnerVersion: (version: { version: string | null; url: string | null }) => void;
  setAvailableVersions: (versions: RunnerRelease[]) => void;
  setSelectedVersion: (version: string) => void;
  setDownloadProgress: (progress: DownloadProgress | null) => void;
  setIsLoadingVersions: (isLoading: boolean) => void;
  setRunnerDisplayName: (name: string | null) => void;
  setTargetStatus: (status: RunnerProxyStatus[]) => void;
}

export interface JobsActions {
  setJobHistory: (history: JobHistoryEntry[]) => void;
  addJob: (job: JobHistoryEntry) => void;
  updateJob: (jobId: string, updates: Partial<JobHistoryEntry>) => void;
}

export interface GitHubActions {
  setRepos: (repos: GitHubRepo[]) => void;
  setOrgs: (orgs: GitHubOrg[]) => void;
}

export interface UpdateActions {
  setUpdateStatus: (status: UpdateStatus) => void;
  setUpdateSettings: (settings: UpdateSettings) => void;
  setIsChecking: (isChecking: boolean) => void;
  setIsDismissed: (isDismissed: boolean) => void;
  setLastChecked: (lastChecked: string | null) => void;
}

export interface UIActions {
  setIsOnline: (isOnline: boolean) => void;
  setIsLoading: (isLoading: boolean) => void;
  setIsInitialLoading: (isInitialLoading: boolean) => void;
  setError: (error: string | null) => void;
  addLog: (log: LogEntry) => void;
  clearLogs: () => void;
}

export interface AppActions extends
  ConfigActions,
  AuthActions,
  RunnerActions,
  JobsActions,
  GitHubActions,
  UpdateActions,
  UIActions {}

// =============================================================================
// Full Store Type
// =============================================================================

export type AppStore = AppState & AppActions;

// =============================================================================
// Default State
// =============================================================================

export const defaultConfigState: ConfigSlice = {
  theme: 'auto',
  logLevel: 'info',
  runnerLogLevel: 'warn',
  maxLogScrollback: 500,
  maxJobHistory: 10,
  sleepProtection: 'never',
  sleepProtectionConsented: false,
  preserveWorkDir: 'never',
  toolCacheLocation: 'persistent',
  userFilter: { mode: 'just-me', allowlist: [] },
  power: DEFAULT_POWER_CONFIG,
  notifications: DEFAULT_NOTIFICATIONS_CONFIG,
  launchAtLogin: false,
  hideOnStart: false,
  runnerConfig: {
    level: 'repo',
    repoUrl: '',
    orgName: '',
    runnerName: '',
    labels: 'self-hosted,macOS',
    runnerCount: 4,
  },
  targets: [],
  maxConcurrentJobs: 4,
};

export const defaultAuthState: AuthSlice = {
  user: null,
  isAuthenticated: false,
  isAuthenticating: false,
  deviceCode: null,
};

export const defaultRunnerState: RunnerSlice = {
  runnerState: { status: 'offline' },
  isDownloaded: false,
  isConfigured: false,
  runnerVersion: { version: null, url: null },
  availableVersions: [],
  selectedVersion: '',
  downloadProgress: null,
  isLoadingVersions: false,
  runnerDisplayName: null,
  targetStatus: [],
};

export const defaultJobsState: JobsSlice = {
  history: [],
};

export const defaultGitHubState: GitHubSlice = {
  repos: [],
  orgs: [],
};

export const defaultUpdateState: UpdateSlice = {
  status: { status: 'idle', currentVersion: '' },
  settings: { autoCheck: true, checkIntervalHours: 24 },
  isChecking: false,
  isDismissed: false,
  lastChecked: null,
};

export const defaultUIState: UISlice = {
  isOnline: true,
  isLoading: false,
  isInitialLoading: true,
  error: null,
  logs: [],
};

export const defaultAppState: AppState = {
  config: defaultConfigState,
  auth: defaultAuthState,
  runner: defaultRunnerState,
  jobs: defaultJobsState,
  github: defaultGitHubState,
  update: defaultUpdateState,
  ui: defaultUIState,
};
