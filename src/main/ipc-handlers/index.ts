/**
 * IPC handlers entry point.
 * Registers all domain-specific handlers.
 */

import { registerAuthHandlers } from './auth';
import { registerRunnerHandlers } from './runner';
import { registerSettingsHandlers } from './settings';
import { registerAppHandlers } from './app';
import { registerUpdateHandlers } from './updater';

/**
 * Set up all IPC handlers.
 */
export const setupIpcHandlers = (): void => {
  registerAuthHandlers();
  registerRunnerHandlers();
  registerSettingsHandlers();
  registerAppHandlers();
  registerUpdateHandlers();
};
