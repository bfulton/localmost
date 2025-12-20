/**
 * Logging utilities: sendLog, initLogger, and status updates.
 */

import { Logger } from './logger';
import { writeToLogFile, getLogSymlinkPath } from './log-file';
import { sanitizeLogMessage } from './security';
import {
  getMainWindow,
  getIsQuitting,
  setLogger,
  getLogLevelSetting,
  setCurrentRunnerStatus,
} from './app-state';
import { updateTrayMenu } from './tray-init';
import { updateSleepProtection } from './app-state';
import {
  IPC_CHANNELS,
  LogEntry,
  RunnerState,
  JobHistoryEntry,
  LOG_LEVEL_PRIORITY,
  LogLevel,
} from '../shared/types';

/**
 * Send log entries to renderer and file.
 */
export const sendLog = (entry: LogEntry): void => {
  const logLevelSetting = getLogLevelSetting();

  // Filter based on log level - only display/save if entry level >= configured level
  const entryPriority = LOG_LEVEL_PRIORITY[entry.level as LogLevel] ?? LOG_LEVEL_PRIORITY.info;
  const configuredPriority = LOG_LEVEL_PRIORITY[logLevelSetting];
  if (entryPriority < configuredPriority) {
    return; // Skip this log entry (too verbose for current setting)
  }

  // Sanitize message to redact sensitive data
  const sanitizedEntry = {
    ...entry,
    message: sanitizeLogMessage(entry.message),
  };

  // Send to renderer (skip if quitting or window is not ready)
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed() && !getIsQuitting()) {
    mainWindow.webContents.send(IPC_CHANNELS.LOG_ENTRY, sanitizedEntry);
  }

  // Write to log file
  const timestamp = new Date(sanitizedEntry.timestamp).toLocaleTimeString();
  writeToLogFile(timestamp, sanitizedEntry.level, sanitizedEntry.message);
};

/**
 * Initialize the logger instance.
 * Call this after log file setup.
 */
export const initLogger = (): void => {
  const logger = new Logger(sendLog);
  setLogger(logger);
};

/**
 * Send status updates to renderer.
 */
export const sendStatusUpdate = (state: RunnerState): void => {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed() && !getIsQuitting()) {
    mainWindow.webContents.send(IPC_CHANNELS.RUNNER_STATUS_UPDATE, state);
  }
  setCurrentRunnerStatus(state.status);
  updateSleepProtection();
  updateTrayMenu();
};

/**
 * Send job history updates to renderer.
 */
export const sendJobHistoryUpdate = (jobs: JobHistoryEntry[]): void => {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed() && !getIsQuitting()) {
    mainWindow.webContents.send(IPC_CHANNELS.JOB_HISTORY_UPDATE, jobs);
  }
};

/**
 * Re-export for convenience.
 */
export { getLogSymlinkPath };
