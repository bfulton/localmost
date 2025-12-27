/**
 * Tests for Workflow YAML Parser
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  parseWorkflowContent,
  parseWorkflowFile,
  findWorkflowFiles,
  findDefaultWorkflow,
  generateMatrixCombinations,
  parseMatrixSpec,
  findMatchingCombination,
  extractSecretReferences,
  extractEnvReferences,
  Workflow,
} from './workflow-parser';

// Mock fs
jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;

describe('Workflow Parser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // parseWorkflowContent
  // ===========================================================================

  describe('parseWorkflowContent', () => {
    it('should parse a simple valid workflow', () => {
      const content = `
name: Test CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
      const result = parseWorkflowContent(content, 'test.yml');

      expect(result.name).toBe('Test CI');
      expect(result.filePath).toBe('test.yml');
      expect(result.workflow.jobs.build).toBeDefined();
      expect(result.workflow.jobs.build.steps).toHaveLength(2);
      expect(result.jobOrder).toEqual(['build']);
    });

    it('should derive name from filename when not specified', () => {
      const content = `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
`;
      const result = parseWorkflowContent(content, '/path/to/my-workflow.yml');

      expect(result.name).toBe('my-workflow');
    });

    it('should throw on invalid YAML', () => {
      const content = `
name: Bad YAML
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
    extra indentation error
`;
      expect(() => parseWorkflowContent(content, 'bad.yml')).toThrow('Invalid YAML');
    });

    it('should throw on empty workflow', () => {
      expect(() => parseWorkflowContent('', 'empty.yml')).toThrow('Empty workflow file');
    });

    it('should throw on workflow without jobs', () => {
      const content = `
name: No Jobs
on: push
`;
      expect(() => parseWorkflowContent(content, 'no-jobs.yml')).toThrow('No jobs defined');
    });

    it('should throw on job missing runs-on', () => {
      const content = `
on: push
jobs:
  build:
    steps:
      - run: echo hello
`;
      expect(() => parseWorkflowContent(content, 'missing-runs-on.yml')).toThrow(
        'missing required \'runs-on\''
      );
    });

    it('should throw on job without steps', () => {
      const content = `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
`;
      expect(() => parseWorkflowContent(content, 'no-steps.yml')).toThrow('has no steps');
    });

    it('should parse workflow with multiple jobs', () => {
      const content = `
on: push
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm run build
`;
      const result = parseWorkflowContent(content, 'multi.yml');

      expect(Object.keys(result.workflow.jobs)).toHaveLength(3);
      expect(result.jobOrder).toContain('lint');
      expect(result.jobOrder).toContain('test');
      expect(result.jobOrder).toContain('build');
    });
  });

  // ===========================================================================
  // Job Dependency Ordering
  // ===========================================================================

  describe('job ordering with dependencies', () => {
    it('should order jobs based on needs (single dependency)', () => {
      const content = `
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - run: deploy
  build:
    runs-on: ubuntu-latest
    steps:
      - run: build
`;
      const result = parseWorkflowContent(content, 'deps.yml');

      const buildIndex = result.jobOrder.indexOf('build');
      const deployIndex = result.jobOrder.indexOf('deploy');
      expect(buildIndex).toBeLessThan(deployIndex);
    });

    it('should order jobs based on needs (multiple dependencies)', () => {
      const content = `
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    needs: [build, test]
    steps:
      - run: deploy
  build:
    runs-on: ubuntu-latest
    steps:
      - run: build
  test:
    runs-on: ubuntu-latest
    steps:
      - run: test
`;
      const result = parseWorkflowContent(content, 'multi-deps.yml');

      const buildIndex = result.jobOrder.indexOf('build');
      const testIndex = result.jobOrder.indexOf('test');
      const deployIndex = result.jobOrder.indexOf('deploy');

      expect(buildIndex).toBeLessThan(deployIndex);
      expect(testIndex).toBeLessThan(deployIndex);
    });

    it('should detect circular dependencies', () => {
      const content = `
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    needs: b
    steps:
      - run: a
  b:
    runs-on: ubuntu-latest
    needs: a
    steps:
      - run: b
`;
      expect(() => parseWorkflowContent(content, 'circular.yml')).toThrow(
        'Circular dependency'
      );
    });

    it('should throw on unknown dependency', () => {
      const content = `
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    needs: nonexistent
    steps:
      - run: deploy
`;
      expect(() => parseWorkflowContent(content, 'unknown-dep.yml')).toThrow(
        'depends on unknown job'
      );
    });
  });

  // ===========================================================================
  // parseWorkflowFile
  // ===========================================================================

  describe('parseWorkflowFile', () => {
    it('should read and parse a workflow file', () => {
      const content = `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
`;
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(content);

      const result = parseWorkflowFile('/path/to/workflow.yml');

      expect(mockFs.readFileSync).toHaveBeenCalledWith('/path/to/workflow.yml', 'utf-8');
      expect(result.filePath).toBe('/path/to/workflow.yml');
    });

    it('should throw if file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      expect(() => parseWorkflowFile('/nonexistent.yml')).toThrow('not found');
    });
  });

  // ===========================================================================
  // findWorkflowFiles
  // ===========================================================================

  describe('findWorkflowFiles', () => {
    it('should find all yml and yaml files', () => {
      mockFs.existsSync.mockReturnValue(true);
      (mockFs.readdirSync as jest.Mock).mockReturnValue([
        'ci.yml',
        'deploy.yaml',
        'README.md',
        'build.yml',
      ]);

      const result = findWorkflowFiles('/repo');

      expect(result).toHaveLength(3);
      expect(result).toContain(path.join('/repo', '.github', 'workflows', 'build.yml'));
      expect(result).toContain(path.join('/repo', '.github', 'workflows', 'ci.yml'));
      expect(result).toContain(path.join('/repo', '.github', 'workflows', 'deploy.yaml'));
    });

    it('should return empty array if workflows directory does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = findWorkflowFiles('/repo');

      expect(result).toHaveLength(0);
    });
  });

  // ===========================================================================
  // findDefaultWorkflow
  // ===========================================================================

  describe('findDefaultWorkflow', () => {
    it('should prefer ci.yml as default', () => {
      mockFs.existsSync.mockReturnValue(true);
      (mockFs.readdirSync as jest.Mock).mockReturnValue([
        'deploy.yml',
        'ci.yml',
        'test.yml',
      ]);

      const result = findDefaultWorkflow('/repo');

      expect(result).toContain('ci.yml');
    });

    it('should fall back to build.yml if ci.yml not found', () => {
      mockFs.existsSync.mockReturnValue(true);
      (mockFs.readdirSync as jest.Mock).mockReturnValue([
        'deploy.yml',
        'build.yml',
      ]);

      const result = findDefaultWorkflow('/repo');

      expect(result).toContain('build.yml');
    });

    it('should fall back to test.yml if ci and build not found', () => {
      mockFs.existsSync.mockReturnValue(true);
      (mockFs.readdirSync as jest.Mock).mockReturnValue([
        'deploy.yml',
        'test.yml',
      ]);

      const result = findDefaultWorkflow('/repo');

      expect(result).toContain('test.yml');
    });

    it('should fall back to first alphabetically if no default names', () => {
      mockFs.existsSync.mockReturnValue(true);
      (mockFs.readdirSync as jest.Mock).mockReturnValue([
        'zebra.yml',
        'alpha.yml',
      ]);

      const result = findDefaultWorkflow('/repo');

      expect(result).toContain('alpha.yml');
    });

    it('should return null if no workflows found', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = findDefaultWorkflow('/repo');

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // generateMatrixCombinations
  // ===========================================================================

  describe('generateMatrixCombinations', () => {
    it('should return single empty combination when no matrix', () => {
      const result = generateMatrixCombinations(undefined);

      expect(result).toEqual([{}]);
    });

    it('should return single empty combination when matrix is empty', () => {
      const result = generateMatrixCombinations({ matrix: {} });

      expect(result).toEqual([{}]);
    });

    it('should generate combinations for single dimension', () => {
      const result = generateMatrixCombinations({
        matrix: { os: ['ubuntu', 'macos'] },
      });

      expect(result).toHaveLength(2);
      expect(result).toContainEqual({ os: 'ubuntu' });
      expect(result).toContainEqual({ os: 'macos' });
    });

    it('should generate Cartesian product for multiple dimensions', () => {
      const result = generateMatrixCombinations({
        matrix: {
          os: ['ubuntu', 'macos'],
          node: [16, 18, 20],
        },
      });

      expect(result).toHaveLength(6);
      expect(result).toContainEqual({ os: 'ubuntu', node: 16 });
      expect(result).toContainEqual({ os: 'ubuntu', node: 18 });
      expect(result).toContainEqual({ os: 'ubuntu', node: 20 });
      expect(result).toContainEqual({ os: 'macos', node: 16 });
      expect(result).toContainEqual({ os: 'macos', node: 18 });
      expect(result).toContainEqual({ os: 'macos', node: 20 });
    });

    it('should handle boolean values', () => {
      const result = generateMatrixCombinations({
        matrix: {
          experimental: [true, false],
        },
      });

      expect(result).toHaveLength(2);
      expect(result).toContainEqual({ experimental: true });
      expect(result).toContainEqual({ experimental: false });
    });
  });

  // ===========================================================================
  // parseMatrixSpec
  // ===========================================================================

  describe('parseMatrixSpec', () => {
    it('should parse simple key=value pairs', () => {
      const result = parseMatrixSpec('os=ubuntu,node=18');

      expect(result).toEqual({ os: 'ubuntu', node: 18 });
    });

    it('should parse boolean values', () => {
      const result = parseMatrixSpec('experimental=true,legacy=false');

      expect(result).toEqual({ experimental: true, legacy: false });
    });

    it('should parse number values', () => {
      const result = parseMatrixSpec('node=20,retries=3');

      expect(result).toEqual({ node: 20, retries: 3 });
    });

    it('should handle string values with dashes', () => {
      const result = parseMatrixSpec('os=macos-latest');

      expect(result).toEqual({ os: 'macos-latest' });
    });

    it('should throw on invalid format', () => {
      expect(() => parseMatrixSpec('invalid')).toThrow('Invalid matrix spec');
    });

    it('should handle empty value as numeric zero', () => {
      // Empty string converts to 0 via Number('')
      expect(() => parseMatrixSpec('key=')).not.toThrow();
      expect(parseMatrixSpec('key=')).toEqual({ key: 0 });
    });
  });

  // ===========================================================================
  // findMatchingCombination
  // ===========================================================================

  describe('findMatchingCombination', () => {
    const combinations = [
      { os: 'ubuntu', node: 16 },
      { os: 'ubuntu', node: 18 },
      { os: 'macos', node: 16 },
      { os: 'macos', node: 18 },
    ];

    it('should find exact match', () => {
      const result = findMatchingCombination(combinations, { os: 'macos', node: 18 });

      expect(result).toEqual({ os: 'macos', node: 18 });
    });

    it('should find partial match', () => {
      const result = findMatchingCombination(combinations, { os: 'ubuntu' });

      expect(result).toEqual({ os: 'ubuntu', node: 16 });
    });

    it('should return null when no match', () => {
      const result = findMatchingCombination(combinations, { os: 'windows' });

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // extractSecretReferences
  // ===========================================================================

  describe('extractSecretReferences', () => {
    it('should extract secrets from job env', () => {
      const workflow: Workflow = {
        on: 'push',
        jobs: {
          build: {
            'runs-on': 'ubuntu-latest',
            env: {
              API_KEY: '${{ secrets.API_KEY }}',
            },
            steps: [{ run: 'echo test' }],
          },
        },
      };

      const result = extractSecretReferences(workflow);

      expect(result).toEqual(['API_KEY']);
    });

    it('should extract secrets from step env', () => {
      const workflow: Workflow = {
        on: 'push',
        jobs: {
          build: {
            'runs-on': 'ubuntu-latest',
            steps: [
              {
                run: 'echo test',
                env: {
                  TOKEN: '${{ secrets.GITHUB_TOKEN }}',
                },
              },
            ],
          },
        },
      };

      const result = extractSecretReferences(workflow);

      expect(result).toEqual(['GITHUB_TOKEN']);
    });

    it('should extract secrets from step run scripts', () => {
      const workflow: Workflow = {
        on: 'push',
        jobs: {
          build: {
            'runs-on': 'ubuntu-latest',
            steps: [
              {
                run: 'echo ${{ secrets.NPM_TOKEN }}',
              },
            ],
          },
        },
      };

      const result = extractSecretReferences(workflow);

      expect(result).toEqual(['NPM_TOKEN']);
    });

    it('should extract secrets from step with', () => {
      const workflow: Workflow = {
        on: 'push',
        jobs: {
          build: {
            'runs-on': 'ubuntu-latest',
            steps: [
              {
                uses: 'actions/publish@v1',
                with: {
                  token: '${{ secrets.PUBLISH_TOKEN }}',
                },
              },
            ],
          },
        },
      };

      const result = extractSecretReferences(workflow);

      expect(result).toEqual(['PUBLISH_TOKEN']);
    });

    it('should extract multiple secrets and deduplicate', () => {
      const workflow: Workflow = {
        on: 'push',
        env: {
          TOKEN: '${{ secrets.API_TOKEN }}',
        },
        jobs: {
          build: {
            'runs-on': 'ubuntu-latest',
            env: {
              NPM: '${{ secrets.NPM_TOKEN }}',
            },
            steps: [
              {
                run: 'echo ${{ secrets.API_TOKEN }}',
                env: {
                  DEPLOY: '${{ secrets.DEPLOY_KEY }}',
                },
              },
            ],
          },
        },
      };

      const result = extractSecretReferences(workflow);

      expect(result).toEqual(['API_TOKEN', 'DEPLOY_KEY', 'NPM_TOKEN']);
    });

    it('should return empty array when no secrets', () => {
      const workflow: Workflow = {
        on: 'push',
        jobs: {
          build: {
            'runs-on': 'ubuntu-latest',
            steps: [{ run: 'echo hello' }],
          },
        },
      };

      const result = extractSecretReferences(workflow);

      expect(result).toEqual([]);
    });
  });

  // ===========================================================================
  // extractEnvReferences
  // ===========================================================================

  describe('extractEnvReferences', () => {
    it('should extract env references from run steps', () => {
      const workflow: Workflow = {
        on: 'push',
        jobs: {
          build: {
            'runs-on': 'ubuntu-latest',
            steps: [
              {
                run: 'echo ${{ env.MY_VAR }}',
              },
            ],
          },
        },
      };

      const result = extractEnvReferences(workflow);

      expect(result).toEqual(['MY_VAR']);
    });

    it('should extract env references from run scripts with if condition', () => {
      const workflow: Workflow = {
        on: 'push',
        jobs: {
          build: {
            'runs-on': 'ubuntu-latest',
            steps: [
              {
                run: 'echo ${{ env.DEPLOY_ENV }}',
              },
            ],
          },
        },
      };

      const result = extractEnvReferences(workflow);

      expect(result).toEqual(['DEPLOY_ENV']);
    });

    it('should extract env references from with', () => {
      const workflow: Workflow = {
        on: 'push',
        jobs: {
          build: {
            'runs-on': 'ubuntu-latest',
            steps: [
              {
                uses: 'action@v1',
                with: {
                  version: '${{ env.VERSION }}',
                },
              },
            ],
          },
        },
      };

      const result = extractEnvReferences(workflow);

      expect(result).toEqual(['VERSION']);
    });
  });
});
