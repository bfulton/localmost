import { describe, it, expect } from '@jest/globals';
import { DEFAULT_RESOURCE_PAUSE_CONFIG } from './job-preferences';

describe('the resource-pause default', () => {
  it('cannot be changed by anything that holds it', () => {
    // The same object is shared by reference into the store's defaults and
    // the renderer's fallbacks, and the resolver starts from it, so a stray
    // write through any of those would quietly change what the runner does
    // by default.
    expect(() => {
      (DEFAULT_RESOURCE_PAUSE_CONFIG as { runningJobs: string }).runningJobs = 'stop';
    }).toThrow(TypeError);
    expect(DEFAULT_RESOURCE_PAUSE_CONFIG).toEqual({ runningJobs: 'finish' });
  });
});
