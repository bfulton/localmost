// Mock Electron modules for unit testing
export const shell = {
  openExternal: jest.fn().mockResolvedValue(undefined),
};

export const app = {
  getPath: jest.fn().mockReturnValue('/tmp/test'),
  getAppPath: jest.fn().mockReturnValue('/tmp/test'),
  whenReady: jest.fn().mockResolvedValue(undefined),
  quit: jest.fn(),
  dock: {
    setIcon: jest.fn(),
  },
};

export const BrowserWindow = jest.fn().mockImplementation(() => ({
  loadURL: jest.fn(),
  on: jest.fn(),
  webContents: {
    send: jest.fn(),
    on: jest.fn(),
  },
  show: jest.fn(),
  hide: jest.fn(),
  isDestroyed: jest.fn().mockReturnValue(false),
}));

export const ipcMain = {
  handle: jest.fn(),
  on: jest.fn(),
};

export const ipcRenderer = {
  invoke: jest.fn(),
  on: jest.fn(),
  send: jest.fn(),
};

export const nativeImage = {
  createFromPath: jest.fn().mockReturnValue({}),
  createFromBuffer: jest.fn().mockReturnValue({}),
};

export const Tray = jest.fn().mockImplementation(() => ({
  setContextMenu: jest.fn(),
  setToolTip: jest.fn(),
  on: jest.fn(),
}));

export const Menu = {
  buildFromTemplate: jest.fn().mockReturnValue({}),
  setApplicationMenu: jest.fn(),
};

export const powerSaveBlocker = {
  start: jest.fn().mockReturnValue(1),
  stop: jest.fn(),
  isStarted: jest.fn().mockReturnValue(true),
};

export default {
  shell,
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  nativeImage,
  Tray,
  Menu,
  powerSaveBlocker,
};
