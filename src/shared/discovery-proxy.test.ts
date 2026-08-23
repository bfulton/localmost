/**
 * Tests for Discovery Proxy
 */

import { DiscoveryProxy } from './discovery-proxy';

describe('DiscoveryProxy', () => {
  let proxy: DiscoveryProxy;

  afterEach(async () => {
    if (proxy) {
      await proxy.stop();
    }
  });

  // ===========================================================================
  // Basic Functionality
  // ===========================================================================

  describe('Basic Functionality', () => {
    it('should start and return a valid port', async () => {
      proxy = new DiscoveryProxy();
      const port = await proxy.start();
      expect(port).toBeGreaterThan(0);
    });

    it('should return proxy URL', async () => {
      proxy = new DiscoveryProxy({ port: 0 });
      const port = await proxy.start();
      expect(proxy.getProxyUrl()).toBe(`http://127.0.0.1:${port}`);
    });

    it('should handle stop gracefully', async () => {
      proxy = new DiscoveryProxy();
      await proxy.start();
      await proxy.stop();
      // Should not throw
    });

    it('should handle multiple stop calls', async () => {
      proxy = new DiscoveryProxy();
      await proxy.start();
      await proxy.stop();
      await proxy.stop(); // Second stop should not throw
    });
  });

  // ===========================================================================
  // Host Allowlist Logic
  // ===========================================================================

  describe('Host Allowlist Logic', () => {
    // Test the isHostAllowed private method via the constructor configuration

    it('should store null allowlist in discovery mode (undefined)', () => {
      proxy = new DiscoveryProxy({
        allowlist: undefined,
      });
      // Access private field for testing
      expect((proxy as unknown as { allowlist: string[] | null }).allowlist).toBeNull();
    });

    it('should store empty array allowlist in strict mode', () => {
      proxy = new DiscoveryProxy({
        allowlist: [],
      });
      expect((proxy as unknown as { allowlist: string[] | null }).allowlist).toEqual([]);
    });

    it('should store allowlist when provided', () => {
      proxy = new DiscoveryProxy({
        allowlist: ['github.com', '*.example.com'],
      });
      expect((proxy as unknown as { allowlist: string[] | null }).allowlist).toEqual([
        'github.com',
        '*.example.com',
      ]);
    });
  });

  // ===========================================================================
  // isHostAllowed Function Tests
  // ===========================================================================

  describe('isHostAllowed', () => {
    // We test the private isHostAllowed method by invoking it via the class
    const testIsHostAllowed = (
      allowlist: string[] | undefined,
      host: string
    ): boolean => {
      const proxy = new DiscoveryProxy({ allowlist });
      // Access private method for testing
      return (proxy as unknown as { isHostAllowed(host: string): boolean }).isHostAllowed(host);
    };

    describe('Discovery Mode (allowlist undefined)', () => {
      it('should allow any host', () => {
        expect(testIsHostAllowed(undefined, 'github.com')).toBe(true);
        expect(testIsHostAllowed(undefined, 'any-random-host.io')).toBe(true);
        expect(testIsHostAllowed(undefined, 'malicious.site')).toBe(true);
      });
    });

    describe('Strict Mode (empty allowlist)', () => {
      it('should block all hosts', () => {
        expect(testIsHostAllowed([], 'github.com')).toBe(false);
        expect(testIsHostAllowed([], 'any-host.com')).toBe(false);
        expect(testIsHostAllowed([], 'localhost')).toBe(false);
      });
    });

    describe('Enforcement Mode (with allowlist)', () => {
      it('should allow exact matches', () => {
        const allowlist = ['github.com', 'npmjs.org'];
        expect(testIsHostAllowed(allowlist, 'github.com')).toBe(true);
        expect(testIsHostAllowed(allowlist, 'npmjs.org')).toBe(true);
      });

      it('should block non-matching hosts', () => {
        const allowlist = ['github.com'];
        expect(testIsHostAllowed(allowlist, 'gitlab.com')).toBe(false);
        expect(testIsHostAllowed(allowlist, 'evil.com')).toBe(false);
      });

      it('should support wildcard patterns', () => {
        const allowlist = ['*.github.com'];
        expect(testIsHostAllowed(allowlist, 'api.github.com')).toBe(true);
        expect(testIsHostAllowed(allowlist, 'raw.githubusercontent.com')).toBe(false);
        expect(testIsHostAllowed(allowlist, 'github.com')).toBe(false); // Root domain doesn't match *.
      });

      it('should be case-insensitive', () => {
        const allowlist = ['GitHub.COM'];
        expect(testIsHostAllowed(allowlist, 'github.com')).toBe(true);
        expect(testIsHostAllowed(allowlist, 'GITHUB.COM')).toBe(true);
        expect(testIsHostAllowed(allowlist, 'GitHub.com')).toBe(true);
      });

      it('should handle multiple allowlist entries', () => {
        const allowlist = ['github.com', '*.npmjs.org', 'crates.io'];
        expect(testIsHostAllowed(allowlist, 'github.com')).toBe(true);
        expect(testIsHostAllowed(allowlist, 'registry.npmjs.org')).toBe(true);
        expect(testIsHostAllowed(allowlist, 'crates.io')).toBe(true);
        expect(testIsHostAllowed(allowlist, 'pypi.org')).toBe(false);
      });

      it('should handle deep subdomains with wildcard', () => {
        const allowlist = ['*.github.com'];
        expect(testIsHostAllowed(allowlist, 'api.github.com')).toBe(true);
        expect(testIsHostAllowed(allowlist, 'deep.nested.github.com')).toBe(true);
      });
    });
  });

  // ===========================================================================
  // Access Tracking
  // ===========================================================================

  describe('Access Tracking', () => {
    it('should start with empty accessed hosts', async () => {
      proxy = new DiscoveryProxy();
      await proxy.start();
      expect(proxy.getAccessedHosts()).toEqual([]);
    });

    it('should return accessed hosts in sorted order', async () => {
      proxy = new DiscoveryProxy();
      await proxy.start();
      // Directly manipulate the internal set for testing
      const accessedHosts = (
        proxy as unknown as { accessedHosts: Set<string> }
      ).accessedHosts;
      accessedHosts.add('zebra.com');
      accessedHosts.add('apple.com');
      accessedHosts.add('mango.com');

      expect(proxy.getAccessedHosts()).toEqual([
        'apple.com',
        'mango.com',
        'zebra.com',
      ]);
    });
  });
});
