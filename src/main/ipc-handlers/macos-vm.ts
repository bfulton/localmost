/**
 * IPC for the macOS VM's setup component: the golden image's status, and
 * building, cancelling, opening the guided setup and removing it. Only the
 * app's own window may ask (trusted-ipc). Nothing the renderer sends is a
 * path or an id: each handler takes no argument, and acts on the one image
 * the manager keeps. index.ts registers it with the mode's manager
 * (src/main/isolation/macos-vm/index.ts).
 */

import { ipcMain } from './trusted-ipc';
import { getMainWindow } from '../app-state';
import { MACOS_VM_CHANNELS, type MacVmSetupStatus } from '../../shared/macos-vm-setup';
import { failure, success, type Result } from '../../shared/types';

/** What the handlers need of the mode's MacVmImageManager. */
export interface MacVmSetupManager {
  status(): MacVmSetupStatus;
  build(): void;
  cancel(): void;
  openGuidedSetup(): void;
  remove(): void;
  on(event: 'status', listener: (status: MacVmSetupStatus) => void): unknown;
}

const act = (fn: () => void): Result => {
  try {
    fn();
    return success();
  } catch (err) {
    return failure(err as Error);
  }
};

export function registerMacVmHandlers(images: MacVmSetupManager): void {
  ipcMain.handle(MACOS_VM_CHANNELS.GET_STATUS, (): MacVmSetupStatus => images.status());
  ipcMain.handle(MACOS_VM_CHANNELS.BUILD, (): Result => act(() => images.build()));
  ipcMain.handle(MACOS_VM_CHANNELS.CANCEL, (): Result => act(() => images.cancel()));
  ipcMain.handle(MACOS_VM_CHANNELS.OPEN_GUIDED_SETUP, (): Result => act(() => images.openGuidedSetup()));
  ipcMain.handle(MACOS_VM_CHANNELS.REMOVE, (): Result => act(() => images.remove()));
  images.on('status', (status: MacVmSetupStatus) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(MACOS_VM_CHANNELS.STATUS_CHANGED, status);
  });
}
