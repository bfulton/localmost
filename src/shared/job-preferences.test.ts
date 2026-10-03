import { describe, it, expect, jest } from '@jest/globals';
import {
  DEFAULT_JOB_ENVIRONMENT_CONFIG,
  DEFAULT_RESOURCE_PAUSE_CONFIG,
  resolveJobEnvironmentConfig,
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
      // Off: the one grant here that reaches what the user's own builds use.
      swiftBuildLinkTemp: false,
    });
  });
});

describe('resolveJobEnvironmentConfig', () => {
  it('takes the Swift Build link-temp grant as off unless the file says true', () => {
    expect(resolveJobEnvironmentConfig(undefined).swiftBuildLinkTemp).toBe(false);
    expect(resolveJobEnvironmentConfig({ swiftBuildLinkTemp: true }).swiftBuildLinkTemp).toBe(true);
    const log = jest.fn();
    expect(resolveJobEnvironmentConfig({ swiftBuildLinkTemp: 'yes' }, log).swiftBuildLinkTemp).toBe(false);
    expect(log).toHaveBeenCalledWith('jobEnvironment.swiftBuildLinkTemp must be true or false; using false');
  });
});
