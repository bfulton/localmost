/**
 * IPC handlers for resource-aware scheduling.
 */

import { ipcMain } from 'electron';
import { getResourceMonitor, getEffectivePauseState } from '../app-state';
import { IPC_CHANNELS, ResourcePauseState } from '../../shared/types';

/**
 * Register resource-related IPC handlers.
 */
export const registerResourceHandlers = (): void => {
  // Get current resource pause state
  ipcMain.handle(IPC_CHANNELS.RESOURCE_GET_STATE, (): ResourcePauseState => {
    const resourceMonitor = getResourceMonitor();
    if (!resourceMonitor) {
      return {
        isPaused: false,
        reason: null,
        conditions: [],
      };
    }
    return resourceMonitor.getPauseState();
  });
};
