/**
 * RunnerContext - provides runner state to React components.
 *
 * This context now reads state from the Zustand store (synced from main via zubridge)
 * and updates via IPC calls (which update the main store).
 */

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { GitHubUser, GitHubRepo, GitHubOrg, RunnerState, JobHistoryEntry, DownloadProgress, DeviceCodeInfo, RunnerRelease, Target, RunnerProxyStatus } from '../../shared/types';
import { useStore } from '../store';

interface RunnerConfig {
  level: 'repo' | 'org';
  repoUrl?: string;
  orgName?: string;
  runnerName: string;
  labels: string;
  runnerCount: number;
}

interface RunnerContextValue {
  // Auth state
  user: GitHubUser | null;
  isAuthenticating: boolean;
  deviceCode: DeviceCodeInfo | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;

  // Repository/Org data
  repos: GitHubRepo[];
  orgs: GitHubOrg[];
  refreshReposAndOrgs: () => Promise<void>;

  // Runner binary state
  isDownloaded: boolean;
  runnerVersion: { version: string | null; url: string | null };
  availableVersions: RunnerRelease[];
  selectedVersion: string;
  setSelectedVersion: (version: string) => void;
  downloadProgress: DownloadProgress | null;
  isLoadingVersions: boolean;
  downloadRunner: () => Promise<void>;

  // Runner configuration
  isConfigured: boolean;
  runnerConfig: RunnerConfig;
  updateRunnerConfig: (updates: Partial<RunnerConfig>) => Promise<void>;
  configureRunner: () => Promise<{ success: boolean; error?: string }>;
  runnerDisplayName: string | null;

  // Targets
  targets: Target[];
  targetStatus: RunnerProxyStatus[];
  refreshTargets: () => Promise<void>;

  // Runner status
  runnerState: RunnerState;
  jobHistory: JobHistoryEntry[];

  // Loading states
  isLoading: boolean;
  isInitialLoading: boolean;
  error: string | null;
  setError: (error: string | null) => void;
}

const RunnerContext = createContext<RunnerContextValue | null>(null);

interface RunnerProviderProps {
  children: ReactNode;
}

// Default runner config
const defaultRunnerConfig: RunnerConfig = {
  level: 'repo',
  repoUrl: '',
  orgName: '',
  runnerName: '',
  labels: 'self-hosted,macOS',
  runnerCount: 4,
};

export const RunnerProvider: React.FC<RunnerProviderProps> = ({ children }) => {
  // Check if zubridge has synced state from main
  const storeState = useStore();
  const isZubridgeReady = storeState !== null && storeState !== undefined;

  // Read state from Zustand store when ready
  const storeUser = useStore((state) => state?.auth?.user ?? null);
  const storeIsAuthenticating = useStore((state) => state?.auth?.isAuthenticating ?? false);
  const storeDeviceCode = useStore((state) => state?.auth?.deviceCode ?? null);
  const storeRepos = useStore((state) => state?.github?.repos ?? []);
  const storeOrgs = useStore((state) => state?.github?.orgs ?? []);
  const storeIsDownloaded = useStore((state) => state?.runner?.isDownloaded ?? false);
  const storeRunnerVersion = useStore((state) => state?.runner?.runnerVersion ?? { version: null, url: null });
  const storeAvailableVersions = useStore((state) => state?.runner?.availableVersions ?? []);
  const storeSelectedVersion = useStore((state) => state?.runner?.selectedVersion ?? '');
  const storeDownloadProgress = useStore((state) => state?.runner?.downloadProgress ?? null);
  const storeIsLoadingVersions = useStore((state) => state?.runner?.isLoadingVersions ?? false);
  const storeIsConfigured = useStore((state) => state?.runner?.isConfigured ?? false);
  const storeRunnerConfig = useStore((state) => state?.config?.runnerConfig ?? defaultRunnerConfig);
  const storeRunnerDisplayName = useStore((state) => state?.runner?.runnerDisplayName ?? null);
  const storeTargets = useStore((state) => state?.config?.targets ?? []);
  const storeTargetStatus = useStore((state) => state?.runner?.targetStatus ?? []);
  const storeRunnerState = useStore((state) => state?.runner?.runnerState ?? { status: 'offline' });
  const storeJobHistory = useStore((state) => state?.jobs?.history ?? []);
  const storeIsLoading = useStore((state) => state?.ui?.isLoading ?? false);
  const storeIsInitialLoading = useStore((state) => state?.ui?.isInitialLoading ?? true);
  const storeError = useStore((state) => state?.ui?.error ?? null);

  // Fallback state for when zubridge isn't ready
  const [fallbackState, setFallbackState] = useState({
    user: null as GitHubUser | null,
    isAuthenticating: false,
    deviceCode: null as DeviceCodeInfo | null,
    repos: [] as GitHubRepo[],
    orgs: [] as GitHubOrg[],
    isDownloaded: false,
    runnerVersion: { version: null, url: null } as { version: string | null; url: string | null },
    availableVersions: [] as RunnerRelease[],
    selectedVersion: '',
    downloadProgress: null as DownloadProgress | null,
    isLoadingVersions: false,
    isConfigured: false,
    runnerConfig: defaultRunnerConfig,
    runnerDisplayName: null as string | null,
    targets: [] as Target[],
    targetStatus: [] as RunnerProxyStatus[],
    runnerState: { status: 'offline' } as RunnerState,
    jobHistory: [] as JobHistoryEntry[],
    isLoading: false,
    isInitialLoading: true,
    error: null as string | null,
  });

  // Use store values if ready, otherwise fallback
  const user = isZubridgeReady ? storeUser : fallbackState.user;
  const isAuthenticating = isZubridgeReady ? storeIsAuthenticating : fallbackState.isAuthenticating;
  const deviceCode = isZubridgeReady ? storeDeviceCode : fallbackState.deviceCode;
  const repos = isZubridgeReady ? storeRepos : fallbackState.repos;
  const orgs = isZubridgeReady ? storeOrgs : fallbackState.orgs;
  const isDownloaded = isZubridgeReady ? storeIsDownloaded : fallbackState.isDownloaded;
  const runnerVersion = isZubridgeReady ? storeRunnerVersion : fallbackState.runnerVersion;
  const availableVersions = isZubridgeReady ? storeAvailableVersions : fallbackState.availableVersions;
  const selectedVersion = isZubridgeReady ? storeSelectedVersion : fallbackState.selectedVersion;
  const downloadProgress = isZubridgeReady ? storeDownloadProgress : fallbackState.downloadProgress;
  const isLoadingVersions = isZubridgeReady ? storeIsLoadingVersions : fallbackState.isLoadingVersions;
  const isConfigured = isZubridgeReady ? storeIsConfigured : fallbackState.isConfigured;
  const runnerConfig = isZubridgeReady ? storeRunnerConfig : fallbackState.runnerConfig;
  const runnerDisplayName = isZubridgeReady ? storeRunnerDisplayName : fallbackState.runnerDisplayName;
  const targets = isZubridgeReady ? storeTargets : fallbackState.targets;
  const targetStatus = isZubridgeReady ? storeTargetStatus : fallbackState.targetStatus;
  const runnerState = isZubridgeReady ? storeRunnerState : fallbackState.runnerState;
  const jobHistory = isZubridgeReady ? storeJobHistory : fallbackState.jobHistory;
  const isLoading = isZubridgeReady ? storeIsLoading : fallbackState.isLoading;
  const isInitialLoading = isZubridgeReady ? storeIsInitialLoading : fallbackState.isInitialLoading;
  const error = isZubridgeReady ? storeError : fallbackState.error;

  // Load initial state via IPC (fallback until zubridge syncs)
  useEffect(() => {
    const loadState = async () => {
      try {
        // Check auth status
        const authStatus = await window.localmost.github.getAuthStatus();
        if (authStatus.isAuthenticated && authStatus.user) {
          setFallbackState(prev => ({ ...prev, user: authStatus.user }));
          loadReposAndOrgs();
        }

        // Check runner status
        const downloaded = await window.localmost.runner.isDownloaded();
        setFallbackState(prev => ({ ...prev, isDownloaded: downloaded }));

        const configured = await window.localmost.runner.isConfigured();
        setFallbackState(prev => ({ ...prev, isConfigured: configured }));

        // Load version info
        const version = await window.localmost.runner.getVersion();
        setFallbackState(prev => ({ ...prev, runnerVersion: version }));

        // Load runner config
        const settings = await window.localmost.settings.get();
        const savedConfig = settings.runnerConfig as Partial<RunnerConfig> | undefined;

        if (savedConfig) {
          setFallbackState(prev => ({
            ...prev,
            runnerConfig: {
              ...prev.runnerConfig,
              level: savedConfig.level || prev.runnerConfig.level,
              repoUrl: savedConfig.repoUrl || prev.runnerConfig.repoUrl,
              orgName: savedConfig.orgName || prev.runnerConfig.orgName,
              runnerName: savedConfig.runnerName || prev.runnerConfig.runnerName,
              labels: savedConfig.labels || prev.runnerConfig.labels,
              runnerCount: savedConfig.runnerCount || prev.runnerConfig.runnerCount,
            },
          }));
        } else {
          // Default runner name based on hostname
          const hostname = await window.localmost.app.getHostname();
          setFallbackState(prev => ({
            ...prev,
            runnerConfig: {
              ...prev.runnerConfig,
              runnerName: `localmost.${hostname}`,
            },
          }));
        }

        // Get display name
        if (configured) {
          const displayName = await window.localmost.runner.getDisplayName();
          setFallbackState(prev => ({ ...prev, runnerDisplayName: displayName }));
        }

        // Load available versions
        await loadAvailableVersions(version.version);

        // Get initial runner status
        const status = await window.localmost.runner.getStatus();
        setFallbackState(prev => ({ ...prev, runnerState: status }));

        // Get initial job history
        const history = await window.localmost.jobs.getHistory();
        setFallbackState(prev => ({ ...prev, jobHistory: history }));

        // Load targets and their status
        const loadedTargets = await window.localmost.targets.list();
        setFallbackState(prev => ({ ...prev, targets: loadedTargets }));
        const loadedStatus = await window.localmost.targets.getStatus();
        setFallbackState(prev => ({ ...prev, targetStatus: loadedStatus }));
      } catch (err) {
        setFallbackState(prev => ({
          ...prev,
          error: `Failed to load runner state: ${(err as Error).message}`,
        }));
      } finally {
        setFallbackState(prev => ({ ...prev, isInitialLoading: false }));
      }
    };

    loadState();

    // Subscribe to status updates
    const unsubStatus = window.localmost.runner.onStatusUpdate((status: RunnerState) => {
      setFallbackState(prev => ({ ...prev, runnerState: status }));
    });
    const unsubJobHistory = window.localmost.jobs.onHistoryUpdate((history: JobHistoryEntry[]) => {
      setFallbackState(prev => ({ ...prev, jobHistory: history }));
    });
    const unsubDeviceCode = window.localmost.github.onDeviceCode((code: DeviceCodeInfo) => {
      setFallbackState(prev => ({ ...prev, deviceCode: code }));
    });
    const unsubTargetStatus = window.localmost.targets.onStatusUpdate((status: RunnerProxyStatus[]) => {
      setFallbackState(prev => ({ ...prev, targetStatus: status }));
    });
    const unsubDownload = window.localmost.runner.onDownloadProgress(async (progress: DownloadProgress) => {
      if (progress.phase === 'complete') {
        setFallbackState(prev => ({
          ...prev,
          downloadProgress: null,
          isDownloaded: true,
          isLoading: false,
        }));
        const version = await window.localmost.runner.getVersion();
        setFallbackState(prev => ({
          ...prev,
          runnerVersion: version,
          selectedVersion: version.version || prev.selectedVersion,
        }));
      } else if (progress.phase === 'error') {
        setFallbackState(prev => ({
          ...prev,
          downloadProgress: null,
          error: progress.message,
          isLoading: false,
        }));
      } else {
        setFallbackState(prev => ({ ...prev, downloadProgress: progress }));
      }
    });

    return () => {
      unsubStatus();
      unsubJobHistory();
      unsubDeviceCode();
      unsubTargetStatus();
      unsubDownload();
    };
  }, []);

  const loadAvailableVersions = async (installedVersion?: string | null) => {
    setFallbackState(prev => ({ ...prev, isLoadingVersions: true }));
    const result = await window.localmost.runner.getAvailableVersions();
    if (result.success && result.versions.length > 0) {
      setFallbackState(prev => ({
        ...prev,
        availableVersions: result.versions,
        selectedVersion: installedVersion && result.versions.some((v: RunnerRelease) => v.version === installedVersion)
          ? installedVersion
          : result.versions[0].version,
      }));
    }
    setFallbackState(prev => ({ ...prev, isLoadingVersions: false }));
  };

  const loadReposAndOrgs = async () => {
    const [reposResult, orgsResult] = await Promise.all([
      window.localmost.github.getRepos(),
      window.localmost.github.getOrgs(),
    ]);
    if (reposResult.success && reposResult.repos) {
      setFallbackState(prev => ({ ...prev, repos: reposResult.repos }));
    }
    if (orgsResult.success && orgsResult.orgs) {
      setFallbackState(prev => ({ ...prev, orgs: orgsResult.orgs }));
    }
  };

  const refreshReposAndOrgs = useCallback(async () => {
    await loadReposAndOrgs();
  }, []);

  const refreshTargets = useCallback(async () => {
    const loadedTargets = await window.localmost.targets.list();
    setFallbackState(prev => ({ ...prev, targets: loadedTargets }));
    // Also refresh isConfigured since adding/removing targets changes it
    const configured = await window.localmost.runner.isConfigured();
    setFallbackState(prev => ({ ...prev, isConfigured: configured }));
    // Update display name if we became configured
    if (configured) {
      const displayName = await window.localmost.runner.getDisplayName();
      setFallbackState(prev => ({ ...prev, runnerDisplayName: displayName }));
      // Auto-start runner if configured but offline (e.g., first target was just added)
      const status = await window.localmost.runner.getStatus();
      if (status.status === 'offline') {
        await window.localmost.runner.start();
      }
    }
  }, []);

  const login = useCallback(async () => {
    setFallbackState(prev => ({
      ...prev,
      isAuthenticating: true,
      error: null,
      deviceCode: null,
    }));

    const result = await window.localmost.github.startDeviceFlow();

    if (result.success && result.user) {
      setFallbackState(prev => ({ ...prev, user: result.user }));
      loadReposAndOrgs();
    } else {
      setFallbackState(prev => ({ ...prev, error: result.error || 'Authentication failed' }));
    }

    setFallbackState(prev => ({
      ...prev,
      isAuthenticating: false,
      deviceCode: null,
    }));
  }, []);

  const logout = useCallback(async () => {
    await window.localmost.github.logout();
    setFallbackState(prev => ({
      ...prev,
      user: null,
      repos: [],
      orgs: [],
    }));
  }, []);

  const downloadRunner = useCallback(async () => {
    setFallbackState(prev => ({
      ...prev,
      isLoading: true,
      error: null,
      downloadProgress: { phase: 'downloading', percent: 0, message: 'Starting...' },
    }));

    if (selectedVersion) {
      await window.localmost.runner.setDownloadVersion(selectedVersion);
    }

    const result = await window.localmost.runner.download();
    if (!result.success) {
      setFallbackState(prev => ({
        ...prev,
        error: result.error || 'Download failed',
        isLoading: false,
        downloadProgress: null,
      }));
    }
  }, [selectedVersion]);

  const setSelectedVersionCallback = useCallback((version: string) => {
    setFallbackState(prev => ({ ...prev, selectedVersion: version }));
  }, []);

  const updateRunnerConfig = useCallback(async (updates: Partial<RunnerConfig>) => {
    setFallbackState(prev => ({
      ...prev,
      runnerConfig: { ...prev.runnerConfig, ...updates },
    }));

    const settings = await window.localmost.settings.get();
    const currentConfig = (settings.runnerConfig || {}) as Record<string, unknown>;
    await window.localmost.settings.set({
      ...settings,
      runnerConfig: { ...currentConfig, ...updates },
    });
  }, []);

  const configureRunner = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    if (runnerConfig.level === 'repo' && !runnerConfig.repoUrl) {
      return { success: false, error: 'Please select a repository' };
    }
    if (runnerConfig.level === 'org' && !runnerConfig.orgName) {
      return { success: false, error: 'Please select an organization' };
    }

    setFallbackState(prev => ({
      ...prev,
      isLoading: true,
      error: null,
    }));

    const result = await window.localmost.runner.configure({
      level: runnerConfig.level,
      repoUrl: runnerConfig.level === 'repo' ? runnerConfig.repoUrl : undefined,
      orgName: runnerConfig.level === 'org' ? runnerConfig.orgName : undefined,
      runnerName: runnerConfig.runnerName.trim(),
      labels: runnerConfig.labels.split(',').map((l: string) => l.trim()).filter(Boolean),
      runnerCount: runnerConfig.runnerCount,
    });

    if (result.success) {
      setFallbackState(prev => ({ ...prev, isConfigured: true }));
      // Save the full runnerConfig so re-registration has runnerName, level, etc.
      await window.localmost.settings.set({ runnerConfig });
      await window.localmost.runner.start();
      const displayName = await window.localmost.runner.getDisplayName();
      setFallbackState(prev => ({ ...prev, runnerDisplayName: displayName }));
    } else {
      setFallbackState(prev => ({ ...prev, error: result.error || 'Configuration failed' }));
    }

    setFallbackState(prev => ({ ...prev, isLoading: false }));
    return result;
  }, [runnerConfig]);

  const setError = useCallback((err: string | null) => {
    setFallbackState(prev => ({ ...prev, error: err }));
  }, []);

  const value: RunnerContextValue = {
    user,
    isAuthenticating,
    deviceCode,
    login,
    logout,
    repos,
    orgs,
    refreshReposAndOrgs,
    isDownloaded,
    runnerVersion,
    availableVersions,
    selectedVersion,
    setSelectedVersion: setSelectedVersionCallback,
    downloadProgress,
    isLoadingVersions,
    downloadRunner,
    isConfigured,
    runnerConfig,
    updateRunnerConfig,
    configureRunner,
    runnerDisplayName,
    targets,
    targetStatus,
    refreshTargets,
    runnerState,
    jobHistory,
    isLoading,
    isInitialLoading,
    error,
    setError,
  };

  return (
    <RunnerContext.Provider value={value}>
      {children}
    </RunnerContext.Provider>
  );
};

export const useRunner = (): RunnerContextValue => {
  const context = useContext(RunnerContext);
  if (!context) {
    throw new Error('useRunner must be used within a RunnerProvider');
  }
  return context;
};
