import { describe, it, expect, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const send = jest.fn();

jest.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
}));
// The sender check has tests of its own (trusted-ipc.test.ts); here the
// handlers are called directly, so they are registered on electron's ipcMain.
jest.mock('./trusted-ipc', () => ({ ipcMain: jest.requireMock<{ ipcMain: unknown }>('electron').ipcMain }));
jest.mock('../app-state', () => ({
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }),
}));

import { registerMacVmHandlers, type MacVmSetupManager } from './macos-vm';
import { MACOS_VM_CHANNELS, type MacVmSetupStatus } from '../../shared/macos-vm-setup';
import type { MacVmImageManager } from '../isolation/macos-vm/golden-image';

/** Checked by the compiler: the mode's manager is what the handlers take. */
const asSetupManager = (m: MacVmImageManager): MacVmSetupManager => m;

describe('the macOS VM setup IPC', () => {
  const status: MacVmSetupStatus = { state: 'not-built', disk: { freeBytes: 1, neededBytes: 2 }, provisioning: 'guided', busy: false };
  let images: EventEmitter & { status: jest.Mock; build: jest.Mock; cancel: jest.Mock; openGuidedSetup: jest.Mock; remove: jest.Mock };

  beforeEach(() => {
    handlers.clear();
    send.mockClear();
    images = Object.assign(new EventEmitter(), {
      status: jest.fn(() => status),
      build: jest.fn(),
      cancel: jest.fn(),
      openGuidedSetup: jest.fn(() => {
        throw new Error('the build is not waiting for the guided setup');
      }),
      remove: jest.fn(),
    });
    registerMacVmHandlers(images);
  });

  it('answers each channel from the manager, taking nothing from the renderer', async () => {
    expect(await handlers.get(MACOS_VM_CHANNELS.GET_STATUS)!({}, '/etc/passwd')).toBe(status);
    expect(await handlers.get(MACOS_VM_CHANNELS.BUILD)!({}, { imageId: '../x' })).toEqual({ success: true, data: undefined });
    expect(images.build).toHaveBeenCalledWith();
    expect(await handlers.get(MACOS_VM_CHANNELS.CANCEL)!({})).toEqual({ success: true, data: undefined });
    expect(await handlers.get(MACOS_VM_CHANNELS.REMOVE)!({})).toEqual({ success: true, data: undefined });
  });

  it('turns a refusal into a failed result, not a thrown IPC error', async () => {
    expect(await handlers.get(MACOS_VM_CHANNELS.OPEN_GUIDED_SETUP)!({})).toEqual({
      success: false,
      error: 'the build is not waiting for the guided setup',
    });
  });

  it("takes the mode's own image manager", () => {
    expect(typeof asSetupManager).toBe('function');
  });

  it('sends the window each new status', () => {
    images.emit('status', { ...status, state: 'building' });
    expect(send).toHaveBeenCalledWith(MACOS_VM_CHANNELS.STATUS_CHANGED, expect.objectContaining({ state: 'building' }));
  });
});
