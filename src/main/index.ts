/**
 * Main process entry point.
 * Orchestrates app lifecycle and initializes all modules.
 */

import { app, BrowserWindow, Notification } from 'electron';
import * as nodePath from 'path';
import { RunnerManager, JobEvent } from './runner-manager';
import { GitHubAuth } from './github-auth';
import { RunnerDownloader } from './runner-downloader';
import { HeartbeatManager } from './heartbeat-manager';
import { BrokerProxyService } from './broker-proxy-service';
import { TargetManager } from './target-manager';
import { ContributorCache } from './contributor-cache';

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

// Zustand store
import { initStore, connectWindow, cleanupStore, store } from './store/init';
import { getEffectivePolicy, effectivePolicyLevel } from '../shared/localmostrc';
import {
  decidePolicyForJob,
  recordPendingPolicy,
  getCachedPolicy,
  formatApprovalRequest,
} from './policy-cache';

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

// Electron keys the single-instance lock - and its caches - on userData, which
// LOCALMOST_CONFIG_DIR does not affect. Without redirecting it, a test run on a
// machine with localmost already open loses the lock and quits during startup.
// Point userData inside the test config directory so a test instance is fully
// isolated from an installed app.
if (process.env.LOCALMOST_CONFIG_DIR) {
  app.setPath('userData', nodePath.join(process.env.LOCALMOST_CONFIG_DIR, 'electron-user-data'));
}

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


/**
 * Check whether a repository's .localmostrc has been approved for use.
 *
 * Returns a reason to refuse the job, or null to proceed. A repository with no
 * policy is never refused: it runs on the built-in baseline, which grants
 * nothing beyond what every job already gets.
 */
async function checkRepoPolicyApproval(
  owner: string,
  repo: string,
  sha?: string
): Promise<string | null> {
  const repository = `${owner}/${repo}`;
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      return `cannot check ${repository} policy: not authenticated`;
    }
    if (!sha) {
      // Without a commit there is no way to know which policy would apply.
      return `cannot check ${repository} policy: no commit SHA for this job`;
    }

    const auth = getGitHubAuth() || new GitHubAuth();
    const content = await auth.getFileContent(accessToken, owner, repo, '.localmostrc', sha);
    const decision = decidePolicyForJob(repository, content);

    if (decision.action === 'allow') return null;
    if (decision.action === 'invalid') {
      return `${repository} has a .localmostrc that could not be parsed: ${decision.reason}`;
    }

    recordPendingPolicy(repository, decision.request.newConfig);
    getLogger()?.warn(formatApprovalRequest(decision.request));
    return decision.request.isNewRepo
      ? `${repository} has a .localmostrc that has not been approved. Review and approve it in Settings > Job Security, or run "localmost policy approve" in a clone of the repository.`
      : `${repository} .localmostrc changed since it was approved. Review and approve it in Settings > Job Security, or run "localmost policy approve" in a clone of the repository.`;
  } catch (err) {
    // Fail closed: an unverifiable policy must not be applied silently.
    return `could not verify ${repository} policy: ${(err as Error).message}`;
  }
}

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

  // Initialize Zustand store (after state machine, so XState sync works)
  initStore();

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

  // Contributor cache for user filtering
  const contributorCache = new ContributorCache(githubAuth, (msg) => logger?.debug(msg));

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
    getAllContributors: async (owner: string, repo: string, sha: string) => {
      const accessToken = await getValidAccessToken();
      if (!accessToken) {
        throw new Error('Not authenticated');
      }
      return contributorCache.getAllAuthors(accessToken, owner, repo, sha);
    },
    getJobTarget: (jobId: string) => brokerProxyService.getJobTarget(jobId),
    getRepoPolicy: async (owner: string, repo: string, _sha: string, workflowName: string) => {
      // Apply the policy that was approved, not whatever is in the repository
      // right now. A job only reaches this point once its policy has been
      // approved, and applying the approved copy means an unreviewed change
      // cannot take effect through a race. That covers the level too: it is
      // declared in the same file and approved with the rest of it.
      const cached = getCachedPolicy(`${owner}/${repo}`);
      if (!cached?.approved) {
        return {
          hosts: [],
          level: 'strict' as const,
          readPaths: [],
          writePaths: [],
          docker: 'off' as const,
        };
      }
      const policy = getEffectivePolicy(cached.config, workflowName);
      return {
        // Network is resolved per workflow and applied to the proxy per job.
        hosts: policy.network?.allow || [],
        level: effectivePolicyLevel(cached.config),
        // Filesystem comes from the shared section only. The sandbox profile
        // is built before the workflow is known and cannot change afterwards,
        // so a per-workflow filesystem section could not be applied - and
        // resolving it here would differ between spawn and claim and read as
        // policy drift.
        readPaths: cached.config.shared?.filesystem?.read || [],
        writePaths: cached.config.shared?.filesystem?.write || [],
        // Docker access, like filesystem, comes from the shared section only:
        // the profile is built before the workflow is known.
        docker: cached.config.shared?.docker ?? 'off',
      };
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

        if (event.type === 'refused') {
          // Say why. Otherwise this is indistinguishable from someone
          // pressing cancel on GitHub.
          title = 'Job Refused';
          body = `${repoShort}: ${event.reason ?? 'blocked by policy'}`;
        } else if (event.type === 'started') {
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

  // Report the runner version we actually have installed. GitHub rejects polls
  // from deprecated runner versions with 403 RunnerVersionTooOld, which leaves
  // every runner offline and every job queued.
  const installedRunnerVersion = runnerDownloader.getInstalledVersion();
  if (installedRunnerVersion) {
    brokerProxyService.setRunnerVersion(installedRunnerVersion);
    logger?.info(`[BrokerProxy] Reporting runner version ${installedRunnerVersion}`);
  }

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
    getLogger()?.info(`[job-received event] targetId=${targetId}, jobId=${jobId}, runId=${githubInfo.githubRunId}, actor=${githubInfo.githubActor}, sha=${githubInfo.githubSha?.slice(0, 7)}`);
    const target = targetManager.getTargets().find(t => t.id === targetId);
    if (target) {
      getLogger()?.info(`Spawning worker for job ${jobId} from ${target.displayName}...`);
      // Construct actions URL directly from GitHub IDs
      let actionsUrl: string | undefined;
      if (githubInfo.githubRunId && githubInfo.githubJobId && githubInfo.githubRepo) {
        actionsUrl = `https://github.com/${githubInfo.githubRepo}/actions/runs/${githubInfo.githubRunId}/job/${githubInfo.githubJobId}`;
        getLogger()?.info(`Constructed actions URL: ${actionsUrl}`);
      }
      // Decide whether this job may run before any worker exists. Cancelling
      // after a worker has started leaves untrusted steps executing for as long
      // as the check takes.
      const [owner, repo] = (githubInfo.githubRepo || target.displayName).split('/');
      if (owner && repo && githubInfo.githubActor) {
        const verdict = await runnerManager.evaluateJobFilter(
          owner,
          repo,
          githubInfo.githubActor,
          githubInfo.githubSha
        );
        if (!verdict.allowed) {
          runnerManager.recordRefusedJob({
            repository: target.displayName,
            jobName: githubInfo.githubJobId ? `job ${githubInfo.githubJobId}` : jobId,
            reason: verdict.reason,
            actionsUrl,
            githubRunId: githubInfo.githubRunId,
          });
          if (githubInfo.githubRunId) {
            await runnerManager.cancelRun(owner, repo, githubInfo.githubRunId, verdict.reason);
          }
          return;
        }

        // A .localmostrc grants access beyond the baseline, so a new or
        // changed one needs the machine owner's consent before it takes effect.
        const policyReason = await checkRepoPolicyApproval(owner, repo, githubInfo.githubSha);
        if (policyReason) {
          runnerManager.recordRefusedJob({
            repository: target.displayName,
            jobName: githubInfo.githubJobId ? `job ${githubInfo.githubJobId}` : jobId,
            reason: policyReason,
            actionsUrl,
            githubRunId: githubInfo.githubRunId,
          });
          if (githubInfo.githubRunId) {
            await runnerManager.cancelRun(owner, repo, githubInfo.githubRunId, policyReason);
          }
          return;
        }
      }

      runnerManager.setPendingTargetContext('next', targetId, target.displayName, actionsUrl, githubInfo.githubRunId, githubInfo.githubJobId, githubInfo.githubActor, githubInfo.githubSha, githubInfo.githubRef);

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

  if (config.auth?.refreshToken) {
    // Set initial auth state with refresh token (no access token yet)
    setAuthState(config.auth);
    // Update store so zubridge syncs user to renderer
    if (config.auth.user) {
      store.getState().setUser(config.auth.user);
    }
    // Get fresh access token on startup
    logger?.info('Getting fresh access token on startup...');
    const token = await forceRefreshToken();
    if (!token) {
      logger?.warn('Failed to refresh access token on startup - user may need to re-authenticate');
    }
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

  // Determine if window should be hidden on start
  // Only hide if setting is enabled AND runner is configured (don't hide setup wizard)
  const isRunnerConfigured = runnerManager.isConfigured();
  logger?.info(`hideOnStart check: hideOnStart=${config.hideOnStart}, isConfigured=${isRunnerConfigured}`);
  const shouldHideOnStart = config.hideOnStart && isRunnerConfigured;
  if (shouldHideOnStart) {
    logger?.info('Window will be hidden on start (hideOnStart enabled)');
  }

  // Create UI
  createMenu();
  createWindow({ show: !shouldHideOnStart });
  initTray();
  setDockIcon();
  setupIpcHandlers();

  // Connect window to Zustand store via zubridge
  const newMainWindow = getMainWindow();
  if (newMainWindow) {
    connectWindow(newMainWindow);
  }

  // Initialize store with current state so renderer has data immediately
  const isDownloaded = runnerDownloader.isDownloaded();
  store.getState().setIsDownloaded(isDownloaded);
  if (isDownloaded) {
    const version = runnerDownloader.getVersion();
    const url = runnerDownloader.getVersionUrl();
    store.getState().setRunnerVersion({ version, url });
  }
  store.getState().setIsConfigured(runnerManager.isConfigured());
  store.getState().setTargets(config.targets || []);

  // Mark initial loading as complete so renderer shows the UI
  store.getState().setIsInitialLoading(false);

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

    // Clean up Zustand store (flushes persistence)
    cleanupStore();

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

  // Clean up Zustand store (flushes persistence)
  cleanupStore();

  getLogger()?.info('Exiting');
  app.quit();
});
