import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { GitHubUser, GitHubRepo, GitHubOrg, RunnerState, JobHistoryEntry, DownloadProgress, DeviceCodeInfo, RunnerRelease } from '../../shared/types';

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

export const RunnerProvider: React.FC<RunnerProviderProps> = ({ children }) => {
  // Auth state
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [deviceCode, setDeviceCode] = useState<DeviceCodeInfo | null>(null);

  // Repos and orgs
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [orgs, setOrgs] = useState<GitHubOrg[]>([]);

  // Runner binary
  const [isDownloaded, setIsDownloaded] = useState(false);
  const [runnerVersion, setRunnerVersion] = useState<{ version: string | null; url: string | null }>({ version: null, url: null });
  const [availableVersions, setAvailableVersions] = useState<RunnerRelease[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<string>('');
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);

  // Runner configuration
  const [isConfigured, setIsConfigured] = useState(false);
  const [runnerConfig, setRunnerConfig] = useState<RunnerConfig>({
    level: 'repo',
    repoUrl: '',
    orgName: '',
    runnerName: '',
    labels: 'self-hosted,macOS',
    runnerCount: 4,
  });
  const [runnerDisplayName, setRunnerDisplayName] = useState<string | null>(null);

  // Runner status
  const [runnerState, setRunnerState] = useState<RunnerState>({ status: 'offline' });
  const [jobHistory, setJobHistory] = useState<JobHistoryEntry[]>([]);

  // Loading states
  const [isLoading, setIsLoading] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load initial state
  useEffect(() => {
    const loadState = async () => {
      try {
        // Check auth status
        const authStatus = await window.localmost.github.getAuthStatus();
        if (authStatus.isAuthenticated && authStatus.user) {
          setUser(authStatus.user);
          loadReposAndOrgs();
        }

        // Check runner status
        setIsDownloaded(await window.localmost.runner.isDownloaded());
        const configured = await window.localmost.runner.isConfigured();
        setIsConfigured(configured);

        // Load version info
        const version = await window.localmost.runner.getVersion();
        setRunnerVersion(version);

        // Load runner config
        const settings = await window.localmost.settings.get();
        const savedConfig = settings.runnerConfig as Partial<RunnerConfig> | undefined;

        if (savedConfig) {
          setRunnerConfig(prev => ({
            ...prev,
            level: savedConfig.level || prev.level,
            repoUrl: savedConfig.repoUrl || prev.repoUrl,
            orgName: savedConfig.orgName || prev.orgName,
            runnerName: savedConfig.runnerName || prev.runnerName,
            labels: savedConfig.labels || prev.labels,
            runnerCount: savedConfig.runnerCount || prev.runnerCount,
          }));
        } else {
          // Default runner name based on hostname
          const hostname = await window.localmost.app.getHostname();
          setRunnerConfig(prev => ({
            ...prev,
            runnerName: `localmost.${hostname}`,
          }));
        }

        // Get display name
        if (configured) {
          const displayName = await window.localmost.runner.getDisplayName();
          setRunnerDisplayName(displayName);
        }

        // Load available versions
        await loadAvailableVersions(version.version);

        // Get initial runner status
        const status = await window.localmost.runner.getStatus();
        setRunnerState(status);

        // Get initial job history
        const history = await window.localmost.jobs.getHistory();
        setJobHistory(history);
      } catch (err) {
        setError(`Failed to load runner state: ${(err as Error).message}`);
      } finally {
        setIsInitialLoading(false);
      }
    };

    loadState();

    // Subscribe to status updates
    const unsubStatus = window.localmost.runner.onStatusUpdate(setRunnerState);
    const unsubJobHistory = window.localmost.jobs.onHistoryUpdate(setJobHistory);
    const unsubDeviceCode = window.localmost.github.onDeviceCode(setDeviceCode);
    const unsubDownload = window.localmost.runner.onDownloadProgress(async (progress: DownloadProgress) => {
      if (progress.phase === 'complete') {
        setDownloadProgress(null);
        setIsDownloaded(true);
        setIsLoading(false);
        const version = await window.localmost.runner.getVersion();
        setRunnerVersion(version);
        if (version.version) {
          setSelectedVersion(version.version);
        }
      } else if (progress.phase === 'error') {
        setDownloadProgress(null);
        setError(progress.message);
        setIsLoading(false);
      } else {
        setDownloadProgress(progress);
      }
    });

    return () => {
      unsubStatus();
      unsubJobHistory();
      unsubDeviceCode();
      unsubDownload();
    };
  }, []);

  const loadAvailableVersions = async (installedVersion?: string | null) => {
    setIsLoadingVersions(true);
    const result = await window.localmost.runner.getAvailableVersions();
    if (result.success && result.versions.length > 0) {
      setAvailableVersions(result.versions);
      if (installedVersion && result.versions.some((v: RunnerRelease) => v.version === installedVersion)) {
        setSelectedVersion(installedVersion);
      } else {
        setSelectedVersion(result.versions[0].version);
      }
    }
    setIsLoadingVersions(false);
  };

  const loadReposAndOrgs = async () => {
    const [reposResult, orgsResult] = await Promise.all([
      window.localmost.github.getRepos(),
      window.localmost.github.getOrgs(),
    ]);
    if (reposResult.success && reposResult.repos) {
      setRepos(reposResult.repos);
    }
    if (orgsResult.success && orgsResult.orgs) {
      setOrgs(orgsResult.orgs);
    }
  };

  const refreshReposAndOrgs = useCallback(async () => {
    await loadReposAndOrgs();
  }, []);

  const login = useCallback(async () => {
    setIsAuthenticating(true);
    setError(null);
    setDeviceCode(null);

    const result = await window.localmost.github.startDeviceFlow();

    if (result.success && result.user) {
      setUser(result.user);
      loadReposAndOrgs();
    } else {
      setError(result.error || 'Authentication failed');
    }

    setIsAuthenticating(false);
    setDeviceCode(null);
  }, []);

  const logout = useCallback(async () => {
    await window.localmost.github.logout();
    setUser(null);
    setRepos([]);
    setOrgs([]);
  }, []);

  const downloadRunner = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setDownloadProgress({ phase: 'downloading', percent: 0, message: 'Starting...' });

    if (selectedVersion) {
      await window.localmost.runner.setDownloadVersion(selectedVersion);
    }

    const result = await window.localmost.runner.download();
    if (!result.success) {
      setError(result.error || 'Download failed');
      setIsLoading(false);
      setDownloadProgress(null);
    }
  }, [selectedVersion]);

  const updateRunnerConfig = useCallback(async (updates: Partial<RunnerConfig>) => {
    setRunnerConfig(prev => ({ ...prev, ...updates }));

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

    setIsLoading(true);
    setError(null);

    const result = await window.localmost.runner.configure({
      level: runnerConfig.level,
      repoUrl: runnerConfig.level === 'repo' ? runnerConfig.repoUrl : undefined,
      orgName: runnerConfig.level === 'org' ? runnerConfig.orgName : undefined,
      runnerName: runnerConfig.runnerName.trim(),
      labels: runnerConfig.labels.split(',').map(l => l.trim()).filter(Boolean),
      runnerCount: runnerConfig.runnerCount,
    });

    if (result.success) {
      setIsConfigured(true);
      await window.localmost.runner.start();
      const displayName = await window.localmost.runner.getDisplayName();
      setRunnerDisplayName(displayName);
    } else {
      setError(result.error || 'Configuration failed');
    }

    setIsLoading(false);
    return result;
  }, [runnerConfig]);

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
    setSelectedVersion,
    downloadProgress,
    isLoadingVersions,
    downloadRunner,
    isConfigured,
    runnerConfig,
    updateRunnerConfig,
    configureRunner,
    runnerDisplayName,
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
