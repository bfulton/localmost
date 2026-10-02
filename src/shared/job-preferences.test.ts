import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_JOB_ENVIRONMENT_CONFIG,
  DEFAULT_RESOURCE_PAUSE_CONFIG,
} from './job-preferences';

describe('the resource-pause and job-environment defaults', () => {
  it('cannot be changed by anything that holds them', () => {
    // The same objects are shared by reference into the store's defaults and
    // the renderer's fallbacks, and every resolver starts from them, so a
    // stray write through any of those would quietly change what the runner
    // does by default.
    expect(() => {
      (DEFAULT_RESOURCE_PAUSE_CONFIG as { runningJobs: string }).runningJobs = 'stop';
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_JOB_ENVIRONMENT_CONFIG as { toolShims: boolean }).toolShims = false;
    }).toThrow(TypeError);
    expect(DEFAULT_RESOURCE_PAUSE_CONFIG).toEqual({ runningJobs: 'finish' });
    expect(DEFAULT_JOB_ENVIRONMENT_CONFIG).toEqual({
      toolShims: true,
      javaToolOptions: true,
      perJobTempDir: true,
      createMissingGrantedDirs: true,
    });
  });
});
