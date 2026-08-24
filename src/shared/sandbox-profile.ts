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

export interface SocketsPolicy {
  /** Unix domain socket paths to allow connections to (e.g., /var/run/docker.sock) */
  allow?: string[];
}

export interface EnvPolicy {
  allow?: string[];
  deny?: string[];
}

export interface SandboxPolicy {
  network?: NetworkPolicy;
  filesystem?: FilesystemPolicy;
  sockets?: SocketsPolicy;
  env?: EnvPolicy;
}

export interface SandboxProfileOptions {
  /** Working directory for the workflow */
  workDir: string;
  /** Port of the proxy server - network traffic is restricted to this port */
  proxyPort: number;
  /** Policy to enforce */
  policy?: SandboxPolicy;
  /** Whether to run in permissive mode (log violations but don't block) */
  permissive?: boolean;
  /** Log file for sandbox violations */
  logFile?: string;
  /** Strict mode - only allow write access to workDir, block user caches */
  strictMode?: boolean;
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

// Note: macOS sandbox-exec does NOT support hostname-based network filtering.
// The (remote ...) filter only supports IP addresses and ports, not domain names.
// Network filtering by hostname is handled by the proxy server, not the sandbox.

/**
 * Generate a macOS sandbox-exec profile from a policy.
 */
export function generateSandboxProfile(options: SandboxProfileOptions): string {
  const { workDir, policy, permissive = false, logFile, strictMode = false } = options;
  const homeDir = escapePath(os.homedir());
  const tmpDir = escapePath(os.tmpdir());
  const escapedWorkDir = escapePath(workDir);

  const modeDescription = strictMode
    ? 'STRICT mode - only workDir write access, no user caches'
    : permissive
      ? 'PERMISSIVE mode - violations are logged, not blocked'
      : 'ENFORCEMENT mode - violations are blocked';

  const lines: string[] = [
    '(version 1)',
    '',
    ';; ============================================================',
    ';; LOCALMOST SANDBOX PROFILE',
    `;; Running in ${modeDescription}`,
    ';; ============================================================',
    '',
  ];

  // Add trace for logging - MUST come before deny/allow default to capture violations
  if (logFile) {
    lines.push(`;; Log violations to: ${logFile}`);
    lines.push(`(trace "${escapePath(logFile)}")`);
  } else {
    lines.push('(trace "/dev/stderr")');
  }
  lines.push('');

  // Default policy
  lines.push(permissive ? '(allow default)' : '(deny default)');
  lines.push('');

  // ------------------------------------------------------------
  // FILE ACCESS
  // ------------------------------------------------------------
  lines.push(';; ------------------------------------------------------------');
  lines.push(';; FILE ACCESS');
  lines.push(';; ------------------------------------------------------------');
  lines.push('');

  // The root directory node itself must be readable or dyld aborts every
  // process with SIGABRT before it runs. This is a literal, not a subpath:
  // (subpath "/") would grant read access to the entire disk.
  lines.push(';; Root directory node - required to resolve absolute paths');
  lines.push('(allow file-read* (literal "/"))');
  lines.push('');

  // Minimal read access - device files only (always needed)
  lines.push(';; Device files - read access');
  lines.push('(allow file-read*');
  lines.push('  (literal "/dev/null")');
  lines.push('  (literal "/dev/random")');
  lines.push('  (literal "/dev/urandom")');
  lines.push('  (literal "/dev/tty"))');
  lines.push('');

  // Working directory - full read access
  lines.push(';; Working directory - read access');
  lines.push('(allow file-read*');
  lines.push(`  (subpath "${escapedWorkDir}"))`);
  lines.push('');

  // Temp directories - read access
  lines.push(';; Temp directories - read access');
  lines.push('(allow file-read*');
  lines.push(`  (subpath "${tmpDir}")`);
  lines.push('  (subpath "/tmp")');
  lines.push('  (subpath "/private/tmp")');
  lines.push('  (subpath "/var/folders")');
  lines.push('  (subpath "/private/var/folders"))');
  lines.push('');

  // Policy-defined read paths (system paths, user caches, etc.)
  if (policy?.filesystem?.read && policy.filesystem.read.length > 0) {
    lines.push(';; Policy-defined read access');
    lines.push('(allow file-read*');
    for (const pattern of policy.filesystem.read) {
      const expanded = expandPath(pattern);
      if (expanded.includes('**')) {
        const base = expanded.replace('/**', '').replace('**/', '');
        lines.push(`  (subpath "${escapePath(base)}")`);
      } else if (expanded.includes('*')) {
        const regex = expanded.replace(/\*/g, '.*').replace(/\//g, '\\/');
        lines.push(`  (regex "${regex}")`);
      } else {
        lines.push(`  (subpath "${escapePath(expanded)}")`);
      }
    }
    lines.push(')');
    lines.push('');
  }

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

  // User cache directories - only in non-strict mode
  if (!strictMode) {
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
  } else {
    lines.push(';; STRICT MODE: User cache directories NOT allowed');
    lines.push('');
  }

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

  // All network traffic is routed through the proxy server which handles
  // hostname-based filtering. The sandbox only allows connections to localhost.
  lines.push(`;; Network: localhost TCP (proxy at port ${options.proxyPort})`);
  lines.push('(allow network-bind (local ip))');
  lines.push('(allow network-outbound (local ip))');
  lines.push('(allow network-inbound (local ip))');
  lines.push('');
  // Unix sockets are restricted to the working directory to prevent
  // connecting to system sockets like Docker or SSH agent.
  // Caller should set TMPDIR to workDir so tools create sockets there.
  lines.push(`;; Unix sockets: only in working directory`);
  lines.push(`(allow network-bind (subpath "${escapedWorkDir}"))`);
  lines.push(`(allow network-outbound (subpath "${escapedWorkDir}"))`);
  lines.push('');

  // Policy-defined socket access
  if (policy?.sockets?.allow) {
    lines.push(';; Policy-defined socket access');
    for (const socketPath of policy.sockets.allow) {
      const expanded = expandPath(socketPath);
      const escaped = escapePath(expanded);
      // Allow both bind and outbound for socket paths
      lines.push(`(allow network-bind (literal "${escaped}"))`);
      lines.push(`(allow network-outbound (literal "${escaped}"))`);
      // Also need file-write for socket operations
      lines.push(`(allow file-write* (literal "${escaped}"))`);
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
 * Generate a discovery sandbox profile that logs all filesystem access.
 *
 * Uses (with report) modifier on allow rules. This causes sandbox to log
 * each matching operation to the unified system log:
 *   kernel: (Sandbox) Sandbox: <process>(<pid>) allow <operation> <path>
 *
 * We can then parse these logs to discover what paths need to be allowed.
 */
export function generateDiscoveryProfile(options: {
  workDir: string;
  proxyPort: number;
  logFile: string;  // Not used - reports go to system log, not a file
}): string {
  const { workDir, proxyPort } = options;
  const escapedWorkDir = escapePath(workDir);

  const lines: string[] = [
    '(version 1)',
    '',
    ';; ============================================================',
    ';; LOCALMOST DISCOVERY PROFILE',
    ';; Logs all filesystem access to system log for policy generation',
    ';; ============================================================',
    '',
    '(deny default)',
    '',
    ';; ------------------------------------------------------------',
    ';; FILE ACCESS - Allow all with reporting to system log',
    ';; ------------------------------------------------------------',
    '(allow file-read* (with report))',
    '(allow file-write* (with report))',
    '(allow file-ioctl (with report))',
    '',
    ';; ------------------------------------------------------------',
    ';; NETWORK ACCESS - Localhost only (proxy handles filtering)',
    ';; ------------------------------------------------------------',
    `;; Network: localhost TCP (proxy at port ${proxyPort})`,
    '(allow network-bind (local ip))',
    '(allow network-outbound (local ip))',
    '(allow network-inbound (local ip))',
    '',
    `;; Unix sockets: working directory and reporting`,
    `(allow network-bind (subpath "${escapedWorkDir}"))`,
    `(allow network-outbound (subpath "${escapedWorkDir}"))`,
    '(allow network-bind (with report))',
    '(allow network-outbound (with report))',
    '',
    ';; ------------------------------------------------------------',
    ';; PROCESS/SYSTEM OPERATIONS - Allow all (no reporting needed)',
    ';; ------------------------------------------------------------',
    '(allow process*)',
    '(allow signal)',
    '(allow mach*)',
    '(allow ipc*)',
    '(allow sysctl*)',
    '(allow iokit*)',
    '(allow pseudo-tty)',
    '(allow user-preference-read)',
    '(allow user-preference-write)',
    '',
  ];

  return lines.join('\n');
}

/**
 * Moderate sandbox policy - the previous default behavior.
 * Allows GitHub Actions infrastructure, common registries, and standard tool caches.
 * Denies access to sensitive credential files.
 */
export const MODERATE_SANDBOX_POLICY: SandboxPolicy = {
  network: {
    allow: [
      // GitHub
      '*.github.com',
      '*.githubusercontent.com',
      'github.com',

      // GitHub Actions infrastructure
      '*.actions.githubusercontent.com',
      '*.blob.core.windows.net',

      // Package registries
      'registry.npmjs.org',
      'registry.yarnpkg.com',
      'pypi.org',
      'files.pythonhosted.org',
      'crates.io',
      'static.crates.io',
      'rubygems.org',
      'api.nuget.org',

      // Node.js downloads
      'nodejs.org',

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

// =============================================================================
// Trace Parsing
// =============================================================================

export interface SandboxTraceResult {
  /** Filesystem paths that need write access */
  writePaths: string[];
  /** Filesystem paths that were read (informational) */
  readPaths: string[];
  /** Unix domain socket paths that need access */
  socketPaths: string[];
}

/**
 * Check if a PID is in our process tree.
 * With kqueue-based pid_tree_watch, we collect all PIDs in real-time,
 * so this is simply a set membership check.
 */
function isInProcessTree(pid: number, collectedPids: Set<number>): boolean {
  return collectedPids.has(pid);
}

/**
 * Parse sandbox trace output to extract paths that were accessed.
 * Returns paths that would need to be allowed in enforcement mode.
 *
 * @param traceContent - The raw system log content containing sandbox reports
 * @param workDir - The working directory (paths inside are excluded)
 * @param collectedPids - Optional set of PIDs from our process tree (from pid_tree_watch)
 */
export function parseSandboxTrace(
  traceContent: string,
  workDir: string,
  collectedPids?: Set<number>
): SandboxTraceResult {
  const writePaths = new Set<string>();
  const readPaths = new Set<string>();
  const socketPaths = new Set<string>();
  const homeDir = os.homedir();

  // System log format from (with report):
  //   kernel: (Sandbox) Sandbox: <process>(<pid>) allow <operation> <path>
  // Example: kernel: (Sandbox) Sandbox: ls(77572) allow file-read-data /usr
  // Example: kernel: (Sandbox) Sandbox: bash(1234) allow file-write-data /tmp/foo
  const traceRegex = /Sandbox:\s+(\w+)\((\d+)\)\s+(allow|deny)\s+(\S+)\s+(.+)$/gm;

  let match;
  while ((match = traceRegex.exec(traceContent)) !== null) {
    const [, , pidStr, action, operation, pathOrTarget] = match;
    const pid = parseInt(pidStr, 10);

    // Filter by process tree if provided
    if (collectedPids && collectedPids.size > 0) {
      if (!isInProcessTree(pid, collectedPids)) {
        continue;
      }
    }

    // Only process allow actions in discovery mode
    if (action !== 'allow') continue;

    // Handle network operations on Unix sockets
    if (operation === 'network-outbound' || operation === 'network-bind') {
      // network-outbound path looks like: /var/run/docker.sock
      // Skip if it's an IP address or localhost
      if (pathOrTarget.startsWith('/')) {
        // Skip paths inside workDir (already allowed)
        if (pathOrTarget.startsWith(workDir)) continue;

        // Convert to relative path with ~ if in home directory
        const relativePath = pathOrTarget.startsWith(homeDir)
          ? '~' + pathOrTarget.slice(homeDir.length)
          : pathOrTarget;
        socketPaths.add(relativePath);
      }
      continue;
    }

    // Handle file operations
    if (!operation.startsWith('file-')) continue;
    const filePath = pathOrTarget;

    // Skip paths inside workDir (already allowed)
    if (filePath.startsWith(workDir)) continue;

    // Skip system paths that are always allowed (temp dirs, devices)
    if (
      filePath.startsWith('/tmp') ||
      filePath.startsWith('/private/tmp') ||
      filePath.startsWith('/var/tmp') ||
      filePath.startsWith('/private/var/tmp') ||
      filePath.startsWith('/var/folders') ||
      filePath.startsWith('/private/var/folders') ||
      filePath.startsWith('/dev/')
    ) {
      continue;
    }

    // Categorize by operation type
    if (operation.includes('write') || operation.includes('create') || operation.includes('unlink')) {
      // Convert to relative path with ~ if in home directory
      const relativePath = filePath.startsWith(homeDir)
        ? '~' + filePath.slice(homeDir.length)
        : filePath;
      writePaths.add(relativePath);
    } else if (operation.includes('read')) {
      // We generally allow reads, but track them for reference
      const relativePath = filePath.startsWith(homeDir)
        ? '~' + filePath.slice(homeDir.length)
        : filePath;
      readPaths.add(relativePath);
    }
  }

  // Known cache directory patterns - consolidate writes to these roots
  const cacheRoots = [
    '~/.npm/_cacache',
    '~/.npm/_logs',
    '~/.npm/_npx',
    '~/.yarn/cache',
    '~/.cache/yarn',
    '~/.cargo/registry',
    '~/.cargo/git',
    '~/.cache/pip',
    '~/.cache/go-build',
    '~/.gradle/caches',
    '~/.m2/repository',
    '~/.pub-cache',
    '~/.nuget/packages',
  ];

  // Consolidate write paths - aggressively consolidate to cache roots
  const consolidateWrites = (paths: Set<string>): string[] => {
    const consolidated = new Set<string>();

    for (const p of paths) {
      // Check if path is under a known cache root
      let matched = false;
      for (const root of cacheRoots) {
        if (p.startsWith(root + '/') || p === root) {
          consolidated.add(root);
          matched = true;
          break;
        }
      }
      if (!matched) {
        consolidated.add(p);
      }
    }

    // Remove children if parent exists
    const sorted = Array.from(consolidated).sort();
    const result: string[] = [];
    for (const p of sorted) {
      const isChild = result.some(
        (existing) => p.startsWith(existing + '/') || p === existing
      );
      if (!isChild) {
        result.push(p);
      }
    }
    return result;
  };

  // Don't consolidate read paths - return them as discovered
  // This gives the user full visibility into what was accessed
  const consolidateReads = (paths: Set<string>): string[] => {
    return Array.from(paths).sort();
  };

  return {
    writePaths: consolidateWrites(writePaths),
    readPaths: consolidateReads(readPaths),
    socketPaths: Array.from(socketPaths).sort(),
  };
}

/** @deprecated Use MODERATE_SANDBOX_POLICY instead */
export const DEFAULT_SANDBOX_POLICY = MODERATE_SANDBOX_POLICY;
