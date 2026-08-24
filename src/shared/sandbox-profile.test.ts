/**
 * Tests for Sandbox Profile Generator
 */

import {
  generateSandboxProfile,
  generateDiscoveryProfile,
  DEFAULT_SANDBOX_POLICY,
} from './sandbox-profile';

// Mock os module
jest.mock('os', () => ({
  homedir: jest.fn(() => '/Users/test'),
  tmpdir: jest.fn(() => '/var/folders/test/temp'),
  cpus: jest.fn(() => new Array(8).fill({})),
  totalmem: jest.fn(() => 16 * 1024 * 1024 * 1024),
}));

describe('Sandbox Profile Generator', () => {

  // ===========================================================================
  // generateSandboxProfile - Basic structure
  // ===========================================================================

  const DEFAULT_PROXY_PORT = 8080;

  describe('generateSandboxProfile - Basic structure', () => {
    it('should generate valid sandbox profile structure', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('(version 1)');
      expect(profile).toContain('(deny default)');
      expect(profile).toContain(';; LOCALMOST SANDBOX PROFILE');
    });

    it('should use allow default in permissive mode', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        permissive: true,
      });

      expect(profile).toContain('(allow default)');
      expect(profile).toContain('PERMISSIVE mode');
    });

    it('should include trace to stderr by default', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('(trace "/dev/stderr")');
    });

    it('should use custom log file when specified', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        logFile: '/tmp/sandbox.log',
      });

      expect(profile).toContain('(trace "/tmp/sandbox.log")');
    });
  });

  // ===========================================================================
  // generateSandboxProfile - File access
  // ===========================================================================

  describe('generateSandboxProfile - File access', () => {
    it('should always allow reading the root directory node', () => {
      // Without this, dyld aborts every sandboxed process with SIGABRT before
      // it runs: reading "/" itself is required to resolve any absolute path.
      // It must be a literal, not a subpath, or it would grant the whole disk.
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        strictMode: true,
      });

      expect(profile).toContain('(literal "/")');
      expect(profile).not.toContain('(subpath "/")');
    });

    it('should allow read access only to workDir and temp by default', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('(allow file-read*');
      expect(profile).toContain('(subpath "/path/to/project")');
      expect(profile).toContain('(subpath "/tmp")');
      // System paths should NOT be allowed by default
      expect(profile).not.toContain('(subpath "/System")');
      expect(profile).not.toContain('(subpath "/Library")');
      expect(profile).not.toContain('(subpath "/usr")');
    });

    it('should allow policy-defined system read paths', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: {
          filesystem: {
            read: ['/System', '/Library', '/usr', '/bin', '/Applications'],
          },
        },
      });

      expect(profile).toContain('(subpath "/System")');
      expect(profile).toContain('(subpath "/Library")');
      expect(profile).toContain('(subpath "/usr")');
    });

    it('should allow write to work directory', () => {
      const profile = generateSandboxProfile({
        workDir: '/my/project',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('(allow file-write*');
      expect(profile).toContain('(subpath "/my/project")');
    });

    it('should allow write to system temp directories', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('(subpath "/tmp")');
      expect(profile).toContain('(subpath "/private/tmp")');
      expect(profile).toContain('(subpath "/var/folders")');
      expect(profile).toContain('(subpath "/private/var/folders")');
    });

    it('should allow write to package manager caches', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('.npm');
      expect(profile).toContain('.yarn');
      expect(profile).toContain('.cargo');
      expect(profile).toContain('.cache');
    });

    it('should allow write to localmost directories', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('.localmost');
    });

    it('should allow policy-defined write paths', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: {
          filesystem: {
            write: ['/custom/path', './relative/path'],
          },
        },
      });

      expect(profile).toContain('(subpath "/custom/path")');
    });

    it('should allow policy-defined read paths', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: {
          filesystem: {
            read: ['/custom/data', '~/mydata'],
          },
        },
      });

      expect(profile).toContain('Policy-defined read access');
      expect(profile).toContain('(subpath "/custom/data")');
    });

    it('should expand ~ in filesystem paths', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: {
          filesystem: {
            write: ['~/custom'],
          },
        },
      });

      expect(profile).toContain('/Users/test/custom');
    });

    it('should handle ** wildcards in paths', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: {
          filesystem: {
            write: ['./build/**'],
          },
        },
      });

      expect(profile).toContain('(subpath');
    });

    it('should deny specified filesystem paths', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: {
          filesystem: {
            deny: ['/secret/path'],
          },
        },
      });

      expect(profile).toContain('(deny file-read*');
      expect(profile).toContain('(deny file-write*');
      expect(profile).toContain('(subpath "/secret/path")');
    });

    it('should allow device files', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('(literal "/dev/null")');
      expect(profile).toContain('(literal "/dev/random")');
      expect(profile).toContain('(literal "/dev/urandom")');
      expect(profile).toContain('(literal "/dev/tty")');
    });
  });

  // ===========================================================================
  // generateSandboxProfile - Network access
  // ===========================================================================

  describe('generateSandboxProfile - Network access', () => {
    it('should restrict network to localhost', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: 9999,
      });

      // Network should be restricted to localhost (proxy handles filtering)
      expect(profile).toContain('(local ip)');
      expect(profile).toContain('proxy at port 9999');
      expect(profile).not.toContain('(allow network*)');
    });

    it('should restrict Unix sockets to working directory', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: 8080,
      });

      // Unix sockets only allowed in workDir (not blanket allow)
      expect(profile).toContain('network-bind (subpath "/path/to/project")');
      expect(profile).toContain('network-outbound (subpath "/path/to/project")');
      expect(profile).not.toContain('(local unix-socket)');
    });

    it('should allow traffic to localhost regardless of policy', () => {
      // Policy is for proxy-level filtering, sandbox just restricts to localhost
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: 8080,
        policy: {
          network: {
            allow: ['github.com'],
          },
        },
      });

      expect(profile).toContain('(local ip)');
      expect(profile).not.toContain('github.com');
    });
  });

  // ===========================================================================
  // generateSandboxProfile - Process and system operations
  // ===========================================================================

  describe('generateSandboxProfile - Process and system operations', () => {
    it('should allow process operations', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('(allow process*)');
    });

    it('should allow signal operations', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('(allow signal)');
    });

    it('should allow mach and ipc operations', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('(allow mach*)');
      expect(profile).toContain('(allow ipc*)');
    });

    it('should allow system operations needed for builds', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('(allow sysctl*)');
      expect(profile).toContain('(allow iokit*)');
      expect(profile).toContain('(allow pseudo-tty)');
    });

    it('should allow Xcode preferences', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('com.apple.dt.Xcode');
    });
  });

  // ===========================================================================
  // generateDiscoveryProfile
  // ===========================================================================

  describe('generateDiscoveryProfile', () => {
    it('should use deny default with (with report) allows for system log reporting', () => {
      const profile = generateDiscoveryProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        logFile: '/tmp/discovery.log',  // Not used anymore - reports go to system log
      });

      expect(profile).toContain('(deny default)');
      // File operations with (with report) for logging to system log
      expect(profile).toContain('(allow file-read* (with report))');
      expect(profile).toContain('(allow file-write* (with report))');
    });

    it('should identify as discovery profile', () => {
      const profile = generateDiscoveryProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        logFile: '/tmp/discovery.log',
      });

      expect(profile).toContain('DISCOVERY PROFILE');
    });

    it('should still restrict network to localhost', () => {
      const profile = generateDiscoveryProfile({
        workDir: '/path/to/project',
        proxyPort: 9999,
        logFile: '/tmp/discovery.log',
      });

      expect(profile).toContain('(local ip)');
      expect(profile).toContain('proxy at port 9999');
    });
  });

  // ===========================================================================
  // DEFAULT_SANDBOX_POLICY
  // ===========================================================================

  describe('DEFAULT_SANDBOX_POLICY', () => {
    it('should include GitHub domains', () => {
      expect(DEFAULT_SANDBOX_POLICY.network?.allow).toContain('*.github.com');
      expect(DEFAULT_SANDBOX_POLICY.network?.allow).toContain('github.com');
    });

    it('should include common package registries', () => {
      expect(DEFAULT_SANDBOX_POLICY.network?.allow).toContain('registry.npmjs.org');
      expect(DEFAULT_SANDBOX_POLICY.network?.allow).toContain('pypi.org');
      expect(DEFAULT_SANDBOX_POLICY.network?.allow).toContain('crates.io');
    });

    it('should include Apple/Xcode domains', () => {
      expect(DEFAULT_SANDBOX_POLICY.network?.allow).toContain('*.apple.com');
      expect(DEFAULT_SANDBOX_POLICY.network?.allow).toContain('cdn.cocoapods.org');
    });

    it('should deny access to sensitive files', () => {
      expect(DEFAULT_SANDBOX_POLICY.filesystem?.deny).toContain('~/.ssh/id_*');
      expect(DEFAULT_SANDBOX_POLICY.filesystem?.deny).toContain('~/.gnupg/*');
      expect(DEFAULT_SANDBOX_POLICY.filesystem?.deny).toContain('~/.aws/*');
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should escape quotes in paths', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/with"quote',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('/path/with\\"quote');
    });

    it('should handle empty policy', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: {},
      });

      expect(profile).toContain('(version 1)');
      expect(profile).toContain('(local ip)');
    });

    it('should handle policy with empty arrays', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: {
          network: { allow: [] },
          filesystem: { write: [], deny: [] },
        },
      });

      expect(profile).toContain('(version 1)');
    });
  });
});
