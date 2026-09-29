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
