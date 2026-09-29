import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockHandle = jest.fn<(channel: string, handler: (...args: any[]) => any) => void>();
jest.mock('electron', () => ({ ipcMain: { handle: mockHandle } }));

const mockAddTargetAndAttach = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('../target-manager', () => ({
  getTargetManager: () => ({ addTargetAndAttach: mockAddTargetAndAttach }),
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
});
