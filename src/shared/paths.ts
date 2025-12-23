/**
 * Shared path utilities that work in both Electron and Node.js CLI contexts.
 * Unlike src/main/paths.ts, this module does not depend on Electron.
 */

import * as path from 'path';
import * as os from 'os';

/**
 * Get the application data directory without Electron dependency.
 * This is used by the CLI which runs outside of Electron.
 *
 * Environment variable LOCALMOST_CONFIG_DIR can override this for testing.
 */
export function getAppDataDirWithoutElectron(): string {
  // Allow environment variable override for testing
  if (process.env.LOCALMOST_CONFIG_DIR) {
    return process.env.LOCALMOST_CONFIG_DIR;
  }

  // Check if running in macOS App Sandbox
  if (process.env.APP_SANDBOX_CONTAINER_ID) {
    // Use the standard macOS Application Support path
    return path.join(os.homedir(), 'Library', 'Application Support', 'localmost');
  }

  // For non-sandboxed apps, use traditional location
  return path.join(os.homedir(), '.localmost');
}

/**
 * Get the CLI socket path.
 * Used for communication between CLI and running app.
 */
export function getCliSocketPath(): string {
  return path.join(getAppDataDirWithoutElectron(), 'localmost.sock');
}
