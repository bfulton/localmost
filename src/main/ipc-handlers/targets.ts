/**
 * IPC handlers for target management (multi-target runner support).
 */

import { ipcMain } from './trusted-ipc';
import { IPC_CHANNELS, Target, Result, RunnerProxyStatus } from '../../shared/types';
import { getTargetManager } from '../target-manager';
import { getLogger, getBrokerProxyService } from '../app-state';
import { store } from '../store/init';
import { isGitHubOwnerName, isGitHubRepoName } from '../../shared/github-names';

/**
 * Register all target-related IPC handlers.
 */
export const registerTargetHandlers = (): void => {
  const log = () => getLogger();

  // List all targets
  ipcMain.handle(IPC_CHANNELS.TARGETS_LIST, (): Target[] => {
    const targets = getTargetManager().getTargets();
    // Update store so zubridge syncs to renderer
    store.getState().setTargets(targets);
    return targets;
  });

  // Add a new target
  ipcMain.handle(
    IPC_CHANNELS.TARGETS_ADD,
    async (
      _event,
      type: unknown,
      owner: unknown,
      repo?: unknown
    ): Promise<Result<Target>> => {
      // The names become GitHub API paths requested with the user's token, so
      // what the renderer sends is held to what GitHub accepts as a name.
      if (type !== 'repo' && type !== 'org') {
        return { success: false, error: 'Invalid target type: expected "repo" or "org"' };
      }
      if (!isGitHubOwnerName(owner)) {
        return { success: false, error: 'Invalid target owner: expected a GitHub user or organization name' };
      }
      if (type === 'repo' && !isGitHubRepoName(repo)) {
        return { success: false, error: 'Invalid repository: expected a GitHub repository name' };
      }
      const repoName = type === 'repo' ? (repo as string) : undefined;
      log()?.info(`[IPC] targets:add ${type} ${owner}${repoName ? '/' + repoName : ''}`);
      return getTargetManager().addTargetAndAttach(type, owner, repoName);
    }
  );

  // Remove a target
  ipcMain.handle(
    IPC_CHANNELS.TARGETS_REMOVE,
    async (_event, targetId: string): Promise<Result> => {
      log()?.info(`[IPC] targets:remove ${targetId}`);
      return getTargetManager().removeTargetAndDetach(targetId);
    }
  );

  // Update a target
  ipcMain.handle(
    IPC_CHANNELS.TARGETS_UPDATE,
    async (_event, targetId: unknown, updates: unknown): Promise<Result<Target>> => {
      // Enabling or disabling is the one change the renderer makes. The rest
      // of a target - its url, owner, repo and id - decides where config.sh
      // sends a registration token and which API paths are requested, so an
      // update carrying anything else is refused rather than trimmed.
      if (
        typeof targetId !== 'string' ||
        typeof updates !== 'object' ||
        updates === null ||
        Object.keys(updates).length !== 1 ||
        typeof (updates as { enabled?: unknown }).enabled !== 'boolean'
      ) {
        return { success: false, error: 'Invalid target update: only enabled may be changed' };
      }
      const enabled = (updates as { enabled: boolean }).enabled;
      log()?.info(`[IPC] targets:update ${targetId}`);
      return getTargetManager().updateTarget(targetId, { enabled });
    }
  );

  // Get target status (from broker proxy)
  ipcMain.handle(
    IPC_CHANNELS.TARGETS_GET_STATUS,
    (): RunnerProxyStatus[] => {
      let status: RunnerProxyStatus[];
      const brokerProxy = getBrokerProxyService();
      if (brokerProxy) {
        status = brokerProxy.getStatus();
      } else {
        // Fallback: return placeholder status based on targets
        const targets = getTargetManager().getTargets();
        status = targets.map(t => ({
          targetId: t.id,
          registered: true,
          sessionActive: false,
          lastPoll: null,
          jobsAssigned: 0,
        }));
      }
      // Update store so zubridge syncs to renderer
      store.getState().setTargetStatus(status);
      return status;
    }
  );
};

/**
 * Send target status updates to renderer.
 * Call this when broker proxy status changes.
 */
export const sendTargetStatusUpdate = (status: RunnerProxyStatus[]): void => {
  // Import here to avoid circular dependency
  const { getMainWindow, getIsQuitting } = require('../app-state');
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed() && !getIsQuitting()) {
    mainWindow.webContents.send(IPC_CHANNELS.TARGETS_STATUS_UPDATE, status);
  }
};
