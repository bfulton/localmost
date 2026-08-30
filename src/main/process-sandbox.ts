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
import * as crypto from 'crypto';
import * as fs from 'fs';
import {
  getAppDataDir,
  getConfigPath,
  getCliSocketPath,
  getRunnerDir,
  getUserDataDir,
  isAppSandboxed,
} from './paths';

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
/** The broker's port, mirrored from BrokerProxyService's default. */
export const DEFAULT_BROKER_PORT = 8787;

/**
 * Where the runner keeps downloaded toolchains, shared across jobs.
 * Mirrors RunnerDownloader.getToolCacheDir.
 */
function getToolCacheDirPath(): string {
  return path.join(getRunnerDir(), 'tool-cache');
}

function generateSandboxProfile(
  instanceDir: string,
  proxyPort?: number,
  brokerPort: number = DEFAULT_BROKER_PORT
): string {
  const escapedDir = instanceDir.replace(/"/g, '\\"');
  const homeDir = os.homedir().replace(/"/g, '\\"');
  const appDataDir = getRunnerBaseDir().replace(/"/g, '\\"');
  // The app's own control plane: approvals, settings and the CLI socket. A job
  // that can write these can approve its own policy, so it is carved out of
  // the app data directory rather than trusted to leave it alone.
  const toolCacheDir = getToolCacheDirPath().replace(/"/g, '\\"');
  const policiesDir = `${appDataDir}/policies`;
  const configFile = getConfigPath().replace(/"/g, '\\"');
  const runnerDir = getRunnerDir().replace(/"/g, '\\"');
  const userDataDir = getUserDataDir().replace(/"/g, '\\"');
  const cliSocket = getCliSocketPath().replace(/"/g, '\\"');
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

;; File ioctl for git file locking in sandbox directory
(allow file-ioctl
  (subpath "${escapedDir}"))

;; Tool cache only. The rest of the app data directory holds the approval
;; cache, settings and the CLI socket - a job that can write those can approve
;; its own policy, so it does not get the directory wholesale.
(allow file-write*
  (subpath "${toolCacheDir}"))

;; File ioctl for git file locking in the tool cache
(allow file-ioctl
  (subpath "${toolCacheDir}"))

;; Belt and braces: never writable, whatever else matches above.
(deny file-write*
  (subpath "${policiesDir}")
  (literal "${configFile}")
  (literal "${cliSocket}"))

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

;; READ ACCESS - the OS, the toolchains, and this job's own directories.
;; Reading everything meant a workflow could read ~/.ssh private keys, AWS
;; credentials and this app's own credential store, which is the opposite of
;; what the policy documentation promises. Listed rather than subtracted, so
;; adding a path is a deliberate act.
(allow file-read*
  ;; Directory nodes on the way down, so path traversal works. These are the
  ;; directories themselves, not their contents: .NET requires read on every
  ;; directory up the hierarchy to open anything beneath it.
  (literal "/")
  (literal "/Users")
  (literal "${homeDir}")
  (literal "${appDataDir}")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/usr/bin")
  (subpath "/usr/lib")
  (subpath "/usr/libexec")
  (subpath "/usr/sbin")
  (subpath "/usr/share")
  (subpath "/System")
  (subpath "/Library/Developer")
  (subpath "/Library/Preferences")
  (subpath "/Library/Frameworks")
  (subpath "/private/etc")
  (subpath "/private/var/db")
  (subpath "/private/var/select")
  (subpath "/private/var/folders")
  (subpath "/etc")
  (subpath "/var")
  (subpath "/tmp")
  (subpath "/private/tmp")
  (subpath "/Applications/Xcode.app")
  ;; Toolchains people actually build with
  (subpath "/opt/homebrew")
  (subpath "/usr/local")
  ;; This job's own workspace, the runner install and the shared tool cache
  (subpath "${escapedDir}")
  (subpath "${runnerDir}")
  (subpath "${toolCacheDir}")
  ;; Package manager caches, which are writable below and so must be readable
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
  (subpath "${homeDir}/Library/Caches")
  (literal "/dev/null")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal "/dev/dtracehelper")
  (literal "/dev/tty"))

;; Never readable, whatever a future path above might overlap: the secrets a
;; developer machine keeps and this app's own credential store.
(deny file-read*
  (subpath "${homeDir}/.ssh")
  (subpath "${homeDir}/.aws")
  (subpath "${homeDir}/.gnupg")
  (subpath "${homeDir}/.kube")
  (subpath "${homeDir}/.docker")
  (subpath "${homeDir}/.config")
  (subpath "${homeDir}/Library/Keychains")
  (subpath "${userDataDir}")
  (subpath "${policiesDir}")
  (literal "${configFile}")
  (literal "${homeDir}/.netrc")
  (literal "${homeDir}/.npmrc"))

;; Device files that need read/write access (git, many tools redirect to /dev/null)
(allow file-write*
  (literal "/dev/null")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal "/dev/tty")
  (literal "/dev/dtracehelper"))

;; Metadata (ls, stat) stays broad: tools walk paths they cannot open, and
;; existence is not the secret. The contents above remain denied.
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
;; Outbound traffic is confined to this instance's filtering proxy. The proxy
;; is what enforces the host policy; leaving raw sockets open made that policy
;; advisory, since a workflow could simply ignore HTTP_PROXY and connect out
;; directly. sandbox-exec cannot filter by hostname, which is why the proxy
;; exists - but it can make the proxy the only way out.
(deny network*)

;; Loopback is allowed: build and test suites routinely start a server and talk
;; to it, and nothing leaves the machine this way. Everything else must go
;; through the proxy, which is itself on loopback.
(allow network-outbound (remote ip "localhost:*"))
${proxyPort ? `(allow network-outbound (remote ip "localhost:${proxyPort}"))` : ';; No proxy port supplied: the proxy is unreachable'}

;; ...except this app's own control channels. The broker carries job payloads
;; including secrets, and the runner reaches it through the proxy rather than
;; directly, so a job has no reason to open it.
(deny network-outbound (remote ip "localhost:${brokerPort}"))

;; .NET asks the kernel about network availability over AF_SYSTEM before it
;; will open a connection; denying it surfaces as "Permission denied" on the
;; proxy connect rather than as anything about sockets.
(allow system-socket)

;; Local sockets stay available: system frameworks need them to function.
(allow network-outbound (remote unix-socket))
(deny network-outbound (literal "${cliSocket}"))

;; Binding a local port is how test servers and build tools talk to themselves,
;; and a unix socket is how many test suites do the same. Binding creates a
;; socket where the job can already write; connecting to this app's own socket
;; stays denied above.
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-bind (local unix-socket))

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
    const profile = generateSandboxProfile(instanceDir, proxyPort);

    // The profile is the thing that confines the job, so it must not live
    // anywhere a job can write. os.tmpdir() is granted to every sandbox, and
    // the name was predictable from the clock: a job could plant a symlink at
    // the next path and have the app write through it, or swap the profile
    // used by the next spawn. It goes in the app's own directory instead,
    // created exclusively so an existing entry is never followed.
    const profileDir = path.join(getRunnerDir(), 'sandbox-profiles');
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const profilePath = path.join(
      profileDir,
      `sandbox-profile-${crypto.randomBytes(16).toString('hex')}.sb`
    );
    fs.writeFileSync(profilePath, profile, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
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
