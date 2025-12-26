/**
 * Main process entry point.
 * Orchestrates app lifecycle and initializes all modules.
 */

import { app, BrowserWindow, Notification } from 'electron';
import { RunnerManager, JobEvent } from './runner-manager';
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
  setResourceMonitor,
  getRunnerManager,
  getRunnerDownloader,
  getHeartbeatManager,
  getCliServer,
  getBrokerProxyService,
  getResourceMonitor,
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
  isUserPaused,
} from './app-state';

// CLI server
import { CliServer } from './cli-server';

// Config and security
import { loadConfig } from './config';
import { installSecurityHandlers } from './security';
import { ensureAppDataDir } from './paths';

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
import { initTray, updateTrayMenu } from './tray-init';

// IPC handlers
import { setupIpcHandlers } from './ipc-handlers';
import { sendTargetStatusUpdate } from './ipc-handlers/targets';

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
import { IPC_CHANNELS, SleepProtection, LogLevel, DEFAULT_POWER_CONFIG, DEFAULT_NOTIFICATIONS_CONFIG } from '../shared/types';

// Resource monitoring
import { ResourceMonitor } from './resource-monitor';

// State machine
import {
  initRunnerStateMachine,
  stopRunnerStateMachine,
  sendRunnerEvent,
  onStateChange,
  selectRunnerStatus,
  selectEffectivePauseState,
} from './runner-state-service';

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
  // Set restrictive umask so all files/directories are user-only (no group/world access)
  process.umask(0o077);

  // Ensure app data directory exists with secure permissions (user-only)
  ensureAppDataDir();

  // Initialize log file and logger
  initLogFile();
  initLogger();

  const logger = getLogger();

  // Log startup banner (figlet "localmost" with font Big)
  const banner = [
    ' _                 _                     _   ',
    '| |               | |                   | |  ',
    '| | ___   ___ __ _| |_ __ ___   ___  ___| |_ ',
    '| |/ _ \\ / __/ _` | | \'_ ` _ \\ / _ \\/ __| __|',
    '| | (_) | (_| (_| | | | | | | | (_) \\__ \\ |_ ',
    '|_|\\___/ \\___\\__,_|_|_| |_| |_|\\___/|___/\\__|',
    '',
    `v${app.getVersion()}`,
  ];
  for (const line of banner) {
    logger?.info(line);
  }

  // Initialize state machine (must be early - before anything uses state)
  initRunnerStateMachine();

  // Subscribe to state changes for UI updates
  onStateChange((snapshot) => {
    const mainWindow = getMainWindow();

    // Send runner status to renderer
    if (mainWindow && !mainWindow.isDestroyed() && !getIsQuitting()) {
      const runnerStatus = selectRunnerStatus(snapshot);
      mainWindow.webContents.send(IPC_CHANNELS.RUNNER_STATUS_UPDATE, runnerStatus);

      // Also send pause state
      const pauseState = selectEffectivePauseState(snapshot);
      mainWindow.webContents.send(IPC_CHANNELS.RESOURCE_STATE_CHANGED, {
        isPaused: pauseState.isPaused,
        reason: pauseState.reason,
        conditions: [],
      });
    }

    // Update tray icon
    updateTrayMenu();
  });

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
    getJobConclusion: async (owner: string, repo: string, jobId: number) => {
      const accessToken = await getValidAccessToken();
      const auth = getGitHubAuth();
      if (!accessToken || !auth) {
        throw new Error('Not authenticated');
      }
      return auth.getJobConclusion(accessToken, owner, repo, jobId);
    },
    onJobEvent: (event: JobEvent) => {
      logger?.info(`Job event: ${event.type} ${event.jobName}`);

      // Check if job notifications are enabled
      const config = loadConfig();
      const notificationsConfig = { ...DEFAULT_NOTIFICATIONS_CONFIG, ...config.notifications };
      if (!notificationsConfig.notifyOnJobEvents) {
        logger?.debug('Job notifications disabled');
        return;
      }

      try {
        const repoShort = event.repository.split('/').pop() || event.repository;
        let title: string;
        let body: string;

        if (event.type === 'started') {
          title = 'Job Started';
          body = `${event.jobName} on ${repoShort}`;
        } else {
          const statusEmoji = event.status === 'completed' ? '✓' : event.status === 'failed' ? '✗' : '○';
          title = `Job ${event.status === 'completed' ? 'Completed' : event.status === 'failed' ? 'Failed' : 'Cancelled'}`;
          body = `${statusEmoji} ${event.jobName} on ${repoShort}`;
        }

        logger?.info(`Showing notification: ${title} - ${body}`);
        const notification = new Notification({ title, body, silent: true });
        notification.show();
      } catch (err) {
        logger?.warn(`Failed to show job notification: ${(err as Error).message}`);
      }
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

  // Set capacity check callback - broker proxy will only acquire jobs when we have capacity AND not paused
  brokerProxyService.setCanAcceptJobCallback(() => {
    // Don't accept jobs if resource monitor says we should be paused
    if (resourceMonitor.shouldPause()) {
      return false;
    }
    return runnerManager.hasAvailableSlot();
  });

  // Wire up broker proxy to runner manager: when a job is received, spawn a worker
  brokerProxyService.on('job-received', async (targetId: string, jobId: string, _registeredRunnerName: string, githubInfo) => {
    getLogger()?.info(`[job-received event] targetId=${targetId}, jobId=${jobId}, runId=${githubInfo.githubRunId}, actor=${githubInfo.githubActor}`);
    const target = targetManager.getTargets().find(t => t.id === targetId);
    if (target) {
      getLogger()?.info(`Spawning worker for job ${jobId} from ${target.displayName}...`);
      // Construct actions URL directly from GitHub IDs
      let actionsUrl: string | undefined;
      if (githubInfo.githubRunId && githubInfo.githubJobId && githubInfo.githubRepo) {
        actionsUrl = `https://github.com/${githubInfo.githubRepo}/actions/runs/${githubInfo.githubRunId}/job/${githubInfo.githubJobId}`;
        getLogger()?.info(`Constructed actions URL: ${actionsUrl}`);
      }
      runnerManager.setPendingTargetContext('next', targetId, target.displayName, actionsUrl, githubInfo.githubRunId, githubInfo.githubJobId, githubInfo.githubActor);

      // Spawn a worker to handle this job
      try {
        await runnerManager.spawnWorkerForJob();
      } catch (err) {
        getLogger()?.error(`Failed to spawn worker for job ${jobId}: ${(err as Error).message}`);
      }
    } else {
      getLogger()?.warn(`[job-received] Target not found for id: ${targetId}`);
    }
  });

  // Wire up broker proxy status updates to renderer
  brokerProxyService.on('status-update', (status) => {
    sendTargetStatusUpdate(status);
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

  // Initialize resource monitor for power settings
  const powerConfig = config.power || DEFAULT_POWER_CONFIG;
  const notificationsConfig = config.notifications || DEFAULT_NOTIFICATIONS_CONFIG;
  const resourceMonitor = new ResourceMonitor({
    ...powerConfig,
    notifyOnPause: notificationsConfig.notifyOnPause,
  });
  setResourceMonitor(resourceMonitor);

  // Handle resource-based pause/resume via state machine
  resourceMonitor.on('should-pause', async (reason: string) => {
    // Don't pause if user explicitly paused (they control when to resume)
    if (isUserPaused()) return;

    logger?.info(`Resource pause triggered: ${reason}`);

    // Send event to state machine - it will update tray and renderer via subscription
    sendRunnerEvent({ type: 'RESOURCE_PAUSE', reason });

    const runnerManager = getRunnerManager();
    const heartbeatManager = getHeartbeatManager();

    // Stop heartbeat to signal unavailability
    heartbeatManager?.stop();
    await heartbeatManager?.clear();

    // Stop any running workers (gracefully - in-progress jobs will complete)
    // The broker proxy will reject new jobs via the canAcceptJob callback
    if (runnerManager?.isRunning()) {
      await runnerManager.stop();
    }
  });

  resourceMonitor.on('should-resume', async () => {
    // Don't resume if user explicitly paused
    if (isUserPaused()) return;

    logger?.info('Resource pause cleared - resuming runner');

    // Send event to state machine - it will update tray and renderer via subscription
    sendRunnerEvent({ type: 'RESOURCE_RESUME' });

    // Restart heartbeat to signal availability
    // The broker proxy will start accepting jobs via the canAcceptJob callback
    const heartbeatManager = getHeartbeatManager();
    const authState = getAuthState();
    if (heartbeatManager && authState?.accessToken) {
      try {
        await heartbeatManager.start();
      } catch (err) {
        logger?.error(`Failed to restart heartbeat: ${(err as Error).message}`);
      }
    }
  });

  // Note: state-changed event is now handled by the XState subscription above
  // which sends status updates to renderer and updates tray

  // Start monitoring (will evaluate conditions and emit events as needed)
  resourceMonitor.start();

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
        // Signal state machine that we're starting
        sendRunnerEvent({ type: 'START' });

        // Clear any stale runner registrations before starting
        await clearStaleRunnerRegistrations();

        // Initialize broker proxy with all target credentials (multiple instances per target)
        const targets = config.targets || [];
        if (targets.length > 0 && brokerProxyService) {
          const { getRunnerProxyManager } = await import('./runner-proxy-manager');
          const proxyManager = getRunnerProxyManager();

          for (const target of targets) {
            if (!target.enabled) continue;

            const allCredentials = proxyManager.loadAllCredentials(target.id);
            if (allCredentials.length > 0) {
              brokerProxyService.addTarget(target, allCredentials);
              logger?.info(`[BrokerProxy] Added ${target.displayName} with ${allCredentials.length} instances`);
            } else {
              logger?.warn(`[BrokerProxy] No credentials for ${target.displayName}, skipping`);
            }
          }

          // Start broker proxy server - workers will connect to this
          try {
            await brokerProxyService.start();
            logger?.info('Broker proxy started, waiting for jobs from targets...');
          } catch (err) {
            logger?.error(`[BrokerProxy] Failed to start: ${(err as Error).message}`);
          }
        }

        // Initialize runner manager (but don't start workers yet)
        // Workers are spawned on-demand when jobs arrive via broker proxy
        await runnerManager.initialize();
        logger?.info('Broker proxy running, workers will spawn when jobs arrive');

        // Signal state machine that initialization is complete
        sendRunnerEvent({ type: 'INITIALIZED' });

        // Start heartbeat when runner auto-starts
        const authState = getAuthState();
        const githubAuth = getGitHubAuth();
        if (heartbeatManager && authState?.accessToken && githubAuth) {
          // Set up heartbeat for all configured targets
          const targets = config.targets || [];
          const heartbeatTargets = targets.map(t =>
            t.type === 'org'
              ? { level: 'org' as const, org: t.owner }
              : { level: 'repo' as const, owner: t.owner, repo: t.repo! }
          );

          if (heartbeatTargets.length > 0) {
            heartbeatManager.setTargets(heartbeatTargets);

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

    // Signal state machine that we're shutting down
    sendRunnerEvent({ type: 'STOP' });

    const logger = getLogger();
    const heartbeatManager = getHeartbeatManager();
    const runnerManager = getRunnerManager();
    const runnerDownloader = getRunnerDownloader();
    const brokerProxyService = getBrokerProxyService();
    const trayManager = getTrayManager();
    const mainWindow = getMainWindow();
    const cliServer = getCliServer();

    // Hide window immediately for visual feedback that quit is happening
    mainWindow?.hide();

    // Stop resource monitor (sync, fast)
    getResourceMonitor()?.stop();
    heartbeatManager?.stop();
    disableSleepProtection();

    // Run independent cleanup tasks in parallel for faster shutdown
    await Promise.all([
      // Clear heartbeats (has 3s timeout)
      heartbeatManager?.clear(),
      // Stop CLI server
      cliServer?.stop(),
      // Stop broker proxy service
      brokerProxyService?.stop(),
      // Cancel jobs and stop runners (has 10s timeout)
      (async () => {
        const runningJobs = runnerManager?.getJobHistory().filter(j => j.status === 'running') || [];
        await cancelJobsOnOurRunners(runningJobs);
        await runnerManager?.stop();
      })(),
    ]);

    // Clean up work directories (can be slow for large dirs)
    if (runnerManager?.getPreserveWorkDir() !== 'always') {
      await runnerDownloader?.cleanupWorkDirectories((msg) => logger?.info(msg));
    }

    trayManager?.destroy();
    mainWindow?.destroy();

    // Signal state machine shutdown is complete and stop it
    sendRunnerEvent({ type: 'SHUTDOWN_COMPLETE' });
    stopRunnerStateMachine();

    logger?.info('Exiting');
    app.quit();
  }
});

// Handle Ctrl+C
process.on('SIGINT', async () => {
  setIsQuitting(true);

  // Signal state machine that we're shutting down
  sendRunnerEvent({ type: 'STOP' });

  const logger = getLogger();
  const heartbeatManager = getHeartbeatManager();
  const runnerManager = getRunnerManager();
  const runnerDownloader = getRunnerDownloader();
  const brokerProxyService = getBrokerProxyService();
  const trayManager = getTrayManager();
  const mainWindow = getMainWindow();
  const cliServer = getCliServer();

  // Hide window immediately for visual feedback
  mainWindow?.hide();

  // Stop sync operations first
  getResourceMonitor()?.stop();
  heartbeatManager?.stop();
  disableSleepProtection();

  // Run independent cleanup tasks in parallel for faster shutdown
  await Promise.all([
    heartbeatManager?.clear(),
    cliServer?.stop(),
    brokerProxyService?.stop(),
    (async () => {
      const runningJobs = runnerManager?.getJobHistory().filter(j => j.status === 'running') || [];
      await cancelJobsOnOurRunners(runningJobs);
      await runnerManager?.stop();
    })(),
  ]);

  // Clean up work directories unless set to 'always' preserve
  if (runnerManager?.getPreserveWorkDir() !== 'always') {
    await runnerDownloader?.cleanupWorkDirectories((msg) => logger?.info(msg));
  }

  trayManager?.destroy();
  mainWindow?.destroy();

  // Signal state machine shutdown is complete and stop it
  sendRunnerEvent({ type: 'SHUTDOWN_COMPLETE' });
  stopRunnerStateMachine();

  getLogger()?.info('Exiting');
  app.quit();
});
