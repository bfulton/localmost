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

/**
 * A profile's top-level rules, each with its continuation lines, so a test can
 * ask what one rule grants rather than whether a string appears anywhere.
 */
function topLevelForms(profile: string): string[] {
  const forms: string[] = [];
  for (const line of profile.split('\n')) {
    if (line.startsWith('(')) forms.push(line);
    else if (/^\s+\(/.test(line) && forms.length > 0) forms[forms.length - 1] += `\n${line}`;
  }
  return forms;
}

describe('Sandbox Profile Generator', () => {
  // The app data directory is named in every profile; pin it to the default
  // under the mocked home whatever the environment running the tests says.
  const savedConfigDir = process.env.LOCALMOST_CONFIG_DIR;
  beforeAll(() => {
    delete process.env.LOCALMOST_CONFIG_DIR;
  });
  afterAll(() => {
    if (savedConfigDir !== undefined) process.env.LOCALMOST_CONFIG_DIR = savedConfigDir;
  });

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

    it('grants no home directory cache that the policy has not declared, with or without a policy', () => {
      // Steps run with HOME inside the workspace, so these grants only served
      // tools that bypass it - and every one is a store the user's own builds
      // later execute from: ~/.cargo/bin, ~/.local/bin, ~/go/bin, Gradle init
      // scripts, Maven settings. Any checkout with a .localmostrc used to get
      // them all.
      for (const policy of [undefined, {}]) {
        const profile = generateSandboxProfile({ workDir: '/path/to/project', proxyPort: DEFAULT_PROXY_PORT, policy });
        const grants = topLevelForms(profile).filter((form) => form.startsWith('(allow'));
        expect(grants.filter((form) => form.includes('"/Users/test/'))).toEqual([]);
      }
    });

    it('still grants a home cache the policy declares', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: { filesystem: { write: ['~/.npm'] } },
      });
      expect(profile).toContain('(subpath "/Users/test/.npm")');
    });

    it('denies the credentials the runner never grants, after every policy grant', () => {
      // A checkout's .localmostrc is applied in test mode without approval; one
      // that declares ~ readable must still not reach the developer's keys.
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: { filesystem: { read: ['~'], write: ['~'] } },
      });
      const forms = topLevelForms(profile);
      const lastGrant = forms.map((f) => f.includes('"/Users/test"')).lastIndexOf(true);
      const deny = forms.findIndex((f) => f.startsWith('(deny file-read* file-write*') && f.includes('/Users/test/.ssh'));
      expect(deny).toBeGreaterThan(lastGrant);
      for (const secret of [
        '(subpath "/Users/test/.ssh")',
        '(subpath "/Users/test/.aws")',
        '(subpath "/Users/test/.gnupg")',
        '(subpath "/Users/test/.config")',
        '(subpath "/Users/test/Library/Keychains")',
        '(literal "/Users/test/.netrc")',
        '(literal "/Users/test/.npmrc")',
      ]) {
        expect(forms[deny]).toContain(secret);
      }
      // Nothing after the deny reopens any of it.
      expect(forms.slice(deny + 1).filter((f) => f.startsWith('(allow file-') && f.includes('/Users/test/.'))).toEqual([]);
    });

    it('grants nothing of the app data directory, with or without a policy', () => {
      // ~/.localmost holds the runner template every worker is copied from and
      // the approval cache. A test run that could write them would reach every
      // later real job, and approve its own policy.
      for (const policy of [undefined, {}]) {
        const profile = generateSandboxProfile({
          workDir: '/Users/test/.localmost/workspaces/ws-1',
          proxyPort: DEFAULT_PROXY_PORT,
          policy,
        });
        const grants = topLevelForms(profile).filter((form) => form.startsWith('(allow'));
        expect(grants.filter((form) => form.includes('"/Users/test/.localmost"'))).toEqual([]);
      }
    });

    it('denies the app data directory after every policy grant, then reopens only the workspace', () => {
      const workDir = '/Users/test/.localmost/workspaces/ws-1';
      const profile = generateSandboxProfile({
        workDir,
        proxyPort: DEFAULT_PROXY_PORT,
        policy: {
          filesystem: {
            read: ['~/.localmost', '~'],
            write: ['~/.localmost/runner', '~/.localmost/policies', '~'],
          },
        },
      });

      const denyForm = topLevelForms(profile).find(
        (form) => form.startsWith('(deny file-read* file-write*') && form.includes('(subpath "/Users/test/.localmost")')
      );
      expect(denyForm).toContain('(subpath "/Users/test/Library/Application Support/localmost")');
      const deny = profile.indexOf(denyForm!);
      expect(deny).toBeGreaterThan(profile.indexOf(';; Policy-defined write access'));
      expect(deny).toBeGreaterThan(profile.indexOf(';; Policy-defined read access'));
      // Seatbelt takes the last matching rule, so after the deny the only
      // file grant that may name anything under the app data directory is
      // this run's own workspace.
      const reopened = topLevelForms(profile.slice(deny))
        .filter((form) => form.startsWith('(allow file-') && !form.startsWith('(allow file-read-metadata'))
        .flatMap((form) => [...form.matchAll(/"([^"]+)"/g)].map((m) => m[1]))
        .filter((p) => p.startsWith('/Users/test/.localmost') || p.startsWith('/Users/test/Library'));
      expect(reopened).toEqual([workDir]);
    });

    it('never lets a step connect to the CLI socket', () => {
      const profile = generateSandboxProfile({ workDir: '/path/to/project', proxyPort: DEFAULT_PROXY_PORT });
      expect(profile).toContain('(deny network-outbound (literal "/Users/test/.localmost/localmost.sock"))');
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

    it('turns a * path into an anchored regex with everything else literal', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: {
          filesystem: {
            read: ['/opt/c++/lib*'],
            write: ['~/.npm/_cacache/*'],
            deny: ['~/.ssh/id_*'],
          },
        },
      });
      // Written into an SBPL string, where a backslash is itself escaped.
      expect(profile).toContain('(regex "^/opt/c\\\\+\\\\+/lib.*$")');
      expect(profile).toContain('(regex "^/Users/test/\\\\.npm/_cacache/.*$")');
      expect(profile).toContain('(deny file-read* (regex "^/Users/test/\\\\.ssh/id_.*$"))');
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
      expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
      expect(profile).toContain('proxy at port 9999');
      expect(profile).not.toContain('(allow network*)');
    });

    it('never grants an IP rule that matches every address', () => {
      // (local ip) names the local end of any IP socket, so as an outbound
      // filter it matches a connection to anywhere: a step could ignore
      // HTTP_PROXY and reach the internet directly, past the allowlist.
      for (const profile of [
        generateSandboxProfile({ workDir: '/path/to/project', proxyPort: 9999 }),
        generateDiscoveryProfile({ workDir: '/path/to/project', proxyPort: 9999, logFile: '' }),
      ]) {
        expect(profile).not.toContain('(local ip)');
        expect(profile).toContain('(deny network*)');
        expect(profile).toContain('(allow network-bind (local ip "localhost:*"))');
        expect(profile).toContain('(allow network-inbound (local ip "localhost:*"))');
        // The app's broker carries job payloads; a step has no reason to open it.
        expect(profile).toContain('(deny network-outbound (remote ip "localhost:8787"))');
        // Nothing after the deny reopens outbound IP beyond loopback.
        const afterDeny = profile.slice(profile.indexOf('(deny network*)'));
        const outboundIp = afterDeny.match(/\(allow network-outbound \((?:remote|local) ip[^)]*\)\)/g);
        expect(outboundIp).toEqual(['(allow network-outbound (remote ip "localhost:*"))']);
      }
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

      expect(profile).toContain('(remote ip "localhost:*")');
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

    it('reports a write the discovery profile refused, so the policy can declare it', () => {
      const result = parseSandboxTrace(
        [
          'kernel: (Sandbox) Sandbox: npm(101) deny(1) file-write-create /opt/cache/x',
          'kernel: (Sandbox) Sandbox: npm(102) allow file-write-data /work/out',
        ].join('\n'),
        '/work'
      );
      expect(result.writePaths).toEqual(['/opt/cache/x']);
    });

    it('never suggests what no policy can grant', () => {
      // The app's own data and the developer's credentials are denied at every
      // level; proposing them for .localmostrc would only mislead.
      const result = parseSandboxTrace(
        [
          'kernel: (Sandbox) Sandbox: sh(101) deny(1) file-read-data /Users/test/.ssh/id_ed25519',
          'kernel: (Sandbox) Sandbox: sh(102) deny(1) file-write-create /Users/test/.localmost/runner/x',
          'kernel: (Sandbox) Sandbox: sh(103) allow file-read-data /Users/test/.aws/config',
        ].join('\n'),
        '/work'
      );
      expect(result.readPaths).toEqual([]);
      expect(result.writePaths).toEqual([]);
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
      expect(profile).toContain('(allow file-write* (with report)\n  (subpath "/path/to/project")');
    });

    it('observes writes outside the workspace without letting them happen', () => {
      // Discovery exists to see what a workflow touches, not to hand an
      // untrusted checkout the disk: an unfiltered write allow let a
      // --updaterc run write anywhere the user can.
      const profile = generateDiscoveryProfile({
        workDir: '/Users/test/.localmost/workspaces/ws-1',
        proxyPort: DEFAULT_PROXY_PORT,
        logFile: '',
      });
      const forms = topLevelForms(profile);
      expect(forms).not.toContain('(allow file-write* (with report))');
      expect(forms).not.toContain('(allow file-ioctl (with report))');
      const writeGrants = forms.filter((f) => f.startsWith('(allow file-write*') || f.startsWith('(allow file-read* file-write*'));
      const granted = writeGrants.flatMap((f) => [...f.matchAll(/\((?:subpath|literal) "([^"]+)"\)/g)].map((m) => m[1]));
      expect(granted.sort()).toEqual(
        [
          '/Users/test/.localmost/workspaces/ws-1',
          '/Users/test/.localmost/workspaces/ws-1',
          '/var/folders/test/temp',
          '/tmp',
          '/private/tmp',
          '/var/folders',
          '/private/var/folders',
          '/dev/null',
          '/dev/random',
          '/dev/urandom',
          '/dev/tty',
          '/dev/dtracehelper',
        ].sort()
      );
      // Reads are still observed everywhere but what is never reachable.
      expect(forms).toContain('(allow file-read* (with report))');
      const deny = forms.findIndex((f) => f.startsWith('(deny file-read* file-write*') && f.includes('/Users/test/.ssh'));
      expect(deny).toBeGreaterThan(forms.indexOf('(allow file-read* (with report))'));
      expect(forms[deny]).toContain('(subpath "/Users/test/.localmost")');
      expect(profile).toContain('(deny network-outbound (literal "/Users/test/.localmost/localmost.sock"))');
      // Preferences are a persistence point too; the Xcode domain is the one
      // the enforcement profile grants.
      expect(forms).not.toContain('(allow user-preference-write)');
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

      expect(profile).toContain('(remote ip "localhost:*")');
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
      expect(profile).toContain('(remote ip "localhost:*")');
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

describe('docker access in the test-mode profile', () => {
  const base = { workDir: '/Users/dev/project', proxyPort: 8080 };

  it('emits no docker rules without a docker policy', () => {
    const profile = generateSandboxProfile({ ...base, policy: {} });
    expect(profile).not.toContain('docker.sock');
  });

  it('never opens the daemon socket or ~/.docker from a docker policy', () => {
    // A policy names requests the filtering socket may forward. It is not a
    // level that unlocks the daemon: a job handed the daemon socket can
    // bind-mount every host path this profile denies.
    const profile = generateSandboxProfile({
      ...base,
      policy: {
        docker: {
          pull: { registries: ['docker.io'] },
          run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'rw' }] },
          build: { context: './' },
          privileged: true,
        },
      },
    });
    expect(profile).not.toContain('docker.sock');
    expect(profile).not.toContain('config.json');
    expect(profile).not.toMatch(/\(allow [^\n]*\.docker/);
  });
});
