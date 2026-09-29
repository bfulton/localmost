/**
 * Tests for ProxyServer host access enforcement.
 *
 * The proxy is the only thing enforcing hostname policy: macOS sandbox-exec
 * cannot filter by hostname, so every allow/block decision happens here.
 */

import * as http from 'http';
import * as net from 'net';
import { ProxyServer, parseConnectTarget } from './proxy-server';
import { SandboxPolicyLevel } from '../shared/types';
import { pinnedLookup } from '../shared/egress-screen';

type AccessDecision = { allowed: boolean; reason?: string };

/**
 * Ask a proxy whether a host is allowed, by default as a CONNECT to 443.
 * checkHostAccess is private; this mirrors the access pattern used in
 * discovery-proxy.test.ts so we exercise the real decision function.
 */
function checkHost(
  proxy: ProxyServer,
  host: string,
  port = 443,
  via: 'connect' | 'http' = 'connect'
): AccessDecision {
  return (
    proxy as unknown as {
      checkHostAccess(host: string, port: number, via: 'connect' | 'http'): AccessDecision;
    }
  ).checkHostAccess(host, port, via);
}

function makeProxy(
  policyLevel: SandboxPolicyLevel,
  allowedHosts?: string[]
): ProxyServer {
  return new ProxyServer({ policyLevel, allowedHosts });
}

describe('ProxyServer host access', () => {
  // =========================================================================
  // Runner infrastructure
  //
  // The Actions runner binary itself is launched with HTTP_PROXY pointed at
  // this proxy (runner-manager.ts). If these hosts are blocked the runner
  // cannot register or poll for jobs, so the app cannot run anything at all.
  // =========================================================================

  describe('runner infrastructure', () => {
    const infrastructureHosts = [
      'localhost',
      '127.0.0.1',
      'github.com',
      'api.github.com',
      'pipelines.actions.githubusercontent.com',
      'results-receiver.actions.githubusercontent.com',
      'vstoken.actions.githubusercontent.com',
    ];

    describe.each(['strict', 'moderate', 'permissive'] as const)(
      '%s policy',
      (level) => {
        it.each(infrastructureHosts)('allows %s', (host) => {
          expect(checkHost(makeProxy(level), host).allowed).toBe(true);
        });
      }
    );

    it('allows blob storage for log and artifact upload under strict policy', () => {
      expect(
        checkHost(makeProxy('strict'), 'foo.blob.core.windows.net').allowed
      ).toBe(true);
    });

    it('reports infrastructure as the reason', () => {
      expect(checkHost(makeProxy('strict'), 'github.com').reason).toBe(
        'infrastructure'
      );
    });
  });

  // =========================================================================
  // Policy applied at job time
  // =========================================================================

  describe('policy hosts set after construction', () => {
    it('allows a host added from a repository policy', () => {
      // The proxy is created when the runner starts, before we know which
      // repository the job belongs to, so .localmostrc hosts have to be applied
      // once the job is assigned.
      const proxy = makeProxy('strict');
      expect(checkHost(proxy, 'index.crates.io').allowed).toBe(false);

      proxy.setPolicyAllowedHosts(['index.crates.io']);

      const decision = checkHost(proxy, 'index.crates.io');
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('policy');
    });

    it('replaces the previous job policy rather than accumulating', () => {
      const proxy = makeProxy('strict');
      proxy.setPolicyAllowedHosts(['a.example.com']);
      proxy.setPolicyAllowedHosts(['b.example.com']);

      expect(checkHost(proxy, 'a.example.com').allowed).toBe(false);
      expect(checkHost(proxy, 'b.example.com').allowed).toBe(true);
    });

    it('still allows infrastructure when a policy is applied', () => {
      const proxy = makeProxy('strict');
      proxy.setPolicyAllowedHosts(['index.crates.io']);

      expect(checkHost(proxy, 'github.com').allowed).toBe(true);
    });
  });

  // =========================================================================
  // Strict policy
  // =========================================================================

  describe('strict policy', () => {
    it('blocks a host that is not infrastructure and not in policy', () => {
      expect(checkHost(makeProxy('strict'), 'evil.example.com').allowed).toBe(
        false
      );
    });

    it('blocks package registries that jobs use', () => {
      expect(
        checkHost(makeProxy('strict'), 'registry.npmjs.org').allowed
      ).toBe(false);
    });

    it('allows a host declared in policy', () => {
      const proxy = makeProxy('strict', ['registry.npmjs.org']);
      const decision = checkHost(proxy, 'registry.npmjs.org');
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('policy');
    });

    it('allows a wildcard host declared in policy', () => {
      const proxy = makeProxy('strict', ['*.internal.example.com']);
      expect(checkHost(proxy, 'build.internal.example.com').allowed).toBe(true);
    });
  });

  // =========================================================================
  // Moderate policy
  // =========================================================================

  describe('moderate policy', () => {
    it('allows common package registries', () => {
      const decision = checkHost(makeProxy('moderate'), 'registry.npmjs.org');
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('moderate-default');
    });

    it('blocks a host outside the moderate defaults', () => {
      expect(checkHost(makeProxy('moderate'), 'evil.example.com').allowed).toBe(
        false
      );
    });
  });

  // =========================================================================
  // Permissive policy
  // =========================================================================

  describe('permissive policy', () => {
    it('allows any host', () => {
      const decision = checkHost(makeProxy('permissive'), 'evil.example.com');
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('permissive');
    });
  });

  // =========================================================================
  // Matching semantics
  // =========================================================================

  describe('matching', () => {
    it('is case-insensitive', () => {
      expect(checkHost(makeProxy('strict'), 'GitHub.com').allowed).toBe(true);
    });

    it('does not let a wildcard match the bare parent domain', () => {
      const proxy = makeProxy('strict', ['*.internal.example.com']);
      expect(checkHost(proxy, 'internal.example.com').allowed).toBe(false);
    });

    it('does not let a suffix match a lookalike domain', () => {
      expect(
        checkHost(makeProxy('strict'), 'notgithub.com').allowed
      ).toBe(false);
    });
  });

  // =========================================================================
  // Ports
  //
  // A host on the allowlist is reached on the port its scheme uses - 443
  // through CONNECT, 80 for plain HTTP - and on another port only when the
  // policy spells host:port. Allowing a name used to allow every port on it:
  // github.com:22, or any service a CDN or cloud host happens to expose.
  // =========================================================================

  describe('ports', () => {
    it('refuses an allowed host on a port its scheme does not use', () => {
      const proxy = makeProxy('strict');
      expect(checkHost(proxy, 'github.com', 22)).toEqual({ allowed: false, reason: 'port' });
      expect(checkHost(proxy, 'github.com', 80, 'connect').allowed).toBe(false);
      expect(checkHost(proxy, 'github.com', 443, 'http').allowed).toBe(false);
      expect(checkHost(proxy, 'github.com', 443, 'connect').allowed).toBe(true);
      expect(checkHost(proxy, 'github.com', 80, 'http').allowed).toBe(true);
    });

    it('pins the moderate defaults and the policy hosts the same way', () => {
      expect(checkHost(makeProxy('moderate'), 'registry.npmjs.org', 8443).reason).toBe('port');
      const proxy = makeProxy('strict', ['svc.example.test', '*.cdn.example.test']);
      expect(checkHost(proxy, 'svc.example.test', 8443)).toEqual({ allowed: false, reason: 'port' });
      expect(checkHost(proxy, 'a.cdn.example.test', 8080, 'http').allowed).toBe(false);
      expect(checkHost(proxy, 'svc.example.test', 443).allowed).toBe(true);
    });

    it('allows the port a policy entry spells, and only that port', () => {
      const proxy = makeProxy('strict', ['svc.example.test:8443', '*.cdn.example.test:8080']);
      expect(checkHost(proxy, 'svc.example.test', 8443)).toEqual({ allowed: true, reason: 'policy' });
      expect(checkHost(proxy, 'svc.example.test', 8443, 'http').allowed).toBe(true);
      expect(checkHost(proxy, 'svc.example.test', 443).allowed).toBe(false);
      expect(checkHost(proxy, 'svc.example.test', 8444).allowed).toBe(false);
      expect(checkHost(proxy, 'a.cdn.example.test', 8080, 'http').allowed).toBe(true);
      expect(checkHost(proxy, 'cdn.example.test', 8080, 'http').allowed).toBe(false);
    });

    it('lets a spelled port reach an infrastructure host on it', () => {
      expect(checkHost(makeProxy('strict', ['github.com:22']), 'github.com', 22)).toEqual({ allowed: true, reason: 'policy' });
    });

    it('matches nothing with an entry whose port is not a port', () => {
      const proxy = makeProxy('strict', ['svc.example.test:https', 'svc.example.test:0', 'svc.example.test:65536']);
      expect(checkHost(proxy, 'svc.example.test', 443).allowed).toBe(false);
      expect(checkHost(proxy, 'svc.example.test', 0).allowed).toBe(false);
    });

    it('reads a bare IPv6 entry as an address, not as an address and a port', () => {
      const proxy = makeProxy('strict', ['2606:4700::1111', '[2606:4700::64]:8443']);
      expect(checkHost(proxy, '2606:4700::1111', 443).allowed).toBe(true);
      expect(checkHost(proxy, '2606:4700::1111', 1111).allowed).toBe(false);
      expect(checkHost(proxy, '2606:4700::64', 8443).allowed).toBe(true);
      expect(checkHost(proxy, '2606:4700::64', 443).allowed).toBe(false);
    });

    it.each(['strict', 'moderate'] as const)('leaves loopback targets on any port under %s', (level) => {
      // The broker is reached at 127.0.0.1 on its own port, over plain HTTP.
      const proxy = makeProxy(level);
      expect(checkHost(proxy, '127.0.0.1', 8787, 'http').allowed).toBe(true);
      expect(checkHost(proxy, '127.0.0.1', 8787, 'connect').allowed).toBe(true);
      expect(checkHost(proxy, 'localhost', 9229, 'http').allowed).toBe(true);
    });

    it('leaves permissive unrestricted, ports included', () => {
      const proxy = makeProxy('permissive');
      expect(checkHost(proxy, 'evil.example.com', 22).allowed).toBe(true);
      expect(checkHost(proxy, '::1', 5432).allowed).toBe(true);
    });

    const authHeader = (token: string) => 'Basic ' + Buffer.from(`localmost:${token}`).toString('base64');
    /** A proxy whose resolver never answers: a refusal has to come before the lookup. */
    const refusingBeforeLookup = async () => {
      const p = new ProxyServer({ policyLevel: 'strict', authToken: 't', lookup: () => new Promise<string[]>(() => undefined) });
      await p.start();
      return p;
    };

    it('answers 403 to CONNECT github.com:22 without resolving it', async () => {
      const p = await refusingBeforeLookup();
      try {
        const status = await new Promise<string>((resolve) => {
          const sock = net.connect(p.getPort(), '127.0.0.1', () =>
            sock.write(`CONNECT github.com:22 HTTP/1.1\r\nHost: github.com:22\r\nProxy-Authorization: ${authHeader('t')}\r\n\r\n`)
          );
          sock.on('error', () => resolve('closed'));
          sock.once('data', (d) => { resolve(d.toString().split('\r\n')[0]); sock.destroy(); });
          setTimeout(() => { resolve('timeout'); sock.destroy(); }, 1000).unref();
        });
        expect(status).toBe('HTTP/1.1 403 Forbidden');
      } finally { await p.stop(); }
    });

    it('tells a plain request which port was refused and how to allow it', async () => {
      const p = await refusingBeforeLookup();
      try {
        const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = http.request(
            { hostname: '127.0.0.1', port: p.getPort(), path: 'http://github.com:8080/', method: 'GET', headers: { 'proxy-authorization': authHeader('t') } },
            (res) => {
              let body = '';
              res.on('data', (d) => { body += d; });
              res.on('end', () => resolve({ status: res.statusCode || 0, body }));
            }
          );
          req.on('error', reject);
          req.setTimeout(1000, () => req.destroy(new Error('timeout')));
          req.end();
        });
        expect(answer.status).toBe(403);
        expect(answer.body).toContain('port 8080');
        expect(answer.body).toContain("'github.com:8080'");
      } finally { await p.stop(); }
    });
  });

  // =========================================================================
  // Defaults
  // =========================================================================

  describe('defaults', () => {
    it('defaults to strict when no policy level is given', () => {
      const proxy = new ProxyServer({});
      expect(proxy.getPolicyLevel()).toBe('strict');
      expect(checkHost(proxy, 'registry.npmjs.org').allowed).toBe(false);
    });

    it('still allows the runner to reach GitHub with no options at all', () => {
      const proxy = new ProxyServer({});
      expect(checkHost(proxy, 'github.com').allowed).toBe(true);
    });
  });
});

describe('resolving policy when a worker claims a job', () => {
  const startProxy = async (onJobAcquired: (jobId: string) => Promise<void>) => {
    const proxy = new ProxyServer({ policyLevel: 'strict', onJobAcquired });
    await proxy.start();
    return proxy;
  };

  const postAcquire = (port: number, body: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: 'http://127.0.0.1:1/acquirejob',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
        },
        (res: http.IncomingMessage) => {
          res.resume();
          resolve(res.statusCode || 0);
        }
      );
      req.on('error', reject);
      req.end(body);
    });

  it('applies the job policy before the request is forwarded', async () => {
    // Ordering is the whole point: the runner fetches its actions right after
    // this call, so a policy applied afterwards is applied too late.
    const seen: string[] = [];
    const proxy = await startProxy(async (jobId) => {
      seen.push(jobId);
    });

    try {
      await postAcquire(proxy.getPort(), JSON.stringify({ jobMessageId: 'msg-42' }));
      expect(seen).toEqual(['msg-42']);
    } finally {
      await proxy.stop();
    }
  });

  it('still forwards the request when the body carries no job id', async () => {
    const proxy = await startProxy(async () => {
      throw new Error('should not be called');
    });

    try {
      const status = await postAcquire(proxy.getPort(), 'not json');
      // 127.0.0.1 is infrastructure, so this reaches an upstream that is not
      // listening: a 502 proves it was forwarded rather than dropped.
      expect(status).toBe(502);
    } finally {
      await proxy.stop();
    }
  });
});

describe('acquirejob forwarding is resilient', () => {
  it('still forwards when policy resolution rejects', async () => {
    // A rejecting resolver must not become an unhandled rejection or strand
    // the runner's acquirejob request.
    const proxy = new ProxyServer({
      policyLevel: 'strict',
      onJobAcquired: async () => {
        throw new Error('resolution failed');
      },
    });
    await proxy.start();

    const body = JSON.stringify({ jobMessageId: 'msg-1' });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: proxy.getPort(),
            path: 'http://127.0.0.1:1/acquirejob',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
          },
          (res: http.IncomingMessage) => {
            res.resume();
            resolve(res.statusCode || 0);
          }
        );
        req.on('error', reject);
        req.end(body);
      });

      expect(status).toBe(502);
    } finally {
      await proxy.stop();
    }
  });
});

describe('acquirejob body limits', () => {
  it('rejects an oversized body instead of buffering it', async () => {
    // Any request to a path ending in /acquirejob reaches this code, so an
    // unbounded buffer is memory a workflow gets to choose the size of.
    let resolverCalled = false;
    const proxy = new ProxyServer({
      policyLevel: 'strict',
      onJobAcquired: async () => {
        resolverCalled = true;
      },
    });
    await proxy.start();

    const body = 'x'.repeat(200 * 1024);
    try {
      const status = await new Promise<number>((resolve) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: proxy.getPort(),
            path: 'http://127.0.0.1:1/acquirejob',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          },
          (res: http.IncomingMessage) => {
            res.resume();
            resolve(res.statusCode || 0);
          }
        );
        req.on('error', () => resolve(0));
        req.end(body);
      });

      expect(status).toBe(413);
      expect(resolverCalled).toBe(false);
    } finally {
      await proxy.stop();
    }
  });
});

describe('screening the address a host resolves to', () => {
  // The proxy checks the host name, then connects. If it re-resolves, a name
  // on the allowlist that resolves to an internal address reaches inside: the
  // broker, a service on loopback, or the cloud metadata endpoint at
  // 169.254.169.254. The screen refuses those addresses.
  const screen = (proxy: ProxyServer, ip: string): boolean =>
    (proxy as unknown as { isBlockedAddress(ip: string): boolean }).isBlockedAddress(ip);

  const proxy = new ProxyServer({ policyLevel: 'permissive' });

  it.each([
    '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1',
    'fe80::1', 'fc00::1', 'fd12:3456::1',
    '::ffff:10.0.0.1', '::ffff:169.254.169.254',
    '::10.0.0.1', '::169.254.169.254', '0.0.0.0', '::',
    '::ffff:0a00:0001', '::ffff:a9fe:a9fe',
    '0:0:0:0:0:ffff:0a00:0001', '0:0:0:0:0:0:0:0', '::ffff:192.168.1.1',
    'ff02::1', 'ff05::1:3',
  ])('refuses the internal address %s', (ip) => {
    expect(screen(proxy, ip)).toBe(true);
  });

  it.each([
    '8.8.8.8', '140.82.112.3', '1.1.1.1',
    '2606:4700:4700::1111', '2606:4700:4700:0:0:0:0:1111',
    // Loopback is not screened: the sandbox already grants direct loopback
    // access, and the broker is reached over it.
    '127.0.0.1', '::1', '0:0:0:0:0:0:0:1',
  ])('allows the address %s', (ip) => {
    expect(screen(proxy, ip)).toBe(false);
  });

  it('blocks a GET whose allowed host resolves to loopback, but allows a literal loopback target', async () => {
    // A repository-controlled name rebinding to 127.0.0.1 must not become a
    // proxy path to a local service; the broker, reached at the literal
    // 127.0.0.1, still must.
    const rebind = new ProxyServer({ policyLevel: 'permissive', lookup: async () => ['127.0.0.1'] });
    await rebind.start();
    const literal = new ProxyServer({ policyLevel: 'permissive', lookup: async () => ['8.8.8.8'] });
    await literal.start();
    const req = (port: number, path: string) => new Promise<number>((resolve, reject) => {
      const r = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode || 0); });
      r.on('error', reject); r.end();
    });
    try {
      // hostname that resolves to loopback -> refused
      expect(await req(rebind.getPort(), 'http://rebind.example/')).toBe(403);
      // literal loopback target reaches an upstream that is not listening ->
      // 502 proves it was NOT screened out (a 403 would mean blocked).
      expect(await req(literal.getPort(), 'http://127.0.0.1:9/')).toBe(502);
    } finally {
      await rebind.stop();
      await literal.stop();
    }
  });

  it('blocks a GET whose allowed host resolves to a private address it could not otherwise reach', async () => {
    const p = new ProxyServer({ policyLevel: 'permissive', lookup: async () => ['10.1.2.3'] });
    await p.start();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port: p.getPort(), path: 'http://rebind.example/', method: 'GET' },
          (res) => { res.resume(); resolve(res.statusCode || 0); }
        );
        req.on('error', reject); req.end();
      });
      expect(status).toBe(403);
    } finally {
      await p.stop();
    }
  });
});

describe('a worker may use only its own proxy', () => {
  const authHeader = (token: string) => 'Basic ' + Buffer.from(`localmost:${token}`).toString('base64');
  const get = (port: number, header?: string) =>
    new Promise<number>((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (header) headers['proxy-authorization'] = header;
      const req = http.request(
        { hostname: '127.0.0.1', port, path: 'http://8.8.8.8/', method: 'GET', headers },
        (res) => { res.resume(); resolve(res.statusCode || 0); }
      );
      req.on('error', reject);
      req.end();
    });

  it('refuses a request with no proxy credentials', async () => {
    const p = new ProxyServer({ policyLevel: 'permissive', authToken: 'secret-a', lookup: async () => ['8.8.8.8'] });
    await p.start();
    try { expect(await get(p.getPort())).toBe(407); } finally { await p.stop(); }
  });

  it("refuses another worker's token", async () => {
    const p = new ProxyServer({ policyLevel: 'permissive', authToken: 'secret-a', lookup: async () => ['8.8.8.8'] });
    await p.start();
    try { expect(await get(p.getPort(), authHeader('secret-b'))).toBe(407); } finally { await p.stop(); }
  });

  it('rejects the old token after rotation, so a reused proxy drops the last job', async () => {
    const p = new ProxyServer({ policyLevel: 'permissive', authToken: 'old-tok', lookup: async () => ['8.8.8.8'] });
    await p.start();
    try {
      p.rotateAuthToken('new-tok');
      expect(await get(p.getPort(), authHeader('old-tok'))).toBe(407);
      const url = new URL(p.getProxyUrl());
      expect(url.password).toBe('new-tok');
    } finally { await p.stop(); }
  });

  it('carries the token in the proxy URL it hands the worker', async () => {
    const p = new ProxyServer({ policyLevel: 'strict', authToken: 'secret-a' });
    await p.start();
    try {
      const url = new URL(p.getProxyUrl());
      expect(url.password).toBe('secret-a');
      expect(url.hostname).toBe('127.0.0.1');
    } finally { await p.stop(); }
  });

  // Rotation must end what the old token already opened, not only refuse what
  // it opens next: auth is checked when a tunnel or request starts and never
  // again, so an orphan of the last job could otherwise keep streaming through
  // a tunnel to a host that job allowed, under the next job's policy.
  /** A TCP upstream that records what reaches it. */
  const upstream = () =>
    new Promise<{ port: number; received: () => string; close: () => void }>((resolve) => {
      let received = '';
      const server = net.createServer((sock) => sock.on('data', (d) => { received += d.toString(); }));
      server.listen(0, '127.0.0.1', () => resolve({
        port: (server.address() as net.AddressInfo).port,
        received: () => received,
        close: () => server.close(),
      }));
    });
  /** Open a CONNECT tunnel through the proxy; resolves once established. */
  const tunnel = (proxyPort: number, target: string, token: string) =>
    new Promise<net.Socket>((resolve, reject) => {
      const sock = net.connect(proxyPort, '127.0.0.1', () => {
        sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${authHeader(token)}\r\n\r\n`);
      });
      sock.on('error', () => undefined);
      sock.once('data', (d) => {
        const status = d.toString().split('\r\n')[0];
        if (status.startsWith('HTTP/1.1 200')) resolve(sock); else reject(new Error(status));
      });
    });
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 40 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  };
  const settle = () => new Promise((r) => setTimeout(r, 100));
  const tracked = (p: ProxyServer) => (p as unknown as { connections: Set<net.Socket> }).connections;
  const local = { policyLevel: 'permissive' as const, lookup: async () => ['127.0.0.1'] };

  it('drops a tunnel the old token opened when the token rotates', async () => {
    const up = await upstream();
    const p = new ProxyServer({ ...local, authToken: 'old-tok' });
    await p.start();
    try {
      const sock = await tunnel(p.getPort(), `127.0.0.1:${up.port}`, 'old-tok');
      const closed = new Promise<void>((r) => sock.once('close', () => r()));
      sock.write('before;');
      await until(() => up.received() === 'before;');

      p.rotateAuthToken('new-tok');
      await closed;
      sock.write('after;');
      await settle();
      expect(up.received()).toBe('before;');
      expect(tracked(p).size).toBe(0);
    } finally { up.close(); await p.stop(); }
  });

  it('cuts a request that was still streaming when the token rotated', async () => {
    // A chunked body is piped upstream as it arrives, so an open POST is a
    // tunnel by another name, authenticated only at its headers - and it is
    // not a tracked tunnel socket, so the http server itself must close it.
    let body = '';
    const upHttp = http.createServer((req, res) => {
      req.on('data', (d) => { body += d.toString(); });
      req.on('error', () => undefined);
      req.on('end', () => res.end());
    });
    await new Promise<void>((r) => upHttp.listen(0, '127.0.0.1', r));
    const upPort = (upHttp.address() as net.AddressInfo).port;
    const p = new ProxyServer({ ...local, authToken: 'old-tok' });
    await p.start();
    try {
      const sock = net.connect(p.getPort(), '127.0.0.1');
      sock.on('error', () => undefined);
      await new Promise<void>((r) => sock.once('connect', r));
      const closed = new Promise<void>((r) => sock.once('close', () => r()));
      sock.write(
        `POST http://127.0.0.1:${upPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${upPort}\r\n` +
        `Proxy-Authorization: ${authHeader('old-tok')}\r\nTransfer-Encoding: chunked\r\n\r\n7\r\nbefore;\r\n`
      );
      await until(() => body === 'before;');

      p.rotateAuthToken('new-tok');
      await closed;
      sock.write('6\r\nafter;\r\n');
      await settle();
      expect(body).toBe('before;');
    } finally { upHttp.closeAllConnections(); upHttp.close(); await p.stop(); }
  });

  it('serves a tunnel opened with the new token after rotation', async () => {
    const up = await upstream();
    const p = new ProxyServer({ ...local, authToken: 'old-tok' });
    await p.start();
    try {
      p.rotateAuthToken('new-tok');
      const sock = await tunnel(p.getPort(), `127.0.0.1:${up.port}`, 'new-tok');
      sock.write('hello;');
      await until(() => up.received() === 'hello;');
      expect(up.received()).toBe('hello;');
      sock.destroy();
    } finally { up.close(); await p.stop(); }
  });

  it('takes a tunnel still resolving its name down with a rotation', async () => {
    // Authorised before the rotation, established after it: tracked from the
    // moment it is accepted, so the rotation reaches it too.
    const up = await upstream();
    const p = new ProxyServer({
      policyLevel: 'permissive',
      authToken: 'old-tok',
      lookup: () => new Promise<string[]>((r) => setTimeout(() => r(['127.0.0.1']), 200)),
    });
    await p.start();
    try {
      // A name, not a literal: literals are never looked up, so only a name
      // has a resolution window for the rotation to land in.
      const outcome = new Promise<string>((resolve) => {
        const sock = net.connect(p.getPort(), '127.0.0.1', () => {
          sock.write(`CONNECT upstream.test:${up.port} HTTP/1.1\r\nHost: upstream.test:${up.port}\r\nProxy-Authorization: ${authHeader('old-tok')}\r\n\r\n`);
        });
        sock.on('error', () => undefined);
        sock.once('data', (d) => resolve(d.toString().split('\r\n')[0]));
        sock.once('close', () => resolve('closed'));
      });
      await new Promise((r) => setTimeout(r, 50));
      p.rotateAuthToken('new-tok');

      expect(await outcome).toBe('closed');
      await settle();
      expect(tracked(p).size).toBe(0);
    } finally { up.close(); await p.stop(); }
  });
});

describe('CONNECT targets', () => {
  // Authority-form host[:port]: a bracketed IPv6 literal or a colon-free name.
  // Splitting on ':' turned '[2606:4700::1111]:443' into host '[2606' port 4700
  // - refused, so no reach, but every IPv6 literal was 403 at every policy
  // level - and let an out-of-range port through to a net.connect throw that
  // left the client hanging with no response.
  const authHeader = (token: string) => 'Basic ' + Buffer.from(`localmost:${token}`).toString('base64');
  /** Send a raw CONNECT; resolves with the status line, or 'closed' / 'timeout'. */
  const connectStatus = (proxyPort: number, target: string, token?: string) =>
    new Promise<string>((resolve) => {
      let settled = false;
      const done = (s: string) => { if (!settled) { settled = true; resolve(s); sock.destroy(); } };
      const sock = net.connect(proxyPort, '127.0.0.1', () => {
        sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${token ? `Proxy-Authorization: ${authHeader(token)}\r\n` : ''}\r\n`);
      });
      sock.on('error', () => done('closed'));
      sock.once('data', (d) => done(d.toString().split('\r\n')[0]));
      sock.once('close', () => done('closed'));
      setTimeout(() => done('timeout'), 2000).unref();
    });
  const listenV6 = (server: net.Server | http.Server) =>
    new Promise<number>((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '::1', () => resolve((server.address() as net.AddressInfo).port));
    });

  it.each([
    ['[::1]:443', { host: '::1', port: 443 }],
    ['[2606:4700:4700::1111]:443', { host: '2606:4700:4700::1111', port: 443 }],
    ['[::ffff:127.0.0.1]:443', { host: '::ffff:127.0.0.1', port: 443 }],
    ['api.github.com:80', { host: 'api.github.com', port: 80 }],
    ['127.0.0.1:8787', { host: '127.0.0.1', port: 8787 }],
    ['api.github.com', { host: 'api.github.com', port: 443 }],
  ])('parses %s', (target, expected) => {
    expect(parseConnectTarget(target)).toEqual(expected);
  });

  it.each([
    '::1:443', 'host:443:extra', 'host:', ':443', '[1.2.3.4]:443', '[host]:443',
    'api.github.com:99999', 'api.github.com:-1', 'api.github.com:0', 'api.github.com:443@10.0.0.1:80', 'a/b:443', '',
  ])('refuses %s', (target) => {
    expect(parseConnectTarget(target)).toBeNull();
  });

  it('tunnels to a bracketed IPv6 literal under a permissive policy', async () => {
    const up = net.createServer((s) => s.end());
    const port = await listenV6(up);
    const p = new ProxyServer({ policyLevel: 'permissive', authToken: 't' });
    await p.start();
    try {
      expect(await connectStatus(p.getPort(), `[::1]:${port}`, 't')).toBe('HTTP/1.1 200 Connection Established');
    } finally { up.close(); await p.stop(); }
  });

  it('refuses a bracketed IPv6 literal the allowlist does not name', async () => {
    const p = new ProxyServer({ policyLevel: 'strict', authToken: 't' });
    await p.start();
    try {
      expect(await connectStatus(p.getPort(), '[::1]:443', 't')).toBe('HTTP/1.1 403 Forbidden');
    } finally { await p.stop(); }
  });

  it.each(['[::ffff:127.0.0.1]:443', '[::]:443', '[::ffff:10.0.0.1]:443', '[fe80::1]:443'])(
    'screens %s with the brackets off', async (target) => {
      const p = new ProxyServer({ policyLevel: 'permissive', authToken: 't' });
      await p.start();
      try {
        expect(await connectStatus(p.getPort(), target, 't')).toBe('HTTP/1.1 403 Forbidden');
      } finally { await p.stop(); }
    }
  );

  it.each(['api.github.com:99999', 'api.github.com:-1', '::1:443', 'host:443:extra'])(
    'answers 400 to the malformed target %s instead of hanging', async (target) => {
      const p = new ProxyServer({ policyLevel: 'permissive', authToken: 't', lookup: async () => ['8.8.8.8'] });
      await p.start();
      try {
        expect(await connectStatus(p.getPort(), target, 't')).toBe('HTTP/1.1 400 Bad Request');
      } finally { await p.stop(); }
    }
  );

  it('checks the token before it looks at the target', async () => {
    const p = new ProxyServer({ policyLevel: 'permissive', authToken: 't' });
    await p.start();
    try {
      expect(await connectStatus(p.getPort(), 'host:443:extra')).toBe('HTTP/1.1 407 Proxy Authentication Required');
    } finally { await p.stop(); }
  });

  const getVia = (proxyPort: number, url: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: proxyPort, path: url, method: 'GET', headers: { 'proxy-authorization': authHeader('t') } },
        (res) => { res.resume(); resolve(res.statusCode || 0); }
      );
      req.on('error', reject);
      req.end();
    });

  it('serves a plain request to a bracketed IPv6 host', async () => {
    const up = http.createServer((_req, res) => res.end('ok'));
    const port = await listenV6(up);
    const p = new ProxyServer({ policyLevel: 'permissive', authToken: 't' });
    await p.start();
    try {
      expect(await getVia(p.getPort(), `http://[::1]:${port}/`)).toBe(200);
    } finally { up.close(); await p.stop(); }
  });

  it('screens a plain request to a bracketed IPv4-mapped loopback', async () => {
    const p = new ProxyServer({ policyLevel: 'permissive', authToken: 't' });
    await p.start();
    try {
      expect(await getVia(p.getPort(), 'http://[::ffff:127.0.0.1]/')).toBe(403);
    } finally { await p.stop(); }
  });
});

describe('an upstream request ends with its client', () => {
  // A plain request's upstream is a second connection the proxy opened for
  // the client. Rotation closes the client's socket, and so does the client
  // going away, but the upstream request lived on: a response that never
  // finished, or an upload the upstream was still reading, kept a connection
  // open to a host the last job's policy allowed.
  /** An upstream that answers headers and then never finishes. */
  const hangingUpstream = async () => {
    let connections = 0;
    const closed: Promise<void>[] = [];
    const up = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial;');
    });
    up.on('connection', (sock: net.Socket) => {
      connections++;
      closed.push(new Promise<void>((r) => sock.once('close', () => r())));
    });
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
    return {
      up,
      port: (up.address() as net.AddressInfo).port,
      connections: () => connections,
      firstClosed: () => closed[0],
    };
  };
  /** Send a raw request and resolve once the first response bytes arrive. */
  const open = (proxyPort: number, head: string) =>
    new Promise<net.Socket>((resolve) => {
      const sock = net.connect(proxyPort, '127.0.0.1', () => sock.write(head));
      sock.on('error', () => undefined);
      sock.once('data', () => resolve(sock));
    });
  const within = <T>(p: Promise<T>, ms: number) =>
    Promise.race([p.then(() => 'closed'), new Promise((r) => setTimeout(() => r('still open'), ms))]);

  it('closes the upstream when the token rotates mid-response', async () => {
    const h = await hangingUpstream();
    const p = new ProxyServer({ policyLevel: 'permissive' });
    await p.start();
    try {
      await open(p.getPort(), `GET http://127.0.0.1:${h.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\n\r\n`);
      p.rotateAuthToken('next');
      expect(await within(h.firstClosed(), 500)).toBe('closed');
    } finally { h.up.closeAllConnections(); h.up.close(); await p.stop(); }
  });

  it('closes the upstream when the client goes away mid-response', async () => {
    const h = await hangingUpstream();
    const p = new ProxyServer({ policyLevel: 'permissive' });
    await p.start();
    try {
      const sock = await open(p.getPort(), `GET http://127.0.0.1:${h.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\n\r\n`);
      sock.destroy();
      expect(await within(h.firstClosed(), 500)).toBe('closed');
    } finally { h.up.closeAllConnections(); h.up.close(); await p.stop(); }
  });

  it('closes a replayed acquirejob upstream when the client goes away', async () => {
    const h = await hangingUpstream();
    const p = new ProxyServer({ policyLevel: 'permissive', onJobAcquired: async () => undefined });
    await p.start();
    try {
      const sock = await open(
        p.getPort(),
        `POST http://127.0.0.1:${h.port}/_apis/x/acquirejob HTTP/1.1\r\nHost: 127.0.0.1:${h.port}\r\nContent-Length: 2\r\n\r\n{}`
      );
      sock.destroy();
      expect(await within(h.firstClosed(), 500)).toBe('closed');
    } finally { h.up.closeAllConnections(); h.up.close(); await p.stop(); }
  });

  it('does not dial at all when the client left while its name was resolving', async () => {
    // The pinned lookup is pointed at the local upstream so a connection, if
    // one were made, would land somewhere this test can see.
    const h = await hangingUpstream();
    const p = new ProxyServer({
      policyLevel: 'permissive',
      lookup: () => new Promise<string[]>((r) => setTimeout(() => r(['203.0.113.7']), 200)),
    });
    (p as unknown as { pinnedLookup: (a: string[]) => unknown }).pinnedLookup = () => pinnedLookup(['127.0.0.1']);
    await p.start();
    try {
      const sock = net.connect(p.getPort(), '127.0.0.1', () =>
        sock.write(`GET http://slow.test:${h.port}/ HTTP/1.1\r\nHost: slow.test:${h.port}\r\n\r\n`)
      );
      sock.on('error', () => undefined);
      await new Promise((r) => setTimeout(r, 50));
      sock.destroy();
      await new Promise((r) => setTimeout(r, 400));
      expect(h.connections()).toBe(0);
    } finally { h.up.closeAllConnections(); h.up.close(); await p.stop(); }
  });
});

describe('the Host an upstream sees', () => {
  // The proxy decides by the host in the request line; the Host header is
  // the client's to write. Forwarded as written, a request the policy allowed
  // for one host asked a shared front end (a CDN, a cloud load balancer) for
  // another, which the policy never allowed.
  const upstreamHosts = async () => {
    const seen: (string | undefined)[] = [];
    const up = http.createServer((req, res) => { seen.push(req.headers.host); res.end('ok'); });
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
    return { up, seen, port: (up.address() as net.AddressInfo).port };
  };
  const send = (proxyPort: number, method: string, url: string, body?: string) =>
    new Promise<number>((resolve, reject) => {
      const headers: Record<string, string> = { host: 'evil.test' };
      if (body !== undefined) headers['content-length'] = String(body.length);
      const req = http.request(
        { hostname: '127.0.0.1', port: proxyPort, path: url, method, headers },
        (res) => { res.resume(); resolve(res.statusCode || 0); }
      );
      req.on('error', reject);
      req.end(body);
    });

  it('is the host the request was checked against, not the Host header sent', async () => {
    const { up, seen, port } = await upstreamHosts();
    const p = new ProxyServer({ policyLevel: 'strict' });
    await p.start();
    try {
      expect(await send(p.getPort(), 'GET', `http://127.0.0.1:${port}/`)).toBe(200);
      expect(seen).toEqual([`127.0.0.1:${port}`]);
    } finally { up.closeAllConnections(); up.close(); await p.stop(); }
  });

  it('is the checked host on a replayed acquirejob too', async () => {
    const { up, seen, port } = await upstreamHosts();
    const p = new ProxyServer({ policyLevel: 'strict', onJobAcquired: async () => undefined });
    await p.start();
    try {
      expect(await send(p.getPort(), 'POST', `http://127.0.0.1:${port}/_apis/x/acquirejob`, '{}')).toBe(200);
      expect(seen).toEqual([`127.0.0.1:${port}`]);
    } finally { up.closeAllConnections(); up.close(); await p.stop(); }
  });
});

describe('the acquirejob forward is screened like every other request', () => {
  // acquirejob is buffered and replayed, so it has its own upstream request.
  // That request dialled by name through the system resolver, unscreened: a
  // name on the allowlist that resolves inside - loopback, a private range,
  // the metadata endpoint - reached it, and a second resolution could differ
  // from anything a screen had seen.
  const post = (proxyPort: number, url: string) =>
    new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({ jobMessageId: 'msg-1' });
      const req = http.request(
        {
          hostname: '127.0.0.1', port: proxyPort, path: url, method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
        },
        (res) => { res.resume(); resolve(res.statusCode || 0); }
      );
      req.on('error', reject);
      req.end(body);
    });
  const acquiring = (options: ConstructorParameters<typeof ProxyServer>[0]) =>
    new ProxyServer({ onJobAcquired: async () => undefined, ...options });

  it('refuses a name that resolves to loopback and never connects to it', async () => {
    // 'localhost' is on the infrastructure list, so only the screen stands
    // between this request and whatever listens on the port. Listening on
    // '::' takes both 127.0.0.1 and ::1, whichever the name resolves to.
    let connections = 0;
    const up = http.createServer((_req, res) => res.end('ok'));
    up.on('connection', () => { connections++; });
    await new Promise<void>((r) => up.listen(0, '::', r));
    const upPort = (up.address() as net.AddressInfo).port;
    const p = acquiring({ policyLevel: 'permissive' });
    await p.start();
    try {
      expect(await post(p.getPort(), `http://localhost:${upPort}/_apis/x/acquirejob`)).toBe(403);
      await new Promise((r) => setTimeout(r, 50));
      expect(connections).toBe(0);
    } finally { up.close(); await p.stop(); }
  });

  it('refuses a name that resolves to a private address', async () => {
    const p = acquiring({ policyLevel: 'permissive', lookup: async () => ['10.0.0.1'] });
    await p.start();
    try {
      expect(await post(p.getPort(), 'http://internal.test/_apis/x/acquirejob')).toBe(403);
    } finally { await p.stop(); }
  });

  it('connects to the addresses it screened, not to a second resolution', async () => {
    // The pinned lookup is swapped for one that records what it was given
    // and answers with a local upstream, so nothing leaves the machine: the
    // request arriving there proves the connection used it. The system
    // resolver has never heard of pinned.test.
    const up = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
    const upPort = (up.address() as net.AddressInfo).port;
    const p = acquiring({ policyLevel: 'permissive', lookup: async () => ['203.0.113.7'] });
    const pinnedWith: string[][] = [];
    (p as unknown as { pinnedLookup: (a: string[]) => unknown }).pinnedLookup = (addresses: string[]) => {
      pinnedWith.push(addresses);
      return pinnedLookup(['127.0.0.1']);
    };
    await p.start();
    try {
      expect(await post(p.getPort(), `http://pinned.test:${upPort}/_apis/x/acquirejob`)).toBe(200);
      expect(pinnedWith).toEqual([['203.0.113.7']]);
    } finally { up.closeAllConnections(); up.close(); await p.stop(); }
  });
});
