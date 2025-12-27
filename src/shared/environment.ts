/**
 * Environment Detection and Diff
 *
 * Detects the local development environment and compares it to
 * GitHub-hosted runner environments to surface potential differences.
 */

import { execSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';

// =============================================================================
// Types
// =============================================================================

export interface EnvironmentInfo {
  /** macOS version (e.g., "14.5") */
  macosVersion: string;
  /** Xcode version if installed (e.g., "16.0") */
  xcodeVersion?: string;
  /** Active Xcode path */
  xcodePath?: string;
  /** Node.js version (e.g., "20.10.0") */
  nodeVersion?: string;
  /** Python version (e.g., "3.12.0") */
  pythonVersion?: string;
  /** Ruby version (e.g., "3.2.2") */
  rubyVersion?: string;
  /** Go version (e.g., "1.21.5") */
  goVersion?: string;
  /** Java version (e.g., "21.0.1") */
  javaVersion?: string;
  /** Rust version (e.g., "1.75.0") */
  rustVersion?: string;
  /** Homebrew prefix */
  homebrewPrefix?: string;
  /** CPU architecture */
  arch: string;
  /** CPU cores */
  cpuCount: number;
  /** Total memory in GB */
  memoryGB: number;
}

export interface EnvironmentDiff {
  property: string;
  local: string;
  github: string;
  severity: 'info' | 'warning' | 'error';
  suggestion?: string;
}

export interface GitHubRunnerEnvironment {
  os: string;
  macosVersion: string;
  xcodeVersion: string;
  nodeVersion: string;
  pythonVersion: string;
  rubyVersion: string;
  arch: string;
}

// =============================================================================
// Known GitHub Runner Environments
// =============================================================================

/**
 * Known GitHub-hosted runner configurations.
 * Updated periodically from: https://github.com/actions/runner-images
 */
export const GITHUB_RUNNER_ENVIRONMENTS: Record<string, GitHubRunnerEnvironment> = {
  'macos-latest': {
    os: 'macos-14',
    macosVersion: '14.5',
    xcodeVersion: '15.4',
    nodeVersion: '20.10.0',
    pythonVersion: '3.12.0',
    rubyVersion: '3.2.2',
    arch: 'arm64',
  },
  'macos-14': {
    os: 'macos-14',
    macosVersion: '14.5',
    xcodeVersion: '15.4',
    nodeVersion: '20.10.0',
    pythonVersion: '3.12.0',
    rubyVersion: '3.2.2',
    arch: 'arm64',
  },
  'macos-13': {
    os: 'macos-13',
    macosVersion: '13.6',
    xcodeVersion: '15.2',
    nodeVersion: '20.10.0',
    pythonVersion: '3.12.0',
    rubyVersion: '3.2.2',
    arch: 'x64',
  },
  'macos-15': {
    os: 'macos-15',
    macosVersion: '15.0',
    xcodeVersion: '16.0',
    nodeVersion: '20.18.0',
    pythonVersion: '3.13.0',
    rubyVersion: '3.3.0',
    arch: 'arm64',
  },
};

// =============================================================================
// Environment Detection
// =============================================================================

/**
 * Detect the local development environment.
 */
export function detectLocalEnvironment(): EnvironmentInfo {
  const env: EnvironmentInfo = {
    macosVersion: getMacOSVersion(),
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    cpuCount: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
  };

  // Xcode
  const xcodeInfo = getXcodeInfo();
  if (xcodeInfo) {
    env.xcodeVersion = xcodeInfo.version;
    env.xcodePath = xcodeInfo.path;
  }

  // Node.js
  env.nodeVersion = getCommandVersion('node', '--version', /v(\d+\.\d+\.\d+)/);

  // Python
  env.pythonVersion = getCommandVersion('python3', '--version', /Python (\d+\.\d+\.\d+)/);

  // Ruby
  env.rubyVersion = getCommandVersion('ruby', '--version', /ruby (\d+\.\d+\.\d+)/);

  // Go
  env.goVersion = getCommandVersion('go', 'version', /go(\d+\.\d+(?:\.\d+)?)/);

  // Java
  env.javaVersion = getCommandVersion('java', '-version', /version "(\d+(?:\.\d+)*)/);

  // Rust
  env.rustVersion = getCommandVersion('rustc', '--version', /rustc (\d+\.\d+\.\d+)/);

  // Homebrew
  env.homebrewPrefix = getHomebrewPrefix();

  return env;
}

/**
 * Get macOS version.
 */
function getMacOSVersion(): string {
  try {
    const result = execSync('sw_vers -productVersion', { encoding: 'utf-8' });
    return result.trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Get Xcode info.
 */
function getXcodeInfo(): { version: string; path: string } | null {
  try {
    const path = execSync('xcode-select -p', { encoding: 'utf-8' }).trim();
    const versionOutput = execSync('xcodebuild -version', { encoding: 'utf-8' });
    const match = versionOutput.match(/Xcode (\d+\.\d+(?:\.\d+)?)/);
    if (match) {
      return { version: match[1], path };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get version from a command.
 */
function getCommandVersion(command: string, flag: string, regex: RegExp): string | undefined {
  try {
    const result = execSync(`${command} ${flag} 2>&1`, { encoding: 'utf-8' });
    const match = result.match(regex);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get Homebrew prefix.
 */
function getHomebrewPrefix(): string | undefined {
  try {
    const result = execSync('brew --prefix', { encoding: 'utf-8' });
    return result.trim();
  } catch {
    return undefined;
  }
}

// =============================================================================
// Environment Comparison
// =============================================================================

/**
 * Compare local environment to a GitHub runner.
 */
export function compareEnvironments(
  local: EnvironmentInfo,
  runsOn: string
): EnvironmentDiff[] {
  const diffs: EnvironmentDiff[] = [];

  // Normalize runs-on value
  const runnerLabel = normalizeRunsOn(runsOn);
  const github = GITHUB_RUNNER_ENVIRONMENTS[runnerLabel];

  if (!github) {
    diffs.push({
      property: 'runner',
      local: 'self-hosted',
      github: runnerLabel,
      severity: 'info',
      suggestion: `Unknown runner label: ${runsOn}. Cannot compare environments.`,
    });
    return diffs;
  }

  // Compare macOS version
  const localMajor = parseInt(local.macosVersion.split('.')[0]);
  const githubMajor = parseInt(github.macosVersion.split('.')[0]);

  if (localMajor !== githubMajor) {
    diffs.push({
      property: 'macOS',
      local: local.macosVersion,
      github: github.macosVersion,
      severity: 'warning',
      suggestion: `Consider updating your workflow to use a runner matching your local macOS version.`,
    });
  }

  // Compare architecture
  if (local.arch !== github.arch) {
    diffs.push({
      property: 'Architecture',
      local: local.arch,
      github: github.arch,
      severity: 'error',
      suggestion: `Architecture mismatch may cause build failures. ${runnerLabel} uses ${github.arch}.`,
    });
  }

  // Compare Xcode version
  if (local.xcodeVersion) {
    const localXcodeMajor = parseInt(local.xcodeVersion.split('.')[0]);
    const githubXcodeMajor = parseInt(github.xcodeVersion.split('.')[0]);

    if (localXcodeMajor !== githubXcodeMajor) {
      diffs.push({
        property: 'Xcode',
        local: local.xcodeVersion,
        github: github.xcodeVersion,
        severity: 'warning',
        suggestion: `Add a step to select the matching Xcode version:\n  - uses: maxim-lobanov/setup-xcode@v1\n    with:\n      xcode-version: '${local.xcodeVersion}'`,
      });
    }
  }

  // Compare Node.js version
  if (local.nodeVersion && github.nodeVersion) {
    const localNodeMajor = parseInt(local.nodeVersion.split('.')[0]);
    const githubNodeMajor = parseInt(github.nodeVersion.split('.')[0]);

    if (localNodeMajor !== githubNodeMajor) {
      diffs.push({
        property: 'Node.js',
        local: local.nodeVersion,
        github: github.nodeVersion,
        severity: 'info',
        suggestion: `Pin Node.js version in workflow:\n  - uses: actions/setup-node@v4\n    with:\n      node-version: '${localNodeMajor}'`,
      });
    }
  }

  // Compare Python version
  if (local.pythonVersion && github.pythonVersion) {
    const localPyMajor = local.pythonVersion.split('.').slice(0, 2).join('.');
    const githubPyMajor = github.pythonVersion.split('.').slice(0, 2).join('.');

    if (localPyMajor !== githubPyMajor) {
      diffs.push({
        property: 'Python',
        local: local.pythonVersion,
        github: github.pythonVersion,
        severity: 'info',
        suggestion: `Pin Python version in workflow:\n  - uses: actions/setup-python@v5\n    with:\n      python-version: '${localPyMajor}'`,
      });
    }
  }

  return diffs;
}

/**
 * Normalize a runs-on value to a known runner label.
 */
function normalizeRunsOn(runsOn: string | string[]): string {
  const value = Array.isArray(runsOn) ? runsOn[0] : runsOn;

  // Handle matrix expressions
  if (value.includes('${{')) {
    return 'macos-latest'; // Default assumption
  }

  return value;
}

/**
 * Format environment diffs for display.
 */
export function formatEnvironmentDiff(diffs: EnvironmentDiff[]): string {
  if (diffs.length === 0) {
    return 'Environment matches GitHub runner configuration.';
  }

  const lines: string[] = ['Environment differences:', ''];

  for (const diff of diffs) {
    const icon = diff.severity === 'error' ? '\u2717' : diff.severity === 'warning' ? '\u26A0' : '\u2139';
    lines.push(`${icon} ${diff.property}`);
    lines.push(`  Local:  ${diff.local}`);
    lines.push(`  GitHub: ${diff.github}`);
    if (diff.suggestion) {
      lines.push(`  Suggestion: ${diff.suggestion}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Show current environment info.
 */
export function formatEnvironmentInfo(env: EnvironmentInfo): string {
  const lines: string[] = ['Local Environment:', ''];

  lines.push(`  macOS:     ${env.macosVersion}`);
  lines.push(`  Arch:      ${env.arch}`);
  lines.push(`  CPU:       ${env.cpuCount} cores`);
  lines.push(`  Memory:    ${env.memoryGB} GB`);

  if (env.xcodeVersion) {
    lines.push(`  Xcode:     ${env.xcodeVersion}`);
  }
  if (env.nodeVersion) {
    lines.push(`  Node.js:   ${env.nodeVersion}`);
  }
  if (env.pythonVersion) {
    lines.push(`  Python:    ${env.pythonVersion}`);
  }
  if (env.rubyVersion) {
    lines.push(`  Ruby:      ${env.rubyVersion}`);
  }
  if (env.goVersion) {
    lines.push(`  Go:        ${env.goVersion}`);
  }
  if (env.javaVersion) {
    lines.push(`  Java:      ${env.javaVersion}`);
  }
  if (env.rustVersion) {
    lines.push(`  Rust:      ${env.rustVersion}`);
  }

  return lines.join('\n');
}
