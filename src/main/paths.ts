/**
 * Centralized path management for App Sandbox compliance.
 *
 * When App Sandbox is enabled:
 *   Uses app.getPath('userData') which Electron maps to the appropriate location
 *   e.g., ~/Library/Application Support/localmost
 *
 * Without App Sandbox:
 *   Uses ~/.localmost for backwards compatibility
 *
 * This module provides a centralized way to get the correct data directory
 * based on whether the app is running in an App Sandbox or not.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { app } from 'electron';

/**
 * Detect if the app is running inside an App Sandbox.
 * macOS sets APP_SANDBOX_CONTAINER_ID when running sandboxed apps.
 */
export function isAppSandboxed(): boolean {
  // macOS sets APP_SANDBOX_CONTAINER_ID when running in a sandbox
  if (process.env.APP_SANDBOX_CONTAINER_ID) {
    return true;
  }

  return false;
}

/**
 * Get the application data directory.
 *
 * For sandboxed apps:
 *   Returns the sandboxed path via app.getPath('userData')
 *   e.g., ~/Library/Application Support/localmost
 *
 * For non-sandboxed apps (development):
 *   Returns ~/.localmost for backwards compatibility
 *
 * Environment variable LOCALMOST_CONFIG_DIR can override this for testing.
 */
export function getAppDataDir(): string {
  // Allow environment variable override for testing
  if (process.env.LOCALMOST_CONFIG_DIR) {
    return process.env.LOCALMOST_CONFIG_DIR;
  }

  // For sandboxed apps, use Electron's userData path (sandbox-compatible)
  if (isAppSandboxed()) {
    return app.getPath('userData');
  }

  // For non-sandboxed apps, use traditional location for backwards compatibility
  return path.join(os.homedir(), '.localmost');
}

/**
 * Get the runner data directory.
 * This is where runner binaries, configs, and sandboxes are stored.
 */
export function getRunnerDir(): string {
  return path.join(getAppDataDir(), 'runner');
}

/**
 * Get the config file path.
 */
export function getConfigPath(): string {
  return path.join(getAppDataDir(), 'config.yaml');
}

/**
 * Get the job history file path.
 */
export function getJobHistoryPath(): string {
  return path.join(getAppDataDir(), 'job-history.json');
}

/**
 * Get the logs directory path.
 */
export function getLogsDir(): string {
  return path.join(getAppDataDir(), 'logs');
}

/**
 * Get the CLI socket path.
 * Used for communication between CLI and running app.
 */
export function getCliSocketPath(): string {
  return path.join(getAppDataDir(), 'localmost.sock');
}

/**
 * Ensure the app data directory exists with secure permissions.
 * Creates ~/.localmost (or sandbox equivalent) with 700 permissions (user-only).
 * This should be called early in app startup.
 */
export function ensureAppDataDir(): void {
  const dir = getAppDataDir();

  if (!fs.existsSync(dir)) {
    // Create with user-only permissions (rwx------)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    // Ensure existing directory has correct permissions
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // May fail if not owner - that's okay, we tried
    }
  }
}
