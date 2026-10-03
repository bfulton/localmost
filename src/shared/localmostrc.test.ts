/**
 * Tests for .localmostrc Parser and Validator
 */

import {
  parseLocalmostrcContent,
  effectivePolicyLevel,
  mergePolicies,
  getEffectivePolicy,
  getRequiredSecrets,
  serializeLocalmostrc,
  diffConfigs,
  formatPolicyDiff,
  LocalmostrcConfig,
} from './localmostrc';
import { SandboxPolicy } from './sandbox-profile';

// Finding and reading the file on disk: localmostrc.file.test.ts.

describe('localmostrc', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // parseLocalmostrcContent
  // ===========================================================================

  describe('parseLocalmostrcContent', () => {
    it('should parse minimal valid config', () => {
      const content = `version: 1`;

      const result = parseLocalmostrcContent(content);

      expect(result.success).toBe(true);
      expect(result.config?.version).toBe(1);
    });

    it('should parse config with shared network policy', () => {
      const content = `
version: 1
shared:
  network:
    allow:
      - github.com
      - "*.npmjs.org"
    deny:
      - evil.com
`;
      const result = parseLocalmostrcContent(content);

      expect(result.success).toBe(true);
      expect(result.config?.shared?.network?.allow).toContain('github.com');
      expect(result.config?.shared?.network?.allow).toContain('*.npmjs.org');
      expect(result.config?.shared?.network?.deny).toContain('evil.com');
    });

    it('should parse config with filesystem policy', () => {
      const content = `
version: 1
shared:
  filesystem:
    read:
      - /usr/local
    write:
      - ./build
    deny:
      - ~/.ssh
`;
      const result = parseLocalmostrcContent(content);

      expect(result.success).toBe(true);
      expect(result.config?.shared?.filesystem?.read).toContain('/usr/local');
      expect(result.config?.shared?.filesystem?.write).toContain('./build');
      expect(result.config?.shared?.filesystem?.deny).toContain('~/.ssh');
    });

    it('should parse config with env policy', () => {
      const content = `
version: 1
shared:
  env:
    allow:
      - PATH
      - HOME
    deny:
      - AWS_SECRET_KEY
`;
      const result = parseLocalmostrcContent(content);

      expect(result.success).toBe(true);
      expect(result.config?.shared?.env?.allow).toContain('PATH');
      expect(result.config?.shared?.env?.deny).toContain('AWS_SECRET_KEY');
    });

    it('should parse config with workflow overrides', () => {
      const content = `
version: 1
shared:
  network:
    allow:
      - github.com
workflows:
  deploy:
    network:
      allow:
        - api.fastlane.tools
    secrets:
      require:
        - DEPLOY_KEY
`;
      const result = parseLocalmostrcContent(content);

      expect(result.success).toBe(true);
      expect(result.config?.workflows?.deploy?.network?.allow).toContain('api.fastlane.tools');
      expect(result.config?.workflows?.deploy?.secrets?.require).toContain('DEPLOY_KEY');
    });

    it('should warn on missing version', () => {
      const content = `
shared:
  network:
    allow:
      - github.com
`;
      const result = parseLocalmostrcContent(content);

      expect(result.success).toBe(true);
      expect(result.warnings).toContain('Missing "version" field. Assuming version 1.');
    });

    it('should error on invalid version type', () => {
      const content = `version: "1"`;

      const result = parseLocalmostrcContent(content);

      expect(result.success).toBe(false);
      expect(result.errors[0].message).toContain('"version" must be a number');
    });

    it('should error on unsupported version', () => {
      const content = `version: 999`;

      const result = parseLocalmostrcContent(content);

      expect(result.success).toBe(false);
      expect(result.errors[0].message).toContain('Unsupported version');
    });

    it('should error on invalid YAML', () => {
      const content = `
version: 1
shared:
  network:
    allow: [
      - missing bracket
`;
      const result = parseLocalmostrcContent(content);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should error on non-object config', () => {
      const content = `- just an array`;

      const result = parseLocalmostrcContent(content);

      expect(result.success).toBe(false);
      expect(result.errors[0].message).toContain('must be a YAML object');
    });

    it('should error on non-array allow list', () => {
      const content = `
version: 1
shared:
  network:
    allow: just-a-string
`;
      const result = parseLocalmostrcContent(content);

      expect(result.success).toBe(false);
      expect(result.errors[0].message).toContain('must be an array');
    });

    it('should error on non-string array items', () => {
      const content = `
version: 1
shared:
  network:
    allow:
      - 123
`;
      const result = parseLocalmostrcContent(content);

      expect(result.success).toBe(false);
      expect(result.errors[0].message).toContain('must be a string');
    });

    it('rejects a filesystem path that would break out of the sandbox profile', () => {
      // Filesystem paths are written into the sandbox-exec profile, a quoted
      // DSL. A path carrying a quote and a newline could close the string and
      // add its own rules - the user approves what the policy appears to say,
      // not what it makes the sandbox enforce.
      const content = [
        'version: 1',
        'shared:',
        '  filesystem:',
        '    read:',
        '      - \'/tmp/x")\\n(allow default)\'',
      ].join('\n');
      const result = parseLocalmostrcContent(content);

      expect(result.success).toBe(false);
      expect(result.errors[0].message).toMatch(/must not contain/i);
    });

    it('rejects a filesystem path with .. traversal that could climb out of the workspace', () => {
      // A relative workspace path is fine, but ".." could climb into the app's
      // runner directory from the worker's own directory, past the filter.
      const content = 'version: 1\nshared:\n  filesystem:\n    read:\n      - \'../../.localmost/runner/proxies\'';
      const result = parseLocalmostrcContent(content);
      expect(result.success).toBe(false);
      expect(result.errors[0].message).toMatch(/must not contain "\.\."/);
    });

    it('still accepts a relative workspace path without traversal', () => {
      const content = 'version: 1\nshared:\n  filesystem:\n    write:\n      - ./build\n      - ./Pods/';
      const result = parseLocalmostrcContent(content);
      expect(result.success).toBe(true);
    });

    it('refuses a relative filesystem deny, which the sandbox never applies', () => {
      // seatbelt never matches a relative path against a real one, so the
      // runner drops it and test mode matched nothing: the policy said a
      // path was denied and nothing was.
      for (const entry of ['./build/secret', 'secrets', '~other/x']) {
        const r = parseLocalmostrcContent(`version: 1\nshared:\n  filesystem:\n    deny:\n      - '${entry}'`);
        expect([entry, r.success]).toEqual([entry, false]);
        expect(r.errors[0].message).toMatch(/shared\.filesystem\.deny\[0\] must be an absolute path or start with ~\//);
      }
      const w = parseLocalmostrcContent('version: 1\nworkflows:\n  ci:\n    filesystem:\n      deny:\n        - build');
      expect(w.errors[0].message).toMatch(/workflows\.ci\.filesystem\.deny\[0\] must be an absolute path/);
      for (const entry of ['/opt/secret', '~/.ssh/id_*', '~']) {
        const r = parseLocalmostrcContent(`version: 1\nshared:\n  filesystem:\n    deny:\n      - '${entry}'`);
        expect([entry, r.success]).toEqual([entry, true]);
      }
    });

    it('rejects a backslash in a filesystem path', () => {
      const content = 'version: 1\nshared:\n  filesystem:\n    write:\n      - \'/tmp/a\\\\b\'';
      const result = parseLocalmostrcContent(content);

      expect(result.success).toBe(false);
      expect(result.errors[0].message).toMatch(/must not contain/i);
    });

    it('should error on invalid workflows type', () => {
      const content = `
version: 1
workflows: just-a-string
`;
      const result = parseLocalmostrcContent(content);

      expect(result.success).toBe(false);
      expect(result.errors[0].message).toContain('"workflows" must be an object');
    });
  });

  // ===========================================================================
  // mergePolicies
  // ===========================================================================

  describe('mergePolicies', () => {
    it('should merge network allow lists', () => {
      const base: SandboxPolicy = {
        network: { allow: ['github.com'] },
      };
      const override: SandboxPolicy = {
        network: { allow: ['npmjs.org'] },
      };

      const result = mergePolicies(base, override);

      expect(result.network?.allow).toContain('github.com');
      expect(result.network?.allow).toContain('npmjs.org');
    });

    it('should deduplicate merged arrays', () => {
      const base: SandboxPolicy = {
        network: { allow: ['github.com', 'npmjs.org'] },
      };
      const override: SandboxPolicy = {
        network: { allow: ['npmjs.org', 'registry.com'] },
      };

      const result = mergePolicies(base, override);

      expect(result.network?.allow).toHaveLength(3);
    });

    it('should merge filesystem policies', () => {
      const base: SandboxPolicy = {
        filesystem: { read: ['/usr'], write: ['./build'] },
      };
      const override: SandboxPolicy = {
        filesystem: { read: ['/opt'], deny: ['~/.ssh'] },
      };

      const result = mergePolicies(base, override);

      expect(result.filesystem?.read).toContain('/usr');
      expect(result.filesystem?.read).toContain('/opt');
      expect(result.filesystem?.write).toContain('./build');
      expect(result.filesystem?.deny).toContain('~/.ssh');
    });

    it('should merge env policies', () => {
      const base: SandboxPolicy = {
        env: { allow: ['PATH'] },
      };
      const override: SandboxPolicy = {
        env: { deny: ['AWS_SECRET'] },
      };

      const result = mergePolicies(base, override);

      expect(result.env?.allow).toContain('PATH');
      expect(result.env?.deny).toContain('AWS_SECRET');
    });

    it('should handle empty base policy', () => {
      const base: SandboxPolicy = {};
      const override: SandboxPolicy = {
        network: { allow: ['github.com'] },
      };

      const result = mergePolicies(base, override);

      expect(result.network?.allow).toContain('github.com');
    });

    it('should handle empty override policy', () => {
      const base: SandboxPolicy = {
        network: { allow: ['github.com'] },
      };
      const override: SandboxPolicy = {};

      const result = mergePolicies(base, override);

      expect(result.network?.allow).toContain('github.com');
    });
  });

  // ===========================================================================
  // getEffectivePolicy
  // ===========================================================================

  describe('getEffectivePolicy', () => {
    it('should return shared policy for unknown workflow', () => {
      const config: LocalmostrcConfig = {
        version: 1,
        shared: {
          network: { allow: ['github.com'] },
        },
      };

      const result = getEffectivePolicy(config, 'unknown');

      expect(result.network?.allow).toContain('github.com');
    });

    it('should merge shared and workflow policies', () => {
      const config: LocalmostrcConfig = {
        version: 1,
        shared: {
          network: { allow: ['github.com'] },
        },
        workflows: {
          deploy: {
            network: { allow: ['api.fastlane.tools'] },
          },
        },
      };

      const result = getEffectivePolicy(config, 'deploy');

      expect(result.network?.allow).toContain('github.com');
      expect(result.network?.allow).toContain('api.fastlane.tools');
    });

    it('should handle missing shared policy', () => {
      const config: LocalmostrcConfig = {
        version: 1,
        workflows: {
          deploy: {
            network: { allow: ['api.com'] },
          },
        },
      };

      const result = getEffectivePolicy(config, 'deploy');

      expect(result.network?.allow).toContain('api.com');
    });
  });

  // ===========================================================================
  // getRequiredSecrets
  // ===========================================================================

  describe('getRequiredSecrets', () => {
    it('should return required secrets for workflow', () => {
      const config: LocalmostrcConfig = {
        version: 1,
        workflows: {
          deploy: {
            secrets: {
              require: ['DEPLOY_KEY', 'API_TOKEN'],
            },
          },
        },
      };

      const result = getRequiredSecrets(config, 'deploy');

      expect(result).toContain('DEPLOY_KEY');
      expect(result).toContain('API_TOKEN');
    });

    it('should return empty array for workflow without secrets', () => {
      const config: LocalmostrcConfig = {
        version: 1,
        workflows: {
          build: {
            network: { allow: ['github.com'] },
          },
        },
      };

      const result = getRequiredSecrets(config, 'build');

      expect(result).toEqual([]);
    });

    it('should return empty array for unknown workflow', () => {
      const config: LocalmostrcConfig = {
        version: 1,
      };

      const result = getRequiredSecrets(config, 'unknown');

      expect(result).toEqual([]);
    });
  });

  // ===========================================================================
  // serializeLocalmostrc
  // ===========================================================================

  describe('serializeLocalmostrc', () => {
    it('should serialize minimal config', () => {
      const config: LocalmostrcConfig = {
        version: 1,
      };

      const result = serializeLocalmostrc(config);

      expect(result).toContain('version: 1');
    });

    it('should serialize network policy', () => {
      const config: LocalmostrcConfig = {
        version: 1,
        shared: {
          network: {
            allow: ['github.com', 'npmjs.org'],
            deny: ['evil.com'],
          },
        },
      };

      const result = serializeLocalmostrc(config);

      expect(result).toContain('network:');
      expect(result).toContain('allow:');
      expect(result).toContain('"github.com"');
      expect(result).toContain('"npmjs.org"');
      expect(result).toContain('deny:');
      expect(result).toContain('"evil.com"');
    });

    it('should serialize filesystem policy', () => {
      const config: LocalmostrcConfig = {
        version: 1,
        shared: {
          filesystem: {
            read: ['/usr/local'],
            write: ['./build'],
          },
        },
      };

      const result = serializeLocalmostrc(config);

      expect(result).toContain('filesystem:');
      expect(result).toContain('read:');
      expect(result).toContain('write:');
    });

    it('should serialize workflow policies', () => {
      const config: LocalmostrcConfig = {
        version: 1,
        workflows: {
          deploy: {
            network: { allow: ['api.com'] },
            secrets: { require: ['API_KEY'] },
          },
        },
      };

      const result = serializeLocalmostrc(config);

      expect(result).toContain('workflows:');
      expect(result).toContain('deploy:');
      expect(result).toContain('secrets:');
      expect(result).toContain('require:');
      expect(result).toContain('API_KEY');
    });

    it('should produce valid YAML that can be parsed back', () => {
      const config: LocalmostrcConfig = {
        version: 1,
        shared: {
          network: {
            allow: ['github.com'],
          },
        },
        workflows: {
          build: {
            filesystem: { write: ['./dist'] },
          },
        },
      };

      const serialized = serializeLocalmostrc(config);
      const parsed = parseLocalmostrcContent(serialized);

      expect(parsed.success).toBe(true);
      expect(parsed.config?.version).toBe(1);
      expect(parsed.config?.shared?.network?.allow).toContain('github.com');
    });
  });

  // ===========================================================================
  // diffConfigs
  // ===========================================================================

  describe('diffConfigs', () => {
    it('should detect added entries', () => {
      const oldConfig: LocalmostrcConfig = {
        version: 1,
        shared: {
          network: { allow: ['github.com'] },
        },
      };
      const newConfig: LocalmostrcConfig = {
        version: 1,
        shared: {
          network: { allow: ['github.com', 'npmjs.org'] },
        },
      };

      const diffs = diffConfigs(oldConfig, newConfig);

      expect(diffs).toContainEqual({
        path: 'shared.network.allow',
        type: 'added',
        newValue: 'npmjs.org',
      });
    });

    it('should detect removed entries', () => {
      const oldConfig: LocalmostrcConfig = {
        version: 1,
        shared: {
          network: { allow: ['github.com', 'npmjs.org'] },
        },
      };
      const newConfig: LocalmostrcConfig = {
        version: 1,
        shared: {
          network: { allow: ['github.com'] },
        },
      };

      const diffs = diffConfigs(oldConfig, newConfig);

      expect(diffs).toContainEqual({
        path: 'shared.network.allow',
        type: 'removed',
        oldValue: 'npmjs.org',
      });
    });

    it('should detect workflow changes', () => {
      const oldConfig: LocalmostrcConfig = {
        version: 1,
        workflows: {
          deploy: {
            network: { allow: ['api.com'] },
          },
        },
      };
      const newConfig: LocalmostrcConfig = {
        version: 1,
        workflows: {
          deploy: {
            network: { allow: ['api.com', 'fastlane.tools'] },
          },
        },
      };

      const diffs = diffConfigs(oldConfig, newConfig);

      expect(diffs).toContainEqual({
        path: 'workflows.deploy.network.allow',
        type: 'added',
        newValue: 'fastlane.tools',
      });
    });

    it('should return empty array when no changes', () => {
      const config: LocalmostrcConfig = {
        version: 1,
        shared: {
          network: { allow: ['github.com'] },
        },
      };

      const diffs = diffConfigs(config, config);

      expect(diffs).toHaveLength(0);
    });
  });

  // ===========================================================================
  // formatPolicyDiff
  // ===========================================================================

  describe('formatPolicyDiff', () => {
    it('should format added entries with + prefix', () => {
      const diffs = [{ path: 'shared.network.allow', type: 'added' as const, newValue: 'github.com' }];

      const result = formatPolicyDiff(diffs);

      expect(result).toContain('+ shared.network.allow: github.com');
    });

    it('should format removed entries with - prefix', () => {
      const diffs = [{ path: 'shared.network.allow', type: 'removed' as const, oldValue: 'evil.com' }];

      const result = formatPolicyDiff(diffs);

      expect(result).toContain('- shared.network.allow: evil.com');
    });

    it('should format changed entries with ~ prefix', () => {
      const diffs = [
        { path: 'version', type: 'changed' as const, oldValue: '1', newValue: '2' },
      ];

      const result = formatPolicyDiff(diffs);

      expect(result).toContain('~ version: 1 -> 2');
    });

    it('should return "No changes" for empty diff', () => {
      const result = formatPolicyDiff([]);

      expect(result).toBe('No changes');
    });
  });
});

describe('top-level keys', () => {
  it('rejects a key the grammar does not have, naming the ones it does', () => {
    // A misspelt key was accepted and ignored, so "levle: strict" read as a
    // decision about the level while leaving whatever else was declared -
    // and a key a later version adds would be approved by an older one unseen.
    const result = parseLocalmostrcContent('version: 1\nlevle: strict\nshared: {}\n');

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/"levle" is not a \.localmostrc key.*version, level, shared, workflows/) }),
    ]);
  });

  it('rejects every unknown key, not just the first', () => {
    const result = parseLocalmostrcContent('version: 1\nnetwork: {}\nsecrets: {}\n');
    expect(result.errors.map((e) => e.message).join('\n')).toMatch(/"network"[\s\S]*"secrets"/);
  });

  it('accepts every key it does have', () => {
    const result = parseLocalmostrcContent('version: 1\nlevel: strict\nshared: {}\nworkflows: {}\n');
    expect(result.success).toBe(true);
  });
});

describe('policy level', () => {
  const withLevel = (level: string) => `version: 1\nlevel: ${level}\n`;

  it('parses a declared level', () => {
    const result = parseLocalmostrcContent(withLevel('moderate'));

    expect(result.success).toBe(true);
    expect(result.config?.level).toBe('moderate');
  });

  it('defaults to strict when the policy does not declare one', () => {
    // Absent means strict, not "whatever the machine happens to be set to":
    // a policy that says nothing must not be the loosest thing that ever ran.
    const result = parseLocalmostrcContent('version: 1\n');

    expect(result.success).toBe(true);
    expect(effectivePolicyLevel(result.config)).toBe('strict');
  });

  it('rejects a level that is not one of the three', () => {
    const result = parseLocalmostrcContent(withLevel('wide-open'));

    expect(result.success).toBe(false);
    expect(result.errors[0].message).toMatch(/level/);
  });

  it('reports a loosened level as a change needing approval', () => {
    // The whole design rests on every policy change reaching the diff. A level
    // that changed silently would hand a repo the loosest sandbox unreviewed.
    const oldConfig = parseLocalmostrcContent(withLevel('strict')).config!;
    const newConfig = parseLocalmostrcContent(withLevel('permissive')).config!;

    const diffs = diffConfigs(oldConfig, newConfig);

    expect(diffs).toContainEqual(
      expect.objectContaining({ path: 'level', type: 'changed', oldValue: 'strict', newValue: 'permissive' })
    );
  });

  it('reports a level appearing where there was none', () => {
    const oldConfig = parseLocalmostrcContent('version: 1\n').config!;
    const newConfig = parseLocalmostrcContent(withLevel('permissive')).config!;

    const diffs = diffConfigs(oldConfig, newConfig);

    expect(diffs.some((d) => d.path === 'level')).toBe(true);
  });

  it('reports no change when the level is unchanged', () => {
    const a = parseLocalmostrcContent(withLevel('moderate')).config!;
    const b = parseLocalmostrcContent(withLevel('moderate')).config!;

    expect(diffConfigs(a, b)).toEqual([]);
  });
});

describe('serializing a declared level', () => {
  it('round-trips the level through serialize and parse', () => {
    // Discovery rewrites this file. Dropping the level on the way through
    // would quietly reset a repository to strict and break its next run.
    const config = parseLocalmostrcContent('version: 1\nlevel: moderate\n').config!;

    const reparsed = parseLocalmostrcContent(serializeLocalmostrc(config)).config!;

    expect(reparsed.level).toBe('moderate');
  });

  it('writes no level when the policy declares none', () => {
    const config = parseLocalmostrcContent('version: 1\n').config!;

    expect(serializeLocalmostrc(config)).not.toContain('level:');
  });
});

describe('writing a policy back', () => {
  // `localmost test --updaterc` parses the file, merges what it discovered
  // and writes the whole policy back. Whatever the writer drops or garbles,
  // the repository loses - silently, or on its next parse.
  const roundTrip = (config: LocalmostrcConfig) => {
    const reparsed = parseLocalmostrcContent(serializeLocalmostrc(config));
    expect(reparsed.errors).toEqual([]);
    return reparsed.config;
  };

  it.each([
    ['every port', true],
    ['a port list', [5432, 6379]],
  ] as const)('keeps every key the grammar accepts, with loopback as %s', (_label, loopback) => {
    const config: LocalmostrcConfig = {
      version: 1,
      level: 'moderate',
      shared: {
        network: { allow: ['github.com'], deny: ['tracker.example'], loopback: loopback as true | number[] },
        filesystem: { read: ['/usr/local'], write: ['./build'], deny: ['~/.ssh'] },
        env: { allow: ['NODE_OPTIONS'], deny: ['AWS_SECRET_ACCESS_KEY'] },
        docker: { pull: { registries: ['docker.io'] } },
        isolation: ['macos-vm', 'seatbelt'],
      },
      workflows: {
        ci: {
          network: { allow: ['registry.npmjs.org'], deny: ['ads.example'] },
          filesystem: { read: ['/opt'], deny: ['/opt/secrets'] },
          env: { allow: ['CI_FLAG'], deny: ['NPM_TOKEN'] },
          docker: { build: { context: './' } },
          secrets: { require: ['DEPLOY_KEY'] },
          isolation: 'seatbelt',
        },
      },
    };

    expect(roundTrip(config)).toEqual(config);
  });

  it('quotes env patterns and workflow names that YAML would read as something else', () => {
    // `*` opens a YAML alias and `: ` a mapping, so unquoted either makes
    // the rewritten file unparseable; `#` starts a comment. A name that
    // reads as a number, bool, null or date parses, but as a different key,
    // so its section would quietly stop applying to the workflow.
    const config: LocalmostrcConfig = {
      version: 1,
      shared: { env: { allow: ['LC_*'], deny: ['*_TOKEN', '*'] } },
      workflows: {
        'Release: tag #1': { secrets: { require: ['NPM_TOKEN'] } },
        'CI build': { env: { deny: ['*SECRET*'] } },
        '1.0': { secrets: { require: ['A'] } },
        '0x10': { secrets: { require: ['B'] } },
        '1e3': { secrets: { require: ['C'] } },
        True: { secrets: { require: ['D'] } },
        true: { secrets: { require: ['E'] } },
        NULL: { secrets: { require: ['F'] } },
        '2024-01-01': { secrets: { require: ['G'] } },
        'release-1.0': { secrets: { require: ['H'] } },
      },
    };

    expect(roundTrip(config)).toEqual(config);
  });

  it('writes a section with nothing in it as one that parses back', () => {
    // mergeDiscoveredAccess leaves `network: { allow: [] }` on a policy
    // that had no network section and gained only paths, and starts a new
    // policy with an empty entry for the workflow.
    const config: LocalmostrcConfig = {
      version: 1,
      shared: { network: { allow: [] }, filesystem: { read: ['/usr'], write: [] } },
      workflows: { ci: {} },
    };

    expect(roundTrip(config)).toEqual({
      version: 1,
      shared: { filesystem: { read: ['/usr'] } },
      workflows: { ci: {} },
    });
  });
});

describe('docker access', () => {
  const runBlock = [
    'version: 1',
    'shared:',
    '  docker:',
    '    run:',
    '      images:',
    '        - "postgres:16"',
    '      mounts:',
    '        - path: ./',
    '          mode: ro',
    '',
  ].join('\n');

  it('accepts a docker action block', () => {
    const result = parseLocalmostrcContent(runBlock);
    expect(result.success).toBe(true);
    expect(result.config?.shared?.docker).toEqual({
      run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' }] },
    });
  });

  it('rejects the old levels with a message naming the actions that replace them', () => {
    for (const level of ['socket', 'contexts', 'credentials']) {
      const result = parseLocalmostrcContent(`version: 1\nshared:\n  docker: ${level}\n`);
      expect(result.success).toBe(false);
      expect(result.errors[0].message).toMatch(/no longer a level/);
      expect(result.errors[0].message).toMatch(/`pull`, `run`, `build`/);
    }
  });

  it('rejects docker: true, which does not say which grant was meant', () => {
    const result = parseLocalmostrcContent('version: 1\nshared:\n  docker: true\n');
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toMatch(/no longer a level/);
  });

  it('rejects an unknown docker action', () => {
    const result = parseLocalmostrcContent('version: 1\nshared:\n  docker:\n    exec: {}\n');
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toMatch(/unknown docker action "exec"/);
  });

  it('accepts docker inside a workflows block', () => {
    // The socket is bound to the merged policy when the job is claimed, so a
    // workflow can carry its own docker grants.
    const result = parseLocalmostrcContent(
      'version: 1\nworkflows:\n  integration:\n    docker:\n      run:\n        mounts:\n          - path: ./tmp/fixtures\n            mode: rw\n'
    );
    expect(result.success).toBe(true);
    expect(result.config?.workflows?.integration.docker).toEqual({
      run: { mounts: [{ path: './tmp/fixtures', mode: 'rw' }] },
    });
  });

  it('validates a workflow docker block the same way as shared, under its own path', () => {
    const result = parseLocalmostrcContent(
      'version: 1\nworkflows:\n  build:\n    docker:\n      run:\n        mounts:\n          - path: ./\n            mode: write\n'
    );
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toMatch(/^workflows\.build\.docker\.run\.mounts\[0\]\.mode/);
  });
});

describe('removed sockets key', () => {
  it('rejects sockets, pointing at docker', () => {
    const result = parseLocalmostrcContent(
      'version: 1\nshared:\n  sockets:\n    allow:\n      - /var/run/docker.sock\n'
    );
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toMatch(/docker:/);
  });
});

describe('docker policy through policy merging', () => {
  it('composes the shared and workflow docker policy in the effective policy', () => {
    // localmost test builds its profile from the effective policy, and the
    // runner binds it to the socket on claim, so a grant dropped here would
    // apply in neither place.
    const config: LocalmostrcConfig = {
      version: 1,
      shared: {
        docker: { run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' }] } },
        network: { allow: ['github.com'] },
      },
      workflows: {
        integration: { docker: { run: { mounts: [{ path: './tmp/fixtures', mode: 'rw' }] } } },
      },
    };

    expect(getEffectivePolicy(config, 'integration').docker).toEqual({
      run: {
        images: ['postgres:16'],
        mounts: [
          { path: './', mode: 'ro' },
          { path: './tmp/fixtures', mode: 'rw' },
        ],
      },
    });
  });

  it('keeps the shared docker policy for a workflow with no overrides', () => {
    const config: LocalmostrcConfig = { version: 1, shared: { docker: { pull: { registries: ['docker.io'] } } } };
    expect(getEffectivePolicy(config, 'anything').docker).toEqual({ pull: { registries: ['docker.io'] } });
  });

  it('leaves docker undefined when neither side declares it', () => {
    const config: LocalmostrcConfig = { version: 1, shared: { network: { allow: ['github.com'] } } };
    expect(getEffectivePolicy(config, 'anything').docker).toBeUndefined();
  });
});

describe('docker policy in the approval diff', () => {
  it('reports each new docker grant as its own diff entry', () => {
    // With the repo policy as the only gate, the diff shown at approval time
    // is the whole of the access control for this capability.
    const before: LocalmostrcConfig = { version: 1 };
    const after: LocalmostrcConfig = {
      version: 1,
      shared: { docker: { pull: { registries: ['docker.io'] }, run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' }] } } },
    };

    const docker = diffConfigs(before, after).filter(d => d.path.startsWith('shared.docker'));

    expect(docker).toEqual(expect.arrayContaining([
      { path: 'shared.docker.pull.registries', type: 'added', newValue: 'docker.io' },
      { path: 'shared.docker.run.images', type: 'added', newValue: 'postgres:16' },
      { path: 'shared.docker.run.mounts', type: 'added', newValue: './:ro' },
    ]));
    expect(docker).toHaveLength(3);
  });

  it('reports a widened mount and a changed network mode', () => {
    const before: LocalmostrcConfig = { version: 1, shared: { docker: { run: { mounts: [{ path: './', mode: 'ro' }], network: 'none' } } } };
    const after: LocalmostrcConfig = { version: 1, shared: { docker: { run: { mounts: [{ path: './', mode: 'rw' }], network: 'bridge' } } } };

    expect(diffConfigs(before, after)).toEqual(expect.arrayContaining([
      { path: 'shared.docker.run.mounts', type: 'removed', oldValue: './:ro' },
      { path: 'shared.docker.run.mounts', type: 'added', newValue: './:rw' },
      { path: 'shared.docker.run.network', type: 'changed', oldValue: 'none', newValue: 'bridge' },
    ]));
  });

  it('reports removed docker access, per workflow too', () => {
    const before: LocalmostrcConfig = {
      version: 1,
      workflows: { integration: { docker: { run: { images: ['redis:7'] } } } },
    };
    const diffs = diffConfigs(before, { version: 1 });
    expect(diffs).toEqual([{ path: 'workflows.integration.docker.run.images', type: 'removed', oldValue: 'redis:7' }]);
  });

  it('formats docker grants like every other line of the diff', () => {
    const after: LocalmostrcConfig = { version: 1, shared: { docker: { run: { images: ['postgres:16'] }, privileged: true } } };
    const text = formatPolicyDiff(diffConfigs({ version: 1 }, after));
    expect(text).toContain('+ shared.docker.run.images: postgres:16');
    expect(text).toContain('+ shared.docker.privileged: true');
  });
});

describe('docker policy through serialization', () => {
  it('round-trips a docker block at both scopes', () => {
    const config: LocalmostrcConfig = {
      version: 1,
      shared: {
        network: { allow: ['github.com'] },
        docker: {
          pull: { registries: ['docker.io', 'ghcr.io'] },
          run: { images: ['postgres:16'], mounts: [{ path: './', mode: 'ro' }], network: 'bridge' },
          build: { context: './' },
        },
      },
      workflows: {
        integration: {
          docker: { run: { mounts: [{ path: './tmp/fixtures', mode: 'rw' }] } },
          secrets: { require: ['DB_PASSWORD'] },
        },
      },
    };

    const written = serializeLocalmostrc(config);
    const reparsed = parseLocalmostrcContent(written);

    expect(reparsed.errors).toEqual([]);
    expect(reparsed.config).toEqual(config);
  });

  it('writes no docker block when the policy grants nothing', () => {
    const config: LocalmostrcConfig = { version: 1, shared: { docker: {}, network: { allow: ['github.com'] } } };
    expect(serializeLocalmostrc(config)).not.toContain('docker');
  });
});

describe('a policy key the grammar does not know', () => {
  const parse = (body: string) => parseLocalmostrcContent(`version: 1\nshared:\n${body}`);

  it('is refused rather than ignored, since an ignored key grants nothing while looking like it grants', () => {
    // The failure this prevents: a misspelled key validates clean, shows up in
    // no approval diff because nothing parses it, and silently applies none of
    // what it appears to declare. Already seen once with `build:`.
    const result = parse('  dokcer:\n    run:\n      images: ["alpine:3"]\n');
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join('\n')).toMatch(/dokcer/);
  });

  it('names the keys that are accepted, so the fix is in the message', () => {
    const errors = parse('  filesystm:\n    read: ["/etc"]\n').errors.map((e) => e.message).join('\n');
    for (const key of ['network', 'filesystem', 'env', 'docker', 'isolation']) expect(errors).toContain(key);
  });

  it('still accepts every key the grammar does know', () => {
    const ok = parse(
      '  network:\n    allow: ["github.com"]\n' +
      '  filesystem:\n    read: ["/etc"]\n' +
      '  env:\n    allow: ["CI"]\n' +
      '  docker:\n    run:\n      images: ["alpine:3"]\n' +
      '  isolation: [macos-vm, seatbelt]\n'
    );
    expect(ok.errors).toEqual([]);
    expect(ok.success).toBe(true);
  });

  it('is refused inside a section too, and the message names the keys that section accepts', () => {
    // `lookback: true` read as a loopback grant and did nothing; `denny:`
    // read as a protection that did not exist. Both validated clean.
    const cases: Array<[string, string, string[]]> = [
      ['  network:\n    lookback: true\n', 'shared.network.lookback', ['allow', 'deny', 'loopback']],
      ['  filesystem:\n    denny: ["~/.ssh"]\n', 'shared.filesystem.denny', ['read', 'write', 'deny']],
      ['  env:\n    alow: ["CI"]\n', 'shared.env.alow', ['allow', 'deny']],
    ];
    for (const [body, where, accepted] of cases) {
      const result = parse(body);
      expect(result.success).toBe(false);
      const message = result.errors.map((e) => e.message).join('\n');
      expect(message).toContain(`${where} is not a policy key`);
      expect(message).toContain(`Accepted keys: ${accepted.join(', ')}.`);
    }
  });

  it('is refused under a workflow\'s secrets', () => {
    const r = parseLocalmostrcContent('version: 1\nworkflows:\n  deploy:\n    secrets:\n      requires: ["KEY"]\n');
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join('\n')).toContain('workflows.deploy.secrets.requires is not a policy key');
  });

  it('still accepts every key a section knows', () => {
    const ok = parse(
      '  network:\n    allow: ["github.com"]\n    deny: ["evil.example"]\n    loopback: [5432]\n' +
      '  filesystem:\n    read: ["/etc"]\n    write: ["~/.npm"]\n    deny: ["~/.ssh"]\n' +
      '  env:\n    allow: ["CI"]\n    deny: ["AWS_*"]\n'
    );
    expect(ok.errors).toEqual([]);
  });
});

describe('secrets is a workflow-scoped key', () => {
  it('is accepted under a workflow', () => {
    const r = parseLocalmostrcContent(
      'version: 1\nworkflows:\n  deploy:\n    secrets:\n      require: ["DEPLOY_KEY"]\n'
    );
    expect(r.errors).toEqual([]);
  });

  it('is refused at shared scope, where nothing reads it', () => {
    const r = parseLocalmostrcContent('version: 1\nshared:\n  secrets:\n    require: ["DEPLOY_KEY"]\n');
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join('\n')).toMatch(/shared\.secrets is not a policy key/);
  });
});

describe('a network entry', () => {
  const parsed = (list: 'allow' | 'deny', entry: string) =>
    parseLocalmostrcContent(`version: 1\nshared:\n  network:\n    ${list}:\n      - ${JSON.stringify(entry)}\n`);

  it('refuses a network entry that is not a host pattern', () => {
    // Each read as some host no connection has - "https" with a port that is
    // not one, a name with a space in it - so it allowed or denied nothing.
    for (const entry of ['https://evil.com', ' evil.com', 'evil.com ', 'evil.com:ssh', '*', '*.', '.evil.com', '*.1.2.3.4', 'a b.com', 'evil..com', ':443', '']) {
      for (const list of ['allow', 'deny'] as const) {
        const r = parsed(list, entry);
        expect([list, entry, r.success]).toEqual([list, entry, false]);
        expect(r.errors[0].message).toMatch(new RegExp(`shared\\.network\\.${list}\\[0\\] must be a host`));
      }
    }
    const w = parseLocalmostrcContent('version: 1\nworkflows:\n  ci:\n    network:\n      deny:\n        - "http://x.example"\n');
    expect(w.errors[0].message).toMatch(/workflows\.ci\.network\.deny\[0\] must be a host/);
  });

  it('refuses a range or a URL with the grammar, not the host its prefix spells', () => {
    // The spelling check reads a host the way a URL does, which ends it at the
    // first of these; "10.0.0.0/8" came back as "write \"10.0.0.0\" instead",
    // and a deny written that way denies one address rather than the range.
    // A tab or line break is dropped the same way, so "evil.com\tx" was
    // offered "evil.comx", a host the entry never named.
    for (const entry of ['10.0.0.0/8', '2001:db8::/32', 'evil.com/path', 'evil.com?x=1', 'evil.com#top', 'evil.com\\x', 'evil.com\tx', 'evil.com\nx', 'evil.com\rx']) {
      for (const list of ['allow', 'deny'] as const) {
        const r = parsed(list, entry);
        expect([list, entry, r.success]).toEqual([list, entry, false]);
        expect(r.errors.map((e) => e.message)).toEqual([
          `shared.network.${list}[0] must be a host, an IP address or *.domain, optionally with :port, and nothing else`,
        ]);
      }
    }
  });

  it('refuses a host written in a spelling the proxy never compares, and says which one it does', () => {
    // A request's host arrives in ASCII, with its address written out and no
    // trailing dot; an allow entry spelled otherwise never matched one. The
    // spelling offered keeps the entry's wildcard and port, so writing it in
    // does not turn a wildcard into one host.
    for (const [entry, suggestion] of [
      ['bücher.example', 'xn--bcher-kva.example'],
      ['0x7f.1', '127.0.0.1'],
      ['0x7f.1:8080', '127.0.0.1:8080'],
      ['*.bücher.example:8443', '*.xn--bcher-kva.example:8443'],
      ['[2001:0db8:0:0:0:0:0:1]:8443', '[2001:db8::1]:8443'],
      ['example.com.', 'example.com'],
      ['*.example.com.:8080', '*.example.com:8080'],
    ]) {
      for (const list of ['allow', 'deny'] as const) {
        const r = parsed(list, entry);
        expect([list, entry, r.success]).toEqual([list, entry, false]);
        expect(r.errors[0].message).toContain(`write "${suggestion}" instead`);
      }
    }
  });

  it('accepts a host, an address or a wildcard, with or without a port', () => {
    for (const entry of [
      'github.com',
      'API.GitHub.com',
      '*.github.com',
      'registry.npmjs.org:8443',
      '*.example.com:8080',
      'my_host-1.internal',
      '192.0.2.1',
      '192.0.2.1:8080',
      '2606:4700::1111',
      '[2001:db8::1]:8443',
      'localhost',
    ]) {
      for (const list of ['allow', 'deny'] as const) {
        expect([list, entry, parsed(list, entry).success]).toEqual([list, entry, true]);
      }
    }
  });
});

describe('network.loopback', () => {
  const shared =(value: string) => parseLocalmostrcContent(`version: 1\nshared:\n  network:\n    loopback: ${value}\n`);
  const messages = (value: string) => shared(value).errors.map((e) => e.message).join('\n');

  it('accepts every port, or a list of ports, under shared:', () => {
    expect(shared('true').config?.shared?.network?.loopback).toBe(true);
    expect(shared('[5432, 6379]').config?.shared?.network?.loopback).toEqual([5432, 6379]);
    expect(shared('[1, 65535]').success).toBe(true);
  });

  it('refuses anything but true or a list of distinct ports', () => {
    for (const value of ['false', '"all"', '5432', '{}', '', '[0]', '[65536]', '[-1]', '[1.5]', '["5432"]', '[true]']) {
      expect([value, shared(value).success]).toEqual([value, false]);
      expect(messages(value)).toMatch(/shared\.network\.loopback/);
    }
    expect(messages('[5432, 5432]')).toMatch(/shared\.network\.loopback lists port 5432 twice/);
  });

  it('is refused per workflow, since the sandbox profile is fixed when the worker starts', () => {
    const r = parseLocalmostrcContent('version: 1\nworkflows:\n  ci:\n    network:\n      loopback: true\n');
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join('\n')).toMatch(
      /workflows\.ci\.network\.loopback is only accepted under shared\.network: the sandbox profile is fixed when the worker starts/
    );
  });

  it('is a policy change, so a new grant is approved before it applies', () => {
    const base: LocalmostrcConfig = { version: 1, shared: { network: { allow: ['github.com'] } } };
    const withLoopback = (loopback: true | number[]): LocalmostrcConfig => ({
      version: 1,
      shared: { network: { allow: ['github.com'], loopback } },
    });
    expect(diffConfigs(base, withLoopback(true))).toEqual([
      { path: 'shared.network.loopback', type: 'added', newValue: 'every port' },
    ]);
    expect(diffConfigs(withLoopback([5432]), withLoopback([5432, 6379]))).toEqual([
      { path: 'shared.network.loopback', type: 'added', newValue: '6379' },
    ]);
    expect(diffConfigs(withLoopback([5432]), withLoopback(true))).toEqual([
      { path: 'shared.network.loopback', type: 'added', newValue: 'every port' },
      { path: 'shared.network.loopback', type: 'removed', oldValue: '5432' },
    ]);
    expect(diffConfigs(withLoopback([5432]), withLoopback([5432]))).toEqual([]);
  });

  it('survives serialization', () => {
    for (const loopback of [true, [5432, 6379]] as const) {
      const config: LocalmostrcConfig = { version: 1, shared: { network: { loopback: loopback as true | number[] } } };
      const reparsed = parseLocalmostrcContent(serializeLocalmostrc(config));
      expect(reparsed.config?.shared?.network?.loopback).toEqual(loopback);
    }
  });

  it('carries into the effective policy of every workflow', () => {
    const config: LocalmostrcConfig = {
      version: 1,
      shared: { network: { loopback: [5432] } },
      workflows: { ci: { network: { allow: ['x.example'] } } },
    };
    expect(getEffectivePolicy(config, 'ci').network).toEqual(
      expect.objectContaining({ allow: ['x.example'], loopback: [5432] })
    );
  });
});
