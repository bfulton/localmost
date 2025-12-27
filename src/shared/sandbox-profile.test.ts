/**
 * Tests for Sandbox Profile Generator
 */

import {
  generateSandboxProfile,
  generateDiscoveryProfile,
  DEFAULT_SANDBOX_POLICY,
  SandboxPolicy,
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

  describe('generateSandboxProfile - Basic structure', () => {
    it('should generate valid sandbox profile structure', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
      });

      expect(profile).toContain('(version 1)');
      expect(profile).toContain('(deny default)');
      expect(profile).toContain(';; LOCALMOST SANDBOX PROFILE');
    });

    it('should use allow default in permissive mode', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        permissive: true,
      });

      expect(profile).toContain('(allow default)');
      expect(profile).toContain('PERMISSIVE mode');
    });

    it('should include trace to stderr by default', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
      });

      expect(profile).toContain('(trace "/dev/stderr")');
    });

    it('should use custom log file when specified', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        logFile: '/tmp/sandbox.log',
      });

      expect(profile).toContain('(trace "/tmp/sandbox.log")');
    });
  });

  // ===========================================================================
  // generateSandboxProfile - File access
  // ===========================================================================

  describe('generateSandboxProfile - File access', () => {
    it('should allow read access to filesystem', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
      });

      expect(profile).toContain('(allow file-read*');
      expect(profile).toContain('(subpath "/")');
    });

    it('should allow write to work directory', () => {
      const profile = generateSandboxProfile({
        workDir: '/my/project',
      });

      expect(profile).toContain('(allow file-write*');
      expect(profile).toContain('(subpath "/my/project")');
    });

    it('should allow write to system temp directories', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
      });

      expect(profile).toContain('(subpath "/tmp")');
      expect(profile).toContain('(subpath "/private/tmp")');
      expect(profile).toContain('(subpath "/var/folders")');
      expect(profile).toContain('(subpath "/private/var/folders")');
    });

    it('should allow write to package manager caches', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
      });

      expect(profile).toContain('.npm');
      expect(profile).toContain('.yarn');
      expect(profile).toContain('.cargo');
      expect(profile).toContain('.cache');
    });

    it('should allow write to localmost directories', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
      });

      expect(profile).toContain('.localmost');
    });

    it('should allow policy-defined write paths', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        policy: {
          filesystem: {
            write: ['/custom/path', './relative/path'],
          },
        },
      });

      expect(profile).toContain('(subpath "/custom/path")');
    });

    it('should expand ~ in filesystem paths', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
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
    it('should allow all network when no policy defined', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
      });

      expect(profile).toContain('(allow network*)');
    });

    it('should restrict network to allowlist when policy defined', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        policy: {
          network: {
            allow: ['github.com'],
          },
        },
      });

      expect(profile).toContain('(allow network-outbound');
      // Domain dots are escaped in the regex pattern
      expect(profile).toContain('github');
      expect(profile).not.toContain('(allow network*)');
    });

    it('should always allow localhost', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        policy: {
          network: {
            allow: ['github.com'],
          },
        },
      });

      expect(profile).toContain('(local ip)');
    });

    it('should handle wildcard domains', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        policy: {
          network: {
            allow: ['*.github.com'],
          },
        },
      });

      expect(profile).toContain('remote regex');
      expect(profile).toContain('github\\\\.com');
    });

    it('should deny specified domains', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        policy: {
          network: {
            deny: ['evil.com'],
          },
        },
      });

      expect(profile).toContain('(deny network-outbound');
      // Domain dots are escaped in the regex pattern
      expect(profile).toContain('evil');
    });

    it('should allow all network in permissive mode even with policy', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        permissive: true,
        policy: {
          network: {
            allow: ['github.com'],
          },
        },
      });

      expect(profile).toContain('(allow network*)');
    });
  });

  // ===========================================================================
  // generateSandboxProfile - Process and system operations
  // ===========================================================================

  describe('generateSandboxProfile - Process and system operations', () => {
    it('should allow process operations', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
      });

      expect(profile).toContain('(allow process*)');
    });

    it('should allow signal operations', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
      });

      expect(profile).toContain('(allow signal)');
    });

    it('should allow mach and ipc operations', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
      });

      expect(profile).toContain('(allow mach*)');
      expect(profile).toContain('(allow ipc*)');
    });

    it('should allow system operations needed for builds', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
      });

      expect(profile).toContain('(allow sysctl*)');
      expect(profile).toContain('(allow iokit*)');
      expect(profile).toContain('(allow pseudo-tty)');
    });

    it('should allow Xcode preferences', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
      });

      expect(profile).toContain('com.apple.dt.Xcode');
    });
  });

  // ===========================================================================
  // generateDiscoveryProfile
  // ===========================================================================

  describe('generateDiscoveryProfile', () => {
    it('should generate permissive profile', () => {
      const profile = generateDiscoveryProfile({
        workDir: '/path/to/project',
        logFile: '/tmp/discovery.log',
      });

      expect(profile).toContain('(allow default)');
      expect(profile).toContain('(trace "/tmp/discovery.log")');
    });

    it('should use permissive mode flag', () => {
      const profile = generateDiscoveryProfile({
        workDir: '/path/to/project',
        logFile: '/tmp/discovery.log',
      });

      expect(profile).toContain('PERMISSIVE mode');
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
      });

      expect(profile).toContain('/path/with\\"quote');
    });

    it('should handle empty policy', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        policy: {},
      });

      expect(profile).toContain('(version 1)');
      expect(profile).toContain('(allow network*)');
    });

    it('should handle policy with empty arrays', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        policy: {
          network: { allow: [] },
          filesystem: { write: [], deny: [] },
        },
      });

      expect(profile).toContain('(version 1)');
    });
  });
});
