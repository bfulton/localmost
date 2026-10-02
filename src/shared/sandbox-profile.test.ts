/**
 * Tests for Sandbox Profile Generator
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
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

    it('reads the workDir, and nothing of the user, by default', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
      });

      expect(profile).toContain('(allow file-read*');
      expect(profile).toContain('(subpath "/path/to/project")');

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

    it('grants no shared temp directory, only the entries bare mktemp creates there', () => {
      // /tmp and the per-user /var/folders tree are shared with everything the
      // user runs, and hold state their own tools trust: the xcrun cache, the
      // clang module cache. A step's temp is in its workspace, as a runner
      // job's is in its sandbox.
      for (const profile of [
        generateSandboxProfile({ workDir: '/path/to/project', proxyPort: DEFAULT_PROXY_PORT }),
        generateDiscoveryProfile({ workDir: '/path/to/project', proxyPort: DEFAULT_PROXY_PORT, logFile: '' }),
      ]) {
        for (const shared of ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', '/var/folders/test/temp']) {
          expect(profile).not.toContain(`(subpath "${shared}")`);
        }
        const mktemp = topLevelForms(profile).find((f) => f.startsWith('(allow file-write* file-read*') && f.includes('(regex #"'));
        expect(mktemp).toMatch(/\/T\/tmp\\\.(\[A-Za-z0-9\]){10}/);
      }
    });

    it("grants the job's own suffixed directory in the per-user temp, in both spellings, and no more of it", () => {
      // DIRHELPER_USER_DIR_SUFFIX moves a process's per-user temp directory to
      // T/<suffix>, and a sandboxed Foundation stages its atomic writes in
      // TemporaryItems there. The job gets that directory; the rest of T,
      // which every process the user runs shares, stays closed.
      const userTemp = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf-8' })
        .trim().replace(/\/+$/, '').replace(/^\/private/, '');
      const suffix = 'localmost-job-3f9a';
      for (const profile of [
        generateSandboxProfile({ workDir: '/path/to/project', proxyPort: DEFAULT_PROXY_PORT, jobTempSuffix: suffix }),
        generateDiscoveryProfile({ workDir: '/path/to/project', proxyPort: DEFAULT_PROXY_PORT, logFile: '', jobTempSuffix: suffix }),
      ]) {
        expect(topLevelForms(profile)).toContain(
          `(allow file-read* file-write*\n  (subpath "/private${userTemp}/${suffix}")\n  (subpath "${userTemp}/${suffix}"))`
        );
        expect(profile).not.toContain(`(subpath "${userTemp}")`);
        expect(profile).not.toContain(`(subpath "/private${userTemp}")`);
      }
      // None when the job has no suffix.
      expect(generateSandboxProfile({ workDir: '/path/to/project', proxyPort: DEFAULT_PROXY_PORT }))
        .not.toContain(`(subpath "${userTemp}/`);
    });

    it.each(['', '.', '..', 'a/b', '../T', 'a"b', 'a b', '-x'])('refuses a temp suffix that is not one plain name: %j', (suffix) => {
      // It lands in the profile as a path component under the shared T.
      expect(() => generateSandboxProfile({ workDir: '/path/to/project', proxyPort: DEFAULT_PROXY_PORT, jobTempSuffix: suffix }))
        .toThrow(/temp suffix/);
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
      const lastGrant = forms.map((f) => f.startsWith('(allow') && f.includes('"/Users/test"')).lastIndexOf(true);
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
        // The plaintext stores other tools keep their tokens and passwords in.
        '(subpath "/Users/test/.azure")',
        '(literal "/Users/test/.git-credentials")',
        '(literal "/Users/test/.pypirc")',
        '(literal "/Users/test/.gem/credentials")',
        '(literal "/Users/test/.local/share/gem/credentials")',
        '(literal "/Users/test/.terraform.d/credentials.tfrc.json")',
        '(literal "/Users/test/.terraformrc")',
        '(literal "/Users/test/.pgpass")',
        '(literal "/Users/test/.vault-token")',
        '(literal "/Users/test/.boto")',
        '(literal "/Users/test/.s3cfg")',
        '(literal "/Users/test/.my.cnf")',
        '(literal "/Users/test/.mylogin.cnf")',
        '(literal "/Users/test/.yarnrc.yml")',
        '(literal "/Users/test/.cache/huggingface/token")',
        '(literal "/Users/test/.cache/huggingface/stored_tokens")',
      ]) {
        expect(forms[deny]).toContain(secret);
      }
      // Nothing after the deny reopens any of it.
      expect(forms.slice(deny + 1).filter((f) => f.startsWith('(allow file-') && f.includes('/Users/test/.'))).toEqual([]);
    });

    it('denies writing the directories above what is never reachable, so none is renamed into view', () => {
      // The denies match paths: granted ~/Library or ~, a step could rename
      // Application Support, ~/.m2 or ~/.nuget/NuGet and read what they hold
      // under the new name. Nodes, not subtrees, after every policy grant.
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: { filesystem: { read: ['~'], write: ['~', '~/Library', '~/.gradle'] } },
      });
      const forms = topLevelForms(profile);
      const writes = forms.findIndex((f) => f.startsWith('(allow file-write*') && f.includes('"/Users/test/.gradle"'));
      const nodes = forms.findIndex((f, i) => i > writes && f.startsWith('(deny file-write*') && f.includes('(literal "/Users/test/.m2")'));
      expect(writes).toBeGreaterThan(-1);
      expect(nodes).toBeGreaterThan(writes);
      for (const node of [
        '/Users/test/Library/Application Support',
        '/Users/test/Library',
        '/Users/test/.m2',
        '/Users/test/.gradle',
        '/Users/test/.cargo',
        '/Users/test/.nuget',
        '/Users/test/.nuget/NuGet',
        '/Users/test/.gem',
        '/Users/test/.terraform.d',
        '/Users/test/.local',
        '/Users/test/.local/share',
        '/Users/test/.local/share/gem',
        '/Users/test/.cache',
        '/Users/test/.cache/huggingface',
        '/Users/test',
        '/Users',
      ]) {
        expect(forms[nodes]).toContain(`(literal "${node}")`);
        expect(forms[nodes]).not.toContain(`(subpath "${node}")`);
      }
      // Nothing after it reopens a write there.
      expect(forms.slice(nodes + 1).filter((f) => f.startsWith('(allow file-write') && /"\/Users\/test(\/(\.m2|\.gradle|\.cargo|\.nuget|Library)[^/"]*)?"/.test(f))).toEqual([]);
    });

    it('denies a credential linked into place by the path the link resolves to, and the directories above both', () => {
      // Dotfile managers link ~/.aws to ~/dotfiles/aws; a cache is moved to
      // another volume and linked back. seatbelt matches the path a link
      // resolves to, so the credentials written as ~/.aws alone held nothing.
      const actualFs = jest.requireActual<typeof import('fs')>('fs');
      const links: Record<string, string> = { '/Users/test/.aws': 'dotfiles/aws', '/Users/test/.m2': '/opt/cache/m2' };
      let forms: string[] = [];
      jest.isolateModules(() => {
        jest.doMock('fs', () => ({
          ...actualFs,
          lstatSync: jest.fn((p: import('fs').PathLike) => ({ isSymbolicLink: () => String(p) in links })),
          readlinkSync: jest.fn((p: import('fs').PathLike) => links[String(p)]),
          realpathSync: jest.fn((p: import('fs').PathLike) => String(p)),
        }));
        const { generateSandboxProfile: generate } = require('./sandbox-profile');
        forms = topLevelForms(generate({
          workDir: '/path/to/project',
          proxyPort: DEFAULT_PROXY_PORT,
          policy: { filesystem: { read: ['~'], write: ['~'] } },
        }));
      });
      const denied = forms.find((f) => f.startsWith('(deny file-read* file-write*') && f.includes('/Users/test/.ssh'));
      for (const filter of [
        '(subpath "/Users/test/.aws")',
        '(subpath "/Users/test/dotfiles/aws")',
        '(literal "/Users/test/.m2/settings.xml")',
        '(literal "/opt/cache/m2/settings.xml")',
        '(literal "/opt/cache/m2/settings-security.xml")',
      ]) {
        expect(denied).toContain(filter);
      }
      const nodes = forms.find((f) => f.startsWith('(deny file-write*') && f.includes('(literal "/Users/test/.m2")'));
      for (const node of ['/Users/test/.m2', '/opt/cache/m2', '/opt/cache', '/opt', '/Users/test/dotfiles', '/Users/test']) {
        expect(nodes).toContain(`(literal "${node}")`);
      }
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

    it('denies the real app data directory and socket even when the CLI runs with an override', () => {
      // LOCALMOST_CONFIG_DIR points the CLI somewhere else, but the installed
      // app still keeps its runner template, approvals and socket in ~/.localmost.
      process.env.LOCALMOST_CONFIG_DIR = '/scratch/appdata';
      try {
        for (const profile of [
          generateSandboxProfile({ workDir: '/scratch/appdata/workspaces/ws-1', proxyPort: DEFAULT_PROXY_PORT }),
          generateDiscoveryProfile({ workDir: '/scratch/appdata/workspaces/ws-1', proxyPort: DEFAULT_PROXY_PORT, logFile: '' }),
        ]) {
          const deny = topLevelForms(profile).find((form) => form.startsWith('(deny file-read* file-write*'));
          expect(deny).toContain('(subpath "/scratch/appdata")');
          expect(deny).toContain('(subpath "/Users/test/.localmost")');
          expect(profile).toContain('(deny network-outbound (literal "/scratch/appdata/localmost.sock"))');
          expect(profile).toContain('(deny network-outbound (literal "/Users/test/.localmost/localmost.sock"))');
        }
      } finally {
        delete process.env.LOCALMOST_CONFIG_DIR;
      }
    });

    it('ends with the process marker, so no policy rule can change what it answers', () => {
      // The app finds a step's processes at the end of the job by asking the
      // kernel what their profile lets them read. A policy deny or grant after
      // the marker would make a step's process look like anyone else's.
      const processMarker = { granted: '/Users/test/.localmost/m/mark-a', withheld: '/Users/test/.localmost/m/mark-b' };
      const policy = { filesystem: { read: ['/**'], deny: ['/Users/test/**'] } };
      for (const profile of [
        generateSandboxProfile({ workDir: '/w', proxyPort: DEFAULT_PROXY_PORT, policy, processMarker }),
        generateDiscoveryProfile({ workDir: '/w', proxyPort: DEFAULT_PROXY_PORT, logFile: '', processMarker }),
      ]) {
        expect(topLevelForms(profile).slice(-2)).toEqual([
          '(deny file-read* (literal "/Users/test/.localmost/m/mark-b"))',
          '(allow file-read* (literal "/Users/test/.localmost/m/mark-a"))',
        ]);
      }
    });

    it('lets a step write inside the workspace but never replace the workspace directory itself', () => {
      // The reopen is a subpath, which covers the directory node too: a step
      // could rmdir it and leave a symlink in its place, and the app's own
      // unsandboxed writes into the workspace would follow it.
      const workDir = '/Users/test/.localmost/workspaces/ws-1';
      for (const profile of [
        generateSandboxProfile({ workDir, proxyPort: DEFAULT_PROXY_PORT }),
        generateDiscoveryProfile({ workDir, proxyPort: DEFAULT_PROXY_PORT, logFile: '' }),
      ]) {
        const forms = topLevelForms(profile);
        const reopen = forms.findIndex((f) => f.startsWith('(allow file-read* file-write*') && f.includes(`(subpath "${workDir}")`));
        const pinned = forms.indexOf(`(deny file-write* (literal "${workDir}"))`);
        expect(reopen).toBeGreaterThan(-1);
        expect(pinned).toBeGreaterThan(reopen);
      }
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
      // A deny covers what lies beneath a match too, as a subpath deny does.
      // In a deny, * stands within one name: it never spans a /.
      expect(profile).toContain('(deny file-read* (regex "^/Users/test/\\\\.ssh/id_[^/]*(/|$)"))');
    });

    it('takes * in a deny within one name, in any component, and closes the directories it stands for', () => {
      // The deny matches paths, so a job granted /opt/out could rename the
      // directory out/secA to out/z and read out/z/key. The directories a
      // wildcard stands for are closed to writes as nodes, by an anchored
      // pattern, as the literal directories above the first * are.
      const forms = topLevelForms(generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: { filesystem: { write: ['/opt/out'], deny: ['/opt/out/sec*/key', '/opt/deep/*/mid/k*'] } },
      }));
      for (const operation of ['file-read*', 'file-write*']) {
        expect(forms).toContain(`(deny ${operation} (regex "^/opt/out/sec[^/]*/key(/|$)"))`);
        expect(forms).toContain(`(deny ${operation} (regex "^/opt/deep/[^/]*/mid/k[^/]*(/|$)"))`);
      }
      for (const node of [
        '(literal "/opt/out")',
        '(literal "/opt")',
        '(regex "^/opt/out/sec[^/]*$")',
        '(literal "/opt/deep")',
        '(regex "^/opt/deep/[^/]*$")',
        // A literal directory past a wildcard is one it stands above too.
        '(regex "^/opt/deep/[^/]*/mid$")',
        '(regex "^/opt/deep/[^/]*/mid/k[^/]*$")',
      ]) {
        expect(forms).toContain(`(deny file-write* ${node})`);
      }
      // Nodes, not what is in them: nothing past the denied name is a node.
      expect(forms.join('\n')).not.toContain('(regex "^/opt/out/sec[^/]*/key$")');
      expect(forms.join('\n')).not.toMatch(/\(deny file-write\* \(regex "[^"]*\.\*/);
    });

    it('denies a path reached through a symlink by its real path too', () => {
      // seatbelt matches the real path, and /tmp and /etc are symlinks into
      // /private: a deny under the spelling written alone held nothing.
      const forms = topLevelForms(generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: { filesystem: { deny: ['/tmp/localmost-deny/x', '/etc/ssl/private', '/tmp/localmost-deny/*.pem'] } },
      }));
      for (const operation of ['file-read*', 'file-write*']) {
        expect(forms).toContain(`(deny ${operation} (subpath "/tmp/localmost-deny/x"))`);
        expect(forms).toContain(`(deny ${operation} (subpath "/private/tmp/localmost-deny/x"))`);
        expect(forms).toContain(`(deny ${operation} (subpath "/private/etc/ssl/private"))`);
        expect(forms).toContain(`(deny ${operation} (regex "^/private/tmp/localmost-deny/[^/]*\\\\.pem(/|$)"))`);
      }
    });

    it('denies writing the directories above a deny, so renaming one cannot carry it away', () => {
      // A deny matches paths: a job granted /opt/out could rename out/a to
      // out/b and read out/b/secret, or out/g to out/h and read every .pem.
      const forms = topLevelForms(generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: { filesystem: { write: ['/opt/out'], deny: ['/opt/out/a/secret', '/opt/out/g/*.pem', '/opt/out/keys-*'] } },
      }));
      for (const node of ['/opt/out/a', '/opt/out/g', '/opt/out', '/opt']) {
        expect(forms).toContain(`(deny file-write* (literal "${node}"))`);
      }
      // Nodes, not what is in them, and never the root.
      expect(forms.join('\n')).not.toMatch(/\(deny file-write\* \((subpath|literal) "\/"\)\)/);
      expect(forms.join('\n')).not.toContain('(deny file-write* (subpath "/opt/out"))');
      // After every grant, so what they grant does not reopen the nodes.
      const grant = forms.findIndex((f) => f.includes('(subpath "/opt/out")'));
      expect(forms.indexOf('(deny file-write* (literal "/opt/out"))')).toBeGreaterThan(grant);
    });

    it('denies what it cannot look up beneath as written and by the real path of what it can', () => {
      // A component the app cannot look up - unsearchable, or a symlink loop -
      // is one the job cannot pass through either. Throwing there stopped
      // every run of the checkout over a deny that holds as written.
      // Written through a link, as /tmp is one into /private, so it has two
      // spellings. Built under the real temp directory: a job may not write /tmp.
      const actualFs = jest.requireActual<typeof import('fs')>('fs');
      const actualOs = jest.requireActual<typeof import('os')>('os');
      const base = actualFs.realpathSync(actualFs.mkdtempSync(path.join(actualOs.tmpdir(), 'localmost-unresolvable-')));
      const real = path.join(base, 'real');
      const written = path.join(base, 'written');
      actualFs.mkdirSync(path.join(real, 'locked', 'inner'), { recursive: true });
      actualFs.symlinkSync('real', written);
      actualFs.symlinkSync('loop', path.join(real, 'loop'));
      actualFs.chmodSync(path.join(real, 'locked'), 0o000);
      try {
        const forms = topLevelForms(generateSandboxProfile({
          workDir: '/path/to/project',
          proxyPort: DEFAULT_PROXY_PORT,
          policy: { filesystem: { deny: [`${written}/locked/inner/secret`, `${written}/loop/secret`, `${written}/locked/*.pem`] } },
        }));
        for (const spelling of [written, real]) {
          expect(forms).toContain(`(deny file-read* (subpath "${spelling}/locked/inner/secret"))`);
          expect(forms).toContain(`(deny file-read* (subpath "${spelling}/loop/secret"))`);
          expect(forms).toContain(`(deny file-write* (literal "${spelling}/locked/inner"))`);
        }
        expect(forms).toContain(`(deny file-read* (regex "^${real.replace(/\./g, '\\\\.')}/locked/[^/]*\\\\.pem(/|$)"))`);
      } finally {
        actualFs.chmodSync(path.join(real, 'locked'), 0o755);
        actualFs.rmSync(base, { recursive: true, force: true });
      }
    });

    it('never looks inside a folder macOS asks the user about, however the deny reaches it', () => {
      // Looking a path up inside ~/Documents, ~/Desktop, ~/Downloads, ~/Library
      // or a volume makes macOS ask whether the app may, at every run, on a
      // machine that may have nobody at it - and a refusal fails the lookup.
      const actualFs = jest.requireActual<typeof import('fs')>('fs');
      const looked: string[] = [];
      const link = '/tmp/localmost-to-documents';
      let build: () => string[] = () => [];
      jest.isolateModules(() => {
        const record = (p: import('fs').PathLike) => looked.push(String(p));
        jest.doMock('fs', () => ({
          ...actualFs,
          lstatSync: jest.fn((p: import('fs').PathLike) => {
            record(p);
            return String(p) === `/private${link}` ? { isSymbolicLink: () => true } : { isSymbolicLink: () => false };
          }),
          readlinkSync: jest.fn((p: import('fs').PathLike) => {
            record(p);
            return '/Users/test/Documents/keys';
          }),
          realpathSync: jest.fn((p: import('fs').PathLike) => {
            record(p);
            return String(p);
          }),
        }));
        const { generateSandboxProfile: generate } = require('./sandbox-profile');
        build = () => topLevelForms(generate({
          workDir: '/path/to/project',
          proxyPort: DEFAULT_PROXY_PORT,
          policy: {
            filesystem: {
              deny: ['~/Documents/finance', '~/Desktop/keys/*.pem', '~/Library/Messages', '/Volumes/Backup/secrets', `/private${link}/id`],
            },
          },
        }));
      });
      const forms = build();
      const guarded = ['Documents', 'Desktop', 'Downloads', 'Library'].map((name) => `/Users/test/${name}/`);
      expect(looked.filter((p) => guarded.some((dir) => p.startsWith(dir)) || p.startsWith('/Volumes/'))).toEqual([]);
      // Denied as written all the same, and through the link as far as the folder.
      expect(forms).toContain('(deny file-read* (subpath "/Users/test/Documents/finance"))');
      expect(forms).toContain('(deny file-read* (subpath "/Users/test/Documents/keys/id"))');
      expect(forms).toContain('(deny file-read* (subpath "/Users/test/Library/Messages"))');
      expect(forms).toContain('(deny file-read* (subpath "/Volumes/Backup/secrets"))');
    });

    it('applies no relative deny, which seatbelt would never match', () => {
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: DEFAULT_PROXY_PORT,
        policy: { filesystem: { deny: ['build/secret', '/opt/kept'] } },
      });
      expect(profile).not.toContain('build/secret');
      expect(profile).toContain('(deny file-read* (subpath "/opt/kept"))');
    });

    it('keeps a policy deny inside the workspace after the workspace is reopened', () => {
      // The workspace is reopened after the final deny of the app data
      // directory it lives in; a deny the policy names inside it must not be
      // undone by that.
      const workDir = '/Users/test/.localmost/workspaces/ws-1';
      const forms = topLevelForms(generateSandboxProfile({
        workDir,
        proxyPort: DEFAULT_PROXY_PORT,
        policy: { filesystem: { deny: [`${workDir}/secrets`] } },
      }));
      const reopen = forms.findIndex((f) => f === `(allow file-read* file-write*\n  (subpath "${workDir}"))`);
      const deny = forms.indexOf(`(deny file-write* (subpath "${workDir}/secrets"))`);
      expect(reopen).toBeGreaterThan(-1);
      expect(deny).toBeGreaterThan(reopen);
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
    /** The outbound IP rules after the network deny, in order. */
    const outboundIpRules = (profile: string): string[] =>
      profile
        .slice(profile.indexOf('(deny network*)'))
        .match(/\((?:allow|deny) network-outbound \((?:remote|local) ip[^)]*\)\)/g) ?? [];

    it('reaches only the proxy on loopback unless the checkout grants more', () => {
      // A service on loopback - a debugger port, a local database, another
      // app's control port - is not the proxy, and a step has no reason to
      // reach it that the user has not agreed to.
      const profile = generateSandboxProfile({ workDir: '/path/to/project', proxyPort: 9999 });
      expect(outboundIpRules(profile)).toEqual([
        '(allow network-outbound (remote ip "localhost:9999"))',
        '(deny network-outbound (remote ip "localhost:8787"))',
      ]);
      expect(profile).toContain('proxy at port 9999');
      expect(profile).not.toContain('(allow network*)');
    });

    it('opens the loopback ports a confirmed grant names, and the broker never', () => {
      expect(
        outboundIpRules(generateSandboxProfile({ workDir: '/p', proxyPort: 9999, loopback: [5432, 6379] }))
      ).toEqual([
        '(allow network-outbound (remote ip "localhost:9999"))',
        '(allow network-outbound (remote ip "localhost:5432"))',
        '(allow network-outbound (remote ip "localhost:6379"))',
        '(deny network-outbound (remote ip "localhost:8787"))',
      ]);
      // Seatbelt takes the last match, so the broker stays closed even under
      // every port, and even when a grant names it.
      for (const loopback of [true, [8787]] as Array<true | number[]>) {
        const rules = outboundIpRules(generateSandboxProfile({ workDir: '/p', proxyPort: 9999, loopback }));
        expect(rules[rules.length - 1]).toBe('(deny network-outbound (remote ip "localhost:8787"))');
      }
      expect(outboundIpRules(generateSandboxProfile({ workDir: '/p', proxyPort: 9999, loopback: true }))).toEqual([
        '(allow network-outbound (remote ip "localhost:9999"))',
        '(allow network-outbound (remote ip "localhost:*"))',
        '(deny network-outbound (remote ip "localhost:8787"))',
      ]);
    });

    it('drops a loopback port that is not one, rather than widening to it', () => {
      // The grant comes from the checkout; only whole port numbers reach the
      // profile, where anything else could change what a rule matches.
      const loopback = [0, 65536, 1.5, -1, '22' as unknown as number, '*' as unknown as number, 443];
      expect(outboundIpRules(generateSandboxProfile({ workDir: '/p', proxyPort: 9999, loopback }))).toEqual([
        '(allow network-outbound (remote ip "localhost:9999"))',
        '(allow network-outbound (remote ip "localhost:443"))',
        '(deny network-outbound (remote ip "localhost:8787"))',
      ]);
      const notAGrant = 'yes' as unknown as true;
      expect(outboundIpRules(generateSandboxProfile({ workDir: '/p', proxyPort: 9999, loopback: notAGrant }))).toEqual([
        '(allow network-outbound (remote ip "localhost:9999"))',
        '(deny network-outbound (remote ip "localhost:8787"))',
      ]);
    });

    it('never grants an IP rule that matches every address', () => {
      // (local ip) names the local end of any IP socket, so as an outbound
      // filter it matches a connection to anywhere: a step could ignore
      // HTTP_PROXY and reach the internet directly, past the allowlist.
      for (const profile of [
        generateSandboxProfile({ workDir: '/path/to/project', proxyPort: 9999, loopback: true }),
        generateDiscoveryProfile({ workDir: '/path/to/project', proxyPort: 9999, logFile: '' }),
      ]) {
        expect(profile).not.toContain('(local ip)');
        expect(profile).toContain('(deny network*)');
        expect(profile).toContain('(allow network-bind (local ip "localhost:*"))');
        expect(profile).toContain('(allow network-inbound (local ip "localhost:*"))');
        // The app's broker carries job payloads; a step has no reason to open it.
        expect(profile).toContain('(deny network-outbound (remote ip "localhost:8787"))');
        // Nothing after the deny reopens outbound IP beyond loopback.
        expect(outboundIpRules(profile).every((rule) => rule.includes('"localhost:'))).toBe(true);
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

    it('should allow traffic to the proxy regardless of policy', () => {
      // Policy is for proxy-level filtering, sandbox just restricts to the proxy
      const profile = generateSandboxProfile({
        workDir: '/path/to/project',
        proxyPort: 8080,
        policy: {
          network: {
            allow: ['github.com'],
          },
        },
      });

      expect(profile).toContain('(remote ip "localhost:8080")');
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

    it('lets a step signal only processes under its own profile', () => {
      // An unfiltered (allow signal) let a step stop or kill any process the
      // user runs: the app, the runner, an editor with unsaved work.
      for (const profile of [
        generateSandboxProfile({ workDir: '/path/to/project', proxyPort: DEFAULT_PROXY_PORT }),
        generateDiscoveryProfile({ workDir: '/path/to/project', proxyPort: DEFAULT_PROXY_PORT, logFile: '' }),
      ]) {
        expect(profile.match(/\(allow signal[^\n]*/g)).toEqual(['(allow signal (target same-sandbox))']);
      }
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
        '/work',
        new Set([101, 102])
      );
      expect(result.writePaths).toEqual(['/opt/cache/x']);
    });

    it('takes a refusal only from a process it knows is the workflow\'s', () => {
      // Every sandboxed process on the machine logs its refusals - other apps,
      // a runner job - and without the workflow's pids to filter by, any of
      // them would add write paths to what --updaterc proposes.
      const log = 'kernel: (Sandbox) Sandbox: evil(555) deny(1) file-write-create /Users/test/Library/LaunchAgents/x.plist';
      for (const pids of [undefined, new Set<number>()]) {
        expect(parseSandboxTrace(log, '/work', pids).writePaths).toEqual([]);
      }
      expect(parseSandboxTrace(log, '/work', new Set([101])).writePaths).toEqual([]);
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
      // Discovery applies no policy and is confirmed on every run as the
      // wide mode it is, so loopback stays open there: it runs the workflow
      // to see what it needs, test servers included.
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
      expect(profile).toContain(`(remote ip "localhost:${DEFAULT_PROXY_PORT}")`);
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
