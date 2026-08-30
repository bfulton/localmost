/**
 * Tests for Sandbox Profile Generator
 */

import {
  generateSandboxProfile,
  generateDiscoveryProfile,
  DEFAULT_SANDBOX_POLICY,
  parseSandboxTrace,
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
    it('grants no system paths that the policy has not declared', () => {
      // Reading a .localmostrc should tell you everything a job may touch, so
      // nothing is granted implicitly. The one exception is the root directory
      // node, which is not an access grant - it is what makes an absolute path
      // resolvable at all.
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        strictMode: true,
      });

      for (const notGranted of ['/bin', '/usr', '/System', '/Library', '/Applications/Xcode.app']) {
        expect(profile).not.toContain(`(subpath "${notGranted}")`);
      }
      expect(profile).toContain('(allow file-read* (literal "/"))');
    });

    it('grants system paths once the policy declares them', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: { filesystem: { read: ['/bin', '/usr'] } },
      });

      expect(profile).toContain('(subpath "/bin")');
      expect(profile).toContain('(subpath "/usr")');
    });

    it('never turns a declared "/" into a subpath', () => {
      // Discovery can observe a read of the root node. Writing it back as a
      // subpath would grant the entire disk and make every other entry moot.
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: { filesystem: { read: ['/', '/bin'] } },
      });

      expect(profile).not.toContain('(subpath "/")');
      expect(profile).toContain('(subpath "/bin")');
    });

    it('does not grant the baseline as write access', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        strictMode: true,
      });

      const writeSection = profile.slice(profile.indexOf(';; Write access'));
      expect(writeSection).not.toContain('(subpath "/usr")');
      expect(writeSection).not.toContain('(subpath "/System")');
    });


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

    it('reads the workDir and temp, and nothing of the user, by default', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('(allow file-read*');
      expect(profile).toContain('(subpath "/path/to/project")');
      expect(profile).toContain('(subpath "/tmp")');

      // A blanket root subpath would grant the whole disk and make every other
      // rule meaningless.
      expect(profile).not.toContain('(subpath "/")');
      expect(profile).not.toContain('(subpath "/Users")');
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

  describe('parseSandboxTrace consolidation', () => {
    function trace(paths: string[]): string {
      return paths
        .map((p, i) => `kernel: (Sandbox) Sandbox: bash(${100 + i}) allow file-read-data ${p}`)
        .join('\n');
    }

    it('drops paths already covered by a listed ancestor', () => {
      // A policy entry is emitted as (subpath ...), so every descendant the
      // trace also recorded is pure redundancy. Discovery previously kept all
      // of them, producing thousands of lines that said nothing new.
      const result = parseSandboxTrace(
        trace(['/opt/homebrew', '/opt/homebrew/bin', '/opt/homebrew/bin/git', '/opt/other']),
        '/work'
      );

      expect(result.readPaths).toEqual(['/opt/homebrew', '/opt/other']);
    });

    it('records system paths, since nothing grants them implicitly', () => {
      const result = parseSandboxTrace(
        trace(['/usr/bin/curl', '/opt/homebrew/bin/git']),
        '/work'
      );

      expect(result.readPaths.sort()).toEqual(['/opt/homebrew/bin/git', '/usr/bin/curl']);
    });

    it('never emits the filesystem root as a policy entry', () => {
      // Reading the root node is required and the generated profile always
      // allows it as a literal. Recording "/" here would be written back as
      // (subpath "/"), silently granting the whole disk.
      const result = parseSandboxTrace(trace(['/', '/opt/homebrew']), '/work');

      expect(result.readPaths).not.toContain('/');
      expect(result.readPaths).toContain('/opt/homebrew');
    });

    it('keeps unrelated siblings', () => {
      const result = parseSandboxTrace(trace(['/opt/a', '/opt/b']), '/work');

      expect(result.readPaths.sort()).toEqual(['/opt/a', '/opt/b']);
    });
  });

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
