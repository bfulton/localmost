/**
 * The Docker filter, the evaluator and the image puller load without
 * Electron. The e2e docker spec imports the filter inside a localmost job,
 * where Electron's binary is not installed, and `localmost test` may one day
 * import the puller from the CLI. Nothing here may need `electron` until a
 * function that really is about the running app (resources path, packaged
 * or not) is called.
 */

import { describe, it, expect, jest } from '@jest/globals';

const MODULES = [
  '../docker/docker-filter-proxy',
  '../docker/docker-evaluator',
  './paths',
  '../docker/puller/registry-client',
  '../docker/puller/image-puller',
];

describe('loading the Docker modules without Electron', () => {
  it.each(MODULES)('%s loads when requiring electron throws', (name) => {
    jest.isolateModules(() => {
      jest.doMock('electron', () => {
        throw new Error('electron must not be required at module load');
      });
      expect(() => require(name)).not.toThrow();
    });
  });

  it('still reads the app only when a path that depends on it is asked for', () => {
    jest.isolateModules(() => {
      const getAppPath = jest.fn(() => '/checkout');
      jest.doMock('electron', () => ({ app: { isPackaged: false, getAppPath } }));
      const { getVmResourcesDir } = require('./paths') as typeof import('./paths');
      expect(getAppPath).not.toHaveBeenCalled();
      expect(getVmResourcesDir()).toBe('/checkout/build');
      expect(getAppPath).toHaveBeenCalledTimes(1);
    });
  });
});
