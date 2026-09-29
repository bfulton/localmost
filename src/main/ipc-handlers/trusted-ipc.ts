/**
 * ipcMain, answering only the app's own page.
 *
 * Every handler here acts with the user's GitHub token or on the machine's
 * runners, and Electron delivers a message from any frame of any webContents
 * that has the preload API. The window keeps to its own page and admits no
 * frames today, but that is the renderer's configuration holding, not the
 * handlers checking. This is the check: a message counts only when it comes
 * from the main window's top frame, showing the app's entry page. Handler
 * modules import `ipcMain` from here instead of from electron, so no channel
 * can be registered without it.
 */

import { ipcMain as electronIpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { getMainWindow } from '../app-state';
import { isAppEntryUrl } from '../navigation';

export const isFromMainWindow = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return false;
  const contents = window.webContents;
  const frame = event.senderFrame;
  return (
    event.sender?.id === contents.id &&
    frame !== null &&
    frame !== undefined &&
    frame.frameTreeNodeId === contents.mainFrame.frameTreeNodeId &&
    isAppEntryUrl(frame.url)
  );
};

export const ipcMain = {
  handle<Args extends unknown[]>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => unknown
  ): void {
    electronIpcMain.handle(channel, (event, ...args) => {
      if (!isFromMainWindow(event)) {
        throw new Error(`${channel} refused: not sent by the localmost window`);
      }
      return listener(event, ...(args as Args));
    });
  },

  on<Args extends unknown[]>(channel: string, listener: (event: IpcMainEvent, ...args: Args) => void): void {
    electronIpcMain.on(channel, (event, ...args) => {
      if (!isFromMainWindow(event)) return;
      listener(event, ...(args as Args));
    });
  },
};
