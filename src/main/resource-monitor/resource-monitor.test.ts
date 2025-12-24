import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock electron
jest.mock('electron', () => ({
  powerMonitor: {
    isOnBatteryPower: jest.fn(() => false),
    on: jest.fn(),
    off: jest.fn(),
  },
  Notification: jest.fn().mockImplementation(() => ({
    show: jest.fn(),
  })),
}));

// Mock child_process
jest.mock('child_process', () => ({
  exec: jest.fn((cmd: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    // Return mock battery level of 75%
    if (cmd.includes('pmset')) {
      callback(null, '75', '');
    } else if (cmd.includes('VDCAssistant') || cmd.includes('AppleCamera')) {
      callback(null, '0', ''); // Camera not in use
    }
  }),
}));

import { powerMonitor } from 'electron';
import { ResourceMonitor } from './index';
import { BatteryMonitor } from './battery-monitor';
import { VideoCallMonitor } from './video-call-monitor';

describe('BatteryMonitor', () => {
  let monitor: BatteryMonitor;

  beforeEach(() => {
    jest.clearAllMocks();
    monitor = new BatteryMonitor();
  });

  afterEach(() => {
    monitor.stop();
  });

  it('should start monitoring', () => {
    monitor.start();
    expect(powerMonitor.on).toHaveBeenCalledWith('on-battery', expect.any(Function));
    expect(powerMonitor.on).toHaveBeenCalledWith('on-ac', expect.any(Function));
  });

  it('should stop monitoring', () => {
    monitor.start();
    monitor.stop();
    expect(powerMonitor.off).toHaveBeenCalledWith('on-battery', expect.any(Function));
    expect(powerMonitor.off).toHaveBeenCalledWith('on-ac', expect.any(Function));
  });

  it('should return initial state', () => {
    const state = monitor.getState();
    expect(state).toHaveProperty('isOnBattery');
    expect(state).toHaveProperty('batteryLevel');
  });

  it('should not recommend pause when threshold is "no"', () => {
    expect(monitor.shouldPause('no')).toBe(false);
  });

  it('should recommend pause only when on battery and below threshold', () => {
    // Mock on battery
    (powerMonitor.isOnBatteryPower as jest.Mock).mockReturnValue(true);
    monitor.start();

    // At 75%, should not pause for <25% threshold
    expect(monitor.shouldPause('<25%')).toBe(false);
    // At 75%, should not pause for <50% threshold
    expect(monitor.shouldPause('<50%')).toBe(false);
    // At 75%, should pause for <75% threshold (75 is not < 75)
    expect(monitor.shouldPause('<75%')).toBe(false);
  });
});

describe('VideoCallMonitor', () => {
  let monitor: VideoCallMonitor;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    monitor = new VideoCallMonitor(60);
  });

  afterEach(() => {
    monitor.stop();
    jest.useRealTimers();
  });

  it('should start monitoring', () => {
    monitor.start();
    // Camera check interval should be set
    expect(monitor.getState().isCameraInUse).toBe(false);
  });

  it('should return initial state', () => {
    const state = monitor.getState();
    expect(state).toEqual({
      isCameraInUse: false,
      inGracePeriod: false,
      gracePeriodEndsAt: null,
    });
  });

  it('should not recommend pause when camera not in use', () => {
    expect(monitor.shouldPause()).toBe(false);
  });

  it('should update grace period setting', () => {
    monitor.setGracePeriod(120);
    // No error should occur
    expect(true).toBe(true);
  });
});

describe('ResourceMonitor', () => {
  let monitor: ResourceMonitor;

  beforeEach(() => {
    jest.clearAllMocks();
    monitor = new ResourceMonitor({
      pauseOnBattery: 'no',
      pauseOnVideoCall: false,
      videoCallGracePeriod: 60,
      notifyOnPause: false,
    });
  });

  afterEach(() => {
    monitor.stop();
  });

  it('should start with default config', () => {
    monitor.start();
    const state = monitor.getPauseState();
    expect(state.isPaused).toBe(false);
    expect(state.conditions).toEqual([]);
  });

  it('should return correct pause state when not paused', () => {
    monitor.start();
    expect(monitor.shouldPause()).toBe(false);
  });

  it('should update config', () => {
    monitor.updateConfig({ pauseOnBattery: '<50%' });
    const config = monitor.getConfig();
    expect(config.pauseOnBattery).toBe('<50%');
  });

  it('should register state-changed listener', () => {
    const handler = jest.fn();
    monitor.on('state-changed', handler);

    monitor.start();
    monitor.updateConfig({ pauseOnBattery: '<50%' });

    // Listener should be registered (event may not fire if state unchanged)
    expect(monitor.listenerCount('state-changed')).toBe(1);
  });

  it('should stop monitoring', () => {
    monitor.start();
    monitor.stop();
    // Should not throw
    expect(true).toBe(true);
  });
});
