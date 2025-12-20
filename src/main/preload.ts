import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  RunnerState,
  LogEntry,
  SetupState,
  GitHubUser,
  GitHubRepo,
  GitHubOrg,
  DownloadProgress,
  ConfigureOptions,
  DeviceCodeInfo,
  RunnerRelease,
  JobHistoryEntry,
  HeartbeatStatus,
} from '../shared/types';

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('localmost', {
  // App / Setup
  app: {
    getSetupState: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_SETUP_STATE),
    minimizeToTray: () => ipcRenderer.send(IPC_CHANNELS.APP_MINIMIZE_TO_TRAY),
    quit: () => ipcRenderer.send(IPC_CHANNELS.APP_QUIT),
    getHostname: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_HOSTNAME),
    getCpuCount: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_CPU_COUNT),
    onNavigate: (callback: (view: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, view: string) => callback(view);
      ipcRenderer.on('navigate', handler);
      return () => ipcRenderer.removeListener('navigate', handler);
    },
  },

  // GitHub auth (Device Flow)
  github: {
    startAuth: () => ipcRenderer.invoke(IPC_CHANNELS.GITHUB_AUTH_START),
    startDeviceFlow: () => ipcRenderer.invoke(IPC_CHANNELS.GITHUB_AUTH_DEVICE_FLOW),
    cancelAuth: () => ipcRenderer.invoke(IPC_CHANNELS.GITHUB_AUTH_CANCEL),
    getAuthStatus: () => ipcRenderer.invoke(IPC_CHANNELS.GITHUB_AUTH_STATUS),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.GITHUB_AUTH_LOGOUT),
    getRepos: () => ipcRenderer.invoke(IPC_CHANNELS.GITHUB_GET_REPOS),
    getOrgs: () => ipcRenderer.invoke(IPC_CHANNELS.GITHUB_GET_ORGS),
    onDeviceCode: (callback: (info: DeviceCodeInfo) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, info: DeviceCodeInfo) => callback(info);
      ipcRenderer.on(IPC_CHANNELS.GITHUB_DEVICE_CODE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.GITHUB_DEVICE_CODE, handler);
    },
  },

  // Runner control
  runner: {
    start: () => ipcRenderer.invoke(IPC_CHANNELS.RUNNER_START),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.RUNNER_STOP),
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.RUNNER_STATUS),
    isDownloaded: () => ipcRenderer.invoke(IPC_CHANNELS.RUNNER_IS_DOWNLOADED),
    isConfigured: () => ipcRenderer.invoke(IPC_CHANNELS.RUNNER_IS_CONFIGURED),
    getDisplayName: () => ipcRenderer.invoke(IPC_CHANNELS.RUNNER_GET_DISPLAY_NAME),
    download: () => ipcRenderer.invoke(IPC_CHANNELS.RUNNER_DOWNLOAD),
    configure: (options: ConfigureOptions) => ipcRenderer.invoke(IPC_CHANNELS.RUNNER_CONFIGURE, options),
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.RUNNER_GET_VERSION),
    getAvailableVersions: () => ipcRenderer.invoke(IPC_CHANNELS.RUNNER_GET_AVAILABLE_VERSIONS),
    setDownloadVersion: (version: string | null) => ipcRenderer.invoke(IPC_CHANNELS.RUNNER_SET_DOWNLOAD_VERSION, version),
    onStatusUpdate: (callback: (state: RunnerState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: RunnerState) => callback(state);
      ipcRenderer.on(IPC_CHANNELS.RUNNER_STATUS_UPDATE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.RUNNER_STATUS_UPDATE, handler);
    },
    onDownloadProgress: (callback: (progress: DownloadProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: DownloadProgress) => callback(progress);
      ipcRenderer.on(IPC_CHANNELS.RUNNER_DOWNLOAD_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.RUNNER_DOWNLOAD_PROGRESS, handler);
    },
  },

  // Logs
  logs: {
    onEntry: (callback: (entry: LogEntry) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, entry: LogEntry) => callback(entry);
      ipcRenderer.on(IPC_CHANNELS.LOG_ENTRY, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.LOG_ENTRY, handler);
    },
    write: (entry: LogEntry) => ipcRenderer.invoke(IPC_CHANNELS.LOG_WRITE, entry),
    clear: () => ipcRenderer.send(IPC_CHANNELS.LOG_CLEAR),
    getPath: () => ipcRenderer.invoke(IPC_CHANNELS.LOG_GET_PATH),
  },

  // Job history
  jobs: {
    getHistory: () => ipcRenderer.invoke(IPC_CHANNELS.JOB_HISTORY_GET),
    setMaxHistory: (max: number) => ipcRenderer.invoke(IPC_CHANNELS.JOB_HISTORY_SET_MAX, max),
    onHistoryUpdate: (callback: (jobs: JobHistoryEntry[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, jobs: JobHistoryEntry[]) => callback(jobs);
      ipcRenderer.on(IPC_CHANNELS.JOB_HISTORY_UPDATE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.JOB_HISTORY_UPDATE, handler);
    },
  },

  // Settings
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
    set: (settings: Record<string, unknown>) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, settings),
  },

  // Heartbeat
  heartbeat: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.HEARTBEAT_GET_STATUS),
  },

  // Network status
  network: {
    isOnline: () => ipcRenderer.invoke(IPC_CHANNELS.NETWORK_GET_STATUS),
    onStatusChange: (callback: (isOnline: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, isOnline: boolean) => callback(isOnline);
      ipcRenderer.on(IPC_CHANNELS.NETWORK_STATUS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NETWORK_STATUS_CHANGED, handler);
    },
  },
});

// Type declarations for the exposed API
export interface LocalmostAPI {
  app: {
    getSetupState: () => Promise<SetupState>;
    minimizeToTray: () => void;
    quit: () => void;
    getHostname: () => Promise<string>;
    getCpuCount: () => Promise<number>;
    onNavigate: (callback: (view: string) => void) => () => void;
  };
  github: {
    startAuth: () => Promise<{ success: boolean; user?: GitHubUser; error?: string }>;
    startDeviceFlow: () => Promise<{ success: boolean; user?: GitHubUser; error?: string }>;
    cancelAuth: () => Promise<{ success: boolean }>;
    getAuthStatus: () => Promise<{ isAuthenticated: boolean; user?: GitHubUser }>;
    logout: () => Promise<{ success: boolean }>;
    getRepos: () => Promise<{ success: boolean; repos?: GitHubRepo[]; error?: string }>;
    getOrgs: () => Promise<{ success: boolean; orgs?: GitHubOrg[]; error?: string }>;
    onDeviceCode: (callback: (info: DeviceCodeInfo) => void) => () => void;
  };
  runner: {
    start: () => Promise<{ success: boolean; error?: string }>;
    stop: () => Promise<{ success: boolean; error?: string }>;
    getStatus: () => Promise<RunnerState>;
    isDownloaded: () => Promise<boolean>;
    isConfigured: () => Promise<boolean>;
    getDisplayName: () => Promise<string>;
    download: () => Promise<{ success: boolean; error?: string }>;
    configure: (options: ConfigureOptions) => Promise<{ success: boolean; error?: string }>;
    getVersion: () => Promise<{ version: string | null; url: string | null }>;
    getAvailableVersions: () => Promise<{ success: boolean; versions: RunnerRelease[]; error?: string }>;
    setDownloadVersion: (version: string | null) => Promise<{ success: boolean }>;
    onStatusUpdate: (callback: (state: RunnerState) => void) => () => void;
    onDownloadProgress: (callback: (progress: DownloadProgress) => void) => () => void;
  };
  logs: {
    onEntry: (callback: (entry: LogEntry) => void) => () => void;
    write: (entry: LogEntry) => Promise<void>;
    clear: () => void;
    getPath: () => Promise<string>;
  };
  jobs: {
    getHistory: () => Promise<JobHistoryEntry[]>;
    setMaxHistory: (max: number) => Promise<{ success: boolean }>;
    onHistoryUpdate: (callback: (jobs: JobHistoryEntry[]) => void) => () => void;
  };
  settings: {
    get: () => Promise<Record<string, unknown>>;
    set: (settings: Record<string, unknown>) => Promise<{ success: boolean }>;
  };
  heartbeat: {
    getStatus: () => Promise<HeartbeatStatus>;
  };
  network: {
    isOnline: () => Promise<boolean>;
    onStatusChange: (callback: (isOnline: boolean) => void) => () => void;
  };
}

declare global {
  interface Window {
    localmost: LocalmostAPI;
  }
}
