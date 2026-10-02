/**
 * Loopback through a worker's own proxy.
 *
 * The sandbox closes a job's direct connections to loopback except to its
 * proxy and the ports its repository declares. The proxy treated a literal
 * loopback target as runner infrastructure on any port, so the same job
 * reached every local service - a debugger on 9229, a dev database, another
 * app's local API - by asking its proxy instead. A literal loopback target
 * is now refused unless it is the broker's port or one the repository's
 * approved policy declares.
 */

import * as http from 'http';
import * as net from 'net';
import { ProxyServer } from './proxy-server';
import { DEFAULT_BROKER_PORT } from '../shared/sandbox-profile';
import { SandboxPolicyLevel } from '../shared/types';

type AccessDecision = { allowed: boolean; reason?: string };

function checkHost(proxy: ProxyServer, host: string, port: number, via: 'connect' | 'http' = 'http'): AccessDecision {
  return (
    proxy as unknown as {
      checkHostAccess(host: string, port: number, via: 'connect' | 'http'): AccessDecision;
    }
  ).checkHostAccess(host, port, via);
}

const LEVELS: SandboxPolicyLevel[] = ['strict', 'moderate', 'permissive'];

/** Every way a job can write "this machine" that the proxy would otherwise dial. */
const LOOPBACK_SPELLINGS = ['127.0.0.1', '127.0.0.2', '127.255.255.254', 'localhost', 'LOCALHOST.', 'db.localhost', '::1', '::ffff:7f00:1'];

describe('literal loopback through the proxy', () => {
  describe.each(LEVELS)('under %s', (level) => {
    it.each(LOOPBACK_SPELLINGS)('refuses %s on a port nothing declares, before any policy is installed', (host) => {
      const proxy = new ProxyServer({ policyLevel: level });
      expect(checkHost(proxy, host, 9229)).toEqual({ allowed: false, reason: 'loopback' });
      expect(checkHost(proxy, host, 9229, 'connect')).toEqual({ allowed: false, reason: 'loopback' });
    });

    it('opens only the default broker port until the real one is known', () => {
      // Fail closed: the only loopback port a fresh proxy opens is the one
      // the runner cannot work without.
      const proxy = new ProxyServer({ policyLevel: level });
      expect(checkHost(proxy, '127.0.0.1', DEFAULT_BROKER_PORT)).toEqual({ allowed: true, reason: 'infrastructure' });
      expect(checkHost(proxy, '127.0.0.1', DEFAULT_BROKER_PORT + 1).allowed).toBe(false);
    });

    it('opens the broker port it is told, and closes the default one', () => {
      const proxy = new ProxyServer({ policyLevel: level });
      proxy.setLoopbackPolicy(4100, undefined);
      expect(checkHost(proxy, '127.0.0.1', 4100).allowed).toBe(true);
      expect(checkHost(proxy, '127.0.0.1', DEFAULT_BROKER_PORT).allowed).toBe(false);
    });

    it('opens exactly the ports the policy lists', () => {
      const proxy = new ProxyServer({ policyLevel: level });
      proxy.setLoopbackPolicy(DEFAULT_BROKER_PORT, [5432, 6379]);
      expect(checkHost(proxy, '127.0.0.1', 5432)).toEqual({ allowed: true, reason: 'policy' });
      expect(checkHost(proxy, '::1', 6379, 'connect').allowed).toBe(true);
      expect(checkHost(proxy, '127.0.0.1', 5433).allowed).toBe(false);
      expect(checkHost(proxy, '127.0.0.1', DEFAULT_BROKER_PORT).allowed).toBe(true);
    });

    it('opens every port when the policy declares all of loopback', () => {
      const proxy = new ProxyServer({ policyLevel: level });
      proxy.setLoopbackPolicy(DEFAULT_BROKER_PORT, true);
      expect(checkHost(proxy, '127.0.0.1', 9229).allowed).toBe(true);
      expect(checkHost(proxy, '::1', 1, 'connect').allowed).toBe(true);
    });
  });

  it("replaces the previous job's grant rather than keeping it", () => {
    const proxy = new ProxyServer({ policyLevel: 'strict' });
    proxy.setLoopbackPolicy(DEFAULT_BROKER_PORT, true);
    proxy.setLoopbackPolicy(DEFAULT_BROKER_PORT, undefined);
    expect(checkHost(proxy, '127.0.0.1', 9229).allowed).toBe(false);
  });

  it('keeps its own copy of the ports it was given', () => {
    const ports = [5432];
    const proxy = new ProxyServer({ policyLevel: 'strict' });
    proxy.setLoopbackPolicy(DEFAULT_BROKER_PORT, ports);
    ports.push(9229);
    expect(checkHost(proxy, '127.0.0.1', 9229).allowed).toBe(false);
  });

  it('lets a deny entry close a declared loopback port, but never the broker', () => {
    const proxy = new ProxyServer({ policyLevel: 'permissive' });
    proxy.setLoopbackPolicy(DEFAULT_BROKER_PORT, true);
    proxy.setPolicyDeniedHosts(['127.0.0.1:5432', '127.0.0.1']);
    expect(checkHost(proxy, '127.0.0.1', 5432)).toEqual({ allowed: false, reason: 'denied' });
    expect(checkHost(proxy, '127.0.0.1', DEFAULT_BROKER_PORT)).toEqual({ allowed: true, reason: 'infrastructure' });
  });

  it('says which loopback port was refused and where to declare it', () => {
    const proxy = new ProxyServer({ policyLevel: 'strict' });
    const body = (proxy as unknown as { refusal(h: string, p: number, r: string): string }).refusal('127.0.0.1', 9229, 'loopback');
    expect(body).toContain('9229');
    expect(body).toContain('network.loopback');
  });
});

describe('loopback refusals on the wire', () => {
  const authHeader = (token: string) => 'Basic ' + Buffer.from(`localmost:${token}`).toString('base64');

  /** A local service the job has no business reaching. */
  const localService = async () => {
    let connections = 0;
    const server = http.createServer((req, res) => { req.resume(); res.end('secret'); });
    server.on('connection', () => { connections++; });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { server, port: (server.address() as net.AddressInfo).port, connections: () => connections };
  };

  const connectStatus = (proxyPort: number, target: string) =>
    new Promise<string>((resolve) => {
      const sock = net.connect(proxyPort, '127.0.0.1', () =>
        sock.write(`CONNECT ${target} HTTP/1.1\r\nProxy-Authorization: ${authHeader('t')}\r\n\r\n`)
      );
      sock.on('error', () => resolve('closed'));
      sock.once('data', (d) => { resolve(d.toString().split('\r\n')[0]); sock.destroy(); });
      setTimeout(() => { resolve('timeout'); sock.destroy(); }, 1000).unref();
    });

  const request = (proxyPort: number, method: string, url: string, body = '') =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1', port: proxyPort, path: url, method,
          headers: { 'proxy-authorization': authHeader('t'), 'content-length': String(body.length) },
        },
        (res) => { res.resume(); resolve(res.statusCode || 0); }
      );
      req.on('error', reject);
      req.end(body);
    });

  it.each(LEVELS)('refuses CONNECT, plain HTTP and acquirejob to an undeclared local port under %s', async (level) => {
    const svc = await localService();
    const acquired: string[] = [];
    const p = new ProxyServer({ policyLevel: level, authToken: 't', onJobAcquired: async (id) => { acquired.push(id); } });
    await p.start();
    try {
      expect(await connectStatus(p.getPort(), `127.0.0.1:${svc.port}`)).toBe('HTTP/1.1 403 Forbidden');
      expect(await request(p.getPort(), 'GET', `http://127.0.0.1:${svc.port}/`)).toBe(403);
      expect(await request(p.getPort(), 'POST', `http://127.0.0.1:${svc.port}/_apis/x/acquirejob`, '{"jobMessageId":"m"}')).toBe(403);
      expect(svc.connections()).toBe(0);
      // Refused before the body was read, so no policy was chosen from it.
      expect(acquired).toEqual([]);
    } finally { svc.server.close(); await p.stop(); }
  });

  it('reaches the broker port it was given, on every path, and no other', async () => {
    const broker = await localService();
    const other = await localService();
    const acquired: string[] = [];
    const p = new ProxyServer({ policyLevel: 'strict', authToken: 't', onJobAcquired: async (id) => { acquired.push(id); } });
    p.setLoopbackPolicy(broker.port, undefined);
    await p.start();
    try {
      expect(await request(p.getPort(), 'GET', `http://127.0.0.1:${broker.port}/w/key/_apis/x`)).toBe(200);
      expect(await request(p.getPort(), 'POST', `http://127.0.0.1:${broker.port}/w/key/acquirejob`, '{"jobMessageId":"m"}')).toBe(200);
      expect(await connectStatus(p.getPort(), `127.0.0.1:${broker.port}`)).toBe('HTTP/1.1 200 Connection Established');
      expect(acquired).toEqual(['m']);
      expect(await request(p.getPort(), 'GET', `http://127.0.0.1:${other.port}/`)).toBe(403);
    } finally {
      broker.server.closeAllConnections(); broker.server.close(); other.server.close(); await p.stop();
    }
  });

  it('rechecks acquirejob against the policy the claim installed, not the one it was buffered under', async () => {
    // The worker was spawned under a policy that declared this port; the job
    // it claimed does not. The claim runs while the body is buffered, and the
    // forward must be judged by what the claim left.
    const svc = await localService();
    const p = new ProxyServer({
      policyLevel: 'strict',
      authToken: 't',
      onJobAcquired: async () => { p.setLoopbackPolicy(DEFAULT_BROKER_PORT, undefined); },
    });
    p.setLoopbackPolicy(DEFAULT_BROKER_PORT, [svc.port]);
    await p.start();
    try {
      expect(await request(p.getPort(), 'POST', `http://127.0.0.1:${svc.port}/x/acquirejob`, '{"jobMessageId":"m"}')).toBe(403);
      expect(svc.connections()).toBe(0);
    } finally { svc.server.close(); await p.stop(); }
  });

  it('reaches a port the policy declares, and not the one beside it', async () => {
    const svc = await localService();
    const other = await localService();
    const p = new ProxyServer({ policyLevel: 'strict', authToken: 't' });
    p.setLoopbackPolicy(DEFAULT_BROKER_PORT, [svc.port]);
    await p.start();
    try {
      expect(await request(p.getPort(), 'GET', `http://127.0.0.1:${svc.port}/`)).toBe(200);
      expect(await connectStatus(p.getPort(), `127.0.0.1:${other.port}`)).toBe('HTTP/1.1 403 Forbidden');
    } finally { svc.server.closeAllConnections(); svc.server.close(); other.server.close(); await p.stop(); }
  });
});
