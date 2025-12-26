/**
 * IPC handlers for target management (multi-target runner support).
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS, Target, Result, RunnerProxyStatus } from '../../shared/types';
import { getTargetManager } from '../target-manager';
import { getRunnerProxyManager } from '../runner-proxy-manager';
import { getLogger, getBrokerProxyService } from '../app-state';

/**
 * Register all target-related IPC handlers.
 */
export const registerTargetHandlers = (): void => {
  const log = () => getLogger();

  // List all targets
  ipcMain.handle(IPC_CHANNELS.TARGETS_LIST, (): Target[] => {
    return getTargetManager().getTargets();
  });

  // Add a new target
  ipcMain.handle(
    IPC_CHANNELS.TARGETS_ADD,
    async (
      _event,
      type: 'repo' | 'org',
      owner: string,
      repo?: string
    ): Promise<Result<Target>> => {
      log()?.info(`[IPC] targets:add ${type} ${owner}${repo ? '/' + repo : ''}`);
      const result = await getTargetManager().addTarget(type, owner, repo);

      // If successful and broker proxy is running, add target to it
      if (result.success && result.data) {
        const brokerProxy = getBrokerProxyService();
        if (brokerProxy) {
          const proxyManager = getRunnerProxyManager();
          const credentials = proxyManager.loadCredentials(result.data.id);
          if (credentials) {
            brokerProxy.addTarget(
              result.data,
              credentials.runner,
              credentials.credentials,
              credentials.rsaParams
            );
          }
        }
      }

      return result;
    }
  );

  // Remove a target
  ipcMain.handle(
    IPC_CHANNELS.TARGETS_REMOVE,
    async (_event, targetId: string): Promise<Result> => {
      log()?.info(`[IPC] targets:remove ${targetId}`);

      // Remove from broker proxy first (if running)
      const brokerProxy = getBrokerProxyService();
      if (brokerProxy) {
        brokerProxy.removeTarget(targetId);
      }

      return getTargetManager().removeTarget(targetId);
    }
  );

  // Update a target
  ipcMain.handle(
    IPC_CHANNELS.TARGETS_UPDATE,
    async (
      _event,
      targetId: string,
      updates: Partial<Pick<Target, 'enabled'>>
    ): Promise<Result<Target>> => {
      log()?.info(`[IPC] targets:update ${targetId}`);
      return getTargetManager().updateTarget(targetId, updates);
    }
  );

  // Get target status (from broker proxy)
  ipcMain.handle(
    IPC_CHANNELS.TARGETS_GET_STATUS,
    (): RunnerProxyStatus[] => {
      const brokerProxy = getBrokerProxyService();
      if (brokerProxy) {
        return brokerProxy.getStatus();
      }
      // Fallback: return placeholder status based on targets
      const targets = getTargetManager().getTargets();
      return targets.map(t => ({
        targetId: t.id,
        registered: true,
        sessionActive: false,
        lastPoll: null,
        jobsAssigned: 0,
      }));
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
