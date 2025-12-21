/**
 * Main process entry point.
 * Orchestrates app lifecycle and initializes all modules.
 */

import { app, BrowserWindow } from 'electron';
import { RunnerManager } from './runner-manager';
import { GitHubAuth } from './github-auth';
import { RunnerDownloader } from './runner-downloader';
import { HeartbeatManager } from './heartbeat-manager';
import { BrokerProxyService } from './broker-proxy-service';
import { TargetManager } from './target-manager';

// State management
import {
  getMainWindow,
  setRunnerManager,
  setRunnerDownloader,
  setGitHubAuth,
  setHeartbeatManager,
  setCliServer,
  setBrokerProxyService,
  setTargetManager,
  getRunnerManager,
  getRunnerDownloader,
  getHeartbeatManager,
  getCliServer,
  getBrokerProxyService,
  getTargetManager,
  getAuthState,
  setAuthState,
  getGitHubAuth,
  setIsQuitting,
  getIsQuitting,
  setSleepProtectionSetting,
  setLogLevelSetting,
  setRunnerLogLevelSetting,
  getRunnerLogLevelSetting,
  disableSleepProtection,
  getTrayManager,
  getLogger,
} from './app-state';

// CLI server
import { CliServer } from './cli-server';

// Config and security
import { loadConfig } from './config';
import { installSecurityHandlers } from './security';

// Logging
import { initLogFile } from './log-file';
import { initLogger, sendLog, sendStatusUpdate, sendJobHistoryUpdate } from './logging';

// Auth and tokens
import { getValidAccessToken, forceRefreshToken, cancelJobsOnOurRunners } from './auth-tokens';

// Runner lifecycle
import { reRegisterSingleInstance, configureSingleInstance, clearStaleRunnerRegistrations } from './runner-lifecycle';

// UI
import { createWindow, setDockIcon } from './window';
import { createMenu } from './menu';
import { initTray } from './tray-init';

// IPC handlers
import { setupIpcHandlers } from './ipc-handlers';

// Auto-updater
import { initAutoUpdater, checkForUpdates } from './auto-updater';

// Constants
import {
  TOKEN_REFRESH_INTERVAL_MS,
  TOKEN_REFRESH_WINDOW_MS,
  AUTO_START_DELAY_MS,
  UPDATE_CHECK_DELAY_MS,
} from '../shared/constants';
import { UpdateSettings } from '../shared/types';
import { IPC_CHANNELS, SleepProtection, LogLevel } from '../shared/types';

// ============================================================================
// App Initialization
// ============================================================================

// Set app name (needed for macOS menu bar in development)
app.setName('localmost');

// Install security handlers immediately
installSecurityHandlers();

// ============================================================================
// Single Instance Lock
// ============================================================================

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, quit this one
  // Note: Can't use bootLog here since log-file imports paths which may have side effects
  process.stderr.write('Another instance of localmost is already running. Quitting...\n');
  app.quit();
} else {
  // This is the primary instance
  app.on('second-instance', () => {
    // Someone tried to run a second instance, focus our window instead
    const mainWindow = getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ============================================================================
// App Ready
// ============================================================================

app.whenReady().then(async () => {
  // Initialize log file and logger
  initLogFile();
  initLogger();

  const logger = getLogger();

  // Initialize modules
  const runnerDownloader = new RunnerDownloader();
  setRunnerDownloader(runnerDownloader);

  const githubAuth = new GitHubAuth();
  setGitHubAuth(githubAuth);

  const runnerManager = new RunnerManager({
    onLog: sendLog,
    onStatusChange: sendStatusUpdate,
    onJobHistoryUpdate: sendJobHistoryUpdate,
    onReregistrationNeeded: reRegisterSingleInstance,
    onConfigurationNeeded: configureSingleInstance,
    getWorkflowRuns: async (owner: string, repo: string) => {
      const accessToken = await getValidAccessToken();
      const auth = getGitHubAuth();
      if (!accessToken || !auth) {
        throw new Error('Not authenticated');
      }
      return auth.getRecentWorkflowRuns(accessToken, owner, repo);
    },
    getWorkflowJobs: async (owner: string, repo: string, runId: number) => {
      const accessToken = await getValidAccessToken();
      const auth = getGitHubAuth();
      if (!accessToken || !auth) {
        throw new Error('Not authenticated');
      }
      return auth.getWorkflowRunJobs(accessToken, owner, repo, runId);
    },
    getRunnerLogLevel: () => getRunnerLogLevelSetting(),
    getUserFilter: () => {
      const config = loadConfig();
      return config.userFilter;
    },
    getCurrentUserLogin: () => {
      const authState = getAuthState();
      return authState?.user?.login;
    },
    cancelWorkflowRun: async (owner: string, repo: string, runId: number) => {
      const accessToken = await getValidAccessToken();
      const auth = getGitHubAuth();
      if (!accessToken || !auth) {
        throw new Error('Not authenticated');
      }
      return auth.cancelWorkflowRun(accessToken, owner, repo, runId);
    },
  });
  setRunnerManager(runnerManager);

  // Initialize heartbeat manager
  const heartbeatManager = new HeartbeatManager({
    onLog: (level, message) => {
      if (level === 'info') logger?.info(message);
      else if (level === 'warn') logger?.warn(message);
      else logger?.error(message);
    },
  });
  setHeartbeatManager(heartbeatManager);

// Initialize CLI server for `localmost` CLI companion
  const cliServer = new CliServer({
    onLog: (level, message) => {
      if (level === 'info') logger?.info(message);
      else if (level === 'warn') logger?.warn(message);
      else logger?.error(message);
    },
  });
  setCliServer(cliServer);
  try {
    await cliServer.start();
  } catch (err) {
    logger?.warn(`Failed to start CLI server: ${(err as Error).message}`);
  }

  // Initialize target manager
  const targetManager = new TargetManager();
  setTargetManager(targetManager);

  // Initialize broker proxy service
  const brokerProxyService = new BrokerProxyService();
  setBrokerProxyService(brokerProxyService);

  // Wire up broker proxy to runner manager: when a job is received from a target,
  // set the pending target context so it gets applied when the job starts
  brokerProxyService.on('job-received', (targetId: string, _jobId: string) => {
    const target = targetManager.getTargets().find(t => t.id === targetId);
    if (target) {
      runnerManager.setPendingTargetContext('next', targetId, target.displayName);
    }
  });

  // Load saved auth state and settings
  const config = loadConfig();

  // Clean up any stale/corrupt runner configuration
  // Must await to ensure orphaned runner processes are killed before starting new ones
  // Only clean work dirs if preserveWorkDir is not 'always'
  try {
    const cleanWorkDirs = config.preserveWorkDir !== 'always';
    await runnerDownloader.cleanupStaleConfiguration(
      (message) => logger?.info(message),
      { cleanWorkDirs }
    );
  } catch (err) {
    logger?.warn(`Startup cleanup failed: ${(err as Error).message}. Will retry when runner starts.`);
  }

  if (config.auth) {
    setAuthState(config.auth);
  }
  if (config.sleepProtection) {
    setSleepProtectionSetting(config.sleepProtection as SleepProtection);
  }
  if (config.logLevel) {
    setLogLevelSetting(config.logLevel as LogLevel);
  }
  if (config.runnerLogLevel) {
    setRunnerLogLevelSetting(config.runnerLogLevel as LogLevel);
  }

  // Create UI
  createMenu();
  createWindow();
  initTray();
  setDockIcon();
  setupIpcHandlers();

  // Initialize auto-updater
  const mainWindow = getMainWindow();
  if (mainWindow) {
    initAutoUpdater(mainWindow);

    // Check for updates on startup (if enabled in settings)
    const updateSettings = config.updateSettings as UpdateSettings | undefined;
    if (updateSettings?.autoCheck !== false) {
      setTimeout(() => {
        logger?.info('Checking for updates...');
        checkForUpdates().catch((err) => {
          logger?.warn(`Update check failed: ${(err as Error).message}`);
        });
      }, UPDATE_CHECK_DELAY_MS);
    }
  }

  // Always launch with visible UI so users see the app is running

  // Auto-start runner if configured (delay to allow renderer to initialize)
  if (runnerManager.isConfigured()) {
    setTimeout(async () => {
      logger?.info('Auto-starting runner...');
      try {
        // Show 'starting' status immediately - clearStaleRunnerRegistrations can take a while
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed() && !getIsQuitting()) {
          mainWindow.webContents.send(IPC_CHANNELS.RUNNER_STATUS_UPDATE, {
            status: 'starting',
            startedAt: new Date().toISOString(),
          });
        }

        // Clear any stale runner registrations before starting
        await clearStaleRunnerRegistrations();
        await runnerManager.start();

        // Start heartbeat when runner auto-starts
        const authState = getAuthState();
        const githubAuth = getGitHubAuth();
        if (heartbeatManager && authState?.accessToken && githubAuth) {
          // Use first target for heartbeat
          const targets = config.targets || [];
          const firstTarget = targets[0];

          if (firstTarget) {
            // Set up heartbeat target from first configured target
            if (firstTarget.type === 'org') {
              heartbeatManager.setTarget({
                level: 'org',
                org: firstTarget.owner,
              });
            } else {
              heartbeatManager.setTarget({
                level: 'repo',
                owner: firstTarget.owner,
                repo: firstTarget.repo!,
              });
            }

            // Set up API callbacks with automatic token refresh on auth errors
            heartbeatManager.setApiCallbacks({
              setRepoVariable: async (owner, repo, name, value) => {
                let token = await getValidAccessToken();
                if (!token) throw new Error('No valid access token');
                try {
                  return await githubAuth!.setRepoVariable(token, owner, repo, name, value);
                } catch (error) {
                  if ((error as Error).message?.includes('Bad credentials') ||
                      (error as Error).message?.includes('401')) {
                    token = await forceRefreshToken();
                    if (!token) throw new Error('Token refresh failed');
                    return await githubAuth!.setRepoVariable(token, owner, repo, name, value);
                  }
                  throw error;
                }
              },
              setOrgVariable: async (org, name, value) => {
                let token = await getValidAccessToken();
                if (!token) throw new Error('No valid access token');
                try {
                  return await githubAuth!.setOrgVariable(token, org, name, value);
                } catch (error) {
                  if ((error as Error).message?.includes('Bad credentials') ||
                      (error as Error).message?.includes('401')) {
                    token = await forceRefreshToken();
                    if (!token) throw new Error('Token refresh failed');
                    return await githubAuth!.setOrgVariable(token, org, name, value);
                  }
                  throw error;
                }
              },
            });

            // Start the heartbeat
            await heartbeatManager.start();
          }
        }
      } catch (err) {
        logger?.error(`Failed to auto-start runner: ${(err as Error).message}`);
      }
    }, AUTO_START_DELAY_MS);
  }

  // Periodically refresh token to keep it valid
  setInterval(async () => {
    const authState = getAuthState();
    const githubAuth = getGitHubAuth();
    if (authState?.refreshToken && authState?.expiresAt && githubAuth) {
      // Proactively refresh if token expires within the refresh window
      const refreshThreshold = Date.now() + TOKEN_REFRESH_WINDOW_MS;
      if (authState.expiresAt < refreshThreshold) {
        getLogger()?.info('Proactively refreshing token before expiration...');
        await getValidAccessToken();
      }
    }
  }, TOKEN_REFRESH_INTERVAL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      getMainWindow()?.show();
    }
  });
});

// ============================================================================
// App Lifecycle Events
// ============================================================================

app.on('window-all-closed', () => {
  // On macOS, keep app running in tray if runner is active
  if (process.platform !== 'darwin' || !getRunnerManager()?.isRunning()) {
    app.quit();
  }
});

app.on('before-quit', async (event) => {
  if (!getIsQuitting()) {
    event.preventDefault();

    // Set isQuitting FIRST to stop all IPC sends to renderer
    setIsQuitting(true);

    const logger = getLogger();
    const heartbeatManager = getHeartbeatManager();
    const runnerManager = getRunnerManager();
    const runnerDownloader = getRunnerDownloader();
    const brokerProxyService = getBrokerProxyService();
    const trayManager = getTrayManager();
    const mainWindow = getMainWindow();
    const cliServer = getCliServer();

    // Now safe to do cleanup that logs (logs go to file only, not renderer)
    await heartbeatManager?.clear();
    heartbeatManager?.stop();

// Stop CLI server
    await cliServer?.stop();

    // Stop broker proxy service
    await brokerProxyService?.stop();

    // Cancel any jobs running on our runners before stopping
    // This prevents orphaned jobs that would block runner deletion on next startup
    await cancelJobsOnOurRunners();

    // Must await stop() to ensure runner processes are killed before app exits
    // (runners are detached process groups that survive parent exit)
    await runnerManager?.stop();

    // Clean up work directories unless set to 'always' preserve
    if (runnerManager?.getPreserveWorkDir() !== 'always') {
      await runnerDownloader?.cleanupWorkDirectories((msg) => logger?.info(msg));
    }

    disableSleepProtection();
    trayManager?.destroy();

    // Close window after all cleanup is done
    mainWindow?.destroy();

    app.quit();
  }
});

// Handle Ctrl+C
process.on('SIGINT', async () => {
  setIsQuitting(true);

  const logger = getLogger();
  const heartbeatManager = getHeartbeatManager();
  const runnerManager = getRunnerManager();
  const runnerDownloader = getRunnerDownloader();
  const brokerProxyService = getBrokerProxyService();
  const trayManager = getTrayManager();
  const mainWindow = getMainWindow();
  const cliServer = getCliServer();

  // Clear heartbeat before stopping to prevent orphaned runners from picking up jobs
  await heartbeatManager?.clear();
  heartbeatManager?.stop();

// Stop CLI server
  await cliServer?.stop();

  // Stop broker proxy service
  await brokerProxyService?.stop();

  // Cancel any jobs running on our runners before stopping
  await cancelJobsOnOurRunners();

  // Must await stop() to ensure runner processes are killed before app exits
  await runnerManager?.stop();

  // Clean up work directories unless set to 'always' preserve
  if (runnerManager?.getPreserveWorkDir() !== 'always') {
    await runnerDownloader?.cleanupWorkDirectories((msg) => logger?.info(msg));
  }

  disableSleepProtection();
  trayManager?.destroy();
  mainWindow?.destroy();

  app.quit();
});
