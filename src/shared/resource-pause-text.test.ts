import { describe, it, expect } from '@jest/globals';
import {
  resourceConditionsOverridden,
  resourcePauseOverriddenLine,
  resourcePauseOverriddenText,
} from './resource-pause-text';

describe('resourceConditionsOverridden', () => {
  it('names the conditions by kind, not by their reason of the moment', () => {
    // Built from the reasons, the line read "until Battery at 75% clears",
    // the percentage moving under it, and "until Video call ended recently
    // clears" through the call's grace period.
    expect(resourceConditionsOverridden(['battery'])).toBe('battery power');
    expect(resourceConditionsOverridden(['video-call'])).toBe('the video call');
    expect(resourceConditionsOverridden(['battery', 'video-call'])).toBe('battery power and the video call');
    expect(resourceConditionsOverridden([])).toBeNull();
  });
});

describe('resourcePauseOverriddenText', () => {
  it('names the condition the resume overrode', () => {
    expect(resourcePauseOverriddenText('battery power')).toBe(
      'Resumed (resource pause overridden until battery power clears)'
    );
  });

  it('says "clear" for two', () => {
    expect(resourcePauseOverriddenText('battery power and the video call')).toBe(
      'Resumed (resource pause overridden until battery power and the video call clear)'
    );
  });
});

describe('resourcePauseOverriddenLine', () => {
  it('is shown while an overridden condition holds', () => {
    expect(resourcePauseOverriddenLine({
      isPaused: false,
      reason: null,
      conditions: [],
      overridden: 'the video call',
    })).toBe('Resumed (resource pause overridden until the video call clears)');
  });

  it('gives way to a pause, and is absent with no override', () => {
    // A new condition pauses the runner while another stays overridden; the
    // pause is what matters then.
    expect(resourcePauseOverriddenLine({
      isPaused: true,
      reason: 'Video call detected',
      conditions: [],
      overridden: 'battery power',
    })).toBeNull();
    expect(resourcePauseOverriddenLine({ isPaused: false, reason: null, conditions: [], overridden: null })).toBeNull();
    expect(resourcePauseOverriddenLine({ isPaused: false, reason: null, conditions: [] })).toBeNull();
    expect(resourcePauseOverriddenLine(undefined)).toBeNull();
  });
});
