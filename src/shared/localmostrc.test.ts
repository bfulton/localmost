/**
 * Tests for .localmostrc Parser and Validator
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  findLocalmostrc,
  parseLocalmostrc,
  parseLocalmostrcContent,
  mergePolicies,
  getEffectivePolicy,
  getRequiredSecrets,
  serializeLocalmostrc,
  diffConfigs,
  formatPolicyDiff,
  LocalmostrcConfig,
  LOCALMOSTRC_VERSION,
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
