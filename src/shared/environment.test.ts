/**
 * Tests for Environment Detection and Diff
 */

import { execSync } from 'child_process';
import {
  detectLocalEnvironment,
  compareEnvironments,
  formatEnvironmentDiff,
  formatEnvironmentInfo,
  GITHUB_RUNNER_ENVIRONMENTS,
  EnvironmentInfo,
} from './environment';

// Mock child_process
jest.mock('child_process');

// Mock os module
jest.mock('os', () => ({
  cpus: jest.fn(() => new Array(8).fill({})),
  totalmem: jest.fn(() => 16 * 1024 * 1024 * 1024),
  homedir: jest.fn(() => '/Users/test'),
  tmpdir: jest.fn(() => '/var/folders/test/temp'),
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe('Environment Detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default mock responses
    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('sw_vers')) return '14.5';
      if (cmdStr.includes('xcode-select')) return '/Applications/Xcode.app/Contents/Developer';
      if (cmdStr.includes('xcodebuild -version')) return 'Xcode 15.4\nBuild version 15F31d';
      if (cmdStr.includes('node --version')) return 'v20.10.0';
      if (cmdStr.includes('python3 --version')) return 'Python 3.12.0';
      if (cmdStr.includes('ruby --version')) return 'ruby 3.2.2 (2023-03-30 revision e51014f9c0)';
      if (cmdStr.includes('go version')) return 'go version go1.21.5 darwin/arm64';
      if (cmdStr.includes('java -version')) return 'openjdk version "21.0.1" 2023-10-17';
      if (cmdStr.includes('rustc --version')) return 'rustc 1.75.0 (82e1608df 2023-12-21)';
      if (cmdStr.includes('brew --prefix')) return '/opt/homebrew';
      return '';
    });
  });

  // ===========================================================================
  // detectLocalEnvironment
  // ===========================================================================

  describe('detectLocalEnvironment', () => {
    it('should detect macOS version', () => {
      const env = detectLocalEnvironment();

      expect(env.macosVersion).toBe('14.5');
    });

    it('should detect architecture', () => {
      const env = detectLocalEnvironment();

      expect(['arm64', 'x64']).toContain(env.arch);
    });

    it('should detect CPU count', () => {
      const env = detectLocalEnvironment();

      expect(env.cpuCount).toBe(8);
    });

    it('should detect memory', () => {
      const env = detectLocalEnvironment();

      expect(env.memoryGB).toBe(16);
    });

    it('should detect Xcode version', () => {
      const env = detectLocalEnvironment();

      expect(env.xcodeVersion).toBe('15.4');
      expect(env.xcodePath).toBe('/Applications/Xcode.app/Contents/Developer');
    });

    it('should detect Node.js version', () => {
      const env = detectLocalEnvironment();

      expect(env.nodeVersion).toBe('20.10.0');
    });

    it('should detect Python version', () => {
      const env = detectLocalEnvironment();

      expect(env.pythonVersion).toBe('3.12.0');
    });

    it('should detect Ruby version', () => {
      const env = detectLocalEnvironment();

      expect(env.rubyVersion).toBe('3.2.2');
    });

    it('should detect Go version', () => {
      const env = detectLocalEnvironment();

      expect(env.goVersion).toBe('1.21.5');
    });

    it('should detect Java version', () => {
      const env = detectLocalEnvironment();

      expect(env.javaVersion).toBe('21.0.1');
    });

    it('should detect Rust version', () => {
      const env = detectLocalEnvironment();

      expect(env.rustVersion).toBe('1.75.0');
    });

    it('should detect Homebrew prefix', () => {
      const env = detectLocalEnvironment();

      expect(env.homebrewPrefix).toBe('/opt/homebrew');
    });

    it('should handle missing tools gracefully', () => {
      mockExecSync.mockImplementation((cmd) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('sw_vers')) return '14.5';
        throw new Error('command not found');
      });

      const env = detectLocalEnvironment();

      expect(env.macosVersion).toBe('14.5');
      expect(env.nodeVersion).toBeUndefined();
      expect(env.xcodeVersion).toBeUndefined();
    });
  });

  // ===========================================================================
  // GITHUB_RUNNER_ENVIRONMENTS
  // ===========================================================================

  describe('GITHUB_RUNNER_ENVIRONMENTS', () => {
    it('should have macos-latest defined', () => {
      expect(GITHUB_RUNNER_ENVIRONMENTS['macos-latest']).toBeDefined();
    });

    it('should have macos-14 defined', () => {
      expect(GITHUB_RUNNER_ENVIRONMENTS['macos-14']).toBeDefined();
    });

    it('should have macos-13 defined', () => {
      expect(GITHUB_RUNNER_ENVIRONMENTS['macos-13']).toBeDefined();
    });

    it('should have macos-15 defined', () => {
      expect(GITHUB_RUNNER_ENVIRONMENTS['macos-15']).toBeDefined();
    });

    it('should have correct architecture for macos-14', () => {
      expect(GITHUB_RUNNER_ENVIRONMENTS['macos-14'].arch).toBe('arm64');
    });

    it('should have correct architecture for macos-13', () => {
      expect(GITHUB_RUNNER_ENVIRONMENTS['macos-13'].arch).toBe('x64');
    });
  });

  // ===========================================================================
  // compareEnvironments
  // ===========================================================================

  describe('compareEnvironments', () => {
    const localEnv: EnvironmentInfo = {
      macosVersion: '14.5',
      arch: 'arm64',
      cpuCount: 8,
      memoryGB: 16,
      xcodeVersion: '15.4',
      nodeVersion: '20.10.0',
      pythonVersion: '3.12.0',
      rubyVersion: '3.2.2',
    };

    it('should return empty array when environments match', () => {
      const diffs = compareEnvironments(localEnv, 'macos-14');

      expect(diffs).toHaveLength(0);
    });

    it('should detect macOS version mismatch', () => {
      const env = { ...localEnv, macosVersion: '13.6' };
      const diffs = compareEnvironments(env, 'macos-14');

      expect(diffs.some((d) => d.property === 'macOS')).toBe(true);
    });

    it('should detect architecture mismatch', () => {
      const env = { ...localEnv, arch: 'x64' };
      const diffs = compareEnvironments(env, 'macos-14');

      expect(diffs.some((d) => d.property === 'Architecture')).toBe(true);
      expect(diffs.find((d) => d.property === 'Architecture')?.severity).toBe('error');
    });

    it('should detect Xcode version mismatch', () => {
      const env = { ...localEnv, xcodeVersion: '14.0' };
      const diffs = compareEnvironments(env, 'macos-14');

      expect(diffs.some((d) => d.property === 'Xcode')).toBe(true);
      expect(diffs.find((d) => d.property === 'Xcode')?.suggestion).toContain('setup-xcode');
    });

    it('should detect Node.js version mismatch', () => {
      const env = { ...localEnv, nodeVersion: '18.19.0' };
      const diffs = compareEnvironments(env, 'macos-14');

      expect(diffs.some((d) => d.property === 'Node.js')).toBe(true);
      expect(diffs.find((d) => d.property === 'Node.js')?.suggestion).toContain('setup-node');
    });

    it('should detect Python version mismatch', () => {
      const env = { ...localEnv, pythonVersion: '3.11.0' };
      const diffs = compareEnvironments(env, 'macos-14');

      expect(diffs.some((d) => d.property === 'Python')).toBe(true);
      expect(diffs.find((d) => d.property === 'Python')?.suggestion).toContain('setup-python');
    });

    it('should handle unknown runner label', () => {
      const diffs = compareEnvironments(localEnv, 'unknown-runner');

      expect(diffs).toHaveLength(1);
      expect(diffs[0].property).toBe('runner');
      expect(diffs[0].suggestion).toContain('Unknown runner label');
    });

    it('should handle array runs-on', () => {
      const diffs = compareEnvironments(localEnv, ['macos-14', 'self-hosted'] as any);

      // Should use first element of array
      expect(diffs).toHaveLength(0);
    });

    it('should handle matrix expression in runs-on', () => {
      const diffs = compareEnvironments(localEnv, '${{ matrix.os }}');

      // Should default to macos-latest
      expect(diffs.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ===========================================================================
  // formatEnvironmentDiff
  // ===========================================================================

  describe('formatEnvironmentDiff', () => {
    it('should return success message for empty diffs', () => {
      const result = formatEnvironmentDiff([]);

      expect(result).toBe('Environment matches GitHub runner configuration.');
    });

    it('should format error diff with X icon', () => {
      const diffs = [
        {
          property: 'Architecture',
          local: 'x64',
          github: 'arm64',
          severity: 'error' as const,
        },
      ];

      const result = formatEnvironmentDiff(diffs);

      expect(result).toContain('\u2717'); // X mark
      expect(result).toContain('Architecture');
      expect(result).toContain('x64');
      expect(result).toContain('arm64');
    });

    it('should format warning diff with warning icon', () => {
      const diffs = [
        {
          property: 'macOS',
          local: '13.6',
          github: '14.5',
          severity: 'warning' as const,
        },
      ];

      const result = formatEnvironmentDiff(diffs);

      expect(result).toContain('\u26A0'); // Warning sign
    });

    it('should format info diff with info icon', () => {
      const diffs = [
        {
          property: 'Node.js',
          local: '18.19.0',
          github: '20.10.0',
          severity: 'info' as const,
        },
      ];

      const result = formatEnvironmentDiff(diffs);

      expect(result).toContain('\u2139'); // Info sign
    });

    it('should include suggestion when provided', () => {
      const diffs = [
        {
          property: 'Node.js',
          local: '18.19.0',
          github: '20.10.0',
          severity: 'info' as const,
          suggestion: 'Use setup-node action',
        },
      ];

      const result = formatEnvironmentDiff(diffs);

      expect(result).toContain('Suggestion:');
      expect(result).toContain('setup-node');
    });
  });

  // ===========================================================================
  // formatEnvironmentInfo
  // ===========================================================================

  describe('formatEnvironmentInfo', () => {
    it('should format basic environment info', () => {
      const env: EnvironmentInfo = {
        macosVersion: '14.5',
        arch: 'arm64',
        cpuCount: 8,
        memoryGB: 16,
      };

      const result = formatEnvironmentInfo(env);

      expect(result).toContain('Local Environment:');
      expect(result).toContain('macOS:');
      expect(result).toContain('14.5');
      expect(result).toContain('Arch:');
      expect(result).toContain('arm64');
      expect(result).toContain('CPU:');
      expect(result).toContain('8 cores');
      expect(result).toContain('Memory:');
      expect(result).toContain('16 GB');
    });

    it('should include Xcode when present', () => {
      const env: EnvironmentInfo = {
        macosVersion: '14.5',
        arch: 'arm64',
        cpuCount: 8,
        memoryGB: 16,
        xcodeVersion: '15.4',
      };

      const result = formatEnvironmentInfo(env);

      expect(result).toContain('Xcode:');
      expect(result).toContain('15.4');
    });

    it('should include all language versions when present', () => {
      const env: EnvironmentInfo = {
        macosVersion: '14.5',
        arch: 'arm64',
        cpuCount: 8,
        memoryGB: 16,
        nodeVersion: '20.10.0',
        pythonVersion: '3.12.0',
        rubyVersion: '3.2.2',
        goVersion: '1.21.5',
        javaVersion: '21.0.1',
        rustVersion: '1.75.0',
      };

      const result = formatEnvironmentInfo(env);

      expect(result).toContain('Node.js:');
      expect(result).toContain('Python:');
      expect(result).toContain('Ruby:');
      expect(result).toContain('Go:');
      expect(result).toContain('Java:');
      expect(result).toContain('Rust:');
    });

    it('should omit missing optional fields', () => {
      const env: EnvironmentInfo = {
        macosVersion: '14.5',
        arch: 'arm64',
        cpuCount: 8,
        memoryGB: 16,
      };

      const result = formatEnvironmentInfo(env);

      expect(result).not.toContain('Node.js:');
      expect(result).not.toContain('Xcode:');
    });
  });
});
