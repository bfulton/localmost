/**
 * CLI installation service.
 * Handles installing/uninstalling the `localmost` command to /usr/local/bin.
 */

import { app, dialog } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getMainWindow } from './app-state';

const execAsync = promisify(exec);

/** Target path for the CLI symlink */
const CLI_INSTALL_PATH = '/usr/local/bin/localmost';

/** Name of the CLI wrapper script bundled in app resources */
const CLI_RESOURCE_NAME = 'localmost-cli';

/**
 * Check if the app is running from a translocated path.
 * App Translocation is a macOS security feature that copies apps to a
 * temporary location when run directly from Downloads or other quarantined locations.
 */
export function isAppTranslocated(): boolean {
  return app.getAppPath().includes('AppTranslocation');
}

/**
 * Get the path to the CLI wrapper script in the app bundle.
 */
function getCliSourcePath(): string {
  return path.join(process.resourcesPath, CLI_RESOURCE_NAME);
}

/**
 * Check if the CLI is currently installed and points to this app.
 */
export async function getCliInstallStatus(): Promise<{
  installed: boolean;
  pointsToThisApp: boolean;
  currentTarget?: string;
}> {
  try {
    const stats = await fs.lstat(CLI_INSTALL_PATH);
    if (!stats.isSymbolicLink()) {
      // It's a regular file, not our symlink
      return { installed: true, pointsToThisApp: false, currentTarget: CLI_INSTALL_PATH };
    }

    const target = await fs.readlink(CLI_INSTALL_PATH);
    const expectedTarget = getCliSourcePath();
    const pointsToThisApp = target === expectedTarget;

    return { installed: true, pointsToThisApp, currentTarget: target };
  } catch {
    // File doesn't exist or can't be read
    return { installed: false, pointsToThisApp: false };
  }
}

/**
 * Install the CLI by creating a symlink in /usr/local/bin.
 * Uses osascript with administrator privileges to handle the sudo requirement.
 */
export async function installCli(): Promise<{ success: boolean; error?: string }> {
  const mainWindow = getMainWindow();

  // Check for App Translocation
  if (isAppTranslocated()) {
    dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: 'Cannot Install CLI',
      message: 'Please move localmost to Applications first',
      detail:
        'The app is running from a temporary location. Drag localmost.app to your Applications folder, then relaunch it before installing the command line tool.',
      buttons: ['OK'],
    });
    return { success: false, error: 'App is translocated' };
  }

  const sourcePath = getCliSourcePath();

  // Verify the CLI script exists in the bundle
  try {
    await fs.access(sourcePath);
  } catch {
    return { success: false, error: 'CLI script not found in app bundle' };
  }

  // Check current status
  const status = await getCliInstallStatus();
  if (status.installed && status.pointsToThisApp) {
    dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: 'CLI Already Installed',
      message: 'The command line tool is already installed',
      detail: `The 'localmost' command is available in your terminal.`,
      buttons: ['OK'],
    });
    return { success: true };
  }

  // Build the shell command
  // mkdir -p ensures /usr/local/bin exists; ln -sf overwrites any existing symlink
  const shellCommand = `mkdir -p /usr/local/bin && ln -sf '${sourcePath}' '${CLI_INSTALL_PATH}'`;

  // Use osascript to run with administrator privileges (triggers macOS password prompt)
  const script = `do shell script "${shellCommand}" with administrator privileges`;

  try {
    await execAsync(`osascript -e '${script}'`);

    dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: 'CLI Installed',
      message: 'Command line tool installed successfully',
      detail: `You can now use 'localmost' in your terminal.\n\nTry: localmost status`,
      buttons: ['OK'],
    });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // User cancelled the password prompt
    if (errorMessage.includes('User canceled') || errorMessage.includes('-128')) {
      return { success: false, error: 'Installation cancelled' };
    }

    dialog.showMessageBox(mainWindow!, {
      type: 'error',
      title: 'Installation Failed',
      message: 'Could not install the command line tool',
      detail: errorMessage,
      buttons: ['OK'],
    });

    return { success: false, error: errorMessage };
  }
}

/**
 * Uninstall the CLI by removing the symlink from /usr/local/bin.
 */
export async function uninstallCli(): Promise<{ success: boolean; error?: string }> {
  const mainWindow = getMainWindow();

  const status = await getCliInstallStatus();
  if (!status.installed) {
    dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: 'CLI Not Installed',
      message: 'The command line tool is not installed',
      detail: `There is no 'localmost' command to remove.`,
      buttons: ['OK'],
    });
    return { success: true };
  }

  // Only remove if it's our symlink (safety check)
  if (!status.pointsToThisApp) {
    const result = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: 'Different CLI Installed',
      message: 'A different localmost CLI is installed',
      detail: `The current CLI points to:\n${status.currentTarget}\n\nThis may be from a different installation. Remove it anyway?`,
      buttons: ['Cancel', 'Remove Anyway'],
      defaultId: 0,
      cancelId: 0,
    });

    if (result.response === 0) {
      return { success: false, error: 'Cancelled by user' };
    }
  }

  // Use osascript to remove with administrator privileges
  const script = `do shell script "rm -f '${CLI_INSTALL_PATH}'" with administrator privileges`;

  try {
    await execAsync(`osascript -e '${script}'`);

    dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: 'CLI Uninstalled',
      message: 'Command line tool removed',
      detail: `The 'localmost' command has been removed from your PATH.`,
      buttons: ['OK'],
    });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes('User canceled') || errorMessage.includes('-128')) {
      return { success: false, error: 'Uninstall cancelled' };
    }

    dialog.showMessageBox(mainWindow!, {
      type: 'error',
      title: 'Uninstall Failed',
      message: 'Could not remove the command line tool',
      detail: errorMessage,
      buttons: ['OK'],
    });

    return { success: false, error: errorMessage };
  }
}
