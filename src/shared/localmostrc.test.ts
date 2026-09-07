/**
 * Tests for .localmostrc Parser and Validator
 */

import * as fs from 'fs';
import {
  findLocalmostrc,
  parseLocalmostrc,
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

// Mock fs
jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;

describe('localmostrc', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // findLocalmostrc
  // ===========================================================================

  describe('findLocalmostrc', () => {
    it('should find .localmostrc file', () => {
      mockFs.existsSync.mockImplementation((p) => p === '/repo/.localmostrc');

      const result = findLocalmostrc('/repo');

      expect(result).toBe('/repo/.localmostrc');
    });

    it('should find .localmostrc.yml file', () => {
      mockFs.existsSync.mockImplementation((p) => p === '/repo/.localmostrc.yml');

      const result = findLocalmostrc('/repo');

      expect(result).toBe('/repo/.localmostrc.yml');
    });

    it('should find .localmostrc.yaml file', () => {
      mockFs.existsSync.mockImplementation((p) => p === '/repo/.localmostrc.yaml');

      const result = findLocalmostrc('/repo');

      expect(result).toBe('/repo/.localmostrc.yaml');
    });

    it('should prefer .localmostrc over .localmostrc.yml', () => {
      mockFs.existsSync.mockImplementation(
        (p) => p === '/repo/.localmostrc' || p === '/repo/.localmostrc.yml'
      );

      const result = findLocalmostrc('/repo');

      expect(result).toBe('/repo/.localmostrc');
    });

    it('should return null if no file found', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = findLocalmostrc('/repo');

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // parseLocalmostrc
  // ===========================================================================

  describe('parseLocalmostrc', () => {
    it('should return error if file not found', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = parseLocalmostrc('/nonexistent.yml');

      expect(result.success).toBe(false);
      expect(result.errors[0].message).toContain('not found');
    });

    it('should return error if file cannot be read', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = parseLocalmostrc('/unreadable.yml');

      expect(result.success).toBe(false);
      expect(result.errors[0].message).toContain('Failed to read');
    });

    it('should parse valid content from file', () => {
      const content = `
version: 1
shared:
  network:
    allow:
      - github.com
`;
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(content);

      const result = parseLocalmostrc('/test.yml');

      expect(result.success).toBe(true);
      expect(result.config?.version).toBe(1);
    });
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
    for (const key of ['network', 'filesystem', 'env', 'docker']) expect(errors).toContain(key);
  });

  it('still accepts every key the grammar does know', () => {
    const ok = parse(
      '  network:\n    allow: ["github.com"]\n' +
      '  filesystem:\n    read: ["/etc"]\n' +
      '  env:\n    allow: ["CI"]\n' +
      '  docker:\n    run:\n      images: ["alpine:3"]\n'
    );
    expect(ok.errors).toEqual([]);
    expect(ok.success).toBe(true);
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
