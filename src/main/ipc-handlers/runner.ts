/**
 * IPC handlers for runner control and configuration.
 */

import * as path from 'path';
import * as fs from 'fs';
import { ipcMain } from 'electron';
import { toUserError } from '../user-error';
import { loadConfig } from '../config';
import { getValidAccessToken, forceRefreshToken } from '../auth-tokens';
import { clearStaleRunnerRegistrations } from '../runner-lifecycle';
import {
  getMainWindow,
  getGitHubAuth,
  getRunnerManager,
  getRunnerDownloader,
  getHeartbeatManager,
  getAuthState,
  getLogger,
  getIsQuitting,
  getBrokerProxyService,
} from '../app-state';
import { getRunnerProxyManager } from '../runner-proxy-manager';
import { sendRunnerEvent } from '../runner-state-service';
import { updateTrayMenu } from '../tray-init';
import { getSnapshot, selectRunnerStatus } from '../runner-state-service';
import {
  IPC_CHANNELS,
  ConfigureOptions,
  DownloadProgress,
  SetupState,
} from '../../shared/types';
import { DEFAULT_RUNNER_COUNT } from '../../shared/constants';

/**
 * Register runner-related IPC handlers.
 */
export const registerRunnerHandlers = (): void => {
  const logger = () => getLogger();

  // Setup state
  ipcMain.handle(IPC_CHANNELS.APP_GET_SETUP_STATE, (): SetupState => {
    const runnerDownloader = getRunnerDownloader();
    const runnerManager = getRunnerManager();
    const authState = getAuthState();

    const isDownloaded = runnerDownloader?.isDownloaded() ?? false;
    const isConfigured = runnerManager?.isConfigured() ?? false;

    let step: SetupState['step'] = 'welcome';
    if (authState) {
      if (!isDownloaded) {
        step = 'download';
      } else if (!isConfigured) {
        step = 'configure';
      } else {
        step = 'complete';
      }
    } else {
      step = 'auth';
    }

    return {
      step,
      isRunnerDownloaded: isDownloaded,
      isRunnerConfigured: isConfigured,
      user: authState?.user,
    };
  });

  // Runner download
  ipcMain.handle(IPC_CHANNELS.RUNNER_IS_DOWNLOADED, () => {
    const runnerDownloader = getRunnerDownloader();
    return runnerDownloader?.isDownloaded() ?? false;
  });

  ipcMain.handle(IPC_CHANNELS.RUNNER_GET_VERSION, () => {
    const runnerDownloader = getRunnerDownloader();
    return {
      version: runnerDownloader?.getVersion() ?? null,
      url: runnerDownloader?.getVersionUrl() ?? null,
    };
  });

  ipcMain.handle(IPC_CHANNELS.RUNNER_GET_AVAILABLE_VERSIONS, async () => {
    const runnerDownloader = getRunnerDownloader();
    try {
      const versions = await runnerDownloader?.getAvailableVersions();
      return { success: true, versions: versions || [] };
    } catch (error) {
      const { userMessage, technicalDetails } = toUserError(error, 'Fetching versions');
      logger()?.error(technicalDetails);
      return { success: false, error: userMessage, versions: [] };
    }
  });

  ipcMain.handle(IPC_CHANNELS.RUNNER_SET_DOWNLOAD_VERSION, (_event, version: string | null) => {
    const runnerDownloader = getRunnerDownloader();
    runnerDownloader?.setDownloadVersion(version);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.RUNNER_DOWNLOAD, async () => {
    const runnerDownloader = getRunnerDownloader();
    const mainWindow = getMainWindow();
    try {
      const progressCallback = (progress: DownloadProgress) => {
        mainWindow?.webContents.send(IPC_CHANNELS.RUNNER_DOWNLOAD_PROGRESS, progress);
      };

      await runnerDownloader?.download(progressCallback);

      return { success: true };
    } catch (error) {
      const { userMessage, technicalDetails } = toUserError(error, 'Download');
      logger()?.error(technicalDetails);
      return { success: false, error: userMessage };
    }
  });

  // Runner configuration
  ipcMain.handle(IPC_CHANNELS.RUNNER_IS_CONFIGURED, () => {
    const runnerManager = getRunnerManager();
    return runnerManager?.isConfigured() ?? false;
  });

  ipcMain.handle(IPC_CHANNELS.RUNNER_GET_DISPLAY_NAME, () => {
    const runnerManager = getRunnerManager();
    return runnerManager?.getStatusDisplayName() ?? '';
  });

  ipcMain.handle(IPC_CHANNELS.RUNNER_CONFIGURE, async (_event, options: ConfigureOptions) => {
    const accessToken = await getValidAccessToken();
    const githubAuth = getGitHubAuth();
    const runnerDownloader = getRunnerDownloader();
    const runnerManager = getRunnerManager();

    if (!accessToken || !githubAuth) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      // Stop the runner if it's currently running before reconfiguring
      if (runnerManager?.isRunning()) {
        logger()?.info('Stopping runner before reconfiguration...');
        await runnerManager.stop();
      }

      let registrationToken: string;
      let configUrl: string;
      let owner: string | undefined;
      let repo: string | undefined;

      if (options.level === 'org') {
        // Organization-level runner
        if (!options.orgName) {
          throw new Error('Organization name is required');
        }
        logger()?.info(`Getting registration token for org ${options.orgName}...`);
        registrationToken = await githubAuth.getOrgRunnerRegistrationToken(accessToken, options.orgName);
        configUrl = `https://github.com/${options.orgName}`;
      } else {
        // Repository-level runner
        if (!options.repoUrl) {
          throw new Error('Repository URL is required');
        }
        const match = options.repoUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
        if (!match) {
          throw new Error('Invalid repository URL');
        }
        [, owner, repo] = match;
        logger()?.info(`Getting registration token for ${owner}/${repo}...`);
        registrationToken = await githubAuth.getRunnerRegistrationToken(accessToken, owner, repo);
        configUrl = `https://github.com/${owner}/${repo}`;
      }

      logger()?.info('Got registration token');

      // Clean up existing runners from GitHub that match our prefix
      const baseRunnerName = options.runnerName;
      logger()?.info(`Checking for existing runners matching "${baseRunnerName}"...`);

      try {
        const existingRunners = options.level === 'org'
          ? await githubAuth.listOrgRunners(accessToken, options.orgName!)
          : await githubAuth.listRunners(accessToken, owner!, repo!);

        // Find runners matching our base name with .N suffix pattern
        const matchingRunners = existingRunners.filter(r =>
          r.name.match(new RegExp(`^${baseRunnerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+$`))
        );

        if (matchingRunners.length > 0) {
          logger()?.info(`Found ${matchingRunners.length} existing runner(s) to remove from GitHub...`);

          for (const runner of matchingRunners) {
            logger()?.info(`Deleting runner "${runner.name}" (ID: ${runner.id}) from GitHub...`);
            try {
              if (options.level === 'org') {
                await githubAuth.deleteOrgRunner(accessToken, options.orgName!, runner.id);
              } else {
                await githubAuth.deleteRunner(accessToken, owner!, repo!, runner.id);
              }
            } catch (deleteError) {
              // Log but continue - runner might already be offline/deleted
              logger()?.warn(`Could not delete runner "${runner.name}": ${(deleteError as Error).message}`);
            }
          }
          logger()?.info('Finished cleaning up existing runners');
        } else {
          logger()?.info('No existing runners found to clean up');
        }
      } catch (listError) {
        // Log but continue - we can still try to configure
        logger()?.warn(`Could not list existing runners: ${(listError as Error).message}`);
      }

      // Configure runner pool (default to 4 max, but only configure instance 1 now)
      // Other instances will be configured on-demand when scaling up (lazy configuration)
      const runnerCount = options.runnerCount || DEFAULT_RUNNER_COUNT;

      // Get the runner version to use
      const version = runnerDownloader?.getDownloadVersion();
      if (!version) {
        throw new Error('No runner version available');
      }

      // Clean config for instance 1 only (others are configured lazily on-demand)
      logger()?.info(`Cleaning config directory for instance 1...`);
      const configFilesToRemove = ['.runner', '.credentials', '.credentials_rsaparams'];
      const configDir = runnerDownloader?.getConfigDir(1);
      if (configDir && fs.existsSync(configDir)) {
        for (const file of configFilesToRemove) {
          const filePath = path.join(configDir, file);
          if (fs.existsSync(filePath)) {
            try {
              await fs.promises.unlink(filePath);
              logger()?.info(`Removed ${file} from config 1`);
            } catch (e) {
              logger()?.warn(`Could not remove ${file} from config 1: ${(e as Error).message}`);
            }
          }
        }
      }

      // Configure instance 1 only - other instances configured on-demand when needed
      const instanceName = `${baseRunnerName}.1`;
      logger()?.info(`Configuring runner instance 1 (up to ${runnerCount} will be configured lazily): ${instanceName}...`);

      await runnerDownloader?.configureInstance(1, version, {
        url: configUrl,
        token: registrationToken,
        name: instanceName,
        labels: options.labels,
        onLog: (level, message) => {
          if (level === 'info') logger()?.info(`[config 1] ${message}`);
          else logger()?.error(`[config 1] ${message}`);
        },
      });

      logger()?.info(`Configuration complete! Instance 1 configured (up to ${runnerCount} total, configured lazily).`);

      // Update runner manager with new runner count
      runnerManager?.setRunnerCount(runnerCount);

      return { success: true };
    } catch (error) {
      const { userMessage, technicalDetails } = toUserError(error, 'Configuration');
      logger()?.error(technicalDetails);
      return { success: false, error: userMessage };
    }
  });

  // Runner control
  ipcMain.handle(IPC_CHANNELS.RUNNER_START, async () => {
    const runnerManager = getRunnerManager();
    const heartbeatManager = getHeartbeatManager();
    const authState = getAuthState();
    const githubAuth = getGitHubAuth();
    const mainWindow = getMainWindow();
    const brokerProxyService = getBrokerProxyService();

    try {
      // Signal state machine that we're starting
      sendRunnerEvent({ type: 'START' });

      // Show 'starting' status immediately - clearStaleRunnerRegistrations can take a while
      if (mainWindow && !mainWindow.isDestroyed() && !getIsQuitting()) {
        mainWindow.webContents.send(IPC_CHANNELS.RUNNER_STATUS_UPDATE, {
          status: 'starting',
          startedAt: new Date().toISOString(),
        });
      }

      // Clear any stale runner registrations before starting
      await clearStaleRunnerRegistrations();

      // Initialize broker proxy with all target credentials
      const config = loadConfig();
      const targets = config.targets || [];
      if (targets.length > 0 && brokerProxyService) {
        const proxyManager = getRunnerProxyManager();

        for (const target of targets) {
          if (!target.enabled) continue;

          const credentials = proxyManager.loadCredentials(target.id);
          if (credentials) {
            brokerProxyService.addTarget(target, credentials.runner, credentials.credentials, credentials.rsaParams);
          } else {
            logger()?.warn(`[BrokerProxy] No credentials for ${target.displayName}, skipping`);
          }
        }

        // Start broker proxy server - workers will connect to this
        try {
          await brokerProxyService.start();
          logger()?.info('Broker proxy started, waiting for jobs from targets...');
        } catch (err) {
          logger()?.error(`[BrokerProxy] Failed to start: ${(err as Error).message}`);
        }
      }

      // Initialize runner manager (workers spawn on-demand when jobs arrive)
      await runnerManager?.initialize();
      logger()?.info('Broker proxy running, workers will spawn when jobs arrive');

      // Signal state machine that initialization is complete
      sendRunnerEvent({ type: 'INITIALIZED' });

      // Start heartbeat when runner starts
      if (heartbeatManager && authState?.accessToken && githubAuth) {
        // Set up heartbeat for all configured targets
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
                // On auth error, try refreshing token and retry once
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
                // On auth error, try refreshing token and retry once
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

          // Set runner name for logging
          const runnerConfig = config.runnerConfig;
          if (runnerConfig?.runnerName) {
            heartbeatManager.setRunnerName(runnerConfig.runnerName);
          }

          // Start the heartbeat
          await heartbeatManager.start();
        }
      }

      // Update tray to reflect new state
      updateTrayMenu();

      return { success: true };
    } catch (error) {
      const { userMessage, technicalDetails } = toUserError(error, 'Starting runner');
      logger()?.error(technicalDetails);
      return { success: false, error: userMessage };
    }
  });

  ipcMain.handle(IPC_CHANNELS.RUNNER_STOP, async () => {
    const runnerManager = getRunnerManager();
    const heartbeatManager = getHeartbeatManager();

    try {
      await runnerManager?.stop();

      // Stop heartbeat when runner stops
      heartbeatManager?.stop();

      // Update tray to reflect new state
      updateTrayMenu();

      return { success: true };
    } catch (error) {
      const { userMessage, technicalDetails } = toUserError(error, 'Stopping runner');
      logger()?.error(technicalDetails);
      return { success: false, error: userMessage };
    }
  });

  ipcMain.handle(IPC_CHANNELS.RUNNER_STATUS, () => {
    // Use state machine for consistent status (same as CLI)
    const snapshot = getSnapshot();
    return snapshot ? selectRunnerStatus(snapshot) : { status: 'offline' };
  });

  // Job history
  ipcMain.handle(IPC_CHANNELS.JOB_HISTORY_GET, () => {
    const runnerManager = getRunnerManager();
    return runnerManager?.getJobHistory() ?? [];
  });

  ipcMain.handle(IPC_CHANNELS.JOB_HISTORY_SET_MAX, (_event, max: number) => {
    const runnerManager = getRunnerManager();
    runnerManager?.setMaxJobHistory(max);
    return { success: true };
  });

  // Cancel a running job
  ipcMain.handle(IPC_CHANNELS.JOB_CANCEL, async (_event, owner: string, repo: string, runId: number) => {
    const logger = getLogger();
    const auth = getGitHubAuth();
    const accessToken = await getValidAccessToken();

    if (!accessToken || !auth) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      logger?.info(`Cancelling workflow run ${runId} in ${owner}/${repo}`);
      await auth.cancelWorkflowRun(accessToken, owner, repo, runId);
      return { success: true };
    } catch (err) {
      const message = (err as Error).message;
      logger?.warn(`Failed to cancel workflow run ${runId}: ${message}`);
      return { success: false, error: message };
    }
  });
};
