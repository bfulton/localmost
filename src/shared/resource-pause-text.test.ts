import { describe, it, expect } from '@jest/globals';
import { resourcePauseOverriddenLine, resourcePauseOverriddenText } from './resource-pause-text';

describe('resourcePauseOverriddenText', () => {
  it('names the condition the resume overrode', () => {
    expect(resourcePauseOverriddenText('Battery at 20%')).toBe(
      'Resumed (resource pause overridden until Battery at 20% clears)'
    );
  });
});

describe('resourcePauseOverriddenLine', () => {
  it('is shown while an overridden condition holds', () => {
    expect(resourcePauseOverriddenLine({
      isPaused: false,
      reason: null,
      conditions: [],
      overridden: 'Video call detected',
    })).toBe('Resumed (resource pause overridden until Video call detected clears)');
  });

  it('gives way to a pause, and is absent with no override', () => {
    // A new condition pauses the runner while another stays overridden; the
    // pause is what matters then.
    expect(resourcePauseOverriddenLine({
      isPaused: true,
      reason: 'Video call detected',
      conditions: [],
      overridden: 'Battery at 20%',
    })).toBeNull();
    expect(resourcePauseOverriddenLine({ isPaused: false, reason: null, conditions: [], overridden: null })).toBeNull();
    expect(resourcePauseOverriddenLine({ isPaused: false, reason: null, conditions: [] })).toBeNull();
    expect(resourcePauseOverriddenLine(undefined)).toBeNull();
  });
});
