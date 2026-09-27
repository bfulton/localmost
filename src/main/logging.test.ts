import { jest, describe, it, expect } from '@jest/globals';

jest.mock('./app-state', () => ({
  getMainWindow: () => null,
  getIsQuitting: () => false,
  setLogger: () => undefined,
  getLogLevelSetting: () => 'info',
  setCurrentRunnerStatus: () => undefined,
  updateSleepProtection: () => undefined,
  getRunnerState: () => ({ status: 'offline' }),
}));
jest.mock('./tray-init', () => ({ updateTrayMenu: () => undefined }));
jest.mock('./runner-state-service', () => ({
  onStateChange: () => () => undefined,
  getEffectivePauseState: () => ({ isPaused: false, reason: null }),
  selectEffectivePauseState: () => ({ isPaused: false, reason: null }),
}));

import { sendStatusUpdate } from './logging';
import { store } from './store';

describe('sendStatusUpdate', () => {
  it('puts the status in the store the renderer reads, not only in the IPC event', () => {
    sendStatusUpdate({ status: 'busy', jobName: 'build', repository: 'o/r' });

    expect(store.getState().runner.runnerState).toMatchObject({
      status: 'busy',
      jobName: 'build',
      repository: 'o/r',
    });
  });
});
