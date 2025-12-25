/**
 * Log file management: initialization, rotation, and streaming.
 */

import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { getLogsDir } from './paths';
import { MAX_LOG_FILES } from '../shared/constants';

// Log file state
const logsDir = getLogsDir();

/**
 * Early boot logger for errors before the main logger is initialized.
 * Writes directly to stderr since log file may not be ready.
 */
export const bootLog = (level: 'info' | 'warn' | 'error', message: string): void => {
  const timestamp = new Date().toISOString();
  const line = `[BOOT] ${timestamp} [${level.toUpperCase()}] ${message}\n`;
  process.stderr.write(line);
  // Also try to write to log file if stream is available
  if (logFileStream) {
    logFileStream.write(line);
  }
};
const logSymlinkPath = path.join(logsDir, 'localmost.log');
let logFilePath: string | null = null;
let logFileStream: fs.WriteStream | null = null;

/**
 * Helper to find asset files in various locations (dev vs packaged app).
 */
export const findAsset = (filename: string): string | undefined => {
  const possiblePaths = [
    // Development: assets folder in project root
    path.join(app.getAppPath(), 'assets', 'generated', filename),
    path.join(__dirname, '..', '..', 'assets', 'generated', filename),
    path.join(__dirname, '..', 'assets', 'generated', filename),
    // Packaged app: extraResource copies 'generated' folder to Resources/
    path.join(process.resourcesPath || '', 'generated', filename),
  ];
  return possiblePaths.find(p => fs.existsSync(p));
};

/**
 * Initialize log file with timestamp and symlink.
 */
export const initLogFile = (): void => {
  try {
    fs.mkdirSync(logsDir, { recursive: true });

    // Create timestamped log file name
    const now = new Date();
    const timestamp = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
    const logFileName = `localmost.${timestamp}.log`;
    logFilePath = path.join(logsDir, logFileName);

    // Create or update symlink atomically to prevent TOCTOU race
    // 1. Create symlink with unique temp name
    // 2. Rename over target (atomic on POSIX systems)
    const tempSymlinkPath = `${logSymlinkPath}.${process.pid}.tmp`;
    try {
      // Remove any stale temp symlink from previous crash
      try {
        fs.unlinkSync(tempSymlinkPath);
      } catch (unlinkErr) {
        // Expected: temp symlink doesn't exist from previous run
        // Only log if it's not ENOENT
        if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          bootLog('warn', `Failed to remove temp symlink: ${(unlinkErr as Error).message}`);
        }
      }
      // Create temp symlink
      fs.symlinkSync(logFileName, tempSymlinkPath);
      // Atomically rename over target
      fs.renameSync(tempSymlinkPath, logSymlinkPath);
    } catch (symlinkErr) {
      // Clean up temp symlink on failure
      try {
        fs.unlinkSync(tempSymlinkPath);
      } catch {
        // Cleanup failed but original error is more important
      }
      bootLog('warn', `Failed to create log symlink: ${(symlinkErr as Error).message}`);
    }

    // Open write stream
    logFileStream = fs.createWriteStream(logFilePath, { flags: 'a' });

    // Clean up old log files
    const logFiles = fs.readdirSync(logsDir)
      .filter(f => f.startsWith('localmost.') && f.endsWith('.log') && f !== 'localmost.log')
      .sort()
      .reverse();

    if (logFiles.length > MAX_LOG_FILES) {
      for (const oldFile of logFiles.slice(MAX_LOG_FILES)) {
        try {
          fs.unlinkSync(path.join(logsDir, oldFile));
        } catch (unlinkErr) {
          bootLog('warn', `Failed to delete old log ${oldFile}: ${(unlinkErr as Error).message}`);
        }
      }
    }
  } catch (e) {
    bootLog('error', `Failed to initialize log file: ${(e as Error).message}`);
  }
};

/**
 * Get the log symlink path for external access.
 */
export const getLogSymlinkPath = (): string => logSymlinkPath;

/**
 * Get the log file stream for writing.
 */
export const getLogFileStream = (): fs.WriteStream | null => logFileStream;

/**
 * Write a formatted log entry to the file stream.
 */
export const writeToLogFile = (timestamp: string, level: string, message: string): void => {
  if (logFileStream) {
    const formattedLevel = level.toUpperCase().padEnd(5);
    logFileStream.write(`${timestamp} [${formattedLevel}] ${message}\n`);
  }
};
