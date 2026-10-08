/**
 * Who may use the proxy `localmost test` starts, and where it will connect.
 *
 * The proxy listens on loopback, and every runner job's sandbox allows
 * loopback. Without a token, a runner job live while `localmost test` ran
 * could use it as egress with no allowlist at all under --updaterc, and with
 * no address screen at any time - reaching the metadata endpoint, the LAN,
 * or a local service by a name that resolves to loopback - and could add
 * hosts to what discovery writes into .localmostrc.
 */

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import * as http from 'http';
import * as net from 'net';
import { DiscoveryProxy } from './discovery-proxy';
import { hostPatternAllows } from './egress-screen';

jest.mock('net', () => {
  const actual = jest.requireActual<typeof import('net')>('net');
  return { ...actual, connect: jest.fn(actual.connect) };
});

jest.mock('http', () => {
  const actual = jest.requireActual<typeof import('http')>('http');
  return { ...actual, request: jest.fn(actual.request) };
});

const netConnect = jest.mocked(net.connect);
const httpRequest = jest.mocked(http.request);

/** The upstream dials the proxy made, as opposed to this test's own connections. */
const upstreamDials = () =>
  netConnect.mock.calls
    .map((call) => call[0] as unknown)
    .filter((opts): opts is net.NetConnectOpts & { lookup?: unknown } =>
      typeof opts === 'object' && opts !== null && 'lookup' in opts);

let proxy: DiscoveryProxy;

afterEach(async () => {
  await proxy?.stop();
  netConnect.mockImplementation(jest.requireActual<typeof import('net')>('net').connect);
  httpRequest.mockImplementation(jest.requireActual<typeof import('http')>('http').request);
});

const start = async (options: ConstructorParameters<typeof DiscoveryProxy>[0] = {}) => {
  proxy = new DiscoveryProxy(options);
  const port = await proxy.start();
  const url = new URL(proxy.getProxyUrl());
  return { port, user: decodeURIComponent(url.username), token: decodeURIComponent(url.password) };
};

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/** Send a CONNECT and return the proxy's status code. */
const connect = (port: number, target: string, auth?: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
          (auth ? `Proxy-Authorization: ${auth}\r\n` : '') +
          '\r\n'
      );
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      const m = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (m) {
        resolve(Number(m[1]));
        socket.destroy();
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(0));
  });

/** Send a plain-HTTP proxy request and return the status code. */
const get = (port: number, target: string, auth?: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = jest.requireActual<typeof import('http')>('http').request(
      {
        hostname: '127.0.0.1',
        port,
        path: target,
        method: 'GET',
        headers: auth ? { 'Proxy-Authorization': auth } : {},
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on('error', reject);
    req.end();
  });

describe('DiscoveryProxy authentication', () => {
  it('names a per-run token in its URL', async () => {
    const a = await start();
    await proxy.stop();
    const b = await start();
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(b.token).not.toBe(a.token);
    expect(proxy.getProxyUrl()).toBe(`http://${a.user}:${b.token}@127.0.0.1:${b.port}`);
  });

  it('refuses a CONNECT without the token, and does not record its host', async () => {
    const { port, user } = await start();
    expect(await connect(port, 'example.com:443')).toBe(407);
    expect(await connect(port, 'example.com:443', basic(user, 'not-the-token'))).toBe(407);
    expect(proxy.getAccessedHosts()).toEqual([]);
    expect(upstreamDials()).toEqual([]);
  });

  it('refuses a plain request without the token', async () => {
    const { port } = await start();
    expect(await get(port, 'http://example.com/')).toBe(407);
    expect(proxy.getAccessedHosts()).toEqual([]);
  });
});

describe('DiscoveryProxy address screen', () => {
  it('refuses a malformed CONNECT target rather than guessing at it', async () => {
    const { port, user, token } = await start();
    for (const target of ['[2606:4700::1111', 'user@example.com:443', 'example.com:0', 'example.com:99999']) {
      expect(await connect(port, target, basic(user, token))).toBe(400);
    }
  });

  it('refuses a host that resolves off the routable internet, even under --updaterc', async () => {
    const internal: Record<string, string[]> = {
      'metadata.test': ['169.254.169.254'],
      'lan.test': ['10.0.0.5'],
      'rebind.test': ['127.0.0.1'],
    };
    const { port, user, token } = await start({ lookup: async (host) => internal[host] ?? [] });
    for (const host of Object.keys(internal)) {
      expect(await connect(port, `${host}:443`, basic(user, token))).toBe(403);
      expect(await get(port, `http://${host}/`, basic(user, token))).toBe(403);
    }
    // A step reaches loopback directly; through the proxy it would reach the
    // broker's port, which its sandbox denies.
    expect(await connect(port, '127.0.0.1:8787', basic(user, token))).toBe(403);
    expect(upstreamDials()).toEqual([]);
  });

  it('never offers a host its screen refused as one to allow', async () => {
    // Discovery writes what it recorded into .localmostrc; a host the screen
    // will always refuse there would be a grant that can never work.
    const { port, user, token } = await start({ lookup: async () => ['127.0.0.1'] });
    expect(await connect(port, 'localhost:3000', basic(user, token))).toBe(403);
    expect(await connect(port, '127.0.0.1:3000', basic(user, token))).toBe(403);
    expect(await get(port, 'http://localhost:3000/', basic(user, token))).toBe(403);
    expect(proxy.getAccessedHosts()).toEqual([]);
    expect(proxy.getAccessStats().blocked).toEqual(['127.0.0.1', 'localhost']);
  });

  it('dials exactly the addresses it screened, and never forwards its own credentials', async () => {
    // Nothing answers at the screened address; each dial is recorded and then
    // refused locally, so the proxy answers 502 straight away.
    const actualNet = jest.requireActual<typeof import('net')>('net');
    const actualHttp = jest.requireActual<typeof import('http')>('http');
    netConnect.mockImplementation(((...args: unknown[]) => {
      const opts = args[0];
      if (typeof opts === 'object' && opts !== null && 'lookup' in opts) {
        const socket = new actualNet.Socket();
        process.nextTick(() => socket.destroy(new Error('refused in test')));
        return socket;
      }
      return (actualNet.connect as (...a: unknown[]) => net.Socket)(...args);
    }) as never);
    httpRequest.mockImplementation(((opts: http.RequestOptions, cb: (res: http.IncomingMessage) => void) =>
      actualHttp.request(
        opts.hostname === 'public.test' ? { hostname: '127.0.0.1', port: 1, method: opts.method } : opts,
        cb
      )) as never);

    const { port, user, token } = await start({ lookup: async () => ['192.0.2.10'] });

    expect(await connect(port, 'public.test:443', basic(user, token))).toBe(502);
    const [dial] = upstreamDials();
    expect(dial).toMatchObject({ host: 'public.test', port: 443 });
    const pinned = await new Promise<string>((resolve) =>
      (dial.lookup as (h: string, o: object, cb: (e: null, a: string) => void) => void)(
        'public.test', {}, (_e, address) => resolve(address)));
    expect(pinned).toBe('192.0.2.10');

    httpRequest.mockClear();
    expect(await get(port, 'http://public.test/path', basic(user, token))).toBe(502);
    const forwarded = httpRequest.mock.calls
      .map((call) => call[0] as http.RequestOptions)
      .find((opts) => opts.hostname === 'public.test');
    expect(forwarded).toBeDefined();
    expect(Object.keys(forwarded!.headers ?? {}).map((h) => h.toLowerCase())).not.toContain('proxy-authorization');
    expect(forwarded!.lookup).toBeDefined();
  });
});

describe('DiscoveryProxy under a policy', () => {
  /** Upstream dials fail at once, so a request the policy lets through answers 502 and is recorded. */
  const refuseUpstreamDials = () => {
    const actualNet = jest.requireActual<typeof import('net')>('net');
    const actualHttp = jest.requireActual<typeof import('http')>('http');
    netConnect.mockClear();
    httpRequest.mockClear();
    netConnect.mockImplementation(((...args: unknown[]) => {
      const opts = args[0];
      if (typeof opts === 'object' && opts !== null && 'lookup' in opts) {
        const socket = new actualNet.Socket();
        process.nextTick(() => socket.destroy(new Error('refused in test')));
        return socket;
      }
      return (actualNet.connect as (...a: unknown[]) => net.Socket)(...args);
    }) as never);
    httpRequest.mockImplementation(((opts: http.RequestOptions, cb: (res: http.IncomingMessage) => void) =>
      actualHttp.request(
        opts.hostname?.endsWith('.example.com') ? { hostname: '127.0.0.1', port: 1, method: opts.method } : opts,
        cb
      )) as never);
  };
  const dialled = () => upstreamDials().map((dial) => {
    const { host, port } = dial as net.TcpNetConnectOpts;
    return `${host}:${port}`;
  });
  const forwarded = () =>
    httpRequest.mock.calls
      .map((call) => call[0] as http.RequestOptions)
      .filter((opts) => opts.hostname?.endsWith('.example.com'))
      .map((opts) => `${opts.hostname}:${opts.port}`);

  it('refuses a denied host an allow wildcard covers', async () => {
    refuseUpstreamDials();
    const { port, user, token } = await start({
      allowlist: ['*.example.com'],
      denylist: ['bad.example.com', 'BAD2.example.com.', 'svc.example.com:8443'],
      lookup: async () => ['192.0.2.10'],
    });
    const auth = basic(user, token);
    expect(await connect(port, 'bad.example.com:443', auth)).toBe(403);
    expect(await get(port, 'http://bad.example.com/', auth)).toBe(403);
    // A deny compares the host however it is spelled.
    expect(await connect(port, 'bad2.example.com:443', auth)).toBe(403);
    expect(await connect(port, 'ok.example.com:443', auth)).toBe(502);
    // An entry with a port denies that port only.
    expect(await connect(port, 'svc.example.com:443', auth)).toBe(502);
    expect(dialled()).toEqual(['ok.example.com:443', 'svc.example.com:443']);
    expect(forwarded()).toEqual([]);
    expect(proxy.getAccessStats().blocked).toEqual(['bad.example.com', 'bad2.example.com']);
  });

  it('refuses an allowed host on a port its scheme does not use', async () => {
    refuseUpstreamDials();
    const { port, user, token } = await start({
      allowlist: ['*.example.com', 'svc.example.com:8443'],
      lookup: async () => ['192.0.2.10'],
    });
    const auth = basic(user, token);
    expect(await connect(port, 'ok.example.com:22', auth)).toBe(403);
    expect(await connect(port, 'ok.example.com:80', auth)).toBe(403);
    expect(await get(port, 'http://ok.example.com:8080/', auth)).toBe(403);
    // A port an entry spells is allowed, and only that one.
    expect(await connect(port, 'svc.example.com:8443', auth)).toBe(502);
    expect(await connect(port, 'ok.example.com:443', auth)).toBe(502);
    expect(await get(port, 'http://ok.example.com/', auth)).toBe(502);
    expect(dialled()).toEqual(['svc.example.com:8443', 'ok.example.com:443']);
    expect(forwarded()).toEqual(['ok.example.com:80']);
  });

  it('records a host reached on another port than its scheme uses as the host:port entry that allows it', async () => {
    // Discovery wrote the bare name, which allows 443 through CONNECT and 80
    // for plain HTTP only, so the next, enforcing run refused a step that
    // reached api.example.com:8443 during discovery.
    refuseUpstreamDials();
    const { port, user, token } = await start({ lookup: async () => ['192.0.2.10'] });
    const auth = basic(user, token);
    const requests: [string, 'connect' | 'http', string, number][] = [
      ['ok.example.com:443', 'connect', 'ok.example.com', 443],
      ['svc.example.com:8443', 'connect', 'svc.example.com', 8443],
      ['web.example.com:80', 'connect', 'web.example.com', 80],
      ['[2606:4700::1111]:8443', 'connect', '2606:4700::1111', 8443],
      ['http://plain.example.com/', 'http', 'plain.example.com', 80],
      ['http://alt.example.com:8080/', 'http', 'alt.example.com', 8080],
    ];
    for (const [target, via] of requests) {
      expect(await (via === 'connect' ? connect : get)(port, target, auth)).toBe(502);
    }
    const recorded = proxy.getAccessedHosts();
    expect(recorded).toEqual([
      '[2606:4700::1111]:8443',
      'alt.example.com:8080',
      'ok.example.com',
      'plain.example.com',
      'svc.example.com:8443',
      'web.example.com:80',
    ]);
    // Each is an entry the enforcing proxy reads as allowing that request.
    for (const [, via, host, reached] of requests) {
      expect([host, reached, recorded.some((entry) => hostPatternAllows(entry, host, reached, via))]).toEqual([host, reached, true]);
    }
  });

  it('sends the checked host upstream, not the Host header sent', async () => {
    // Forwarded as written, the Host header asks a shared front end - a CDN,
    // a cloud load balancer - for a site the policy denied.
    refuseUpstreamDials();
    const { port, user, token } = await start({
      allowlist: ['ok.example.com'],
      denylist: ['bad.example.com'],
      lookup: async () => ['192.0.2.10'],
    });
    const status = await new Promise<number>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          'GET http://ok.example.com/ HTTP/1.1\r\nHost: bad.example.com\r\n' +
            `Proxy-Authorization: ${basic(user, token)}\r\nConnection: close\r\n\r\n`
        );
      });
      let data = '';
      socket.on('data', (chunk) => { data += chunk.toString(); });
      socket.on('error', reject);
      socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
    });
    expect(status).toBe(502);
    const sent = httpRequest.mock.calls
      .map((call) => call[0] as http.RequestOptions)
      .filter((opts) => opts.hostname?.endsWith('.example.com'))
      .map((opts) => [opts.hostname, (opts.headers as http.OutgoingHttpHeaders).host]);
    expect(sent).toEqual([['ok.example.com', 'ok.example.com']]);
  });

  it('observes every port under --updaterc, where there is no allow list', async () => {
    refuseUpstreamDials();
    const { port, user, token } = await start({ lookup: async () => ['192.0.2.10'] });
    expect(await connect(port, 'ok.example.com:22', basic(user, token))).toBe(502);
    expect(dialled()).toEqual(['ok.example.com:22']);
  });
});
