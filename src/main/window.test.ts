/**
 * The main window's navigation and external-link handling, driven through
 * the handlers createWindow installs.
 */

import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

const ENTRY = 'file:///Applications/localmost.app/Contents/Resources/app.asar/.webpack/renderer/main_window/index.html';
(globalThis as Record<string, unknown>).MAIN_WINDOW_WEBPACK_ENTRY = ENTRY;
(globalThis as Record<string, unknown>).MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY = '/preload.js';

type WillNavigate = (event: { preventDefault: () => void }, url: string) => void;
type WindowOpen = (details: { url: string }) => { action: string };

const contentsHandlers: Record<string, WillNavigate> = {};
let windowOpenHandler: WindowOpen | null = null;
const mockOpenExternal = jest.fn<(url: string) => Promise<void>>();

jest.mock('electron', () => ({
  app: { dock: undefined, quit: jest.fn() },
  dialog: { showMessageBox: jest.fn() },
  nativeImage: { createFromPath: jest.fn() },
  shell: { openExternal: (url: string) => mockOpenExternal(url) },
  BrowserWindow: jest.fn().mockImplementation(() => ({
    loadURL: jest.fn(),
    on: jest.fn(),
    webContents: {
      on: (name: string, handler: WillNavigate) => {
        contentsHandlers[name] = handler;
      },
      once: jest.fn(),
      setWindowOpenHandler: (handler: WindowOpen) => {
        windowOpenHandler = handler;
      },
      session: { webRequest: { onHeadersReceived: jest.fn() } },
    },
  })),
}));
jest.mock('./app-state', () => ({
  setMainWindow: jest.fn(),
  getRunnerManager: () => null,
  getIsQuitting: () => false,
  getLogger: () => null,
}));
jest.mock('./log-file', () => ({ findAsset: () => null }));

import { createWindow } from './window';

describe('main window navigation', () => {
  beforeAll(() => {
    createWindow({ show: false });
  });

  beforeEach(() => {
    mockOpenExternal.mockClear();
    mockOpenExternal.mockResolvedValue(undefined);
  });

  const navigate = (url: string): boolean => {
    let prevented = false;
    contentsHandlers['will-navigate']({ preventDefault: () => { prevented = true; } }, url);
    return prevented;
  };

  it('stays on the app page, and refuses any other page on disk', () => {
    expect(navigate(ENTRY)).toBe(false);
    expect(navigate(`${ENTRY}#settings`)).toBe(false);
    for (const url of ['file:///etc/passwd', 'file:///tmp/evil.html', 'data:text/html,<p>x', 'about:blank', `${ENTRY}.html`]) {
      expect({ url, prevented: navigate(url) }).toEqual({ url, prevented: true });
    }
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('sends a GitHub link to the browser, and nothing else', () => {
    expect(navigate('https://github.com/bfulton/localmost/actions/runs/1')).toBe(true);
    expect(mockOpenExternal).toHaveBeenCalledWith('https://github.com/bfulton/localmost/actions/runs/1');
    mockOpenExternal.mockClear();

    for (const url of ['https://evil.example/', 'http://github.com/x', 'https://github.com.evil.example/', 'https://user@github.com/']) {
      expect({ url, prevented: navigate(url) }).toEqual({ url, prevented: true });
    }
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('opens only GitHub links from window.open, and never a new window', () => {
    expect(windowOpenHandler!({ url: 'https://github.com/login/device' })).toEqual({ action: 'deny' });
    expect(mockOpenExternal).toHaveBeenCalledWith('https://github.com/login/device');
    mockOpenExternal.mockClear();

    for (const url of ['https://evil.example/', 'http://example.com/', 'file:///etc/passwd']) {
      expect(windowOpenHandler!({ url })).toEqual({ action: 'deny' });
    }
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });
});
