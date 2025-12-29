/**
 * Main Zustand store - single source of truth for app state.
 *
 * This store runs in the main process and syncs to renderer via zubridge.
 */

import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';
import {
  AppStore,
  AppState,
  defaultAppState,
  ConfigSlice,
  ThemeSetting,
} from './types';
import {
  LogLevel,
  SleepProtection,
  ToolCacheLocation,
  UserFilterConfig,
  PowerConfig,
  NotificationsConfig,
  GitHubUser,
  DeviceCodeInfo,
  RunnerState,
  JobHistoryEntry,
  DownloadProgress,
  RunnerRelease,
  Target,
  RunnerProxyStatus,
  UpdateStatus,
  UpdateSettings,
  LogEntry,
  GitHubRepo,
  GitHubOrg,
} from '../../shared/types';

// Create the store
export const store = createStore<AppStore>()(
  subscribeWithSelector((set, _get) => ({
    // Initial state
    ...defaultAppState,

    // ==========================================================================
    // Config Actions
    // ==========================================================================

    setTheme: (theme: ThemeSetting) => {
      set((state) => ({ config: { ...state.config, theme } }));
    },

    setLogLevel: (logLevel: LogLevel) => {
      set((state) => ({ config: { ...state.config, logLevel } }));
    },

    setRunnerLogLevel: (runnerLogLevel: LogLevel) => {
      set((state) => ({ config: { ...state.config, runnerLogLevel } }));
    },

    setMaxLogScrollback: (maxLogScrollback: number) => {
      set((state) => {
        // Trim logs if needed
        const logs = state.ui.logs.length > maxLogScrollback
          ? state.ui.logs.slice(-maxLogScrollback)
          : state.ui.logs;
        return {
          config: { ...state.config, maxLogScrollback },
          ui: { ...state.ui, logs },
        };
      });
    },

    setMaxJobHistory: (maxJobHistory: number) => {
      set((state) => ({ config: { ...state.config, maxJobHistory } }));
    },

    setSleepProtection: (sleepProtection: SleepProtection) => {
      set((state) => ({ config: { ...state.config, sleepProtection } }));
    },

    consentToSleepProtection: () => {
      set((state) => ({ config: { ...state.config, sleepProtectionConsented: true } }));
    },

    setPreserveWorkDir: (preserveWorkDir: 'never' | 'session' | 'always') => {
      set((state) => ({ config: { ...state.config, preserveWorkDir } }));
    },

    setToolCacheLocation: (toolCacheLocation: ToolCacheLocation) => {
      set((state) => ({ config: { ...state.config, toolCacheLocation } }));
    },

    setUserFilter: (userFilter: UserFilterConfig) => {
      set((state) => ({ config: { ...state.config, userFilter } }));
    },

    setPower: (power: PowerConfig) => {
      set((state) => ({ config: { ...state.config, power } }));
    },

    setNotifications: (notifications: NotificationsConfig) => {
      set((state) => ({ config: { ...state.config, notifications } }));
    },

    setLaunchAtLogin: (launchAtLogin: boolean) => {
      set((state) => ({ config: { ...state.config, launchAtLogin } }));
    },

    setHideOnStart: (hideOnStart: boolean) => {
      set((state) => ({ config: { ...state.config, hideOnStart } }));
    },

    updateRunnerConfig: (updates: Partial<ConfigSlice['runnerConfig']>) => {
      set((state) => ({
        config: {
          ...state.config,
          runnerConfig: { ...state.config.runnerConfig, ...updates },
        },
      }));
    },

    setTargets: (targets: Target[]) => {
      set((state) => ({ config: { ...state.config, targets } }));
    },

    setMaxConcurrentJobs: (maxConcurrentJobs: number) => {
      set((state) => ({ config: { ...state.config, maxConcurrentJobs } }));
    },

    // ==========================================================================
    // Auth Actions
    // ==========================================================================

    setUser: (user: GitHubUser | null) => {
      set((state) => ({
        auth: {
          ...state.auth,
          user,
          isAuthenticated: user !== null,
        },
      }));
    },

    setIsAuthenticating: (isAuthenticating: boolean) => {
      set((state) => ({ auth: { ...state.auth, isAuthenticating } }));
    },

    setDeviceCode: (deviceCode: DeviceCodeInfo | null) => {
      set((state) => ({ auth: { ...state.auth, deviceCode } }));
    },

    logout: () => {
      set((state) => ({
        auth: {
          ...state.auth,
          user: null,
          isAuthenticated: false,
          deviceCode: null,
        },
        github: {
          repos: [],
          orgs: [],
        },
      }));
    },

    // ==========================================================================
    // Runner Actions
    // ==========================================================================

    setRunnerState: (runnerState: RunnerState) => {
      set((state) => ({ runner: { ...state.runner, runnerState } }));
    },

    setIsDownloaded: (isDownloaded: boolean) => {
      set((state) => ({ runner: { ...state.runner, isDownloaded } }));
    },

    setIsConfigured: (isConfigured: boolean) => {
      set((state) => ({ runner: { ...state.runner, isConfigured } }));
    },

    setRunnerVersion: (runnerVersion: { version: string | null; url: string | null }) => {
      set((state) => ({ runner: { ...state.runner, runnerVersion } }));
    },

    setAvailableVersions: (availableVersions: RunnerRelease[]) => {
      set((state) => ({ runner: { ...state.runner, availableVersions } }));
    },

    setSelectedVersion: (selectedVersion: string) => {
      set((state) => ({ runner: { ...state.runner, selectedVersion } }));
    },

    setDownloadProgress: (downloadProgress: DownloadProgress | null) => {
      set((state) => ({ runner: { ...state.runner, downloadProgress } }));
    },

    setIsLoadingVersions: (isLoadingVersions: boolean) => {
      set((state) => ({ runner: { ...state.runner, isLoadingVersions } }));
    },

    setRunnerDisplayName: (runnerDisplayName: string | null) => {
      set((state) => ({ runner: { ...state.runner, runnerDisplayName } }));
    },

    setTargetStatus: (targetStatus: RunnerProxyStatus[]) => {
      set((state) => ({ runner: { ...state.runner, targetStatus } }));
    },

    // ==========================================================================
    // Jobs Actions
    // ==========================================================================

    setJobHistory: (history: JobHistoryEntry[]) => {
      set((state) => ({ jobs: { ...state.jobs, history } }));
    },

    addJob: (job: JobHistoryEntry) => {
      set((state) => {
        const maxHistory = state.config.maxJobHistory;
        const history = [job, ...state.jobs.history].slice(0, maxHistory);
        return { jobs: { ...state.jobs, history } };
      });
    },

    updateJob: (jobId: string, updates: Partial<JobHistoryEntry>) => {
      set((state) => ({
        jobs: {
          ...state.jobs,
          history: state.jobs.history.map((job) =>
            job.id === jobId ? { ...job, ...updates } : job
          ),
        },
      }));
    },

    // ==========================================================================
    // GitHub Actions
    // ==========================================================================

    setRepos: (repos: GitHubRepo[]) => {
      set((state) => ({ github: { ...state.github, repos } }));
    },

    setOrgs: (orgs: GitHubOrg[]) => {
      set((state) => ({ github: { ...state.github, orgs } }));
    },

    // ==========================================================================
    // Update Actions
    // ==========================================================================

    setUpdateStatus: (status: UpdateStatus) => {
      set((state) => ({
        update: {
          ...state.update,
          status,
          isChecking: status.status === 'checking',
          // Reset dismissed when new update is available
          isDismissed: status.status === 'available' ? false : state.update.isDismissed,
        },
      }));
    },

    setUpdateSettings: (settings: UpdateSettings) => {
      set((state) => ({ update: { ...state.update, settings } }));
    },

    setIsChecking: (isChecking: boolean) => {
      set((state) => ({ update: { ...state.update, isChecking } }));
    },

    setIsDismissed: (isDismissed: boolean) => {
      set((state) => ({ update: { ...state.update, isDismissed } }));
    },

    setLastChecked: (lastChecked: string | null) => {
      set((state) => ({ update: { ...state.update, lastChecked } }));
    },

    // ==========================================================================
    // UI Actions
    // ==========================================================================

    setIsOnline: (isOnline: boolean) => {
      set((state) => ({ ui: { ...state.ui, isOnline } }));
    },

    setIsLoading: (isLoading: boolean) => {
      set((state) => ({ ui: { ...state.ui, isLoading } }));
    },

    setIsInitialLoading: (isInitialLoading: boolean) => {
      set((state) => ({ ui: { ...state.ui, isInitialLoading } }));
    },

    setError: (error: string | null) => {
      set((state) => ({ ui: { ...state.ui, error } }));
    },

    addLog: (log: LogEntry) => {
      set((state) => {
        const maxScrollback = state.config.maxLogScrollback;
        const logs = [...state.ui.logs.slice(-(maxScrollback - 1)), log];
        return { ui: { ...state.ui, logs } };
      });
    },

    clearLogs: () => {
      set((state) => ({ ui: { ...state.ui, logs: [] } }));
    },
  }))
);

// Export typed getState and subscribe
export const getState = store.getState;
export const setState = store.setState;
export const subscribe = store.subscribe;

// =============================================================================
// Selectors
// =============================================================================

// Config selectors
export const selectConfig = (state: AppState) => state.config;
export const selectTheme = (state: AppState) => state.config.theme;
export const selectLogLevel = (state: AppState) => state.config.logLevel;
export const selectRunnerLogLevel = (state: AppState) => state.config.runnerLogLevel;
export const selectPower = (state: AppState) => state.config.power;
export const selectNotifications = (state: AppState) => state.config.notifications;
export const selectTargets = (state: AppState) => state.config.targets;
export const selectRunnerConfig = (state: AppState) => state.config.runnerConfig;

// Auth selectors
export const selectAuth = (state: AppState) => state.auth;
export const selectUser = (state: AppState) => state.auth.user;
export const selectIsAuthenticated = (state: AppState) => state.auth.isAuthenticated;

// Runner selectors
export const selectRunner = (state: AppState) => state.runner;
export const selectRunnerState = (state: AppState) => state.runner.runnerState;
export const selectIsDownloaded = (state: AppState) => state.runner.isDownloaded;
export const selectIsConfigured = (state: AppState) => state.runner.isConfigured;
export const selectTargetStatus = (state: AppState) => state.runner.targetStatus;

// Jobs selectors
export const selectJobs = (state: AppState) => state.jobs;
export const selectJobHistory = (state: AppState) => state.jobs.history;

// GitHub selectors
export const selectGitHub = (state: AppState) => state.github;
export const selectRepos = (state: AppState) => state.github.repos;
export const selectOrgs = (state: AppState) => state.github.orgs;

// Update selectors
export const selectUpdate = (state: AppState) => state.update;
export const selectUpdateStatus = (state: AppState) => state.update.status;

// UI selectors
export const selectUI = (state: AppState) => state.ui;
export const selectIsOnline = (state: AppState) => state.ui.isOnline;
export const selectLogs = (state: AppState) => state.ui.logs;
export const selectError = (state: AppState) => state.ui.error;
