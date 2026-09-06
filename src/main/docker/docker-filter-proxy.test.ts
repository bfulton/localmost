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
import { DockerFilterProxy, DockerFilterProxyLogEntry } from './docker-filter-proxy';
import { DockerBackend } from './docker-backend';

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

const backendWith = (endpoint: string | null, sandboxDir: string, supportsPrivileged = false): DockerBackend => ({
  name: 'test',
  supportsPrivileged,
  resolveEndpoint: () => (endpoint ? { socketPath: endpoint } : null),
  workspaceMountRoot: () => sandboxDir,
});

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
  opts: Partial<ConstructorParameters<typeof DockerFilterProxy>[0]> & { backend?: DockerBackend } = {}
): Promise<{ proxy: DockerFilterProxy; sock: string; logs: DockerFilterProxyLogEntry[] }> => {
  const logs: DockerFilterProxyLogEntry[] = [];
  const sock = path.join(dir, 'docker.sock');
  const proxy = new DockerFilterProxy({
    backend: opts.backend ?? backendWith(null, dir),
    onLog: (entry) => logs.push(entry),
    ...opts,
  });
  proxies.push(proxy);
  await proxy.start(sock);
  return { proxy, sock, logs };
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
    const { proxy, sock, logs } = await startProxy(dir, { backend: backendWith(null, dir) });
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
    const proxy = new DockerFilterProxy({ backend: backendWith(null, dir) });
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
          res.end(JSON.stringify({ Id: 'abc123', Warnings: [] }));
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
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, dir) });
    proxy.bind('owner/repo', runPolicy);

    const reply = await request(sock, 'POST', '/v1.45/containers/create?name=db', { Image: 'postgres:16' }, { Connection: 'keep-alive' });

    expect(reply.status).toBe(201);
    expect(JSON.parse(reply.body).Id).toBe('abc123');
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
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, dir) });
    proxy.bind('owner/repo', runPolicy);

    const reply = await request(sock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16', HostConfig: { Binds: ['/etc:/x'] } });

    expect(reply.status).toBe(403);
    expect(daemon.seen).toHaveLength(0);
  });

  it('pins an unversioned request to the version it understands when forwarding', async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, dir) });
    proxy.bind('owner/repo', runPolicy);

    await request(sock, 'POST', '/containers/create', { Image: 'postgres:16' });

    expect(daemon.seen[0].url).toBe('/v1.45/containers/create');
  });

  it('attaches registry auth on a pull so the job never holds the secret', async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, {
      backend: backendWith(daemon.sock, dir),
      attachRegistryAuth: (registry) => (registry === 'docker.io' ? 'dG9rZW4=' : undefined),
    });
    proxy.bind('owner/repo', { pull: { registries: ['docker.io', 'ghcr.io'] } });

    // The job sends a header of its own; it must not reach the daemon.
    const reply = await request(sock, 'POST', '/v1.45/images/create?fromImage=postgres&tag=16', undefined, { 'X-Registry-Auth': 'forged' });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('Pulling');
    expect(daemon.seen[0].headers['x-registry-auth']).toBe('dG9rZW4=');

    // A registry we hold nothing for is forwarded with no auth at all.
    await request(sock, 'POST', '/v1.45/images/create?fromImage=ghcr.io%2Fowner%2Fapp&tag=1', undefined, { 'X-Registry-Auth': 'forged' });
    expect(daemon.seen[1].headers['x-registry-auth']).toBeUndefined();
  });

  it('clamps the API version the daemon advertises, so the client negotiates down to ours', async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { sock } = await startProxy(dir, { backend: backendWith(daemon.sock, dir) });

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
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, dir) });
    proxy.bind('owner/repo', { build: { context: './' } });

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
    const { proxy, sock: proxySock } = await startProxy(dir, { backend: backendWith(sock, dir) });
    proxy.bind('owner/repo', { build: { context: './' } });

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
    const { proxy, sock: proxySock } = await startProxy(dir, { backend: backendWith(sock, dir) });
    proxy.bind('owner/repo', { build: { context: './' } });

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
        res.end(JSON.stringify({ Id: 'abc', Warnings: [] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      new Promise<void>((r) => { releaseBody = r; }).then(() => res.end(JSON.stringify({ StatusCode: 0 })));
    });
    servers.push(daemon);
    await new Promise<void>((r) => daemon.listen(sock, () => r()));
    const { proxy, sock: proxySock } = await startProxy(dir, { backend: backendWith(sock, dir) });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });
    // Own the container first, as `docker run` does.
    expect((await request(proxySock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16' })).status).toBe(201);

    const headersSeen = new Promise<number>((resolve, reject) => {
      const req = http.request({ socketPath: proxySock, path: '/v1.45/containers/abc/wait?condition=next-exit', method: 'POST', agent: false }, (res) => {
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
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, dir), realpath: undefined });
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
        // answers the create that precedes the attach, then upgrades.
        if (buffered.slice(0, end).includes('/containers/create')) {
          const payload = JSON.stringify({ Id: 'abc123', Warnings: [] });
          socket.write(
            `HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n${payload}`
          );
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
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, dir) });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });
    // Own the container first, as `docker run` does before attaching.
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16' })).status).toBe(201);

    const { head, socket } = await attach(sock, '/v1.45/containers/abc123/attach?stream=1&stdin=1&stdout=1', 'X-Registry-Auth: forged\r\n');
    expect(head).toMatch(/^HTTP\/1\.1 101/);
    expect(daemon.heads[0]).toMatch(/^POST \/v1\.45\/containers\/abc123\/attach\?stream=1&stdin=1&stdout=1 HTTP\/1\.1/);
    expect(daemon.heads[0]).toMatch(/Upgrade: tcp/);
    expect(daemon.heads[0]).not.toMatch(/X-Registry-Auth/i);

    socket.write('hello');
    expect(await readOnce(socket)).toBe('HELLO');
    socket.destroy();
  });

  it('refuses an attach the policy does not permit on the raw connection, before the daemon sees it', async () => {
    const dir = tmp();
    const daemon = await fakeAttachDaemon(dir);
    const { sock } = await startProxy(dir, { backend: backendWith(daemon.sock, dir) });

    const { head, socket } = await attach(sock, '/v1.45/containers/abc123/attach?stream=1');
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
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, dir) });
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
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, dir) });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });

    // Before any create, the socket owns nothing: the whole `docker run`
    // sequence must be refused against an id it never handed out.
    const foreignStart = await request(sock, 'POST', '/v1.45/containers/theirs999/start');
    expect(foreignStart.status).toBe(403);

    // The fake daemon answers create with Id 'abc123'.
    const created = await request(sock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16' });
    expect(created.status).toBe(201);

    // Now the verbs the CLI issues next must go through for that container.
    for (const [method, url] of [
      ['GET', '/v1.45/containers/abc123/json'],
      ['POST', '/v1.45/containers/abc123/start'],
      ['POST', '/v1.45/containers/abc123/wait'],
      ['DELETE', '/v1.45/containers/abc123'],
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
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, dir) });
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
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, dir) });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], network: 'bridge' } });

    const { head, socket } = await attach(sock, '/v1.45/containers/theirs999/attach?stream=1');
    socket.destroy();
    expect(head).not.toMatch(/101/);
  });
});

describe('mount sources are pinned before forwarding', () => {
  it('sends the daemon the resolved path, so a swapped symlink cannot change what is mounted', async () => {
    const dir = tmp();
    const workspace = fs.realpathSync.native(dir);
    const real = path.join(workspace, 'inside');
    const link = path.join(workspace, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);

    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, {
      backend: { name: 'test', supportsPrivileged: false, resolveEndpoint: () => ({ socketPath: daemon.sock }), workspaceMountRoot: () => workspace },
    });
    proxy.bind('owner/repo', { run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'rw' }], network: 'bridge' } });

    const reply = await request(sock, 'POST', '/v1.45/containers/create', {
      Image: 'postgres:16',
      HostConfig: { Binds: [`${link}:/ws`] },
    });
    expect(reply.status).toBe(201);

    // The filter resolved `link` to decide. If it forwards the spelling it was
    // given, the daemon resolves it again at mount time and the job can swap
    // the symlink in between.
    const create = daemon.seen.find((s) => s.url.includes('/containers/create'))!;
    const binds = (JSON.parse(create.body.toString()) as { HostConfig: { Binds: string[] } }).HostConfig.Binds;
    expect(binds[0]).toBe(`${real}:/ws`);
  });
});

describe('a request target the filter cannot read', () => {
  it('is refused, and the connection does not hang', async () => {
    const dir = tmp();
    const daemon = await fakeDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, dir) });
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
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, dir) });
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
    expect((await request(sock, 'GET', '/v1.45/containers/abc123/json')).status).toBe(403);
  });

  it('does not accept a bare prefix of an owned id', async () => {
    const { sock } = await setup();
    // The fake daemon answers create with Id abc123. A prefix could resolve on
    // the real daemon to a container this job never created.
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'postgres:16' })).status).toBe(201);
    expect((await request(sock, 'GET', '/v1.45/containers/abc123/json')).status).toBeLessThan(400);
    expect((await request(sock, 'GET', '/v1.45/containers/ab/json')).status).toBe(403);
  });
});

describe('networks a job creates', () => {
  it('may be read, joined and deleted, and are forgotten once removed', async () => {
    const dir = tmp();
    const daemon = await networkDaemon(dir);
    const { proxy, sock } = await startProxy(dir, { backend: backendWith(daemon.sock, dir) });
    proxy.bind('owner/repo', {
      run: { images: ['alpine:3'], network: 'bridge', networks: [{ name: 'vk-*', internal: true }] },
    });

    expect((await request(sock, 'POST', '/v1.45/networks/create', { Name: 'vk-1', Internal: true })).status).toBe(201);

    // Both the id the daemon assigned and the name the job asked for.
    expect((await request(sock, 'GET', '/v1.45/networks/net123')).status).toBeLessThan(400);
    expect((await request(sock, 'GET', '/v1.45/networks/vk-1')).status).toBeLessThan(400);
    // A container may join it.
    expect((await request(sock, 'POST', '/v1.45/containers/create', { Image: 'alpine:3', HostConfig: { NetworkMode: 'vk-1' } })).status).toBe(201);
    // Someone else's network is still refused.
    expect((await request(sock, 'GET', '/v1.45/networks/theirs')).status).toBe(403);

    expect((await request(sock, 'DELETE', '/v1.45/networks/vk-1')).status).toBeLessThan(400);
    expect((await request(sock, 'GET', '/v1.45/networks/vk-1')).status).toBe(403);
    expect((await request(sock, 'GET', '/v1.45/networks/net123')).status).toBe(403);
  });
});

/** A fake daemon that also answers network create. */
const networkDaemon = (dir: string): Promise<{ sock: string }> =>
  new Promise((resolve) => {
    const sock = path.join(dir, 'netd.sock');
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const p = req.url!.replace(/^\/v\d+\.\d+/, '').split('?')[0];
        if (p === '/networks/create') {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: 'net123', Warning: '' }));
        } else if (p === '/containers/create') {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: 'abc123', Warnings: [] }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    servers.push(server);
    server.listen(sock, () => resolve({ sock }));
  });
