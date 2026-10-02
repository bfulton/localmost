/**
 * Main process entry point.
 * Orchestrates app lifecycle and initializes all modules.
 */

import { app, BrowserWindow, Notification, powerMonitor } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { RunnerManager, JobEvent } from './runner-manager';
import { VmBackend } from './vm/vm-backend';
import { DefaultVmManager } from './vm/vm-manager';
import { GuestImage } from './vm/guest-image';
import { getVmResourcesDir, guestDir, helperPath } from './vm/paths';
import { CacheDisks } from './vm/cache-disks';
import { VmImagePuller } from './docker/puller/image-puller';
import { RegistryClient } from './docker/puller/registry-client';
import { resolveRegistryCredentials } from './docker/registry-auth';
import { MemoryPressureMonitor } from './resource-monitor/memory-pressure-monitor';
import { GitHubAuth } from './github-auth';
import { RunnerDownloader } from './runner-downloader';
import { HeartbeatManager, toHeartbeatTarget } from './heartbeat-manager';
import { BrokerProxyService } from './broker-proxy-service';
import { TargetManager } from './target-manager';
import { ContributorCache } from './contributor-cache';
import { admitJob, buildAdmissionDeps, PolicyApprovalDeps } from './job-admission';
import { repoPolicyRuntime } from './repo-policy';

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
  getRunnerState,
} from './app-state';

// CLI server
import { CliServer } from './cli-server';

// Config and security
import { loadConfig, DockerVmConfigSource } from './config';
import { sweepJobTempDirs, userTempDir } from './job-temp';
import { installSecurityHandlers } from './security';
import { ensureAppDataDir, getAppDataDir } from './paths';

// Logging
import { initLogFile } from './log-file';
import { initLogger, sendLog, sendStatusUpdate, sendJobHistoryUpdate } from './logging';

// Auth and tokens
import { getValidAccessToken, forceRefreshToken, cancelJobsOnOurRunners } from './auth-tokens';

// Runner lifecycle
import { reRegisterSingleInstance, configureSingleInstance, clearStaleRunnerRegistrations } from './runner-lifecycle';
import { finishPendingSweeps } from './process-group';

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
import { canAcceptJob, startHeartbeatUnlessPaused, wireResourceMonitor } from './runner-pause';

// State machine
import {
  initRunnerStateMachine,
  stopRunnerStateMachine,
  sendRunnerEvent,
  onStateChange,
  selectEffectivePauseState,
} from './runner-state-service';

// Zustand store
import { initStore, connectWindow, cleanupStore, store } from './store/init';
import { runnerJobEnvironment, runnerResourcePause } from './store';
import {
  decidePolicyForJob,
  recordPendingPolicy,
  getApprovedPolicyForCommit,
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
 * Check whether a repository's .localmostrc has been approved for use: see
 * checkRepoPolicyApproval in job-admission.
 */
const repoPolicyApproval: PolicyApprovalDeps = {
  getAccessToken: getValidAccessToken,
  getFileContent: (accessToken, owner, repo, filePath, ref) =>
    (getGitHubAuth() || new GitHubAuth()).getFileContent(accessToken, owner, repo, filePath, ref),
  decidePolicyForJob,
  recordPendingPolicy,
  announce: (request) => getLogger()?.warn(formatApprovalRequest(request)),
};

/** The per-job Docker VMs, and the monitor that holds their boots back under memory pressure. */
let vmManager: DefaultVmManager | null = null;
let memoryPressureMonitor: MemoryPressureMonitor | null = null;

/** The per-repository golden data disks, and their refreshes (contract §6.5). */
let cacheDisks: CacheDisks | null = null;

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
      // Machine transitions are a good moment to refresh the renderer, but
      // the status comes from the runner: this channel has two producers,
      // and one published a machine that is never told about jobs, blanking
      // a running job whenever the other fired.
      mainWindow.webContents.send(IPC_CHANNELS.RUNNER_STATUS_UPDATE, getRunnerState());

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

  // The per-job Docker VMs (docs/roadmap/vm-docker-backend.md). One is
  // booted at the first Docker request, beyond the baseline, of a job whose
  // policy grants Docker, and goes with its worker. Every path is the app's
  // own: <data>, realpathed once, and the helper, guest and CLI in Resources
  // (or the checkout's build/).
  // Read from config.yaml at each worker spawn, and cached in between.
  const dockerVmConfigSource = new DockerVmConfigSource({
    read: () => loadConfig().dockerVm,
    host: { cores: os.cpus().length, memoryBytes: os.totalmem() },
    log: (message) => logger?.warn(`[docker-vm] ${message}`),
  });
  const dockerVmConfig = () => dockerVmConfigSource.current();
  const guestImage = new GuestImage(guestDir());
  const vmLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => logger?.[level](`[docker-vm] ${message}`);
  const dataDir = fs.realpathSync(getAppDataDir());
  // A refresh VM is booted by the same manager as a job's, in slot 0, and
  // queues behind every job boot; CacheDisks is handed only this function.
  cacheDisks = new CacheDisks({
    dataDir,
    startRefreshVm: ({ repository, repoKey }) => {
      if (!vmManager) throw new Error('the Docker VM manager is not running');
      return vmManager.start({ mode: 'refresh', slot: 0, repository, repoKey });
    },
    guest: () => {
      const manifest = guestImage.manifest();
      return { guestVersion: manifest.guestVersion, dataFormat: manifest.dataFormat };
    },
    cacheLimitGiB: () => dockerVmConfig().cacheLimitGiB,
    dataDiskGiB: () => dockerVmConfig().dataDiskGiB,
    conditions: () => ({
      onBattery: powerMonitor.isOnBatteryPower(),
      memoryPressure: memoryPressureMonitor?.level() ?? 'normal',
    }),
    log: vmLog,
  });
  vmManager = new DefaultVmManager({
    dataDir,
    resources: getVmResourcesDir(),
    helperPath,
    guest: guestImage,
    config: dockerVmConfig,
    // Read at each data disk, so a changed runner count is used at once.
    runnerSlots: () => getRunnerManager()?.getRunnerCount() ?? 1,
    cacheDisks,
    log: vmLog,
  });
  // Before any worker exists: whatever an earlier run left - a helper still
  // running, a VM's directory, an unfinished refresh disk - goes first.
  await vmManager.sweep().catch((err: Error) => logger?.warn(`[docker-vm] Startup sweep failed: ${err.message}`));
  // Pulls run here, on the Mac, anonymously until a registry refuses; only
  // then are the operator's credentials asked for, once per registry per
  // job, and they never enter a VM (§6). What a failing credential helper
  // printed goes to the app log only.
  const puller = new VmImagePuller({
    dataDir,
    client: new RegistryClient({
      credentials: (registry) => resolveRegistryCredentials(registry, { log: (m) => logger?.warn(`[docker-vm] ${m}`) }),
    }),
    cacheDisks,
    limits: () => {
      const { pullMaxGiB, jobPullMaxGiB, minFreeGiB } = dockerVmConfig();
      return { pullMaxGiB, jobPullMaxGiB, minFreeGiB };
    },
    log: vmLog,
  });
  const dockerBackend = new VmBackend({
    vmManager,
    guest: guestImage,
    puller,
    cacheDisks,
    config: dockerVmConfig,
  });
  // VZ has no Linux time sync, and a VM's clock stops while the Mac sleeps.
  powerMonitor.on('resume', () => vmManager?.onResume());
  memoryPressureMonitor = new MemoryPressureMonitor({
    onChange: (level) => vmManager?.onMemoryPressure(level),
    log: (level, message) => vmLog(level, message),
  });
  memoryPressureMonitor.start();

  const runnerManager = new RunnerManager({
    onLog: sendLog,
    onStatusChange: sendStatusUpdate,
    onJobHistoryUpdate: sendJobHistoryUpdate,
    // Bind this job to the worker being spawned for it, by its slot (the
    // worker key's target and instance). This expectation is the only way a
    // session binds to a job: a worker nobody announced takes nothing.
    onWorkerReservedForJob: (targetId: string, instanceNum: number, jobId?: string) =>
      getBrokerProxyService()?.expectWorkerForJob(targetId, instanceNum, jobId),
    onWorkerReservationCancelled: (targetId: string, instanceNum: number, jobId?: string) =>
      getBrokerProxyService()?.forgetExpectedWorker(targetId, instanceNum, jobId),
    issueBrokerUrl: (instanceNum: number, targetId?: string) =>
      getBrokerProxyService()?.issueWorkerKey(instanceNum, targetId),
    revokeBrokerUrl: (instanceNum: number) => getBrokerProxyService()?.revokeWorkerKey(instanceNum),
    issueWorkerCredential: async (instanceNum: number) =>
      getBrokerProxyService()?.issueWorkerCredential(instanceNum),
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
    getJobTarget: (instanceNum: number, jobId: string) => brokerProxyService.getJobTargetForWorker(instanceNum, jobId),
    // The one loopback port every worker's proxy keeps open.
    getBrokerPort: () => brokerProxyService.getPort(),
    // Approved container requests go to the job's own Docker VM. The socket
    // the job sees is localmost's; the VM's is never handed over.
    dockerBackend,
    getDockerVmConfig: () => dockerVmConfigSource.refresh(),
    // What each job's environment gets (docs/roadmap/job-environment.md), as
    // Settings shows it, at each worker spawn.
    getJobEnvironmentConfig: runnerJobEnvironment,
    // Apply the policy that was approved, not whatever is in the repository
    // right now. A job only reaches this point once its policy has been
    // approved, and applying the approved copy means an unreviewed change
    // cannot take effect through a race. That covers the level too: it is
    // declared in the same file and approved with the rest of it. Only a
    // commit the pre-spawn check found carrying that policy gets it; one
    // whose .localmostrc was deleted, or that was never checked, gets none.
    getRepoPolicy: async (owner: string, repo: string, sha: string, workflowName: string) =>
      repoPolicyRuntime(getApprovedPolicyForCommit(`${owner}/${repo}`, sha), workflowName),
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
        } else if (event.type === 'cancel-failed') {
          // The run is still going on GitHub; say so rather than let a
          // refusal read as the end of it.
          title = 'Cancel Failed';
          body = `${repoShort}: ${event.reason ?? 'the workflow run could not be cancelled'}`;
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
  brokerProxyService.setCanAcceptJobCallback(() => canAcceptJob({ resourceMonitor, runnerManager }));

  // Wire up broker proxy to runner manager: when a job is received, decide
  // whether it may run and spawn the worker for it.
  const admission = buildAdmissionDeps(repoPolicyApproval, {
    findTarget: (targetId: string) => targetManager.getTargets().find(t => t.id === targetId),
    runnerManager,
    broker: brokerProxyService,
    log: (level, message) => getLogger()?.[level](message),
  });
  brokerProxyService.on('job-received', (targetId: string, jobId: string, _registeredRunnerName: string, githubInfo) => {
    admitJob(admission, targetId, jobId, githubInfo).catch((err) => {
      getLogger()?.error(`Admission of job ${jobId} failed: ${(err as Error).message}`);
    });
  });

  // Wire up broker proxy status updates to renderer
  brokerProxyService.on('status-update', (status) => {
    sendTargetStatusUpdate(status);
  });

  // Load saved auth state and settings
  const config = loadConfig();

  // Clean up any stale/corrupt runner configuration
  // Must await to ensure orphaned runner processes are killed before starting new ones
  try {
    await runnerDownloader.cleanupStaleConfiguration((message) => logger?.info(message));
  } catch (err) {
    logger?.warn(`Startup cleanup failed: ${(err as Error).message}. Leftovers stay until the next launch.`);
  }
  // The temp directories finished jobs left in the per-user temp directory,
  // once their sandboxes are gone: this data directory's only, by name.
  const userTemp = userTempDir((_level, message) => logger?.warn(message));
  if (userTemp) {
    await sweepJobTempDirs(userTemp, runnerDownloader.getSandboxBase(), (message) => logger?.info(message));
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

  // Handle resource-based pause/resume via state machine.
  // What it does to running jobs is read at each pause, as Settings shows it.
  wireResourceMonitor(resourceMonitor, runnerResourcePause);

  // The tray shows what a manual resume overrode until its condition clears,
  // which changes no pause on the state machine.
  resourceMonitor.on('state-changed', () => updateTrayMenu());

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
          const heartbeatTargets = targets.map(toHeartbeatTarget);

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

            // Start the heartbeat, unless the user paused while it started
            await startHeartbeatUnlessPaused(heartbeatManager);
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
        // stop() resolves as soon as the worker leaders exit. Any descendant
        // that ignored SIGTERM is still waiting out a grace period on an
        // unref'd timer that will not fire once we quit, so finish those now -
        // after this point nothing is left to reap them.
        finishPendingSweeps();
        // Each worker's socket released its VM as it stopped; this stops what
        // is left - a spare, a cache refresh - bounded at 10 s.
        memoryPressureMonitor?.stop();
        await Promise.all([cacheDisks?.shutdown(), vmManager?.shutdownAll()]);
      })(),
    ]);

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

  const heartbeatManager = getHeartbeatManager();
  const runnerManager = getRunnerManager();
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
      memoryPressureMonitor?.stop();
      await Promise.all([cacheDisks?.shutdown(), vmManager?.shutdownAll()]);
    })(),
  ]);

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
