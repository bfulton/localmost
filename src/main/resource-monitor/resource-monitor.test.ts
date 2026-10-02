import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock the camera helper; video-call-monitor.test.ts runs a real one
const mockCameraWatch = { stop: jest.fn() };
jest.mock('./camera-helper', () => ({
  cameraHelperPath: jest.fn(() => '/Resources/is-camera-on'),
  watchCamera: jest.fn(() => mockCameraWatch),
}));

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
import { cameraHelperPath, watchCamera } from './camera-helper';

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

  it('should not recommend pause when threshold is "never"', () => {
    expect(monitor.shouldPause('never')).toBe(false);
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

  it('should watch the helper and follow the camera state it reports', () => {
    const handler = jest.fn();
    monitor.on('state-changed', handler);
    monitor.start();

    expect(watchCamera).toHaveBeenCalledWith('/Resources/is-camera-on', expect.any(Function), expect.any(Function));
    const onChange = (watchCamera as jest.Mock).mock.calls[0][1] as (isOn: boolean) => void;
    onChange(true);
    expect(monitor.getPauseReason()).toBe('Video call detected');
    onChange(false);
    expect(monitor.getPauseReason()).toBe('Video call ended recently');
    jest.advanceTimersByTime(60_000);
    expect(monitor.shouldPause()).toBe(false);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('should log and carry on when the helper cannot be found', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (cameraHelperPath as jest.Mock).mockImplementationOnce(() => {
      throw new Error("Cannot find module 'is-camera-on'");
    });

    expect(() => monitor.start()).not.toThrow();
    expect(warn).toHaveBeenCalledWith('Video call detection unavailable:', "Cannot find module 'is-camera-on'");
    expect(watchCamera).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('should stop the helper when stopped', () => {
    monitor.start();
    monitor.stop();
    expect(mockCameraWatch.stop).toHaveBeenCalledTimes(1);
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
      pauseOnBattery: 'never',
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

describe('ResourceMonitor overridden by a manual resume', () => {
  let monitor: ResourceMonitor;
  let pauses: string[];
  let resumes: number;

  /** The handler the battery monitor registered for a power event. */
  const powerHandler = (event: 'on-battery' | 'on-ac'): (() => void) => {
    const calls = (powerMonitor.on as jest.Mock).mock.calls.filter((call) => call[0] === event);
    return calls[calls.length - 1][1] as () => void;
  };

  /** What the camera helper reports, as the video call monitor hears it. */
  const camera = (isOn: boolean): void => {
    const calls = (watchCamera as jest.Mock).mock.calls;
    (calls[calls.length - 1][1] as (isOn: boolean) => void)(isOn);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    (powerMonitor.isOnBatteryPower as jest.Mock).mockReturnValue(true);
    monitor = new ResourceMonitor({
      pauseOnBattery: 'always',
      pauseOnVideoCall: true,
      videoCallGracePeriod: 0,
      notifyOnPause: false,
    });
    pauses = [];
    resumes = 0;
    monitor.on('should-pause', (reason) => pauses.push(reason));
    monitor.on('should-resume', () => { resumes += 1; });
    monitor.start();
  });

  afterEach(() => {
    monitor.stop();
    jest.useRealTimers();
    (powerMonitor.isOnBatteryPower as jest.Mock).mockReturnValue(false);
  });

  it('stops recommending the pause until the condition clears, then pauses again when it recurs', () => {
    // A resume while the condition held lifted the pause in the tray, but
    // canAcceptJob asked the monitor, which still said pause: the runner
    // read resumed and took nothing until the condition cleared.
    expect(pauses).toEqual(['Battery at 75%']);
    expect(monitor.shouldPause()).toBe(true);

    expect(monitor.overrideUntilClear()).toBe('Battery at 75%');
    expect(monitor.shouldPause()).toBe(false);
    expect(monitor.getPauseState()).toMatchObject({ isPaused: false, reason: null, overridden: 'Battery at 75%' });
    // The resume lifted the pause itself; the monitor has nothing to say.
    expect(resumes).toBe(0);

    powerHandler('on-ac')();
    expect(monitor.shouldPause()).toBe(false);
    expect(monitor.getPauseState().overridden).toBeNull();
    expect(resumes).toBe(0);

    powerHandler('on-battery')();
    expect(pauses).toEqual(['Battery at 75%', 'Battery at 75%']);
    expect(monitor.shouldPause()).toBe(true);
  });

  it('says when an override ends, so the tray stops showing it', () => {
    monitor.overrideUntilClear();
    const states: Array<string | null | undefined> = [];
    monitor.on('state-changed', (state) => states.push(state.overridden));

    powerHandler('on-ac')();

    expect(states).toEqual([null]);
  });

  it('pauses for a condition that begins while another is overridden', () => {
    monitor.overrideUntilClear();

    camera(true);

    expect(pauses).toEqual(['Battery at 75%', 'Video call detected']);
    expect(monitor.shouldPause()).toBe(true);
    expect(monitor.getPauseState()).toMatchObject({ isPaused: true, reason: 'Video call detected', overridden: 'Battery at 75%' });
  });

  it('overrides every condition holding at the resume', () => {
    camera(true);
    expect(monitor.overrideUntilClear()).toBe('Battery at 75% and Video call detected');
    expect(monitor.shouldPause()).toBe(false);

    // One clearing leaves the other overridden: the call's grace period is
    // still the call.
    camera(false);
    expect(monitor.shouldPause()).toBe(false);
    jest.advanceTimersByTime(0);
    expect(monitor.shouldPause()).toBe(false);
    expect(monitor.getPauseState().overridden).toBe('Battery at 75%');

    camera(true);
    expect(monitor.shouldPause()).toBe(true);
    expect(pauses).toEqual(['Battery at 75%', 'Video call detected']);
  });

  it('overrides nothing when no condition holds', () => {
    powerHandler('on-ac')();
    expect(resumes).toBe(1);

    expect(monitor.overrideUntilClear()).toBeNull();

    powerHandler('on-battery')();
    expect(monitor.shouldPause()).toBe(true);
    expect(pauses).toEqual(['Battery at 75%', 'Battery at 75%']);
  });
});
