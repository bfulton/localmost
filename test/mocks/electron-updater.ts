// Mock electron-updater for unit testing
// Uses a singleton to persist state across jest.resetModules()
import { EventEmitter } from 'events';

// Singleton instance stored on global to persist across module resets
const globalKey = '__mockElectronUpdater__';

function getAutoUpdater() {
  if (!(global as Record<string, unknown>)[globalKey]) {
    const instance = new EventEmitter() as EventEmitter & {
      autoDownload: boolean;
      autoInstallOnAppQuit: boolean;
      checkForUpdates: jest.Mock;
      downloadUpdate: jest.Mock;
      quitAndInstall: jest.Mock;
    };
    instance.autoDownload = true;
    instance.autoInstallOnAppQuit = false;
    instance.checkForUpdates = jest.fn();
    instance.downloadUpdate = jest.fn();
    instance.quitAndInstall = jest.fn();
    (global as Record<string, unknown>)[globalKey] = instance;
  }
  return (global as Record<string, unknown>)[globalKey];
}

export const autoUpdater = getAutoUpdater();
export default { autoUpdater };
