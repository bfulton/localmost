/**
 * Tests for the DockerBackend seam and its stage 1 implementation.
 *
 * The backend is what the filtering socket forwards approved requests to. At
 * stage 1 that is the operator's own daemon, which is why privileged can never
 * be granted here: nothing contains a container that escapes it.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { DesktopBackend } from './docker-backend';
import { resolveDockerEndpoint } from '../../shared/docker-access';

jest.mock('../../shared/docker-access', () => ({
  resolveDockerEndpoint: jest.fn(),
}));

const mockResolveDockerEndpoint = resolveDockerEndpoint as jest.MockedFunction<
  typeof resolveDockerEndpoint
>;

describe('DesktopBackend', () => {
  beforeEach(() => {
    mockResolveDockerEndpoint.mockReset();
  });

  it('resolves the operator daemon endpoint and never permits privileged', () => {
    const backend = new DesktopBackend({
      resolve: () => ({ socketPath: '/var/run/docker.sock' }),
    });
    expect(backend.name).toBe('docker-desktop');
    expect(backend.supportsPrivileged).toBe(false);
    expect(backend.resolveEndpoint()).toEqual({ socketPath: '/var/run/docker.sock' });
  });

  it('finds the daemon the same way the app does today when no resolver is injected', () => {
    mockResolveDockerEndpoint.mockReturnValue({ socketPath: '/Users/me/.docker/run/docker.sock' });
    const backend = new DesktopBackend();
    expect(backend.resolveEndpoint()).toEqual({ socketPath: '/Users/me/.docker/run/docker.sock' });
    expect(mockResolveDockerEndpoint).toHaveBeenCalledTimes(1);
  });

  it('reports no endpoint when no daemon socket is present', () => {
    mockResolveDockerEndpoint.mockReturnValue(null);
    expect(new DesktopBackend().resolveEndpoint()).toBeNull();
  });

  it("roots job mounts at the runner's _work checkout inside the sandbox", () => {
    const backend = new DesktopBackend();
    expect(backend.workspaceMountRoot('/tmp/sandbox/1')).toBe('/tmp/sandbox/1/_work');
  });

  it('lets the workspace subdir be overridden for a differently laid out sandbox', () => {
    const backend = new DesktopBackend({ workspaceSubdir: 'checkout' });
    expect(backend.workspaceMountRoot('/tmp/sandbox/1')).toBe('/tmp/sandbox/1/checkout');
  });
});
