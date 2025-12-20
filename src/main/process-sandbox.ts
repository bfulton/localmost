/**
 * Process Sandbox - Controlled Process Execution (macOS only)
 *
 * This module provides controlled process execution by:
 * - Only allowing execution of known, trusted binaries
 * - Restricting execution to the app's data directory
 * - Using macOS sandbox-exec for OS-level process isolation
 * - Using Node.js native APIs instead of shell commands where possible
 */

import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { getAppDataDir, isAppSandboxed } from './paths';

/**
 * Allowed executable patterns within the runner directory.
 * These are the only binaries that can be spawned.
 */
const ALLOWED_EXECUTABLES = [
  'run.sh',
  'config.sh',
  'bin/Runner.Listener',
  'bin/Runner.Worker',
] as const;

/**
 * Get the base runner directory path (app data directory).
 * Uses centralized path management.
 */
function getRunnerBaseDir(): string {
  return getAppDataDir();
}

/**
 * Validate that an executable path is within the allowed sandbox.
 * Returns the validated absolute path or throws an error.
 */
function validateExecutablePath(executablePath: string): string {
  const runnerBase = getRunnerBaseDir();
  const absolutePath = path.isAbsolute(executablePath)
    ? executablePath
    : path.resolve(executablePath);

  // Normalize to prevent path traversal attacks
  const normalizedPath = path.normalize(absolutePath);

  // Verify the path is within our runner directory
  if (!normalizedPath.startsWith(runnerBase)) {
    throw new Error(
      `Security violation: Attempted to execute binary outside sandbox: ${executablePath}`
    );
  }

  // Verify the executable matches an allowed pattern
  const relativePath = path.relative(runnerBase, normalizedPath);
  const isAllowed = ALLOWED_EXECUTABLES.some((pattern) => {
    // Check if the relative path ends with the allowed pattern
    // This handles both runner/run.sh and runner-2/run.sh etc.
    return relativePath.endsWith(pattern) || relativePath.includes(`runner/${pattern}`) ||
      relativePath.includes(`runner-`) && relativePath.endsWith(pattern.split('/').pop() || '');
  });

  if (!isAllowed) {
    throw new Error(
      `Security violation: Executable not in allowlist: ${relativePath}`
    );
  }

  // Verify the file exists
  if (!fs.existsSync(normalizedPath)) {
    throw new Error(`Executable not found: ${normalizedPath}`);
  }

  return normalizedPath;
}

/**
 * Generate a macOS sandbox profile for the runner process.
 *
 * SECURITY MODEL:
 * The profile restricts file WRITES to known-safe directories while allowing
 * broad READ access. Network, process, and IPC access remain permissive
 * because CI runners genuinely require these capabilities.
 *
 * File write restrictions prevent:
 * - Malicious workflows from modifying system files
 * - Accidental damage to user's home directory
 * - Persistence mechanisms outside the runner directory
 *
 * Current security layers:
 * - Application-level path validation (validateExecutablePath)
 * - Executable allowlist (ALLOWED_EXECUTABLES)
 * - Sandbox write restrictions (this profile)
 * - Network proxy with domain filtering (separate layer)
 */
function generateSandboxProfile(instanceDir: string): string {
  const escapedDir = instanceDir.replace(/"/g, '\\"');
  const homeDir = os.homedir().replace(/"/g, '\\"');
  const appDataDir = getRunnerBaseDir().replace(/"/g, '\\"');
  const tmpDir = os.tmpdir().replace(/"/g, '\\"');

  return `
(version 1)
(deny default)

;; Trace denied operations to stderr (useful for debugging sandbox issues)
(trace "/dev/stderr")

;; ============================================================
;; LOCALMOST RUNNER SANDBOX PROFILE
;; Restricts file writes to safe directories while allowing
;; the GitHub Actions runner to function.
;; ============================================================

;; ------------------------------------------------------------
;; FILE ACCESS - Restricted writes, broad reads
;; ------------------------------------------------------------

;; WRITE ACCESS - Only to specific directories
;; Runner sandbox directory (build artifacts, cloned repos)
(allow file-write*
  (subpath "${escapedDir}"))

;; App data directory (tool cache, other instances)
(allow file-write*
  (subpath "${appDataDir}"))

;; System temp directories (many tools require this)
;; Note: /var is a symlink to /private/var on macOS, and sandbox
;; checks may use canonical paths, so we need both variants
(allow file-write*
  (subpath "${tmpDir}")
  (subpath "/tmp")
  (subpath "/private/tmp")
  (subpath "/var/folders")
  (subpath "/private/var/folders"))

;; User cache directories (npm, cargo, pip, etc.)
(allow file-write*
  (subpath "${homeDir}/.npm")
  (subpath "${homeDir}/.yarn")
  (subpath "${homeDir}/.pnpm-store")
  (subpath "${homeDir}/.cache")
  (subpath "${homeDir}/.cargo")
  (subpath "${homeDir}/.rustup")
  (subpath "${homeDir}/.gradle")
  (subpath "${homeDir}/.m2")
  (subpath "${homeDir}/.nuget")
  (subpath "${homeDir}/.dotnet")
  (subpath "${homeDir}/.local")
  (subpath "${homeDir}/go")
  (subpath "${homeDir}/Library/Caches"))

;; READ ACCESS - Broad to allow tools to function
(allow file-read*
  (subpath "/")
  (literal "/dev/null")
  (literal "/dev/random")
  (literal "/dev/urandom"))

;; Allow file metadata operations everywhere (ls, stat, etc.)
(allow file-read-metadata)

;; ------------------------------------------------------------
;; PROCESS OPERATIONS - Permissive (runner spawns build tools)
;; ------------------------------------------------------------
(allow process*)
(allow signal)

;; ------------------------------------------------------------
;; NETWORK ACCESS - Permissive (runner contacts many services)
;; Note: Network filtering is done at the proxy layer, not here
;; ------------------------------------------------------------
(allow network*)

;; ------------------------------------------------------------
;; MACH/IPC OPERATIONS - Permissive (required by system frameworks)
;; ------------------------------------------------------------
(allow mach*)
(allow ipc*)

;; ------------------------------------------------------------
;; SYSTEM OPERATIONS - Required by various tools
;; ------------------------------------------------------------
(allow sysctl*)
(allow iokit*)
(allow pseudo-tty)
(allow user-preference-read)
(allow user-preference-write
  (preference-domain "com.apple.dt.Xcode"))
`;
}

/** Log callback for sandbox events */
export type SandboxLogCallback = (level: 'debug' | 'error', message: string) => void;

export interface SandboxOptions extends SpawnOptions {
  /** Proxy server port for network isolation (used by proxy layer, not sandbox profile) */
  proxyPort?: number;
  /** Log prefix for identifying this process (e.g., runner instance ID) */
  logPrefix?: string;
  /** Optional callback for logging sandbox events */
  onLog?: SandboxLogCallback;
}

/**
 * Spawn a sandboxed process. Only allows execution of trusted binaries
 * within the runner directory.
 *
 * On macOS: Uses sandbox-exec for OS-level filesystem and process isolation.
 * On other platforms: Uses path validation only (no OS-level sandbox).
 *
 * Network isolation is handled separately by the HTTP proxy allowlist.
 */
export function spawnSandboxed(
  executable: string,
  args: string[],
  options: SandboxOptions = {}
): ChildProcess {
  // Validate the executable path
  const validatedPath = validateExecutablePath(executable);

  // Determine and validate working directory
  let instanceDir: string;
  if (options.cwd && typeof options.cwd === 'string') {
    const cwdPath = path.isAbsolute(options.cwd)
      ? options.cwd
      : path.resolve(options.cwd);
    instanceDir = path.normalize(cwdPath);

    if (!instanceDir.startsWith(getRunnerBaseDir())) {
      throw new Error(
        `Security violation: Working directory outside sandbox: ${options.cwd}`
      );
    }
  } else {
    // Default to the directory containing the executable
    instanceDir = path.dirname(validatedPath);
  }

  // Extract custom options (don't pass to spawn)
  const { proxyPort, logPrefix, onLog, ...spawnOptions } = options;

  // Create a prefixed logger - only logs if onLog callback is provided
  const prefix = logPrefix ? `[${logPrefix}] ` : '';
  const log = {
    debug: (msg: string) => onLog?.('debug', `${prefix}${msg}`),
    error: (msg: string) => onLog?.('error', `${prefix}${msg}`),
  };

  // Use sandbox-exec for OS-level isolation on macOS
  if (process.platform === 'darwin') {
    const profile = generateSandboxProfile(instanceDir);

    // Write profile to temp file for debugging and to avoid shell escaping issues
    const profilePath = path.join(os.tmpdir(), `sandbox-profile-${Date.now()}.sb`);
    fs.writeFileSync(profilePath, profile, 'utf-8');
    log.debug(`Wrote sandbox profile to: ${profilePath}`);
    log.debug(`Spawning: sandbox-exec -f ${profilePath} ${validatedPath} ${args.join(' ')}`);
    log.debug(`Working directory: ${instanceDir}`);
    log.debug(`isAppSandboxed: ${isAppSandboxed()}`);

    // Spawn via sandbox-exec with profile file (avoids shell escaping issues)
    const child = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, validatedPath, ...args], {
      ...spawnOptions,
      shell: false,
    });

    // Clean up profile file when process exits successfully
    child.on('exit', (code, signal) => {
      log.debug(`sandbox-exec exited with code=${code}, signal=${signal}`);
      if (code === 0) {
        try {
          fs.unlinkSync(profilePath);
        } catch (unlinkErr) {
          log.debug(`Failed to cleanup sandbox profile: ${(unlinkErr as Error).message}`);
        }
      } else {
        // Keep profile file for debugging on error
        log.error(`Keeping sandbox profile for debugging: ${profilePath}`);
      }
    });

    child.on('error', (err) => {
      log.error(`sandbox-exec spawn error: ${err.message}`);
    });

    return child;
  }

  // On non-macOS platforms, spawn directly (path validation still applies)
  return spawn(validatedPath, args, {
    ...spawnOptions,
    shell: false,
  });
}
