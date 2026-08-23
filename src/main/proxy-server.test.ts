/**
 * Tests for ProxyServer host access enforcement.
 *
 * The proxy is the only thing enforcing hostname policy: macOS sandbox-exec
 * cannot filter by hostname, so every allow/block decision happens here.
 */

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
