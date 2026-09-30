/**
 * Tests for the LegacyDockerBackend seam and its stage 1 implementation.
 *
 * The backend is what the filtering socket forwards approved requests to. At
 * stage 1 that is the operator's own daemon, which is why privileged can never
 * be granted here: nothing contains a container that escapes it.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { DesktopBackend, DockerProgress, WorkerContext } from './docker-backend';
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

describe('the root that declared mount paths resolve against', () => {
  const backend = new DesktopBackend({ resolve: () => null });

  it('is the repository checkout, which is what "./" means in a workflow', () => {
    // The runner checks out into _work/<repo>/<repo> (GITHUB_WORKSPACE). Rooting
    // at _work instead made every declared path narrower than "./" unmatchable:
    // "./tmp/fixtures" resolved to _work/tmp/fixtures, which never exists.
    expect(backend.workspaceMountRoot('/s/1', 'bfulton/localmost')).toBe('/s/1/_work/localmost/localmost');
  });

  it('falls back to the work folder when no repository is bound yet', () => {
    expect(backend.workspaceMountRoot('/s/1')).toBe('/s/1/_work');
  });
});

describe("DesktopBackend's worker, the stage 2 interface over the operator's daemon", () => {
  const ctx = {} as WorkerContext;
  let dir: string;
  let server: http.Server | null = null;
  const seen: Array<{ url: string; auth: string | undefined }> = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-'));
    seen.length = 0;
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const daemon = (answer: (res: http.ServerResponse) => void): Promise<string> =>
    new Promise((resolve) => {
      const sock = path.join(dir, 'd.sock');
      server = http.createServer((req, res) => {
        seen.push({ url: req.url!, auth: req.headers['x-registry-auth'] as string | undefined });
        req.resume();
        answer(res);
      });
      server.listen(sock, () => resolve(sock));
    });

  it('is shared by every worker, so its sockets remove what their jobs made', () => {
    expect(new DesktopBackend().disposable).toBe(false);
  });

  it("answers with the operator's daemon, found afresh each time, and no VM of its own", async () => {
    let endpoint: string | null = null;
    const worker = new DesktopBackend({ resolve: () => (endpoint ? { socketPath: endpoint } : null) }).forWorker(ctx);
    expect(worker.running()).toBe(false);
    expect(await worker.endpoint(1000)).toEqual({ kind: 'none', reason: 'no Docker daemon is available to this job' });
    expect(worker.baseline('/_ping')).toMatchObject({ status: 503 });
    endpoint = '/var/run/docker.sock';
    expect(worker.running()).toBe(true);
    expect(await worker.endpoint(1000)).toEqual({ kind: 'ready', socketPath: '/var/run/docker.sock' });
    expect(worker.containerProxyEnv()).toEqual({});
    await expect(worker.approveBinds('f'.repeat(64), [])).resolves.toBeUndefined();
    await expect(worker.release()).resolves.toBeUndefined();
  });

  it("pulls through the daemon with the operator's credential for that registry alone, handing on its progress", async () => {
    const sock = await daemon((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(JSON.stringify({ status: 'Pulling from library/postgres', id: '16' }) + '\n');
      res.end(JSON.stringify({ status: 'Done' }) + '\n');
    });
    const worker = new DesktopBackend({
      resolve: () => ({ socketPath: sock }),
      registryAuth: (registry) => (registry === 'docker.io' ? 'dG9rZW4=' : undefined),
    }).forWorker(ctx);
    const progress: DockerProgress[] = [];
    await worker.pull({ registry: 'docker.io', repositoryPath: 'library/postgres', tag: '16' }, (p) => progress.push(p), new AbortController().signal);
    await worker.pull({ registry: 'ghcr.io', repositoryPath: 'o/app', digest: `sha256:${'a'.repeat(64)}`, platform: 'linux/arm64' }, () => {}, new AbortController().signal);
    expect(progress).toEqual([{ status: 'Pulling from library/postgres', id: '16' }, { status: 'Done' }]);
    expect(seen).toEqual([
      { url: '/images/create?fromImage=docker.io%2Flibrary%2Fpostgres&tag=16', auth: 'dG9rZW4=' },
      { url: `/images/create?fromImage=ghcr.io%2Fo%2Fapp&tag=sha256%3A${'a'.repeat(64)}&platform=linux%2Farm64`, auth: undefined },
    ]);
  });

  it("rejects a pull the daemon refuses, with the daemon's message", async () => {
    const sock = await daemon((res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'pull access denied for nope' }));
    });
    const worker = new DesktopBackend({ resolve: () => ({ socketPath: sock }) }).forWorker(ctx);
    await expect(worker.pull({ registry: 'docker.io', repositoryPath: 'library/nope', tag: 'latest' }, () => {}, new AbortController().signal))
      .rejects.toThrow('pull access denied for nope');
  });
});
