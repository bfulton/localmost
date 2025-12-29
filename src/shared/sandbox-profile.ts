/**
 * Sandbox Profile Generator
 *
 * Generates macOS sandbox-exec profiles based on .localmostrc policies.
 * Used for enforcing least-privilege sandbox in both CLI test mode and
 * background runner execution.
 */

import * as os from 'os';
import * as path from 'path';

// =============================================================================
// Types
// =============================================================================

export interface NetworkPolicy {
  allow?: string[];
  deny?: string[];
}

export interface FilesystemPolicy {
  read?: string[];
  write?: string[];
  deny?: string[];
}

export interface EnvPolicy {
  allow?: string[];
  deny?: string[];
}

export interface SandboxPolicy {
  network?: NetworkPolicy;
  filesystem?: FilesystemPolicy;
  env?: EnvPolicy;
}

export interface SandboxProfileOptions {
  /** Working directory for the workflow */
  workDir: string;
  /** Policy to enforce */
  policy?: SandboxPolicy;
  /** Whether to run in permissive mode (log violations but don't block) */
  permissive?: boolean;
  /** Log file for sandbox violations */
  logFile?: string;
}

// =============================================================================
// Profile Generation
// =============================================================================

/**
 * Expand path patterns with ~ and ** wildcards.
 */
function expandPath(pattern: string): string {
  let expanded = pattern;

  // Expand ~
  if (expanded.startsWith('~/') || expanded === '~') {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }

  return expanded;
}

/**
 * Escape a path for use in sandbox profile.
 */
function escapePath(pathStr: string): string {
  return pathStr.replace(/"/g, '\\"');
}

/**
 * Generate a network domain pattern for sandbox-exec.
 */
function generateNetworkPattern(domain: string): string {
  const escaped = domain.replace(/"/g, '\\"');

  // Handle wildcards
  if (domain.startsWith('*.')) {
    // Subdomain wildcard: *.github.com matches api.github.com, raw.githubusercontent.com
    const baseDomain = escaped.slice(2);
    return `(remote regex ".*\\\\.${baseDomain.replace(/\./g, '\\\\.')}$")`;
  }

  // Exact domain match
  return `(remote regex "^${escaped.replace(/\./g, '\\\\.')}$")`;
}

/**
 * Generate a macOS sandbox-exec profile from a policy.
 */
export function generateSandboxProfile(options: SandboxProfileOptions): string {
  const { workDir, policy, permissive = false, logFile } = options;
  const homeDir = escapePath(os.homedir());
  const tmpDir = escapePath(os.tmpdir());
  const escapedWorkDir = escapePath(workDir);

  const lines: string[] = [
    '(version 1)',
    permissive ? '(allow default)' : '(deny default)',
    '',
    ';; ============================================================',
    ';; LOCALMOST SANDBOX PROFILE',
    permissive
      ? ';; Running in PERMISSIVE mode - violations are logged, not blocked'
      : ';; Running in ENFORCEMENT mode - violations are blocked',
    ';; ============================================================',
    '',
  ];

  // Add trace for logging
  if (logFile) {
    lines.push(`;; Log violations to: ${logFile}`);
    lines.push(`(trace "${escapePath(logFile)}")`);
  } else {
    lines.push('(trace "/dev/stderr")');
  }
  lines.push('');

  // ------------------------------------------------------------
  // FILE ACCESS
  // ------------------------------------------------------------
  lines.push(';; ------------------------------------------------------------');
  lines.push(';; FILE ACCESS');
  lines.push(';; ------------------------------------------------------------');
  lines.push('');

  // Always allow reading from most places (needed for tools to work)
  lines.push(';; Read access - broad to allow tools to function');
  lines.push('(allow file-read*');
  lines.push('  (subpath "/")');
  lines.push('  (literal "/dev/null")');
  lines.push('  (literal "/dev/random")');
  lines.push('  (literal "/dev/urandom"))');
  lines.push('');

  // Write access - restricted
  lines.push(';; Write access - working directory');
  lines.push('(allow file-write*');
  lines.push(`  (subpath "${escapedWorkDir}"))`);
  lines.push('');

  lines.push(';; File ioctl for git file locking');
  lines.push('(allow file-ioctl');
  lines.push(`  (subpath "${escapedWorkDir}"))`);
  lines.push('');

  // System temp directories
  lines.push(';; System temp directories');
  lines.push('(allow file-write*');
  lines.push(`  (subpath "${tmpDir}")`);
  lines.push('  (subpath "/tmp")');
  lines.push('  (subpath "/private/tmp")');
  lines.push('  (subpath "/var/folders")');
  lines.push('  (subpath "/private/var/folders"))');
  lines.push('');

  // Standard user cache directories
  lines.push(';; User cache directories (npm, cargo, pip, etc.)');
  lines.push('(allow file-write*');
  lines.push(`  (subpath "${homeDir}/.npm")`);
  lines.push(`  (subpath "${homeDir}/.yarn")`);
  lines.push(`  (subpath "${homeDir}/.pnpm-store")`);
  lines.push(`  (subpath "${homeDir}/.cache")`);
  lines.push(`  (subpath "${homeDir}/.cargo")`);
  lines.push(`  (subpath "${homeDir}/.rustup")`);
  lines.push(`  (subpath "${homeDir}/.gradle")`);
  lines.push(`  (subpath "${homeDir}/.m2")`);
  lines.push(`  (subpath "${homeDir}/.nuget")`);
  lines.push(`  (subpath "${homeDir}/.dotnet")`);
  lines.push(`  (subpath "${homeDir}/.local")`);
  lines.push(`  (subpath "${homeDir}/go")`);
  lines.push(`  (subpath "${homeDir}/Library/Caches"))`);
  lines.push('');

  // Localmost directories
  lines.push(';; Localmost directories');
  lines.push('(allow file-write*');
  lines.push(`  (subpath "${homeDir}/.localmost"))`);
  lines.push('');

  // Policy-defined filesystem access
  if (policy?.filesystem?.write) {
    lines.push(';; Policy-defined write access');
    lines.push('(allow file-write*');
    for (const pattern of policy.filesystem.write) {
      const expanded = expandPath(pattern);
      // Handle ** wildcards
      if (expanded.includes('**')) {
        const base = expanded.replace('/**', '').replace('**/', '');
        lines.push(`  (subpath "${escapePath(base)}")`);
      } else if (expanded.includes('*')) {
        // Handle single * wildcards with regex
        const regex = expanded.replace(/\*/g, '.*').replace(/\//g, '\\/');
        lines.push(`  (regex "${regex}")`);
      } else {
        lines.push(`  (subpath "${escapePath(expanded)}")`);
      }
    }
    lines.push(')');
    lines.push('');
  }

  // Policy-defined read restrictions (if any explicit deny)
  if (policy?.filesystem?.deny) {
    lines.push(';; Policy-defined filesystem deny');
    for (const pattern of policy.filesystem.deny) {
      const expanded = expandPath(pattern);
      if (expanded.includes('*')) {
        const regex = expanded.replace(/\*/g, '.*').replace(/\//g, '\\/');
        lines.push(`(deny file-read* (regex "${regex}"))`);
        lines.push(`(deny file-write* (regex "${regex}"))`);
      } else {
        lines.push(`(deny file-read* (subpath "${escapePath(expanded)}"))`);
        lines.push(`(deny file-write* (subpath "${escapePath(expanded)}"))`);
      }
    }
    lines.push('');
  }

  // Device files
  lines.push(';; Device files');
  lines.push('(allow file-write*');
  lines.push('  (literal "/dev/null")');
  lines.push('  (literal "/dev/random")');
  lines.push('  (literal "/dev/urandom")');
  lines.push('  (literal "/dev/tty")');
  lines.push('  (literal "/dev/dtracehelper"))');
  lines.push('');

  // Metadata operations
  lines.push('(allow file-read-metadata)');
  lines.push('');

  // ------------------------------------------------------------
  // NETWORK ACCESS
  // ------------------------------------------------------------
  lines.push(';; ------------------------------------------------------------');
  lines.push(';; NETWORK ACCESS');
  lines.push(';; ------------------------------------------------------------');
  lines.push('');

  if (policy?.network?.allow && !permissive) {
    // Restrictive network mode - only allow specified domains
    lines.push(';; Policy-defined network allowlist');
    lines.push('(allow network-outbound');
    lines.push('  (local ip)'); // Always allow localhost
    for (const domain of policy.network.allow) {
      lines.push(`  ${generateNetworkPattern(domain)}`);
    }
    lines.push(')');
    lines.push('');

    // Allow inbound for localhost (for local dev servers)
    lines.push('(allow network-inbound (local ip))');
  } else {
    // Permissive network mode
    lines.push(';; Permissive network access (no policy defined)');
    lines.push('(allow network*)');
  }
  lines.push('');

  // Network deny rules
  if (policy?.network?.deny) {
    lines.push(';; Policy-defined network deny');
    for (const domain of policy.network.deny) {
      lines.push(`(deny network-outbound ${generateNetworkPattern(domain)})`);
    }
    lines.push('');
  }

  // ------------------------------------------------------------
  // PROCESS OPERATIONS
  // ------------------------------------------------------------
  lines.push(';; ------------------------------------------------------------');
  lines.push(';; PROCESS OPERATIONS - Permissive (runner spawns build tools)');
  lines.push(';; ------------------------------------------------------------');
  lines.push('(allow process*)');
  lines.push('(allow signal)');
  lines.push('');

  // ------------------------------------------------------------
  // MACH/IPC OPERATIONS
  // ------------------------------------------------------------
  lines.push(';; ------------------------------------------------------------');
  lines.push(';; MACH/IPC OPERATIONS - Required by system frameworks');
  lines.push(';; ------------------------------------------------------------');
  lines.push('(allow mach*)');
  lines.push('(allow ipc*)');
  lines.push('');

  // ------------------------------------------------------------
  // SYSTEM OPERATIONS
  // ------------------------------------------------------------
  lines.push(';; ------------------------------------------------------------');
  lines.push(';; SYSTEM OPERATIONS');
  lines.push(';; ------------------------------------------------------------');
  lines.push('(allow sysctl*)');
  lines.push('(allow iokit*)');
  lines.push('(allow pseudo-tty)');
  lines.push('(allow user-preference-read)');
  lines.push('(allow user-preference-write');
  lines.push('  (preference-domain "com.apple.dt.Xcode"))');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate a permissive sandbox profile for discovery mode.
 * This logs all access but doesn't block anything.
 */
export function generateDiscoveryProfile(options: {
  workDir: string;
  logFile: string;
}): string {
  return generateSandboxProfile({
    workDir: options.workDir,
    permissive: true,
    logFile: options.logFile,
  });
}

/**
 * Default sandbox policy when no .localmostrc exists.
 * This is fairly permissive but includes sensible defaults.
 */
export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  network: {
    allow: [
      // GitHub
      '*.github.com',
      '*.githubusercontent.com',
      'github.com',

      // Package registries
      'registry.npmjs.org',
      'registry.yarnpkg.com',
      'pypi.org',
      'files.pythonhosted.org',
      'crates.io',
      'static.crates.io',
      'rubygems.org',
      'api.nuget.org',

      // Apple/Xcode
      '*.apple.com',
      'cdn.cocoapods.org',
      'trunk.cocoapods.org',

      // Common CDNs
      '*.cloudfront.net',
      '*.fastly.net',
    ],
  },
  filesystem: {
    deny: [
      // Sensitive files
      '~/.ssh/id_*',
      '~/.gnupg/*',
      '~/.aws/*',
      '~/.config/gh/*',
    ],
  },
};
