import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockHandle = jest.fn<(channel: string, handler: (...args: any[]) => any) => void>();
jest.mock('electron', () => ({ ipcMain: { handle: mockHandle } }));
// The sender check has tests of its own (trusted-ipc.test.ts); here the
// handlers are called directly, so they are registered on electron's ipcMain.
jest.mock('./trusted-ipc', () => ({ ipcMain: jest.requireMock<{ ipcMain: unknown }>('electron').ipcMain }));

const mockAddTargetAndAttach = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockUpdateTarget = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('../target-manager', () => ({
  getTargetManager: () => ({ addTargetAndAttach: mockAddTargetAndAttach, updateTarget: mockUpdateTarget }),
}));
jest.mock('../app-state', () => ({
  getLogger: () => null,
  getBrokerProxyService: () => null,
}));
jest.mock('../store/init', () => ({ store: { getState: () => ({}) } }));

import { registerTargetHandlers } from './targets';
import { IPC_CHANNELS } from '../../shared/types';

describe('targets IPC handlers', () => {
  let handlers: Record<string, (...args: any[]) => any>;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers = {};
    mockHandle.mockImplementation((channel, handler) => {
      handlers[channel] = handler;
    });
    mockAddTargetAndAttach.mockResolvedValue({ success: true, data: { id: 't1' } });
    mockUpdateTarget.mockResolvedValue({ success: true, data: { id: 't1' } });
    registerTargetHandlers();
  });

  it('adds a target only when its names are GitHub names, refusing anything else before it is fetched', async () => {
    for (const args of [
      ['repo', '../x', 'supdb'],
      ['repo', 'bfulton', '..'],
      ['repo', 'bfulton', 'a/b'],
      ['repo', 'bfulton', undefined],
      ['org', 'x/../user', undefined],
      ['org', { toString: () => 'x' }, undefined],
      ['enterprise', 'bfulton', undefined],
    ]) {
      const result = await handlers[IPC_CHANNELS.TARGETS_ADD]({}, ...args);
      expect({ args, success: result.success }).toEqual({ args, success: false });
    }
    expect(mockAddTargetAndAttach).not.toHaveBeenCalled();

    const result = await handlers[IPC_CHANNELS.TARGETS_ADD]({}, 'repo', 'bfulton', 'my.repo');
    expect(result).toEqual({ success: true, data: { id: 't1' } });
    expect(mockAddTargetAndAttach).toHaveBeenCalledWith('repo', 'bfulton', 'my.repo');
  });

  it('lets an update change whether a target is enabled, and nothing else about it', async () => {
    // The stored target's url is what config.sh registers against with a
    // fresh registration token, and its owner and repo name API paths; none
    // of them is the renderer's to rewrite.
    const result = await handlers[IPC_CHANNELS.TARGETS_UPDATE]({}, 't1', {
      enabled: true,
      url: 'https://evil.example/o/r',
      owner: '../x',
      id: '../..',
    });
    expect(result.success).toBe(false);
    for (const args of [
      ['t1', { enabled: 'yes' }],
      ['t1', {}],
      ['t1', null],
      [{ id: 't1' }, { enabled: true }],
    ]) {
      const refused = await handlers[IPC_CHANNELS.TARGETS_UPDATE]({}, ...args);
      expect({ args, success: refused.success }).toEqual({ args, success: false });
    }
    expect(mockUpdateTarget).not.toHaveBeenCalled();

    expect(await handlers[IPC_CHANNELS.TARGETS_UPDATE]({}, 't1', { enabled: false })).toEqual({ success: true, data: { id: 't1' } });
    expect(mockUpdateTarget).toHaveBeenCalledWith('t1', { enabled: false });
  });
});
