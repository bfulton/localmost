/**
 * The filtering docker socket, end to end over real unix sockets.
 *
 * A fake daemon on a second socket stands in for the backend, so the tests
 * assert what reaches the daemon and what the job sees, not just what the
 * evaluator says.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as zlib from 'zlib';
import { DockerFilterProxy, DockerFilterProxyLogEntry } from './docker-filter-proxy';
import { ApprovedBind, DockerBackend, PullRequest, runnerWorkspaceRoot, WorkerDocker } from './docker-backend';
import type { DockerPolicy } from '../../shared/docker-policy';

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

const request = (
  socketPath: string,
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path: p,
        method,
        // No keep-alive pool: a pooled socket loses its http error listener
        // while a large upload may still be in flight, and a refusal that
        // arrives before the upload completes then surfaces as an uncaught
        // EPIPE in whichever test runs next.
        agent: false,
        headers: {
          ...(payload !== undefined && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });

/** What a fake worker was asked to do, for the tests to read. */
interface WorkerCalls {
  binds: Array<{ repository: string; policy: DockerPolicy }>;
  pulls: PullRequest[];
  approvals: Array<{ containerId: string; binds: ApprovedBind[] }>;
  releases: number;
  /** Each time the filter asked for the daemon: how long it would wait, and whether the VM may boot for it. */
  endpoints: Array<{ timeoutMs: number; boot: boolean }>;
}

/** A backend and the worker it hands the socket, as the filter is built with them. */
interface Fixture {
  backend: DockerBackend;
  worker: WorkerDocker;
  calls: WorkerCalls;
}

/**
 * A fake worker in front of a fake daemon: the endpoint is the daemon's when
 * there is one, and a VM counts as running exactly then, so the baseline is
 * forwarded. Everything else a test overrides.
 */
const backendWith = (
  endpoint: string | null,
  supportsPrivileged = false,
  overrides: Partial<WorkerDocker> & { disposable?: boolean; workspaceMountRoot?: (sandboxDir: string) => string } = {}
): Fixture => {
  const calls: WorkerCalls = { binds: [], pulls: [], approvals: [], releases: 0, endpoints: [] };
  const { disposable = false, workspaceMountRoot, ...workerOverrides } = overrides;
  const worker: WorkerDocker = {
    bind: (repository, policy) => calls.binds.push({ repository, policy }),
    prewarm: () => {},
    dropSpare: () => {},
    endpoint: async (timeoutMs, options) => {
      calls.endpoints.push({ timeoutMs, boot: options?.boot ?? false });
      return endpoint ? { kind: 'ready', socketPath: endpoint } : { kind: 'none', reason: 'no Docker daemon is available to this job' };
    },
    running: () => endpoint !== null,
    baseline: () => ({ status: 503, headers: { 'Content-Type': 'application/json' }, body: { message: 'no Docker daemon is available to this job' } }),
    pull: async (req, onProgress) => {
      calls.pulls.push(req);
      onProgress({ status: 'Pulling from ' + req.repositoryPath, id: req.tag ?? req.digest });
      onProgress({ status: 'Done' });
    },
    imageForDigest: () => undefined,
    approveBinds: async (containerId, binds) => {
      calls.approvals.push({ containerId, binds });
    },
    containerProxyEnv: () => ({}),
    release: async () => {
      calls.releases++;
    },
    ...workerOverrides,
  };
  const backend: DockerBackend = {
    name: 'test',
    supportsPrivileged,
    disposable,
    workspaceMountRoot: workspaceMountRoot ?? ((sandboxDir) => sandboxDir),
    forWorker: () => worker,
  };
  return { backend, worker, calls };
};

const proxies: DockerFilterProxy[] = [];
const dirs: string[] = [];
/** Servers a test stood up; closed in afterEach so a failed assertion cannot leak a handle. */
const servers: Array<http.Server | net.Server> = [];
const closeServer = (server: http.Server | net.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfp-'));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.stop();
  for (const server of servers.splice(0)) await closeServer(server);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const startProxy = async (
  dir: string,
  opts: Partial<Omit<ConstructorParameters<typeof DockerFilterProxy>[0], 'backend' | 'worker'>> & { backend?: Fixture } = {}
): Promise<{ proxy: DockerFilterProxy; sock: string; logs: DockerFilterProxyLogEntry[]; calls: WorkerCalls }> => {
  const logs: DockerFilterProxyLogEntry[] = [];
  const sock = path.join(dir, 'docker.sock');
  const { backend: fixture = backendWith(null), ...rest } = opts;
  const proxy = new DockerFilterProxy({
    backend: fixture.backend,
    worker: fixture.worker,
    onLog: (entry) => logs.push(entry),
    ...rest,
  });
  proxies.push(proxy);
  await proxy.start(sock);
  return { proxy, sock, logs, calls: fixture.calls };
};

describe('DockerFilterProxy', () => {
  it('refuses container create until a policy is bound', async () => {
    const dir = tmp();
    const { sock, logs } = await startProxy(dir);

    const denied = await request(sock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16' });

    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.status).toBe(403);
    expect(denied.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(denied.body).message).toMatch(/no docker policy is bound/i);
    expect(logs.some((l) => l.level === 'info' && /denied POST \/containers\/create/.test(l.message))).toBe(true);
  });

  it('is born unbound, and reports the repository it is bound to as the single source of truth', async () => {
    const dir = tmp();
    const { proxy } = await startProxy(dir);
    expect(proxy.boundRepository()).toBeUndefined();

    proxy.bind('owner/repo', { run: { images: ['postgres:16'] } });

    // A mismatch between the claimed job and this value is enforced by the
    // caller refusing to bind; the proxy only ever reports what it holds.
    expect(proxy.boundRepository()).toBe('owner/repo');
  });

  it('logs the policy hint on a denial after binding, for discovery', async () => {
    const dir = tmp();
    const { proxy, sock, logs } = await startProxy(dir);
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });

    const denied = await request(sock, 'POST', '/v1.45/containers/create', { Image: 'redis:7' });

    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body).message).toMatch(/redis:7/);
    const entry = logs.find((l) => /denied/.test(l.message));
    expect(entry?.policyHint).toMatch(/images:\s*\n\s*- "redis:7"/);
  });

  it('refuses API versions outside the range it understands, so unknown shapes never pass through', async () => {
    const dir = tmp();
    const { proxy, sock } = await startProxy(dir);
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });

    const tooNew = await request(sock, 'POST', '/v1.99/containers/create', { Image: 'postgres:16' });
    expect(tooNew.status).toBe(400);
    expect(JSON.parse(tooNew.body).message).toMatch(/v1\.99/);
    const tooOld = await request(sock, 'GET', '/v1.10/_ping');
    expect(tooOld.status).toBe(400);
  });

  it('answers with a clean Docker error when no daemon is behind the backend, rather than hanging', async () => {
    const dir = tmp();
    const { proxy, sock, logs } = await startProxy(dir, { backend: backendWith(null) });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });

    const ping = await request(sock, 'GET', '/v1.45/_ping');
    expect(ping.status).toBe(503);
    expect(JSON.parse(ping.body).message).toMatch(/no docker daemon/i);
    const create = await request(sock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16' });
    expect(create.status).toBe(503);
    expect(logs.filter((l) => l.level === 'warn' && /no docker daemon/i.test(l.message))).toHaveLength(1);
  });

  it('refuses a socket path the kernel would truncate', async () => {
    const dir = tmp();
    const { backend, worker } = backendWith(null);
    const proxy = new DockerFilterProxy({ backend, worker });
    const tooLong = path.join(dir, 'x'.repeat(120), 'docker.sock');
    await expect(proxy.start(tooLong)).rejects.toThrow(/104/);
  });

  it('refuses an oversized JSON body instead of buffering it', async () => {
    const dir = tmp();
    const { proxy, sock } = await startProxy(dir);
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });

    const huge = { Image: 'postgres:16', Env: ['X=' + 'y'.repeat(2 * 1024 * 1024)] };
    const reply = await request(sock, 'POST', '/v1.45/containers/create', huge);

    expect(reply.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// Forwarding, against a fake daemon on a second unix socket.
// ---------------------------------------------------------------------------

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }

/** A daemon that records what reaches it and answers like the real one would. */
const fakeDaemon = (dir: string): Promise<{ sock: string; seen: Seen[] }> =>
  new Promise((resolve) => {
    const sock = path.join(dir, 'daemon.sock');
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        const p = req.url!.replace(/^\/v\d+\.\d+/, '').split('?')[0];
        if (p === '/_ping') {
          res.writeHead(200, { 'Api-Version': '1.52', 'Content-Type': 'text/plain' });
          res.end('OK');
        } else if (p === '/version') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Version: '28.0.0', ApiVersion: '1.52', MinAPIVersion: '1.24' }));
        } else if (p === '/containers/create') {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: 'abc1230000000000000000000000000000000000000000000000000000000000', Warnings: [] }));
        } else if (p === '/networks/create') {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: 'ae'.repeat(32), Warning: '' }));
        } else if (p === '/images/create') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write(JSON.stringify({ status: 'Pulling' }) + '\n');
          res.end(JSON.stringify({ status: 'Done' }) + '\n');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, bytes: body.length }));
        }
      });
    });
    servers.push(server);
    server.listen(sock, () => resolve({ sock, seen }));
  });

describe('DockerFilterProxy forwarding', () => {
  const runPolicy = { run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' as const }], network: 'bridge' } };

  it('forwards an approved request to the backend endpoint', async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', runPolicy);

    const reply = await request(sock, 'POST', '/v1.45/containers/create?name=db', { Image: 'postgres:16' }, { Connection: 'keep-alive' });

    expect(reply.status).toBe(201);
    expect(JSON.parse(reply.body).Id).toBe('abc1230000000000000000000000000000000000000000000000000000000000');
    expect(daemon.seen).toHaveLength(1);
    expect(daemon.seen[0].method).toBe('POST');
    expect(daemon.seen[0].url).toBe('/v1.45/containers/create?name=db');
    expect(JSON.parse(daemon.seen[0].body.toString())).toEqual({ Image: 'postgres:16' });
    // Keep-alive is decided per leg: never pooled towards the daemon, and the
    // daemon's own `close` is not passed on to the job.
    expect(daemon.seen[0].headers.connection).toBe('close');
    expect(reply.headers.connection).toBe('keep-alive');
  });

  it('still refuses what the policy does not declare, without touching the daemon', async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', runPolicy);

    const reply = await request(sock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16', HostConfig: { Binds: ['/etc:/x'] } });

    expect(reply.status).toBe(403);
    expect(daemon.seen).toHaveLength(0);
  });

  it('refuses a key the daemon would fold to HostConfig, without touching the daemon', async () => {
    // Go's encoding/json reads U+017F (long s) as s, so the daemon takes
    // "HoſtConfig" for HostConfig: privileged, with the host's root mounted.
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', runPolicy);

    for (const body of [
      '{"Image":"postgres:16","Ho\u017ftConfig":{"Privileged":true}}',
      '{"Image":"postgres:16","Ho\\u017ftConfig":{"Binds":["/:/host"]}}',
    ]) {
      const reply = await request(sock, 'POST', '/v1.45/containers/create', body, { 'content-type': 'application/json' });
      expect([body, reply.status]).toEqual([body, 403]);
      expect(JSON.parse(reply.body).message).toMatch(/ASCII/);
    }
    expect(daemon.seen).toHaveLength(0);
  });

  it('sends the daemon the body it judged, not a repeated key JSON.parse dropped', async () => {
    // JSON.parse keeps the last copy of a repeated key. Go's decoder decodes
    // every copy in turn into the same field, and a map keeps the entries an
    // earlier copy put there, so forwarding these bytes would have the daemon
    // bind the bridge to a host address the filter never saw.
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', { run: { images: ['alpine:3'], network: 'bridge', networks: [{ name: 'vk-*', internal: true }] } });

    const body =
      '{"Name":"vk-1","Internal":true,' +
      '"Options":{"com.docker.network.bridge.host_binding_ipv4":"0.0.0.0"},"Options":{}}';
    const reply = await request(sock, 'POST', '/v1.45/networks/create', body, { 'content-type': 'application/json' });

    expect(reply.status).toBe(201);
    expect(daemon.seen).toHaveLength(1);
    const forwarded = daemon.seen[0].body.toString();
    expect(forwarded.match(/"Options"/g)).toHaveLength(1);
    expect(forwarded).not.toContain('host_binding');
    expect(JSON.parse(forwarded)).toEqual({ Name: 'vk-1', Internal: true, Options: {} });
  });

  it('refuses a pull or build whose parameters could come from a form body, without touching the daemon', async () => {
    // Go's FormValue prefers a form body's parameters to the URL's, and the
    // proxy streams a non-JSON body through unread: the daemon would pull
    // from the body's registry, or build on the host network.
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock, calls } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' }, pull: { registries: ['docker.io'] }, build: { context: './', tags: ['app:*'] } });

    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    const pulled = await request(sock, 'POST', '/v1.45/images/create?fromImage=postgres&tag=16', 'fromImage=evil.example.com%2Fx', form);
    expect(pulled.status).toBe(403);
    const built = await request(sock, 'POST', '/v1.45/build?t=app', 'networkmode=host&t=app', form);
    expect(built.status).toBe(403);
    expect(daemon.seen).toHaveLength(0);
    expect(calls.pulls).toHaveLength(0);

    // The same pull and build as the CLI sends them still go through: the
    // pull on the Mac, the build to the daemon.
    expect((await request(sock, 'POST', '/v1.45/images/create?fromImage=postgres&tag=16')).status).toBe(200);
    expect((await request(sock, 'POST', '/v1.45/build?t=app', 'tar', { 'content-type': 'application/x-tar' })).status).toBe(200);
    expect(calls.pulls).toHaveLength(1);
    expect(daemon.seen).toHaveLength(1);
  });

  it('refuses a body nested deeper than any Docker body, and answers', async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', runPolicy);

    const depth = 100_000;
    const body = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
    const reply = await request(sock, 'POST', '/v1.45/containers/create', body, { 'content-type': 'application/json' });
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body).message).toMatch(/nested/);
    expect(daemon.seen).toHaveLength(0);
  });

  it('pins an unversioned request to the version it understands when forwarding', async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', runPolicy);

    await request(sock, 'POST', '/containers/create', { Image: 'postgres:16' });

    expect(daemon.seen[0].url).toBe('/v1.45/containers/create');
  });

  it('pulls on the Mac through the worker, streaming its progress, and never forwards the pull', async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock, calls, logs } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', { pull: { registries: ['docker.io', 'ghcr.io'] } });

    // The job's own credential headers go nowhere: nothing is forwarded.
    const reply = await request(sock, 'POST', '/v1.45/images/create?fromImage=postgres&tag=16', undefined, {
      'X-Registry-Auth': 'forged',
      'X-Registry-Config': 'forged',
    });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('application/json');
    expect(reply.body.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { status: 'Pulling from library/postgres', id: '16' },
      { status: 'Done' },
    ]);
    expect(calls.pulls).toEqual([{ registry: 'docker.io', repositoryPath: 'library/postgres', tag: '16' }]);
    expect(logs.some((l) => l.message === 'pulled POST /images/create through the worker, not forwarded')).toBe(true);
    expect(logs.some((l) => /^forwarded POST \/images/.test(l.message))).toBe(false);
    expect(daemon.seen).toHaveLength(0);

    await request(sock, 'POST', '/v1.45/images/create?fromImage=ghcr.io%2Fowner%2Fapp&tag=1&platform=linux%2Famd64');
    expect(calls.pulls[1]).toEqual({ registry: 'ghcr.io', repositoryPath: 'owner/app', tag: '1', platform: 'linux/amd64' });
    expect(daemon.seen).toHaveLength(0);
  });

  it('reads a pull by digest as a digest, from the name or from the tag parameter', async () => {
    const dir = tmp();
    const { proxy, sock, calls } = await startProxy(dir, { backend: backendWith(dir) });
    proxy.bind('owner/repo', { pull: { registries: ['docker.io'] } });
    const digest = `sha256:${'0123456789abcdef'.repeat(4)}`;

    await request(sock, 'POST', `/v1.45/images/create?fromImage=${encodeURIComponent(`alpine@${digest}`)}`);
    await request(sock, 'POST', `/v1.45/images/create?fromImage=alpine&tag=${encodeURIComponent(digest)}`);
    await request(sock, 'POST', '/v1.45/images/create?fromImage=alpine');
    expect(calls.pulls).toEqual([
      { registry: 'docker.io', repositoryPath: 'library/alpine', digest },
      { registry: 'docker.io', repositoryPath: 'library/alpine', digest },
      { registry: 'docker.io', repositoryPath: 'library/alpine', tag: 'latest' },
    ]);
  });

  it('ends the progress stream with the error, as the daemon would, when the pull fails after the headers', async () => {
    const dir = tmp();
    const fixture = backendWith(dir, false, {
      pull: async (_req, onProgress) => {
        onProgress({ status: 'Pulling' });
        throw new Error('image alpine has no arm64 build, and amd64 images need Rosetta for Linux');
      },
    });
    const { proxy, sock } = await startProxy(dir, { backend: fixture });
    proxy.bind('owner/repo', { pull: { registries: ['docker.io'] } });

    const reply = await request(sock, 'POST', '/v1.45/images/create?fromImage=alpine&tag=3');
    expect(reply.status).toBe(200);
    const lines = reply.body.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[lines.length - 1]).toEqual({
      errorDetail: { message: 'image alpine has no arm64 build, and amd64 images need Rosetta for Linux' },
      error: 'image alpine has no arm64 build, and amd64 images need Rosetta for Linux',
    });
  });

  it('aborts the pull when the job hangs up', async () => {
    const dir = tmp();
    let aborted!: () => void;
    const abortSeen = new Promise<void>((resolve) => (aborted = resolve));
    const fixture = backendWith(dir, false, {
      // Progress keeps coming, as it does while layers download; the socket
      // stays half-open for a client that only shut its sending side, so the
      // hang-up is seen at the next write.
      pull: (_req, onProgress, signal) =>
        new Promise((_resolve, reject) => {
          const ticker = setInterval(() => onProgress({ status: 'Downloading' }), 20);
          signal.addEventListener('abort', () => {
            clearInterval(ticker);
            aborted();
            reject(new Error('aborted'));
          });
        }),
    });
    const { proxy, sock } = await startProxy(dir, { backend: fixture });
    proxy.bind('owner/repo', { pull: { registries: ['docker.io'] } });

    const req = http.request({ socketPath: sock, path: '/v1.45/images/create?fromImage=alpine&tag=3', method: 'POST', agent: false }, (res) => {
      res.once('data', () => req.destroy());
    });
    req.on('error', () => {});
    req.end();
    await abortSeen;
  });

  it('refuses a pull whose query another daemon could read as a different image, before it is pulled', async () => {
    // On Podman each of these pulls evil.example.com/x, while a filter that
    // reads the first value judged postgres.
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock, calls } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', { pull: { registries: ['docker.io'] } });

    for (const query of [
      'fromImage=postgres&fromImage=evil.example.com%2Fx',
      'fromImage=postgres;&fromImage=evil.example.com%2Fx',
      'fromImage=postgres%zz&fromImage=evil.example.com%2Fx',
      'fromImage=postgres&FROMIMAGE=evil.example.com%2Fx',
    ]) {
      const reply = await request(sock, 'POST', `/v1.45/images/create?${query}`);
      expect(reply.status).toBe(400);
    }
    expect(calls.pulls).toHaveLength(0);

    // The one list a client repeats, a build's tags, still goes through.
    proxy.bind('owner/repo', { build: { context: './', tags: ['app:*'] } });
    const built = await request(sock, 'POST', '/v1.45/build?t=app%3A1&t=app%3Alatest', 'tar', { 'content-type': 'application/x-tar' });
    expect(built.status).toBe(200);
    expect(daemon.seen).toHaveLength(1);
  });

  it('refuses a build tag that would replace a run image, carry a registry or go undeclared, without touching the daemon', async () => {
    // A build's -t replaces the local image of that name, so a build tagged
    // postgres:16 would be what every later `docker run postgres:16` runs.
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', {
      pull: { registries: ['docker.io'] },
      run: { images: ['postgres:16'] },
      build: { context: './', tags: ['myapp:*'] },
    });
    const tar = { 'content-type': 'application/x-tar' };

    for (const query of [
      't=postgres%3A16', 't=Postgres', 't=ghcr.io%2Fx%2Fy', 't=other%3A1',
      't=myapp%3Aci&t=postgres%3A16', 'T=postgres%3A16', 'TAG=postgres%3A16', 't=myapp%3Aci&T=postgres%3A16',
    ]) {
      const reply = await request(sock, 'POST', `/v1.45/build?${query}`, 'tar', tar);
      expect([query, reply.status]).toEqual([query, query.includes('&T=') ? 400 : 403]);
    }
    expect(daemon.seen).toHaveLength(0);

    // A declared tag, every one of a repeated t, and no tag at all go through.
    for (const query of ['t=myapp%3Aci', 't=myapp%3Aci&t=myapp%3Alatest', 'dockerfile=Dockerfile']) {
      expect([query, (await request(sock, 'POST', `/v1.45/build?${query}`, 'tar', tar)).status]).toEqual([query, 200]);
    }
    expect(daemon.seen).toHaveLength(3);
  });

  it('never pulls from a registry a pull tag would make of the image name', async () => {
    // Podman joins fromImage and tag with ":", so these pull localhost:5000/x
    // and evil.example.com:443/x. Judged by fromImage alone, both were Docker
    // Hub images.
    const dir = tmp();
    const { proxy, sock, calls } = await startProxy(dir, { backend: backendWith(dir) });
    proxy.bind('owner/repo', { pull: { registries: ['docker.io'] } });

    for (const query of ['fromImage=localhost&tag=5000%2Fx', 'fromImage=evil.example.com&TAG=443%2Fx']) {
      const reply = await request(sock, 'POST', `/v1.45/images/create?${query}`);
      expect([query, reply.status]).toEqual([query, 403]);
    }
    expect(calls.pulls).toHaveLength(0);

    // A tag or a digest still pulls, from Docker Hub.
    const digest = `sha256%3A${'0123456789abcdef'.repeat(4)}`;
    for (const tag of ['latest', 'v1.2.3', digest]) {
      const reply = await request(sock, 'POST', `/v1.45/images/create?fromImage=postgres&tag=${tag}`);
      expect([tag, reply.status]).toEqual([tag, 200]);
    }
    expect(calls.pulls.map((p) => p.registry)).toEqual(['docker.io', 'docker.io', 'docker.io']);
  });

  it('pulls an uppercase first component from the registry the daemon reads it as', async () => {
    // The daemon's reference parser reads `LOCALHOST/x` and `Evil/x` as
    // registry hosts. Read as Docker Hub namespaces, they were approved under
    // docker.io.
    const dir = tmp();
    const { proxy, sock, calls } = await startProxy(dir, { backend: backendWith(dir) });
    proxy.bind('owner/repo', { pull: { registries: ['docker.io'] } });

    for (const image of ['Evil/x', 'LOCALHOST/x']) {
      const reply = await request(sock, 'POST', `/v1.45/images/create?fromImage=${encodeURIComponent(image)}&tag=1`);
      expect(reply.status).toBe(403);
    }
    expect(calls.pulls).toHaveLength(0);

    // Declared as the registry it is, it is asked of that registry.
    proxy.bind('owner/repo', { pull: { registries: ['LOCALHOST'] } });
    const declared = await request(sock, 'POST', '/v1.45/images/create?fromImage=LOCALHOST%2Fx&tag=1');
    expect(declared.status).toBe(200);
    expect(calls.pulls).toEqual([{ registry: 'LOCALHOST', repositoryPath: 'x', tag: '1' }]);
  });

  it('clamps the API version the daemon advertises, so the client negotiates down to ours', async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });

    const ping = await request(sock, 'HEAD', '/_ping');
    expect(ping.status).toBe(200);
    expect(ping.headers['api-version']).toBe('1.45');
    const version = await request(sock, 'GET', '/v1.45/version');
    expect(version.status).toBe(200);
    const parsed = JSON.parse(version.body);
    expect(parsed.ApiVersion).toBe('1.45');
    expect(parsed.Version).toBe('28.0.0');
    expect(Number(version.headers['content-length'])).toBe(Buffer.byteLength(version.body));
  });

  it('streams a non-JSON body through without buffering it, once the request line is approved', async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', { build: { context: './', tags: ['app:*'] } });

    const tar = 'x'.repeat(3 * 1024 * 1024); // well over the JSON cap
    const reply = await request(sock, 'POST', '/v1.45/build?t=app', tar, { 'content-type': 'application/x-tar' });

    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).bytes).toBe(tar.length);
    expect(daemon.seen[0].body.length).toBe(tar.length);

    const denied = await request(sock, 'POST', '/v1.45/build?t=app&remote=https%3A%2F%2Fx', tar, { 'content-type': 'application/x-tar' });
    expect(denied.status).toBe(403);
    expect(daemon.seen).toHaveLength(1);
  });

  it('relays an answer the daemon gives before the streamed body has arrived, and stays up', async () => {
    // Like dockerd (a Go server): refuse on the request line, keep reading a
    // little of the body, then hang up. The proxy must deliver that answer
    // to the job even though the job is still uploading, and an upstream
    // socket error with no listener must not take the app down.
    const dir = tmp();
    const sock = path.join(dir, 'early.sock');
    const daemon = net.createServer((socket) => {
      let seen = 0;
      let answered = false;
      socket.on('error', () => {});
      socket.on('data', (data: Buffer) => {
        seen += data.length;
        if (!answered && data.includes('\r\n\r\n')) {
          answered = true;
          const body = JSON.stringify({ message: 'bad build' });
          socket.write(`HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
        }
        if (answered && seen > 256 * 1024) socket.destroy();
      });
    });
    servers.push(daemon);
    await new Promise<void>((r) => daemon.listen(sock, () => r()));
    const { proxy, sock: proxySock } = await startProxy(dir, { backend: backendWith(sock) });
    proxy.bind('owner/repo', { build: { context: './', tags: ['app:*'] } });

    const tar = 'x'.repeat(6 * 1024 * 1024);
    const replies = await Promise.all([1, 2, 3].map(() =>
      request(proxySock, 'POST', '/v1.45/build?t=app', tar, { 'content-type': 'application/x-tar' })));
    for (const reply of replies) {
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body).message).toBe('bad build');
    }
    await new Promise((r) => setTimeout(r, 50)); // let any late write completion fire
    expect(proxy.isRunning()).toBe(true);
  });

  it('stays up when a daemon hangs up the instant it answers, and the job still gets an error, not a dropped connection', async () => {
    // Harsher than dockerd: nothing of the body is read before the close.
    // Whether the daemon's own answer or the proxy's 502 wins the race, the
    // job sees a Docker error and the socket keeps serving.
    const dir = tmp();
    const sock = path.join(dir, 'early.sock');
    const daemon = http.createServer((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'bad build' }));
    });
    servers.push(daemon);
    await new Promise<void>((r) => daemon.listen(sock, () => r()));
    const { proxy, sock: proxySock } = await startProxy(dir, { backend: backendWith(sock) });
    proxy.bind('owner/repo', { build: { context: './', tags: ['app:*'] } });

    const tar = 'x'.repeat(6 * 1024 * 1024);
    const replies = await Promise.all([1, 2, 3].map(() =>
      request(proxySock, 'POST', '/v1.45/build?t=app', tar, { 'content-type': 'application/x-tar' })));
    for (const reply of replies) {
      expect([400, 502]).toContain(reply.status);
      expect(JSON.parse(reply.body).message).toMatch(/bad build|daemon unreachable/);
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(proxy.isRunning()).toBe(true);
    expect((await request(proxySock, 'POST', '/v1.45/containers/create', { Image: 'x' })).status).toBe(403);
  });

  it('sends the daemon\'s headers on as soon as they arrive, before any body', async () => {
    // `docker run` issues wait before start and needs the 200 for wait back
    // at once - the body only comes when the container exits. Headers held
    // until the first body byte deadlock the CLI.
    const dir = tmp();
    const sock = path.join(dir, 'wait.sock');
    let releaseBody: () => void = () => {};
    const daemon = http.createServer((req, res) => {
      // The CLI creates the container before it waits on it, and the socket
      // only addresses containers it created, so the create is served too.
      if (req.url?.includes('/containers/create')) {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Id: 'abc1230000000000000000000000000000000000000000000000000000000000', Warnings: [] }));
        return;
      }
      // And the removal that follows when the socket stops.
      if (req.method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      new Promise<void>((r) => { releaseBody = r; }).then(() => res.end(JSON.stringify({ StatusCode: 0 })));
    });
    servers.push(daemon);
    await new Promise<void>((r) => daemon.listen(sock, () => r()));
    const { proxy, sock: proxySock } = await startProxy(dir, { backend: backendWith(sock) });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });
    // Own the container first, as `docker run` does.
    expect((await request(proxySock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16' })).status).toBe(201);

    const headersSeen = new Promise<number>((resolve, reject) => {
      const req = http.request({ socketPath: proxySock, path: '/v1.45/containers/abc1230000000000000000000000000000000000000000000000000000000000/wait?condition=next-exit', method: 'POST', agent: false }, (res) => {
        resolve(res.statusCode!);
        res.resume();
      });
      req.on('error', reject);
      req.end();
    });
    const outcome = await Promise.race([headersSeen, new Promise<string>((r) => setTimeout(() => r('no headers within 1.5s'), 1500))]);
    expect(outcome).toBe(200);
    releaseBody();
  });

  it('judges a mount by where it really is, with the sandbox directory resolved the same way', async () => {
    // os.tmpdir() is a symlink on macOS (/var -> /private/var); the root and
    // the source must be resolved alike or every workspace mount is refused.
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    fs.mkdirSync(path.join(dir, 'fixtures'));
    fs.symlinkSync('/etc', path.join(dir, 'escape'));
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock), realpath: undefined });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], mounts: [{ path: './fixtures', mode: 'rw' }], network: 'bridge' } });

    const ok = await request(sock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16', HostConfig: { Binds: [`${dir}/fixtures:/f`] } });
    expect(ok.status).toBe(201);
    const viaSymlink = await request(sock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16', HostConfig: { Binds: [`${dir}/escape:/x:ro`] } });
    expect(viaSymlink.status).toBe(403);
    expect(JSON.parse(viaSymlink.body).message).toMatch(/outside the job workspace/);
  });

  it('removes its socket on stop and can start again on the same path', async () => {
    const dir = tmp();
    const { proxy, sock } = await startProxy(dir);
    expect(fs.existsSync(sock)).toBe(true);
    expect(proxy.isRunning()).toBe(true);

    await proxy.stop();
    expect(fs.existsSync(sock)).toBe(false);
    expect(proxy.isRunning()).toBe(false);

    await proxy.start(sock);
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16' })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Attach: an upgraded connection, relayed raw once the request is judged.
// ---------------------------------------------------------------------------

/** A daemon that answers an attach with 101 and then echoes bytes back upper-cased. */
const fakeAttachDaemon = (dir: string): Promise<{ sock: string; heads: string[] }> =>
  new Promise((resolve) => {
    const sock = path.join(dir, 'attach.sock');
    const heads: string[] = [];
    const server = net.createServer((socket) => {
      let buffered = '';
      let upgraded = false;
      socket.on('data', (data: Buffer) => {
        if (upgraded) {
          socket.write(data.toString().toUpperCase());
          return;
        }
        buffered += data.toString();
        const end = buffered.indexOf('\r\n\r\n');
        if (end === -1) return;
        // The socket only attaches to a container it created, so this fake
        // answers the create that precedes the attach, then upgrades - and
        // the removal that follows when the socket stops.
        if (buffered.slice(0, end).includes('/containers/create')) {
          const payload = JSON.stringify({ Id: 'abc1230000000000000000000000000000000000000000000000000000000000', Warnings: [] });
          socket.write(
            `HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n${payload}`
          );
          buffered = '';
          return;
        }
        if (buffered.startsWith('DELETE ')) {
          socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
          buffered = '';
          return;
        }
        heads.push(buffered.slice(0, end));
        upgraded = true;
        socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n');
        const rest = buffered.slice(end + 4);
        if (rest) socket.write(rest.toUpperCase());
      });
    });
    servers.push(server);
    server.listen(sock, () => resolve({ sock, heads }));
  });

const attach = (sock: string, url: string, extraHeaders = ''): Promise<{ head: string; socket: net.Socket }> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(sock);
    let buffered = '';
    const onData = (data: Buffer) => {
      buffered += data.toString();
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      resolve({ head: buffered.slice(0, end), socket });
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(`POST ${url} HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n${extraHeaders}Content-Length: 0\r\n\r\n`);
    });
  });

const readOnce = (socket: net.Socket): Promise<string> =>
  new Promise((resolve) => socket.once('data', (d: Buffer) => resolve(d.toString())));

describe('DockerFilterProxy attach', () => {
  it('relays an approved attach in both directions after the daemon upgrades', async () => {
    const dir = tmp();
    const daemon = await fakeAttachDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });
    // Own the container first, as `docker run` does before attaching.
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16' })).status).toBe(201);

    const { head, socket } = await attach(sock, '/v1.45/containers/abc1230000000000000000000000000000000000000000000000000000000000/attach?stream=1&stdin=1&stdout=1', 'X-Registry-Auth: forged\r\n');
    expect(head).toMatch(/^HTTP\/1\.1 101/);
    expect(daemon.heads[0]).toMatch(/^POST \/v1\.45\/containers\/abc1230000000000000000000000000000000000000000000000000000000000\/attach\?stream=1&stdin=1&stdout=1 HTTP\/1\.1/);
    expect(daemon.heads[0]).toMatch(/Upgrade: tcp/);
    expect(daemon.heads[0]).not.toMatch(/X-Registry-Auth/i);

    socket.write('hello');
    expect(await readOnce(socket)).toBe('HELLO');
    socket.destroy();
  });

  it('attaches to the id a name was created with, not whatever holds the name now', async () => {
    const dir = tmp();
    const daemon = await fakeAttachDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });
    expect((await request(sock, 'POST', '/v1.45/containers/create?name=mine', { Image: 'postgres:16' })).status).toBe(201);

    const { head, socket } = await attach(sock, '/v1.45/containers/mine/attach?stream=1&stdout=1');
    socket.destroy();
    expect(head).toMatch(/^HTTP\/1\.1 101/);
    expect(daemon.heads[0]).toMatch(/^POST \/v1\.45\/containers\/abc1230000000000000000000000000000000000000000000000000000000000\/attach\?stream=1&stdout=1 HTTP\/1\.1/);
  });

  it('refuses an attach the policy does not permit on the raw connection, before the daemon sees it', async () => {
    const dir = tmp();
    const daemon = await fakeAttachDaemon(dir);
    const { sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });

    const { head, socket } = await attach(sock, '/v1.45/containers/abc1230000000000000000000000000000000000000000000000000000000000/attach?stream=1');
    expect(head).toMatch(/^HTTP\/1\.1 403/);
    expect(head).toMatch(/Content-Type: application\/json/);
    expect(daemon.heads).toHaveLength(0);
    socket.destroy();
  });
});

describe('an HTTP/1.0 client of the served socket', () => {
  it('receives the relayed response and sees the connection close, rather than hanging', async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'] } });

    // What `printf ... | nc -U` does: send the request, half-close, then wait
    // for the server to answer and close. An HTTP/1.0 client has no
    // Content-Length contract to lean on; EOF is how it knows it is done.
    const received = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const client = net.connect(sock);
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error(`connection not closed within 3s; received ${Buffer.concat(chunks).length} bytes`));
      }, 3000);
      client.on('connect', () => {
        client.write('GET /_ping HTTP/1.0\r\nHost: localhost\r\n\r\n');
        client.end();
      });
      client.on('data', (c: Buffer) => chunks.push(c));
      client.on('error', (e) => { clearTimeout(timer); reject(e); });
      client.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString()); });
    });

    expect(received).toMatch(/^HTTP\/1\.[01] 200/);
    expect(received).toContain('OK');
  });
});

describe('container ownership tracking', () => {
  it('permits the run verbs on a container it created, and refuses one it did not', async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });

    // Before any create, the socket owns nothing: the whole `docker run`
    // sequence must be refused against an id it never handed out.
    const foreignStart = await request(sock, 'POST', '/v1.45/containers/theirs999/start');
    expect(foreignStart.status).toBe(403);

    // The fake daemon answers create with Id 'abc1230000000000000000000000000000000000000000000000000000000000'.
    const created = await request(sock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16' });
    expect(created.status).toBe(201);

    // Now the verbs the CLI issues next must go through for that container.
    for (const [method, url] of [
      ['GET', '/v1.45/containers/abc1230000000000000000000000000000000000000000000000000000000000/json'],
      ['POST', '/v1.45/containers/abc1230000000000000000000000000000000000000000000000000000000000/start'],
      ['POST', '/v1.45/containers/abc1230000000000000000000000000000000000000000000000000000000000/wait'],
      ['DELETE', '/v1.45/containers/abc1230000000000000000000000000000000000000000000000000000000000'],
    ] as const) {
      const res = await request(sock, method, url);
      expect({ url, status: res.status }).toEqual({ url, status: expect.any(Number) });
      expect(res.status).toBeLessThan(400);
    }

    // ...and a container belonging to someone else still does not.
    expect((await request(sock, 'GET', '/v1.45/containers/theirs999/json')).status).toBe(403);
  });
});

const rawUpgrade = (sock: string, method: string, url: string): Promise<{ head: string; socket: net.Socket }> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(sock);
    let buffered = '';
    const onData = (data: Buffer) => {
      buffered += data.toString();
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      resolve({ head: buffered.slice(0, end), socket });
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(`${method} ${url} HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`);
    });
  });

describe('upgrade requests', () => {
  it('does not turn a permitted baseline read into a raw daemon tunnel', async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });

    // GET /_ping is in the always-on baseline, so the policy permits it. If an
    // Upgrade header alone opens a raw pipe, the job holds an unfiltered socket
    // to the daemon and can pipeline anything over it.
    const { head, socket } = await rawUpgrade(sock, 'GET', '/v1.45/_ping');
    expect(head).not.toMatch(/101/);

    // Prove no tunnel: a denied request written on the same socket must not be
    // answered by the daemon.
    const smuggled = await new Promise<string>((resolve) => {
      let got = '';
      socket.on('data', (d: Buffer) => { got += d.toString(); });
      socket.write('GET /v1.45/containers/json HTTP/1.1\r\nHost: docker\r\n\r\n');
      setTimeout(() => resolve(got), 300);
    });
    socket.destroy();
    expect(smuggled).not.toMatch(/"ok"\s*:\s*true|Names|\[\s*\{/);
  });

  it('refuses an upgrade on a container the socket does not own', async () => {
    const dir = tmp();
    const daemon = await fakeAttachDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });

    const { head, socket } = await attach(sock, '/v1.45/containers/theirs999/attach?stream=1');
    socket.destroy();
    expect(head).not.toMatch(/101/);
  });
});

describe('mount sources are pinned before forwarding', () => {
  it('sends the daemon the resolved path, not the spelling the client sent through a symlink', async () => {
    const dir = tmp();
    const workspace = fs.realpathSync.native(dir);
    const real = path.join(workspace, 'inside');
    const link = path.join(workspace, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);

    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, {
      backend: backendWith(daemon.sock, false, { workspaceMountRoot: () => workspace }),
    });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'rw' }], network: 'bridge' } });

    const reply = await request(sock, 'POST', '/v1.45/containers/create', {
      Image: 'postgres:16',
      HostConfig: { Binds: [`${link}:/ws`] },
    });
    expect(reply.status).toBe(201);

    // The filter resolved `link` to decide. If it forwarded the spelling it
    // was given, the daemon would resolve the link again, wherever the job had
    // pointed it by then. This pins the create only: the daemon resolves the
    // pinned path once more at start, and a link swapped onto it after it is
    // checked and before the container starts is still followed.
    const create = daemon.seen.find((s) => s.url.includes('/containers/create'))!;
    const binds = (JSON.parse(create.body.toString()) as { HostConfig: { Binds: string[] } }).HostConfig.Binds;
    expect(binds[0]).toBe(`${real}:/ws`);
  });
});

describe('the mount boundary is the sandbox the app created, not what the job makes of it', () => {
  // The job's profile writes its whole sandbox directory, so it can replace
  // _work, or its own checkout, with a link to anywhere. Resolving the root
  // through those links on every request moved the boundary with them: with
  // `./` declared, everything under the link's target became "the workspace".
  // The sandbox directory itself is the job's to rename too (the profile lets
  // it make tmp.XXXXXXXXXX names beside it), so the root is the one resolved
  // when the socket started, never resolved again per request.
  it.each([
    ['its checkout (_work/repo/repo)', 'checkout'],
    ['_work', 'work'],
    ['its own sandbox directory', 'sandbox'],
  ])('refuses a mount outside the sandbox after the job links %s elsewhere', async (_label, which) => {
    const dir = tmp();
    const sandbox = path.join(dir, 's');
    const victim = path.join(dir, 'victim');
    const checkout = path.join(sandbox, '_work', 'repo', 'repo');
    fs.mkdirSync(path.join(checkout, 'data', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(victim, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(victim, '.ssh', 'id_ed25519'), 'SECRET');
    const daemon = await fakeDaemon(dir);
    // Every backend's mount root and the real realpath: os.tmpdir() is itself
    // a symlink on macOS, which a legitimate mount must still get past.
    const started = await startProxy(sandbox, {
      backend: backendWith(daemon.sock, false, { workspaceMountRoot: runnerWorkspaceRoot }),
    });
    const { proxy } = started;
    let sock = started.sock;
    const create = (bind: string) => request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3', HostConfig: { Binds: [bind] } });

    // Before: a narrower declared mount judges against the literal root as it
    // did against the resolved one, and so does `./`; the victim does not mount.
    proxy.bind('owner/repo', { run: { images: ['alpine:3'], mounts: [{ path: './data', mode: 'rw' }], network: 'bridge' } });
    expect((await create(`${checkout}/data/sub:/d`)).status).toBe(201);
    expect((await create(`${checkout}:/d`)).status).toBe(403);
    proxy.bind('owner/repo', { run: { images: ['alpine:3'], mounts: [{ path: './', mode: 'rw' }], network: 'bridge' } });
    expect((await create(`${checkout}/data:/d`)).status).toBe(201);
    expect((await create(`${victim}/.ssh:/x`)).status).toBe(403);
    expect(daemon.seen).toHaveLength(2);

    // Each bind the job then tries: the victim by its own path, and by the
    // link's spelling of it.
    let binds = [`${victim}/.ssh:/x`, `${checkout}/.ssh:/x`, `${checkout}:/x`];
    if (which === 'checkout') {
      fs.renameSync(checkout, `${checkout}.x`);
      fs.symlinkSync(victim, checkout);
    } else if (which === 'sandbox') {
      // The victim is laid out as a sandbox, so a root resolved again through
      // the link would find a checkout there with ./data in it. The socket
      // moves with the directory, and the job keeps talking to it.
      const victimData = path.join(victim, '_work', 'repo', 'repo', 'data');
      fs.mkdirSync(victimData, { recursive: true });
      const moved = path.join(dir, 'tmp.AbCdEfGhIj');
      fs.renameSync(sandbox, moved);
      fs.symlinkSync(victim, sandbox);
      sock = path.join(moved, 'docker.sock');
      binds = [`${victimData}:/d`, `${checkout}/data:/d`, `${checkout}:/d`, `${victim}/.ssh:/x`];
    } else {
      const staged = path.join(dir, 'staged');
      fs.mkdirSync(path.join(staged, 'repo'), { recursive: true });
      fs.symlinkSync(victim, path.join(staged, 'repo', 'repo'));
      fs.renameSync(path.join(sandbox, '_work'), path.join(sandbox, '_work.x'));
      fs.symlinkSync(staged, path.join(sandbox, '_work'));
    }

    // After: neither the victim's path nor the link's spelling of it gets through.
    for (const bind of binds) {
      const reply = await create(bind);
      expect([bind, reply.status]).toEqual([bind, 403]);
    }
    expect(daemon.seen).toHaveLength(2);
  });
});

describe('a request target the filter cannot read', () => {
  it('is refused, and the connection does not hang', async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });

    // Resolve on the response head, not on close: HTTP/1.1 keep-alive means a
    // correctly-answered request leaves the socket open.
    const answered = await new Promise<string>((resolve, reject) => {
      let buffered = '';
      const client = net.connect(sock);
      const done = (v: string) => { clearTimeout(timer); client.destroy(); resolve(v); };
      const timer = setTimeout(() => { client.destroy(); reject(new Error('no answer within 3s: the connection hung')); }, 3000);
      client.on('connect', () => client.write('GET //evil/v1.45/containers/json HTTP/1.1\r\nHost: docker\r\n\r\n'));
      client.on('data', (c: Buffer) => { buffered += c.toString(); if (buffered.includes('\r\n\r\n')) done(buffered); });
      client.on('error', (e) => { clearTimeout(timer); reject(e); });
      client.on('close', () => { clearTimeout(timer); resolve(buffered); });
    });

    // 400, naming the target: a target the filter cannot read is a bad
    // request, not a policy denial, and saying so is the difference between
    // "fix your URL" and "ask your operator for a grant".
    expect(answered).toMatch(/^HTTP\/1\.[01] 400/);
    expect(answered).toMatch(/origin-form|could not be parsed/);
    // Nothing reached the daemon.
    expect(daemon.seen).toHaveLength(0);
    expect(proxy.isRunning()).toBe(true);
  });
});

describe('which containers a job may address', () => {
  const setup = async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });
    return { sock, daemon };
  };

  it('lets a job address the container it created by --name', async () => {
    const { sock } = await setup();
    // docker run --name mine ... -> POST /containers/create?name=mine, and
    // every later call addresses it as "mine", never as the id.
    expect((await request(sock, 'POST', '/v1.45/containers/create?name=mine', { Image: 'postgres:16' })).status).toBe(201);
    expect((await request(sock, 'POST', '/v1.45/containers/mine/start')).status).toBeLessThan(400);
    expect((await request(sock, 'GET', '/v1.45/containers/mine/json')).status).toBeLessThan(400);
  });

  it('forgets a container once it is removed, so its name cannot be reused', async () => {
    const { sock } = await setup();
    await request(sock, 'POST', '/v1.45/containers/create?name=mine', { Image: 'postgres:16' });
    expect((await request(sock, 'DELETE', '/v1.45/containers/mine')).status).toBeLessThan(400);
    // The container is gone; the daemon may hand that name to anyone next.
    expect((await request(sock, 'GET', '/v1.45/containers/mine/json')).status).toBe(403);
    expect((await request(sock, 'GET', '/v1.45/containers/abc1230000000000000000000000000000000000000000000000000000000000/json')).status).toBe(403);
  });

  it('sends the daemon the id a name was created with, so a name freed by --rm cannot reach its next holder', async () => {
    const { sock, daemon } = await setup();
    // docker run --rm --name mine: the daemon frees the name the moment the
    // container exits, and another job, or the operator, may take it. The
    // name is still owned here, so what the daemon receives must be the id
    // it was created with - a removed container is then a 404, not whichever
    // container holds the name now.
    await request(sock, 'POST', '/v1.45/containers/create?name=mine', { Image: 'postgres:16' });
    expect((await request(sock, 'POST', '/v1.45/containers/mine/kill?signal=KILL')).status).toBeLessThan(400);
    expect(daemon.seen[daemon.seen.length - 1].url).toBe('/v1.45/containers/abc1230000000000000000000000000000000000000000000000000000000000/kill?signal=KILL');
    // Unversioned, and on a bare container path, the same.
    expect((await request(sock, 'POST', '/containers/mine/wait?condition=removed')).status).toBeLessThan(400);
    expect(daemon.seen[daemon.seen.length - 1].url).toBe('/v1.45/containers/abc1230000000000000000000000000000000000000000000000000000000000/wait?condition=removed');
    expect((await request(sock, 'DELETE', '/v1.45/containers/mine?force=1')).status).toBeLessThan(400);
    expect(daemon.seen[daemon.seen.length - 1].url).toBe('/v1.45/containers/abc1230000000000000000000000000000000000000000000000000000000000?force=1');
  });

  it('does not accept a bare prefix of an owned id', async () => {
    const { sock } = await setup();
    // The fake daemon answers create with Id abc1230000000000000000000000000000000000000000000000000000000000. A prefix could resolve on
    // the real daemon to a container this job never created.
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16' })).status).toBe(201);
    expect((await request(sock, 'GET', '/v1.45/containers/abc1230000000000000000000000000000000000000000000000000000000000/json')).status).toBeLessThan(400);
    expect((await request(sock, 'GET', '/v1.45/containers/ab/json')).status).toBe(403);
  });
});

describe('networks a job creates', () => {
  it('may be read, joined and deleted, and are forgotten once removed', async () => {
    const dir = tmp();
    const daemon = await networkDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', {
      run: { images: ['alpine:3'], network: 'bridge', networks: [{ name: 'vk-*', internal: true }] },
    });

    expect((await request(sock, 'POST', '/v1.45/networks/create', { Name: 'vk-1', Internal: true })).status).toBe(201);

    // Both the id the daemon assigned and the name the job asked for.
    expect((await request(sock, 'GET', `/v1.45/networks/${NET_ID}`)).status).toBeLessThan(400);
    expect((await request(sock, 'GET', '/v1.45/networks/vk-1')).status).toBeLessThan(400);
    // A container may join it.
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3', HostConfig: { NetworkMode: 'vk-1' } })).status).toBe(201);
    // Someone else's network is still refused.
    expect((await request(sock, 'GET', '/v1.45/networks/theirs')).status).toBe(403);

    expect((await request(sock, 'DELETE', '/v1.45/networks/vk-1')).status).toBeLessThan(400);
    expect((await request(sock, 'GET', '/v1.45/networks/vk-1')).status).toBe(403);
    expect((await request(sock, 'GET', `/v1.45/networks/${NET_ID}`)).status).toBe(403);
  });

  it('are not the job\'s when the daemon answers with an id that is not one', async () => {
    // With guest root the answer is the job's to choose; an id like "host",
    // owned, would be pinned into a later create's NetworkMode.
    for (const hostile of ['host', 'none', '../x', 'AE'.repeat(32), '']) {
      const dir = tmp();
      const daemon = await networkDaemon(dir, hostile);
      const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
      proxy.bind('owner/repo', {
        run: { images: ['alpine:3'], network: 'bridge', networks: [{ name: 'vk-*', internal: true }] },
      });
      const reply = await request(sock, 'POST', '/v1.45/networks/create', { Name: 'vk-1', Internal: true });
      expect([hostile, reply.status, JSON.parse(reply.body).message]).toEqual([hostile, 502, 'the Docker daemon sent a network create answer without a network id']);
      // Neither the name nor the id is the job's.
      expect((await request(sock, 'GET', '/v1.45/networks/vk-1')).status).toBe(403);
      if (hostile !== '') expect((await request(sock, 'GET', `/v1.45/networks/${encodeURIComponent(hostile)}`)).status).toBe(403);
      const joined = await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3', HostConfig: { NetworkMode: 'vk-1' } });
      expect(joined.status).toBe(403);
      expect(daemon.seen.filter((line) => line.startsWith('POST /v1.45/containers/create'))).toEqual([]);
    }
  });

  it('are addressed at the daemon by the id they were created with', async () => {
    // A network name is freed when anyone removes it, and the next network
    // with that name is not this job's. The daemon is sent the id.
    const dir = tmp();
    const daemon = await networkDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', {
      run: { images: ['alpine:3'], network: 'bridge', networks: [{ name: 'vk-*', internal: true }] },
    });
    expect((await request(sock, 'POST', '/v1.45/networks/create', { Name: 'vk-1', Internal: true })).status).toBe(201);

    expect((await request(sock, 'GET', '/v1.45/networks/vk-1?verbose=true')).status).toBeLessThan(400);
    expect(daemon.seen[daemon.seen.length - 1]).toBe(`GET /v1.45/networks/${NET_ID}?verbose=true`);
    expect((await request(sock, 'DELETE', '/networks/vk-1')).status).toBeLessThan(400);
    expect(daemon.seen[daemon.seen.length - 1]).toBe(`DELETE /v1.45/networks/${NET_ID}`);
  });

  it('are joined at create by the id they were created with, not by a name anyone may take next', async () => {
    // `docker run --network vk-1` names the network in the create body, twice:
    // HostConfig.NetworkMode and an EndpointsConfig key. If vk-1 was removed
    // and another job made a network of that name, the name would join that
    // job's network. The daemon is sent the id, which it resolves or refuses.
    const dir = tmp();
    const daemon = await networkDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', {
      run: { images: ['alpine:3'], network: 'bridge', networks: [{ name: 'vk-*', internal: true }] },
    });
    expect((await request(sock, 'POST', '/v1.45/networks/create', { Name: 'vk-1', Internal: true })).status).toBe(201);

    expect(
      (
        await request(sock, 'POST', '/v1.45/containers/create', {
          Image: 'alpine:3',
          HostConfig: { NetworkMode: 'vk-1' },
          NetworkingConfig: { EndpointsConfig: { 'vk-1': { Aliases: ['db'], NetworkID: 'vk-1' } } },
        })
      ).status
    ).toBe(201);
    expect(daemon.bodies[daemon.bodies.length - 1]).toEqual({
      Image: 'alpine:3',
      HostConfig: { NetworkMode: NET_ID },
      NetworkingConfig: { EndpointsConfig: { 'vk-1': { Aliases: ['db'], NetworkID: NET_ID } } },
    });

    // The daemon reads these keys in any casing, so the pin does too.
    expect(
      (
        await request(sock, 'POST', '/v1.45/containers/create', {
          Image: 'alpine:3',
          HostConfig: { networkmode: 'vk-1' },
          NetworkingConfig: { endpointsconfig: { 'vk-1': { networkid: '' } } },
        })
      ).status
    ).toBe(201);
    expect(daemon.bodies[daemon.bodies.length - 1]).toEqual({
      Image: 'alpine:3',
      HostConfig: { networkmode: NET_ID },
      NetworkingConfig: { endpointsconfig: { 'vk-1': { NetworkID: NET_ID } } },
    });

    // The declared network is not the job's to pin, and is sent as named.
    expect(
      (
        await request(sock, 'POST', '/v1.45/containers/create', {
          Image: 'alpine:3',
          HostConfig: { NetworkMode: 'bridge' },
          NetworkingConfig: { EndpointsConfig: { bridge: {} } },
        })
      ).status
    ).toBe(201);
    expect(daemon.bodies[daemon.bodies.length - 1]).toEqual({
      Image: 'alpine:3',
      HostConfig: { NetworkMode: 'bridge' },
      NetworkingConfig: { EndpointsConfig: { bridge: {} } },
    });
  });

  it('are recorded under the name whatever casing the client spelled the key with', async () => {
    // The daemon decodes `name` into the same field as `Name`, so it creates
    // the network either way, and the evaluator already judges either way.
    // Reading only `Name` here left the network created but unaddressable: the
    // job could not join, inspect or delete what it had just made.
    const dir = tmp();
    const daemon = await networkDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', {
      run: { images: ['alpine:3'], network: 'bridge', networks: [{ name: 'vk-*', internal: true }] },
    });

    expect((await request(sock, 'POST', '/v1.45/networks/create', { name: 'vk-1', internal: true })).status).toBe(201);

    expect((await request(sock, 'GET', '/v1.45/networks/vk-1')).status).toBeLessThan(400);
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3', HostConfig: { NetworkMode: 'vk-1' } })).status).toBe(201);
  });
});

/** The ids the fake daemons give the networks they create: 64 hex, as dockerd's. */
const NET_ID = 'ae'.repeat(32);
const NET1_ID = '1'.padStart(64, '0');

/** A fake daemon that also answers network create. */
const networkDaemon = (dir: string, networkId: string = NET_ID): Promise<{ sock: string; seen: string[]; bodies: unknown[] }> =>
  new Promise((resolve) => {
    const sock = path.join(dir, 'netd.sock');
    const seen: string[] = [];
    const bodies: unknown[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push(`${req.method} ${req.url}`);
        const body = Buffer.concat(chunks).toString();
        bodies.push(body === '' ? undefined : JSON.parse(body));
        const p = req.url!.replace(/^\/v\d+\.\d+/, '').split('?')[0];
        if (p === '/networks/create') {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: networkId, Warning: '' }));
        } else if (p === '/containers/create') {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: 'abc1230000000000000000000000000000000000000000000000000000000000', Warnings: [] }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    servers.push(server);
    server.listen(sock, () => resolve({ sock, seen, bodies }));
  });

// ---------------------------------------------------------------------------
// /info: a baseline read, cut down to what a client needs to start.
// ---------------------------------------------------------------------------

/** What a daemon says about itself, including much a job has no business reading. */
const FULL_INFO = {
  ID: 'daemon-id',
  Name: 'operators-macbook',
  ServerVersion: '28.0.0',
  OSType: 'linux',
  Architecture: 'aarch64',
  OperatingSystem: 'Docker Desktop',
  KernelVersion: '6.10.14-linuxkit',
  NCPU: 8,
  MemTotal: 8_000_000_000,
  Driver: 'overlay2',
  CgroupVersion: '2',
  SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'],
  DockerRootDir: '/var/lib/docker',
  HttpProxy: 'http://user:secret@corp-proxy:3128',
  HttpsProxy: 'http://user:secret@corp-proxy:3128',
  NoProxy: 'internal.corp',
  RegistryConfig: { Mirrors: ['https://mirror.internal.corp'], InsecureRegistryCIDRs: ['10.0.0.0/8'] },
  Labels: ['com.corp.owner=ops'],
  Containers: 12,
  ContainersRunning: 3,
  Images: 40,
  Swarm: { NodeID: 'node', LocalNodeState: 'active' },
  Plugins: { Volume: ['local'], Network: ['bridge'] },
};

const KEPT_INFO_KEYS = [
  'Architecture', 'CgroupVersion', 'Driver', 'KernelVersion', 'MemTotal',
  'NCPU', 'OSType', 'OperatingSystem', 'SecurityOptions', 'ServerVersion',
];

/** A daemon that answers every request as the test says, and records the headers it was sent. */
const infoDaemon = (
  dir: string,
  answer: (res: http.ServerResponse) => void
): Promise<{ sock: string; seen: http.IncomingHttpHeaders[] }> =>
  new Promise((resolve) => {
    const sock = path.join(dir, 'infod.sock');
    const seen: http.IncomingHttpHeaders[] = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push(req.headers);
        answer(res);
      });
    });
    servers.push(server);
    server.listen(sock, () => resolve({ sock, seen }));
  });

describe('/info through the filter', () => {
  const answerInFull = (res: http.ServerResponse): void => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(FULL_INFO));
  };

  it('keeps only what a client needs, dropping proxy credentials, registry config and the host name', async () => {
    const dir = tmp();
    const daemon = await infoDaemon(dir, answerInFull);
    const { sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });

    const reply = await request(sock, 'GET', '/v1.45/info');

    expect(reply.status).toBe(200);
    const info = JSON.parse(reply.body);
    expect(Object.keys(info).sort()).toEqual(KEPT_INFO_KEYS);
    expect(info.HttpProxy).toBeUndefined();
    expect(info.RegistryConfig).toBeUndefined();
    expect(info.Name).toBeUndefined();
    expect(reply.body).not.toContain('secret');
    expect(info.ServerVersion).toBe('28.0.0');
    expect(info.SecurityOptions).toEqual(FULL_INFO.SecurityOptions);
    expect(Number(reply.headers['content-length'])).toBe(Buffer.byteLength(reply.body));
  });

  it('cuts down an unversioned /info the same way', async () => {
    const dir = tmp();
    const daemon = await infoDaemon(dir, answerInFull);
    const { sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });

    const reply = await request(sock, 'GET', '/info');

    expect(reply.status).toBe(200);
    expect(Object.keys(JSON.parse(reply.body)).sort()).toEqual(KEPT_INFO_KEYS);
  });

  it('cuts down a chunked answer', async () => {
    const dir = tmp();
    const daemon = await infoDaemon(dir, (res) => {
      const body = JSON.stringify(FULL_INFO);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
      res.write(body.slice(0, 40));
      res.end(body.slice(40));
    });
    const { sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });

    const reply = await request(sock, 'GET', '/v1.45/info');

    expect(reply.status).toBe(200);
    expect(reply.headers['transfer-encoding']).toBeUndefined();
    expect(Object.keys(JSON.parse(reply.body)).sort()).toEqual(KEPT_INFO_KEYS);
  });

  it('asks the daemon for an uncompressed answer, and still reads a gzip one', async () => {
    const dir = tmp();
    const daemon = await infoDaemon(dir, (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      res.end(zlib.gzipSync(JSON.stringify(FULL_INFO)));
    });
    const { sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });

    const reply = await request(sock, 'GET', '/v1.45/info', undefined, { 'Accept-Encoding': 'gzip' });

    expect(daemon.seen[0]['accept-encoding']).toBeUndefined();
    expect(reply.status).toBe(200);
    expect(reply.headers['content-encoding']).toBeUndefined();
    expect(Object.keys(JSON.parse(reply.body)).sort()).toEqual(KEPT_INFO_KEYS);
    expect(reply.body).not.toContain('secret');
  });

  it('refuses an answer in an encoding it cannot read, rather than passing it on unread', async () => {
    const dir = tmp();
    const daemon = await infoDaemon(dir, (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'x-unknown' });
      res.end(JSON.stringify(FULL_INFO));
    });
    const { sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });

    const reply = await request(sock, 'GET', '/v1.45/info');

    expect(reply.status).toBe(502);
    expect(reply.body).not.toContain('secret');
    expect(JSON.parse(reply.body).message).toMatch(/info/);
  });

  it('refuses an answer far larger than any real /info, rather than holding it all in memory', async () => {
    const dir = tmp();
    const daemon = await infoDaemon(dir, (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...FULL_INFO, Labels: ['x'.repeat(2 * 1024 * 1024)] }));
    });
    const { sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });

    const reply = await request(sock, 'GET', '/v1.45/info');

    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body).message).toMatch(/info/);
  });

  it('refuses a gzip answer that inflates past the same limit', async () => {
    const dir = tmp();
    const daemon = await infoDaemon(dir, (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      // A few KB on the wire, megabytes once inflated.
      res.end(zlib.gzipSync(JSON.stringify({ ...FULL_INFO, Labels: ['x'.repeat(2 * 1024 * 1024)] })));
    });
    const { sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });

    const reply = await request(sock, 'GET', '/v1.45/info');

    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body).message).toMatch(/info/);
  });

  it('refuses an answer that is not a JSON object', async () => {
    const dir = tmp();
    const daemon = await infoDaemon(dir, (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('HttpProxy: http://user:secret@corp-proxy:3128');
    });
    const { sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });

    const reply = await request(sock, 'GET', '/v1.45/info');

    expect(reply.status).toBe(502);
    expect(reply.body).not.toContain('secret');
  });

  it('passes on only the message of a daemon error', async () => {
    const dir = tmp();
    const daemon = await infoDaemon(dir, (res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'daemon is starting', HttpProxy: 'http://user:secret@corp-proxy:3128' }));
    });
    const { sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });

    const reply = await request(sock, 'GET', '/v1.45/info');

    expect(reply.status).toBe(500);
    expect(JSON.parse(reply.body)).toEqual({ message: 'daemon is starting' });
  });
});

// ---------------------------------------------------------------------------
// What a job leaves behind: containers do not outlive the socket.
// ---------------------------------------------------------------------------

interface LifetimeDaemonOptions {
  /** The status every container removal is answered with. */
  deleteStatus?: number;
  /** The status for a given container's nth removal attempt, counting from 1; overrides deleteStatus. */
  deleteStatusFor?: (id: string, attempt: number) => number;
  /** Keep container removals unanswered until released. */
  holdDeletes?: boolean;
  /** How long each container removal takes to answer. */
  deleteDelayMs?: number;
  /** The newest API version served; a path naming a newer one gets a 400, as a real daemon answers. */
  maxApiVersion?: number;
}

/**
 * A daemon that hands out a fresh id per create, and notes for each request
 * whether the job's socket still existed when it arrived. It also counts the
 * container removals in flight at once, and the ids it removed.
 */
/** The daemon's id for the nth container it creates: 64 hex, as dockerd's are. */
const cid = (n: number): string => `c${n.toString(16).padStart(63, '0')}`;

const lifetimeDaemon = (
  dir: string,
  jobSocket: string,
  options: LifetimeDaemonOptions = {}
): Promise<{
  sock: string;
  seen: string[];
  socketPresent: boolean[];
  removed: Set<string>;
  maxInFlight: () => number;
  release: () => void;
}> =>
  new Promise((resolve) => {
    const sock = path.join(dir, 'lifetime.sock');
    const seen: string[] = [];
    const socketPresent: boolean[] = [];
    const removed = new Set<string>();
    const attempts = new Map<string, number>();
    const held: Array<() => void> = [];
    let released = false;
    let containers = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push(`${req.method} ${req.url}`);
        socketPresent.push(fs.existsSync(jobSocket));
        const version = /^\/v(\d+\.\d+)\//.exec(req.url!)?.[1];
        if (version !== undefined && options.maxApiVersion !== undefined && Number(version) > options.maxApiVersion) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            message: `client version ${version} is too new. Maximum supported API version is ${options.maxApiVersion}`,
          }));
          return;
        }
        const p = req.url!.replace(/^\/v\d+\.\d+/, '').split('?')[0];
        if (p === '/containers/create') {
          containers += 1;
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: cid(containers), Warnings: [] }));
        } else if (p === '/networks/create') {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: NET1_ID, Warning: '' }));
        } else if (req.method === 'DELETE' && p.startsWith('/containers/')) {
          const id = p.slice('/containers/'.length);
          const attempt = (attempts.get(id) ?? 0) + 1;
          attempts.set(id, attempt);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const answer = (): void => {
            inFlight -= 1;
            const status = options.deleteStatusFor?.(id, attempt) ?? options.deleteStatus ?? 204;
            if (status >= 200 && status < 300) removed.add(id);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(status === 204 ? undefined : JSON.stringify({ message: 'removal failed' }));
          };
          if (options.holdDeletes && !released) held.push(answer);
          else if (options.deleteDelayMs) setTimeout(answer, options.deleteDelayMs);
          else answer();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    servers.push(server);
    server.listen(sock, () =>
      resolve({
        sock,
        seen,
        socketPresent,
        removed,
        maxInFlight: () => maxInFlight,
        release: () => {
          released = true;
          for (const answer of held.splice(0)) answer();
        },
      })
    );
  });

describe('containers a job leaves behind', () => {
  const policy = {
    run: { images: ['alpine:3'], network: 'bridge', networks: [{ name: 'vk-*', internal: true }] },
  };

  it('removes the containers it created when it stops, and the networks after them', async () => {
    // docker run -d returns at once, and the container keeps running after the
    // job - with egress no proxy filters - unless something removes it.
    const dir = tmp();
    const sock = path.join(dir, 'docker.sock');
    const daemon = await lifetimeDaemon(dir, sock);
    const { proxy, calls } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', policy);

    expect((await request(sock, 'POST', '/v1.45/containers/create?name=db', { Image: 'alpine:3' })).status).toBe(201);
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' })).status).toBe(201);
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' })).status).toBe(201);
    expect((await request(sock, 'POST', '/v1.45/networks/create', { Name: 'vk-1', Internal: true })).status).toBe(201);
    // The job removed this one itself; it is not removed a second time.
    expect((await request(sock, 'DELETE', `/v1.45/containers/${cid(3)}`)).status).toBeLessThan(400);
    const before = daemon.seen.length;

    await proxy.stop();

    const sweep = daemon.seen.slice(before);
    // Each container once, by id, however many names it had - forced, since a
    // running one is the case that matters, with its anonymous volumes.
    expect(sweep.slice(0, 2).sort()).toEqual([
      `DELETE /containers/${cid(1)}?force=1&v=1`,
      `DELETE /containers/${cid(2)}?force=1&v=1`,
    ]);
    // A network with a container still attached cannot be removed, so it goes last.
    expect(sweep.slice(2)).toEqual([`DELETE /networks/${NET1_ID}`]);
    // The socket was already gone, so the job could not start another meanwhile.
    expect(daemon.socketPresent.slice(before)).toEqual([false, false, false]);
    // The job's requests may boot the VM; the removal only uses one already there.
    expect(calls.endpoints.slice(0, -1).every((e) => e.boot)).toBe(true);
    expect(calls.endpoints.at(-1)).toEqual({ timeoutMs: 0, boot: false });
  });

  it('logs what it could not remove, and still stops', async () => {
    const dir = tmp();
    const sock = path.join(dir, 'docker.sock');
    const daemon = await lifetimeDaemon(dir, sock, { deleteStatus: 500 });
    const { proxy, logs } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', policy);
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' })).status).toBe(201);

    await proxy.stop();

    expect(proxy.isRunning()).toBe(false);
    expect(fs.existsSync(sock)).toBe(false);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes(cid(1)) && /500/.test(l.message))).toBe(true);
  });

  it('logs the containers it could not reach the daemon to remove, and still stops', async () => {
    const dir = tmp();
    const sock = path.join(dir, 'docker.sock');
    const daemon = await lifetimeDaemon(dir, sock);
    let endpoint: string | null = daemon.sock;
    const backend = backendWith(null, false, {
      endpoint: async () => (endpoint ? { kind: 'ready', socketPath: endpoint } : { kind: 'none', reason: 'gone' }),
      running: () => endpoint !== null,
    });
    const { proxy, logs } = await startProxy(dir, { backend });
    proxy.bind('owner/repo', policy);
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' })).status).toBe(201);

    // The daemon went away before the job ended.
    endpoint = path.join(dir, 'gone.sock');
    await proxy.stop();

    expect(proxy.isRunning()).toBe(false);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes(cid(1)))).toBe(true);
  });

  it('makes a second stop wait for the first one to finish removing', async () => {
    // Whoever stops the socket next - the slot's next spawn, or the app
    // quitting - must not go on while the last job's containers still run.
    const dir = tmp();
    const sock = path.join(dir, 'docker.sock');
    const daemon = await lifetimeDaemon(dir, sock, { holdDeletes: true });
    const { proxy } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', policy);
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' })).status).toBe(201);

    const first = proxy.stop();
    const events: string[] = [];
    const second = proxy.stop().then(() => events.push('second stop'));
    for (let waited = 0; !daemon.seen.some((s) => s.startsWith('DELETE')); waited += 5) {
      expect(waited).toBeLessThan(2000);
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 20));
    events.push('removal answered');
    daemon.release();
    await Promise.all([first, second]);

    expect(events).toEqual(['removal answered', 'second stop']);
  });

  it('makes a stop that comes once removals are under way wait for them too', async () => {
    // As it happens in the manager: the worker's exit starts the removals, and
    // the slot's next spawn stops the socket again later, by which time the
    // socket has closed and its record of the job's containers is spent.
    const dir = tmp();
    const sock = path.join(dir, 'docker.sock');
    const daemon = await lifetimeDaemon(dir, sock, { holdDeletes: true });
    const { proxy } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', policy);
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' })).status).toBe(201);

    const first = proxy.stop();
    for (let waited = 0; !daemon.seen.some((s) => s.startsWith('DELETE')); waited += 5) {
      expect(waited).toBeLessThan(2000);
      await new Promise((r) => setTimeout(r, 5));
    }
    const events: string[] = [];
    const second = proxy.stop().then(() => events.push('second stop'));
    await new Promise((r) => setTimeout(r, 50));
    events.push('removal answered');
    daemon.release();
    await Promise.all([first, second]);

    expect(events).toEqual(['removal answered', 'second stop']);
  });

  it('removes them on a daemon older than the API version the socket speaks', async () => {
    // The CLI negotiates down to an older daemon through the clamped ping, so
    // the job's own requests name a version that daemon serves. The sweep is
    // the one request the socket words itself, and a daemon refuses a
    // version newer than its own with a 400 - so it names none.
    const dir = tmp();
    const sock = path.join(dir, 'docker.sock');
    const daemon = await lifetimeDaemon(dir, sock, { maxApiVersion: 1.43 });
    const { proxy, logs } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', policy);
    expect((await request(sock, 'POST', '/v1.43/containers/create', { Image: 'alpine:3' })).status).toBe(201);
    expect((await request(sock, 'POST', '/v1.43/networks/create', { Name: 'vk-1', Internal: true })).status).toBe(201);

    await proxy.stop();

    expect(daemon.removed).toEqual(new Set([cid(1)]));
    expect(daemon.seen).toContain(`DELETE /networks/${NET1_ID}`);
    expect(logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('removes many a few at a time, and tries a failed removal again', async () => {
    // A job can leave as many containers as it likes. They are removed a few
    // at a time rather than all at once, and one refused the first time is
    // asked for again, so no one failure decides which of them survive.
    const dir = tmp();
    const sock = path.join(dir, 'docker.sock');
    const daemon = await lifetimeDaemon(dir, sock, {
      deleteDelayMs: 5,
      deleteStatusFor: (id, attempt) => (Number(id.slice(1)) % 3 === 0 && attempt === 1 ? 500 : 204),
    });
    const { proxy, logs } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', policy);
    for (let i = 0; i < 50; i += 1) {
      expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' })).status).toBe(201);
    }

    await proxy.stop();

    expect(daemon.removed.size).toBe(50);
    expect(daemon.maxInFlight()).toBeGreaterThan(1);
    expect(daemon.maxInFlight()).toBeLessThanOrEqual(8);
    expect(logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('counts a container the daemon was already removing as removed once it is gone', async () => {
    // docker run -d --rm: the daemon removes the container itself when it is
    // killed, and may answer the forced removal racing it with a 409.
    const dir = tmp();
    const sock = path.join(dir, 'docker.sock');
    const daemon = await lifetimeDaemon(dir, sock, { deleteStatusFor: (_id, attempt) => (attempt === 1 ? 409 : 404) });
    const { proxy, logs } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', policy);
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' })).status).toBe(201);

    await proxy.stop();

    expect(daemon.seen.filter((s) => s.startsWith('DELETE'))).toHaveLength(2);
    expect(logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('counts a container the daemon no longer has as removed, without a warning', async () => {
    const dir = tmp();
    const sock = path.join(dir, 'docker.sock');
    const daemon = await lifetimeDaemon(dir, sock, { deleteStatus: 404 });
    const { proxy, logs } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', policy);
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' })).status).toBe(201);

    await proxy.stop();

    expect(daemon.seen.filter((s) => s.startsWith('DELETE'))).toEqual([`DELETE /containers/${cid(1)}?force=1&v=1`]);
    expect(logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('gives up on a removal the daemon never answers, and still stops', async () => {
    // A hung daemon must not hold the slot's next worker, or the app
    // quitting, forever.
    const dir = tmp();
    const sock = path.join(dir, 'docker.sock');
    const daemon = await lifetimeDaemon(dir, sock, { holdDeletes: true });
    const { proxy, logs } = await startProxy(dir, { backend: backendWith(daemon.sock), removeTimeoutMs: 50 });
    proxy.bind('owner/repo', policy);
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' })).status).toBe(201);

    await proxy.stop();

    expect(proxy.isRunning()).toBe(false);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes(`container ${cid(1)}`) && /no answer/.test(l.message))).toBe(true);
  }, 3000);
});

// ---------------------------------------------------------------------------
// The per-job VM (contract §5.3), against a fake WorkerDocker.
// ---------------------------------------------------------------------------

describe('the worker behind the socket', () => {
  const CID = 'f'.repeat(64);
  const proxyEnv = {
    HTTP_PROXY: 'http://localmost:tok@198.18.0.1:3128',
    HTTPS_PROXY: 'http://localmost:tok@198.18.0.1:3128',
    http_proxy: 'http://localmost:tok@198.18.0.1:3128',
    https_proxy: 'http://localmost:tok@198.18.0.1:3128',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  };

  /** A daemon answering create with CID and everything else with 200, recording all it is sent. */
  const vmDaemon = (dir: string, answers: Record<string, (res: http.ServerResponse) => void> = {}) =>
    new Promise<{ sock: string; seen: Seen[] }>((resolve) => {
      const sock = path.join(dir, 'vm.sock');
      const seen: Seen[] = [];
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
          const p = req.url!.replace(/^\/v\d+\.\d+/, '').split('?')[0];
          const custom = answers[`${req.method} ${p}`];
          if (custom) return custom(res);
          if (p === '/containers/create') {
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ Id: CID, Warnings: [] }));
          } else if (p === '/networks/create') {
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ Id: seen.length.toString(16).padStart(64, '0'), Warning: '' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{}');
          }
        });
      });
      servers.push(server);
      server.listen(sock, () => resolve({ sock, seen }));
    });

  const policy: DockerPolicy = {
    run: { images: ['alpine:3'], mounts: [{ path: './', mode: 'rw' }], network: 'bridge', networks: [{ name: 'open-*', internal: false }, { name: 'vk-*', internal: true }] },
    build: { context: './', tags: ['app:*'] },
  };

  const envOf = (seen: Seen): string[] => (JSON.parse(seen.body.toString()) as { Env?: string[] }).Env ?? [];

  it('tells the worker of every bind, which decides whether one boots a VM', async () => {
    const dir = tmp();
    const { proxy, calls } = await startProxy(dir, { backend: backendWith(null) });
    proxy.bind('owner/repo', policy);
    proxy.bind('owner/repo', {});
    expect(calls.binds).toEqual([{ repository: 'owner/repo', policy }, { repository: 'owner/repo', policy: {} }]);
  });

  it('drops the job\'s registry credentials from every request, a build\'s included', async () => {
    const dir = tmp();
    const daemon = await vmDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', policy);
    const forged = { 'X-Registry-Auth': 'forged', 'X-Registry-Config': 'forged' };
    await request(sock, 'POST', '/v1.45/build?t=app', 'tar', { 'content-type': 'application/x-tar', ...forged });
    await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' }, forged);
    await request(sock, 'GET', '/v1.45/version', undefined, forged);
    expect(daemon.seen).toHaveLength(3);
    for (const seen of daemon.seen) {
      expect([seen.url, seen.headers['x-registry-auth'], seen.headers['x-registry-config']]).toEqual([seen.url, undefined, undefined]);
    }
  });

  it('refuses POST /auth and the checkpoint endpoints, whatever the policy', async () => {
    const dir = tmp();
    const daemon = await vmDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', { ...policy, pull: { registries: ['docker.io'] } });
    const owned = await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' });
    expect(owned.status).toBe(201);
    for (const [method, url] of [
      ['POST', '/v1.45/auth'],
      ['GET', `/v1.45/containers/${CID}/checkpoints`],
      ['POST', `/v1.45/containers/${CID}/checkpoints`],
      ['DELETE', `/v1.45/containers/${CID}/checkpoints/c1`],
    ]) {
      const reply = await request(sock, method, url, method === 'POST' ? {} : undefined);
      expect([method, url, reply.status]).toEqual([method, url, 403]);
    }
    expect(daemon.seen.map((s) => s.url)).toEqual(['/v1.45/containers/create']);
  });

  describe('a container create', () => {
    it('gets the job\'s proxy on the default bridge, keeping any variable the job set', async () => {
      const dir = tmp();
      const daemon = await vmDaemon(dir);
      const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, false, { containerProxyEnv: () => proxyEnv }) });
      proxy.bind('owner/repo', policy);
      await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3', Env: ['HTTPS_PROXY=http://mine:1', 'A=b'] });
      await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3', HostConfig: { NetworkMode: 'default' } });
      const [custom, plain] = daemon.seen.map(envOf);
      expect(custom).toEqual([
        'HTTPS_PROXY=http://mine:1',
        'A=b',
        'HTTP_PROXY=http://localmost:tok@198.18.0.1:3128',
        'http_proxy=http://localmost:tok@198.18.0.1:3128',
        'https_proxy=http://localmost:tok@198.18.0.1:3128',
        'NO_PROXY=localhost,127.0.0.1,::1',
        'no_proxy=localhost,127.0.0.1,::1',
      ]);
      expect(plain.sort()).toEqual(Object.entries(proxyEnv).map(([k, v]) => `${k}=${v}`).sort());
    });

    it('gets it on a network the job created routable, and not on an internal one or none', async () => {
      const dir = tmp();
      const daemon = await vmDaemon(dir);
      const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, false, { containerProxyEnv: () => proxyEnv }) });
      proxy.bind('owner/repo', policy);
      expect((await request(sock, 'POST', '/v1.45/networks/create', { Name: 'open-1', Internal: false })).status).toBe(201);
      expect((await request(sock, 'POST', '/v1.45/networks/create', { Name: 'vk-1', Internal: true })).status).toBe(201);
      const creates = [
        { Image: 'alpine:3', HostConfig: { NetworkMode: 'open-1' } },
        { Image: 'alpine:3', HostConfig: { NetworkMode: 'vk-1' } },
        { Image: 'alpine:3', HostConfig: { NetworkMode: 'none' } },
        { Image: 'alpine:3', HostConfig: { NetworkMode: 'vk-1' }, NetworkingConfig: { EndpointsConfig: { 'vk-1': {}, 'open-1': {} } } },
      ];
      for (const body of creates) expect((await request(sock, 'POST', '/v1.45/containers/create', body)).status).toBe(201);
      const envs = daemon.seen.slice(2).map(envOf);
      expect(envs.map((env) => env.some((e) => e.startsWith('HTTP_PROXY=')))).toEqual([true, false, false, true]);
    });

    it('is not given a proxy when the worker has none to give', async () => {
      const dir = tmp();
      const daemon = await vmDaemon(dir);
      const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
      proxy.bind('owner/repo', policy);
      await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' });
      expect(JSON.parse(daemon.seen[0].body.toString())).toEqual({ Image: 'alpine:3' });
    });

    it('is answered, and owned, only once the VM has its approved binds; a start by name before then is refused', async () => {
      const dir = tmp();
      const workspace = fs.realpathSync(dir);
      fs.mkdirSync(path.join(workspace, 'data'));
      const daemon = await vmDaemon(dir);
      let approve!: () => void;
      const approvals: Array<{ containerId: string; binds: ApprovedBind[] }> = [];
      const fixture = backendWith(daemon.sock, false, {
        approveBinds: (containerId, binds) => {
          approvals.push({ containerId, binds });
          return new Promise<void>((resolve) => (approve = resolve));
        },
      });
      const { proxy, sock } = await startProxy(dir, { backend: fixture });
      proxy.bind('owner/repo', policy);

      const created = request(sock, 'POST', '/v1.45/containers/create?name=db', {
        Image: 'alpine:3',
        HostConfig: { Binds: [`${workspace}/data:/data/:ro`] },
      });
      await new Promise<void>((resolve) => {
        const poll = () => (approvals.length > 0 ? resolve() : setTimeout(poll, 5));
        poll();
      });
      expect(approvals).toEqual([{ containerId: CID, binds: [{ source: `${workspace}/data`, destination: '/data', readOnly: true }] }]);
      const early = await request(sock, 'POST', '/v1.45/containers/db/start');
      expect(early.status).toBe(403);

      approve();
      const reply = await created;
      expect(reply.status).toBe(201);
      expect(JSON.parse(reply.body).Id).toBe(CID);
      expect((await request(sock, 'POST', '/v1.45/containers/db/start')).status).toBe(200);
      expect(daemon.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
        'POST /v1.45/containers/create?name=db',
        `POST /v1.45/containers/${CID}/start`,
      ]);
    });

    it('removes the container and answers 500 when the approval fails', async () => {
      const dir = tmp();
      const daemon = await vmDaemon(dir);
      const fixture = backendWith(daemon.sock, false, {
        approveBinds: async () => {
          throw new Error('the guest agent did not answer approve-binds in 10s');
        },
      });
      const { proxy, sock, logs } = await startProxy(dir, { backend: fixture });
      proxy.bind('owner/repo', policy);

      const reply = await request(sock, 'POST', '/v1.45/containers/create?name=db', { Image: 'alpine:3' });
      expect(reply.status).toBe(500);
      expect(JSON.parse(reply.body).message).toBe("could not register the approved binds with the job's Docker VM");
      expect(daemon.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
        'POST /v1.45/containers/create?name=db',
        `DELETE /containers/${CID}?force=1`,
      ]);
      expect((await request(sock, 'POST', '/v1.45/containers/db/start')).status).toBe(403);
      expect(logs.some((l) => l.level === 'warn' && /approve-binds/.test(l.message))).toBe(true);
    });

    it('refuses an answer with no container id in it', async () => {
      const dir = tmp();
      const daemon = await vmDaemon(dir, {
        'POST /containers/create': (res) => {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: '../../etc', Warnings: [] }));
        },
      });
      const { proxy, sock, calls } = await startProxy(dir, { backend: backendWith(daemon.sock) });
      proxy.bind('owner/repo', policy);
      expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' })).status).toBe(502);
      expect(calls.approvals).toEqual([]);
    });
  });

  describe('a digest reference', () => {
    const DIGEST = `sha256:${'d'.repeat(64)}`;
    const IMAGE_ID = `sha256:${'c'.repeat(64)}`;
    const digestPolicy: DockerPolicy = { run: { images: ['alpine:3', `alpine@${DIGEST}`], network: 'bridge' } };
    const byDigest = { registry: 'docker.io', repositoryPath: 'library/alpine', digest: DIGEST };

    /** A worker that pulled alpine@DIGEST this job, and records what it was asked. */
    const pulledWorker = (sock: string, known: string | null = IMAGE_ID) => {
      const asked: PullRequest[] = [];
      const fixture = backendWith(sock, false, {
        imageForDigest: (req) => {
          asked.push(req);
          return req.registry === byDigest.registry && req.repositoryPath === byDigest.repositoryPath && req.digest === DIGEST ? (known ?? undefined) : undefined;
        },
      });
      return { fixture, asked };
    };

    it("is created by the image id this job's pull by digest resolved it to, however it is spelled", async () => {
      const dir = tmp();
      const daemon = await vmDaemon(dir);
      const { fixture, asked } = pulledWorker(daemon.sock);
      const { proxy, sock } = await startProxy(dir, { backend: fixture });
      proxy.bind('owner/repo', digestPolicy);
      for (const image of [`alpine@${DIGEST}`, `docker.io/library/alpine@${DIGEST}`]) {
        expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: image })).status).toBe(201);
      }
      expect(daemon.seen.map((s) => JSON.parse(s.body.toString()).Image)).toEqual([IMAGE_ID, IMAGE_ID]);
      expect(asked).toEqual([byDigest, byDigest]);
    });

    it('is inspected by that image id', async () => {
      const dir = tmp();
      const daemon = await vmDaemon(dir);
      const { proxy, sock } = await startProxy(dir, { backend: pulledWorker(daemon.sock).fixture });
      proxy.bind('owner/repo', digestPolicy);
      expect((await request(sock, 'GET', `/v1.45/images/alpine@${DIGEST}/json`)).status).toBe(200);
      expect((await request(sock, 'GET', `/images/${encodeURIComponent(`alpine@${DIGEST}`)}/json`)).status).toBe(200);
      expect(daemon.seen.map((s) => s.url)).toEqual([`/v1.45/images/${IMAGE_ID}/json`, `/v1.45/images/${IMAGE_ID}/json`]);
    });

    it('goes as the job wrote it when no pull of this job resolved it, and a tag is never looked up', async () => {
      const dir = tmp();
      const daemon = await vmDaemon(dir);
      const { fixture, asked } = pulledWorker(daemon.sock, null);
      const { proxy, sock } = await startProxy(dir, { backend: fixture });
      proxy.bind('owner/repo', digestPolicy);
      await request(sock, 'POST', '/v1.45/containers/create', { Image: `alpine@${DIGEST}` });
      await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' });
      await request(sock, 'GET', `/v1.45/images/alpine@${DIGEST}/json`);
      expect(daemon.seen.map((s) => (s.body.length ? JSON.parse(s.body.toString()).Image : s.url))).toEqual([
        `alpine@${DIGEST}`,
        'alpine:3',
        `/v1.45/images/alpine@${DIGEST}/json`,
      ]);
      expect(asked).toEqual([byDigest, byDigest]);
    });

    it('is judged by the policy as the job wrote it, before any lookup', async () => {
      const dir = tmp();
      const daemon = await vmDaemon(dir);
      const { fixture, asked } = pulledWorker(daemon.sock);
      const { proxy, sock } = await startProxy(dir, { backend: fixture });
      proxy.bind('owner/repo', { run: { images: ['alpine:3'], network: 'bridge' } });
      expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: `alpine@${DIGEST}` })).status).toBe(403);
      expect((await request(sock, 'GET', `/v1.45/images/alpine@${DIGEST}/json`)).status).toBe(403);
      expect(daemon.seen).toEqual([]);
      expect(asked).toEqual([]);
    });

    it('is left alone when the worker answers something that is not an image id', async () => {
      const dir = tmp();
      const daemon = await vmDaemon(dir);
      const { proxy, sock } = await startProxy(dir, { backend: pulledWorker(daemon.sock, '../../containers/x').fixture });
      proxy.bind('owner/repo', digestPolicy);
      await request(sock, 'POST', '/v1.45/containers/create', { Image: `alpine@${DIGEST}` });
      await request(sock, 'GET', `/v1.45/images/alpine@${DIGEST}/json`);
      expect(JSON.parse(daemon.seen[0].body.toString()).Image).toBe(`alpine@${DIGEST}`);
      expect(daemon.seen[1].url).toBe(`/v1.45/images/alpine@${DIGEST}/json`);
    });
  });

  describe('a daemon answer the filter holds to parse', () => {
    /** Streams JSON-looking bytes until the filter hangs up; resolves with how many it wrote. */
    const flood = (status: number) => {
      let written = 0;
      let done!: (n: number) => void;
      const finished = new Promise<number>((resolve) => (done = resolve));
      const answer = (res: http.ServerResponse) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        const chunk = Buffer.alloc(64 * 1024, 'a');
        const pump = () => {
          while (written < 64 * 1024 * 1024) {
            written += chunk.length;
            if (!res.write(chunk)) {
              res.once('drain', pump);
              return;
            }
          }
          res.end();
        };
        res.on('close', () => done(written));
        pump();
      };
      return { answer, finished };
    };

    it.each([
      ['a create', 'POST /containers/create', 201, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' }],
      ['a network create', 'POST /networks/create', 201, 'POST', '/v1.45/networks/create', { Name: 'vk-1', Internal: true }],
      ['/version', 'GET /version', 200, 'GET', '/v1.45/version', undefined],
    ] as Array<[string, string, number, string, string, unknown]>)('is refused with 502 when %s answer is oversized, without holding it', async (_what, key, status, method, url, body) => {
      const dir = tmp();
      const { answer, finished } = flood(status);
      const daemon = await vmDaemon(dir, { [key]: answer });
      const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
      proxy.bind('owner/repo', policy);
      const reply = await request(sock, method, url, body);
      expect(reply.status).toBe(502);
      expect(JSON.parse(reply.body).message).toBe('the Docker VM sent an oversized answer');
      // Cut off long before the daemon was done.
      expect(await finished).toBeLessThan(16 * 1024 * 1024);
    });

    it('is not held at all when it is a stream the filter only relays: an inspect is piped', async () => {
      const dir = tmp();
      const big = 'x'.repeat(2 * 1024 * 1024);
      const daemon = await vmDaemon(dir, {
        [`GET /containers/${CID}/json`]: (res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: CID, pad: big }));
        },
      });
      const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
      proxy.bind('owner/repo', policy);
      await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' });
      const reply = await request(sock, 'GET', `/v1.45/containers/${CID}/json`);
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body).pad).toHaveLength(big.length);
    });
  });

  it("merges the job's proxy into a build's buildargs, keeping the job's values", async () => {
    const dir = tmp();
    const daemon = await vmDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, false, { containerProxyEnv: () => proxyEnv }) });
    proxy.bind('owner/repo', policy);
    const own = encodeURIComponent(JSON.stringify({ HTTP_PROXY: 'http://mine:1', VERSION: '2' }));
    await request(sock, 'POST', `/v1.45/build?t=app&buildargs=${own}`, 'tar', { 'content-type': 'application/x-tar' });
    await request(sock, 'POST', '/build?t=app', 'tar', { 'content-type': 'application/x-tar' });
    const [withOwn, bare] = daemon.seen.map((s) => new URL(s.url, 'http://x'));
    expect(withOwn.pathname).toBe('/v1.45/build');
    expect(withOwn.searchParams.get('t')).toBe('app');
    expect(JSON.parse(withOwn.searchParams.get('buildargs')!)).toEqual({ ...proxyEnv, HTTP_PROXY: 'http://mine:1', VERSION: '2' });
    expect(bare.pathname).toBe('/v1.45/build');
    expect(JSON.parse(bare.searchParams.get('buildargs')!)).toEqual(proxyEnv);
  });

  it('logs the base-image rule once when a build cannot reach a registry from the VM', async () => {
    const dir = tmp();
    const daemon = await vmDaemon(dir, {
      'POST /build': (res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write(JSON.stringify({ stream: 'Step 1/2 : FROM node:22\n' }) + '\n');
        res.end(JSON.stringify({ errorDetail: { message: 'Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io on 198.18.0.1:53: connection refused' } }) + '\n');
      },
    });
    const { proxy, sock, logs } = await startProxy(dir, { backend: backendWith(daemon.sock) });
    proxy.bind('owner/repo', policy);
    for (let i = 0; i < 2; i++) await request(sock, 'POST', '/v1.45/build?t=app', 'tar', { 'content-type': 'application/x-tar' });
    expect(logs.filter((l) => /pull the base images with docker pull before docker build/.test(l.message))).toHaveLength(1);
  });

  describe('the baseline', () => {
    const baselineWorker = (running: boolean) =>
      backendWith(null, false, {
        running: () => running,
        baseline: (p): { status: number; headers: Record<string, string>; body: unknown } =>
          p === '/_ping'
            ? { status: 200, headers: { 'Api-Version': '1.54', 'Content-Type': 'text/plain; charset=utf-8', 'Builder-Version': '1' }, body: 'OK' }
            : p === '/version'
              ? { status: 200, headers: { 'Api-Version': '1.54', 'Content-Type': 'application/json' }, body: { Version: '29.5.3', ApiVersion: '1.54' } }
              : { status: 200, headers: { 'Content-Type': 'application/json' }, body: { OSType: 'linux', NCPU: 4 } },
        endpoint: async () => ({ kind: 'none', reason: 'the job has no Docker VM' }),
      });

    it('is answered from the worker with no VM running, clamped as a forwarded one is, and boots nothing', async () => {
      const dir = tmp();
      const { sock } = await startProxy(dir, { backend: baselineWorker(false) });
      const ping = await request(sock, 'GET', '/_ping');
      expect([ping.status, ping.body, ping.headers['api-version'], ping.headers['builder-version']]).toEqual([200, 'OK', '1.45', '1']);
      const head = await request(sock, 'HEAD', '/_ping');
      expect([head.status, head.body]).toEqual([200, '']);
      const version = await request(sock, 'GET', '/v1.45/version');
      expect(JSON.parse(version.body)).toEqual({ Version: '29.5.3', ApiVersion: '1.45' });
      const info = await request(sock, 'GET', '/v1.45/info');
      expect(JSON.parse(info.body)).toEqual({ OSType: 'linux', NCPU: 4 });
    });

    it('is forwarded, and /info cut down, once a VM is running', async () => {
      const dir = tmp();
      const daemon = await vmDaemon(dir, {
        'GET /info': (res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ OSType: 'linux', Name: 'the-vm', HttpProxy: 'http://secret' }));
        },
      });
      const { sock } = await startProxy(dir, { backend: backendWith(daemon.sock) });
      const info = await request(sock, 'GET', '/v1.45/info');
      expect(JSON.parse(info.body)).toEqual({ OSType: 'linux' });
      expect(daemon.seen.map((s) => s.url)).toEqual(['/v1.45/info']);
    });
  });

  describe('waiting for the VM', () => {
    it('forwards once the VM is ready, having waited for it', async () => {
      const dir = tmp();
      const daemon = await vmDaemon(dir);
      let ready!: () => void;
      const booted = new Promise<void>((resolve) => (ready = resolve));
      const waits: Array<[number, boolean | undefined]> = [];
      const fixture = backendWith(daemon.sock, false, {
        endpoint: async (timeoutMs, options) => {
          waits.push([timeoutMs, options?.boot]);
          await booted;
          return { kind: 'ready', socketPath: daemon.sock };
        },
      });
      const { proxy, sock } = await startProxy(dir, { backend: fixture, bootTimeoutMs: 45_000 });
      proxy.bind('owner/repo', policy);
      const pending = request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(daemon.seen).toHaveLength(0);
      ready();
      expect((await pending).status).toBe(201);
      // The job's first request that needs the daemon is what boots the VM.
      expect(waits).toEqual([[45_000, true]]);
    });

    it("answers 503 with the worker's reason when there is no VM, and says so once at warn", async () => {
      const dir = tmp();
      const fixture = backendWith(null, false, {
        endpoint: async () => ({ kind: 'none', reason: 'no Docker VM capacity' }),
      });
      const { proxy, sock, logs } = await startProxy(dir, { backend: fixture });
      proxy.bind('owner/repo', policy);
      for (let i = 0; i < 2; i++) {
        const reply = await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' });
        expect([reply.status, JSON.parse(reply.body).message]).toEqual([503, 'no Docker VM capacity']);
      }
      const attach = await request(sock, 'POST', '/v1.45/containers/x/attach?stream=1', undefined, { Connection: 'Upgrade', Upgrade: 'tcp' });
      expect(attach.status).toBe(403);
      expect(logs.filter((l) => l.level === 'warn' && /no Docker VM capacity/.test(l.message))).toHaveLength(1);
    });
  });

  describe('stopping', () => {
    it('removes nothing from a daemon that goes with the worker, and releases the worker', async () => {
      const dir = tmp();
      const daemon = await vmDaemon(dir);
      const fixture = backendWith(daemon.sock, false, { disposable: true });
      const { proxy, sock, calls } = await startProxy(dir, { backend: fixture });
      proxy.bind('owner/repo', policy);
      expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' })).status).toBe(201);
      await proxy.stop();
      expect(daemon.seen.filter((s) => s.method === 'DELETE')).toEqual([]);
      expect(calls.releases).toBe(1);
    });

    it('still removes what the job made from a daemon it shares, then releases', async () => {
      const dir = tmp();
      const daemon = await vmDaemon(dir);
      const { proxy, sock, calls } = await startProxy(dir, { backend: backendWith(daemon.sock) });
      proxy.bind('owner/repo', policy);
      expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3' })).status).toBe(201);
      await proxy.stop();
      expect(daemon.seen.filter((s) => s.method === 'DELETE').map((s) => s.url)).toEqual([`/containers/${CID}?force=1&v=1`]);
      expect(calls.releases).toBe(1);
    });
  });
});
