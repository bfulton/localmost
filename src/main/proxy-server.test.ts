/**
 * Tests for ProxyServer host access enforcement.
 *
 * The proxy is the only thing enforcing hostname policy: macOS sandbox-exec
 * cannot filter by hostname, so every allow/block decision happens here.
 */

import * as http from 'http';
import { ProxyServer } from './proxy-server';
import { SandboxPolicyLevel } from '../shared/types';

type AccessDecision = { allowed: boolean; reason?: string };

/**
 * Ask a proxy whether a host is allowed.
 * checkHostAccess is private; this mirrors the access pattern used in
 * discovery-proxy.test.ts so we exercise the real decision function.
 */
function checkHost(proxy: ProxyServer, host: string): AccessDecision {
  return (
    proxy as unknown as { checkHostAccess(host: string): AccessDecision }
  ).checkHostAccess(host);
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
