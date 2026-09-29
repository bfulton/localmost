import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const ENTRY = 'file:///Applications/localmost.app/Contents/Resources/app.asar/.webpack/renderer/main_window/index.html';
(globalThis as Record<string, unknown>).MAIN_WINDOW_WEBPACK_ENTRY = ENTRY;

type Listener = (event: unknown, ...args: unknown[]) => unknown;
const invokeListeners: Record<string, Listener> = {};
const messageListeners: Record<string, Listener> = {};
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: Listener) => {
      invokeListeners[channel] = listener;
    },
    on: (channel: string, listener: Listener) => {
      messageListeners[channel] = listener;
    },
  },
}));

const mainFrame = { frameTreeNodeId: 7, url: `${ENTRY}#status` };
let mainWindow: unknown = null;
jest.mock('../app-state', () => ({ getMainWindow: () => mainWindow }));

import { ipcMain } from './trusted-ipc';

const windowWith = (destroyed = false) => ({
  isDestroyed: () => destroyed,
  webContents: { id: 3, mainFrame },
});

const fromMainFrame = { sender: { id: 3 }, senderFrame: mainFrame };

describe('trusted ipcMain', () => {
  const handled = jest.fn<(...args: unknown[]) => string>();
  const heard = jest.fn<(...args: unknown[]) => void>();

  beforeEach(() => {
    handled.mockReset().mockReturnValue('answered');
    heard.mockReset();
    mainWindow = windowWith();
    ipcMain.handle('probe:invoke', (_event, a: string, b: number) => handled(a, b));
    ipcMain.on('probe:send', (_event, a: string) => heard(a));
  });

  it('passes a message from the main window\'s top frame to the handler', () => {
    expect(invokeListeners['probe:invoke'](fromMainFrame, 'x', 1)).toBe('answered');
    expect(handled).toHaveBeenCalledWith('x', 1);
    messageListeners['probe:send'](fromMainFrame, 'y');
    expect(heard).toHaveBeenCalledWith('y');
  });

  it('refuses a message from a child frame, another webContents, a page that is not the app, or no window', () => {
    const refused: Array<[string, unknown]> = [
      ['child frame', { sender: { id: 3 }, senderFrame: { frameTreeNodeId: 8, url: ENTRY } }],
      ['other webContents', { sender: { id: 4 }, senderFrame: mainFrame }],
      ['frame gone', { sender: { id: 3 }, senderFrame: null }],
      ['other page', { sender: { id: 3 }, senderFrame: { frameTreeNodeId: 7, url: 'file:///tmp/evil.html' } }],
    ];
    for (const [label, event] of refused) {
      expect(() => invokeListeners['probe:invoke'](event, 'x', 1)).toThrow(/refused/);
      messageListeners['probe:send'](event, 'y');
      expect({ label, handled: handled.mock.calls.length, heard: heard.mock.calls.length })
        .toEqual({ label, handled: 0, heard: 0 });
    }

    mainWindow = null;
    expect(() => invokeListeners['probe:invoke'](fromMainFrame, 'x', 1)).toThrow(/refused/);
    mainWindow = windowWith(true);
    expect(() => invokeListeners['probe:invoke'](fromMainFrame, 'x', 1)).toThrow(/refused/);
    expect(handled).not.toHaveBeenCalled();
  });
});

describe('handler modules', () => {
  it('all register through the trusted ipcMain, never electron\'s directly', () => {
    const modules = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'trusted-ipc.ts');
    expect(modules.length).toBeGreaterThan(5);
    for (const file of modules) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      const importsElectronIpc = /import\s*\{[^}]*\bipcMain\b[^}]*\}\s*from\s*'electron'/.test(source);
      expect({ file, importsElectronIpc }).toEqual({ file, importsElectronIpc: false });
    }
  });
});
