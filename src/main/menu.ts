/**
 * Application menu management.
 */

import { app, Menu, MenuItemConstructorOptions, shell } from 'electron';
import { getMainWindow, getRunnerManager } from './app-state';
import { showAboutDialog, confirmQuitIfBusy } from './window';
import { installCli, uninstallCli } from './cli-install';
import { REPOSITORY_URL, PRIVACY_POLICY_URL } from '../shared/constants';

/**
 * Create and set the application menu.
 */
export const createMenu = (): void => {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: 'localmost',
            submenu: [
              {
                label: 'About localmost',
                click: () => showAboutDialog(),
              },
              { type: 'separator' as const },
              {
                label: 'Status',
                click: () => {
                  const mainWindow = getMainWindow();
                  mainWindow?.show();
                  mainWindow?.webContents.send('navigate', 'status');
                },
              },
              {
                label: 'Settings...',
                accelerator: 'CmdOrCtrl+,',
                click: () => {
                  const mainWindow = getMainWindow();
                  mainWindow?.show();
                  mainWindow?.webContents.send('navigate', 'settings');
                },
              },
              { type: 'separator' as const },
              {
                label: 'Install Command Line Tool...',
                click: () => installCli(),
              },
              {
                label: 'Uninstall Command Line Tool...',
                click: () => uninstallCli(),
              },
              { type: 'separator' as const },
              { role: 'hide' as const, label: 'Hide localmost' },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              {
                label: 'Quit localmost',
                accelerator: 'CmdOrCtrl+Q',
                click: async () => {
                  if (await confirmQuitIfBusy()) {
                    await getRunnerManager()?.stop();
                    app.quit();
                  }
                },
              },
            ] as MenuItemConstructorOptions[],
          },
        ]
      : []),
    // Edit menu (for copy/paste)
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ] as MenuItemConstructorOptions[],
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const },
            ]
          : []),
      ] as MenuItemConstructorOptions[],
    },
    // Help menu
    {
      label: 'Help',
      submenu: [
        {
          label: 'Privacy Policy',
          click: () => shell.openExternal(PRIVACY_POLICY_URL),
        },
        {
          label: 'View on GitHub',
          click: () => shell.openExternal(REPOSITORY_URL),
        },
        ...(!isMac
          ? [
              { type: 'separator' as const },
              {
                label: 'About localmost',
                click: () => showAboutDialog(),
              },
            ]
          : []),
      ] as MenuItemConstructorOptions[],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
};
