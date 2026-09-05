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
import { SandboxPolicyLevel } from '../shared/types';
import type { DockerGrants } from '../shared/docker-access';
import { expandPath } from '../shared/sandbox-profile';
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

/** What a repository's approved policy contributes to the sandbox profile. */
export interface SandboxFilesystemPolicy {
  /** The level the repository declared; strict when it declared none. */
  level: SandboxPolicyLevel;
  /** Paths the policy declares readable, beyond the floor. */
  read: string[];
  /** Paths the policy declares writable, beyond the workspace. */
  write: string[];
}

/** Everything the runner profile is built from. */
interface RunnerProfileOptions {
  /** The instance directory this worker runs in. */
  instanceDir: string;
  /** The broker's port, denied to jobs because it carries job payloads. */
  brokerPort?: number;
  /** Registration only: reach the network without going through a proxy. */
  allowDirectNetwork?: boolean;
  /** The repository's approved policy; strict with nothing declared by default. */
  filesystemPolicy?: SandboxFilesystemPolicy;
  /** What the repository's declared docker level opens; empty when off. */
  dockerGrants?: DockerGrants;
}

function generateSandboxProfile({
  instanceDir,
  brokerPort = DEFAULT_BROKER_PORT,
  allowDirectNetwork = false,
  filesystemPolicy = { level: 'strict', read: [], write: [] },
  dockerGrants,
}: RunnerProfileOptions): string {
  // Docker access, if the repository declared and had a level approved.
  //
  // These come after the deny block below on purpose: the Docker Desktop socket
  // lives inside ~/.docker, which is denied wholesale, and seatbelt takes the
  // last matching rule. Each grant is a single literal, never the directory.
  const dockerRules = ((grants?: DockerGrants): string => {
    if (!grants) return '';
    const lines: string[] = [];

    // These paths reach us from the operator's DOCKER_HOST or home directory,
    // and land in a security DSL, so they are escaped like every other path
    // interpolated into this profile.
    const quote = (value: string): string => value.replace(/"/g, '\\"');

    for (const socket of grants.socketLiterals) {
      lines.push(`(allow network-outbound (literal "${quote(socket)}"))`);
      lines.push(`(allow file-read* (literal "${quote(socket)}"))`);
      lines.push(`(allow file-write* (literal "${quote(socket)}"))`);
    }
    for (const file of grants.readLiterals) {
      lines.push(`(allow file-read* (literal "${quote(file)}"))`);
    }
    for (const dir of grants.readSubpaths) {
      lines.push(`(allow file-read* (subpath "${quote(dir)}"))`);
    }

    if (lines.length === 0) return '';
    return [
      ';; Docker access, declared by the repository policy and approved. A job',
      ';; that can reach the daemon can bind-mount host paths into a container,',
      ';; which this profile cannot constrain. See docs/roadmap/docker-access.md.',
      ...lines,
      '',
    ].join('\n');
  })(dockerGrants);

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

  // Toolchains and package-manager caches are a convenience for jobs, not
  // something the runner needs. Under strict a repository declares what it
  // wants; moderate and permissive keep them, which is the same split the
  // network allowlists already use.
  const toolchainPaths =
    filesystemPolicy.level === 'strict'
      ? []
      : [
          '/opt/homebrew',
          '/usr/local',
          '/Applications/Xcode.app',
          '/Library/Developer',
          `${homeDir}/.npm`,
          `${homeDir}/.yarn`,
          `${homeDir}/.pnpm-store`,
          `${homeDir}/.cache`,
          `${homeDir}/.cargo`,
          `${homeDir}/.rustup`,
          `${homeDir}/.gradle`,
          `${homeDir}/.m2`,
          `${homeDir}/.nuget`,
          `${homeDir}/.dotnet`,
          `${homeDir}/.local`,
          `${homeDir}/go`,
          `${homeDir}/Library/Caches`,
        ];
  // Policies are written with ~ for the user's home, the same as the CLI path
  // expands. Without this a declared "~/.npm" would name a directory called ~.
  const subpaths = (paths: string[]) =>
    paths
      .map((entry) => `  (subpath "${expandPath(entry).replace(/"/g, '\\"')}")`)
      .join('\n');
  const policyReads = subpaths(filesystemPolicy.read);
  const policyWrites = subpaths(filesystemPolicy.write);
  const toolchainRules = subpaths(toolchainPaths);
  const cacheWritePaths =
    filesystemPolicy.level === 'strict'
      ? []
      : toolchainPaths.filter((entry) => entry.startsWith(homeDir));
  const cacheWriteRules = cacheWritePaths.length
    ? `(allow file-write*\n${subpaths(cacheWritePaths)})`
    : ';; strict: caches are not writable unless the policy declares them';
  const tmpDir = os.tmpdir().replace(/"/g, '\\"');

  return `
(version 1)
(deny default)

;; Trace denied operations to stderr (useful for debugging sandbox issues)
(trace "/dev/stderr")

;; ============================================================
;; LOCALMOST RUNNER SANDBOX PROFILE
;; Reads and writes are allowlists, outbound network is confined to this
;; instance's filtering proxy, and the app's own control plane is denied.
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

;; Package-manager caches. Under strict a repository declares the ones it
;; needs; moderate and permissive keep them, matching the read side.
${cacheWriteRules}

;; Paths the repository's approved policy declares writable.
${policyWrites ? `(allow file-write*\n${policyWrites})` : ';; No policy-declared write paths'}

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
  ;; This job's own workspace, the runner install and the shared tool cache
  (subpath "${escapedDir}")
  (subpath "${runnerDir}")
  (subpath "${toolCacheDir}")
${toolchainRules}
${policyReads}
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
  (literal "${homeDir}/.npmrc")
  ;; Credentials that live inside the package-manager caches granted above.
  ;; The cache directories have to be readable for builds to work, so the
  ;; secret files within them are subtracted by name.
  (literal "${homeDir}/.m2/settings.xml")
  (literal "${homeDir}/.m2/settings-security.xml")
  (literal "${homeDir}/.gradle/gradle.properties")
  (literal "${homeDir}/.cargo/credentials")
  (literal "${homeDir}/.cargo/credentials.toml")
  (literal "${homeDir}/.nuget/NuGet/NuGet.Config"))
${dockerRules}

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
;; Hostname filtering is done at the proxy layer - sandbox-exec cannot express
;; it - so the sandbox's job is to make the proxy the only way out.
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
${allowDirectNetwork ? ';; Runner registration talks to GitHub directly: app-driven, no workflow\n;; code involved, and there is no instance proxy at configuration time.\n(allow network-outbound)' : ''}

;; ...except this app's own control channels. The broker carries job payloads
;; including secrets, and the runner reaches it through the proxy rather than
;; directly, so a job has no reason to open it.
(deny network-outbound (remote ip "localhost:${brokerPort}"))

;; .NET asks the kernel about network availability over AF_SYSTEM before it
;; will open a connection; denying it surfaces as "Permission denied" on the
;; proxy connect rather than as anything about sockets.
(allow system-socket)

;; Only the system sockets the runtime needs, named rather than granted as a
;; class: connecting to any unix socket reaches privileged system services and
;; is broader than anything else in this profile.
(allow network-outbound
  ;; The system sockets the runtime needs, named rather than granted as a
  ;; class: reaching any unix socket would reach privileged system services.
  (literal "/private/var/run/mDNSResponder")
  (literal "/var/run/mDNSResponder")
  (literal "/private/var/run/syslog")
  (literal "/var/run/syslog")
  ;; Sockets the job itself created. Test suites bind one and connect to it,
  ;; so this is scoped to the same directories binding is.
  (subpath "${escapedDir}")
  (subpath "${tmpDir}")
  (subpath "/tmp")
  (subpath "/private/tmp")
  (subpath "/private/var/folders"))

;; Binding a local port is how test servers and build tools talk to themselves,
;; and a unix socket is how many test suites do the same. Binding creates a
;; socket where the job can already write; connecting to this app's own socket
;; stays denied above.
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
;; Test suites bind unix sockets in the workspace and temp. Binding creates a
;; file where the job can already write, so it is scoped to those directories
;; rather than granted everywhere.
(allow network-bind
  (subpath "${escapedDir}")
  (subpath "${tmpDir}")
  (subpath "/tmp")
  (subpath "/private/tmp")
  (subpath "/private/var/folders"))

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
  /**
   * Let this process reach the network directly instead of only its proxy.
   *
   * For registering a runner with GitHub, which the app drives with the user's
   * own token and which runs no workflow code. Job execution never sets it:
   * that is exactly what the proxy confinement is for.
   */
  allowDirectNetwork?: boolean;
  /**
   * The repository's approved policy, which decides how much filesystem the
   * job gets. Absent means strict with nothing declared.
   */
  filesystemPolicy?: SandboxFilesystemPolicy;
  /**
   * What the repository's declared docker level opens. A job that can reach
   * the daemon is not confined by this profile: see docs/roadmap/docker-access.md.
   */
  dockerGrants?: DockerGrants;
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
  const {
    allowDirectNetwork,
    filesystemPolicy,
    dockerGrants,
    logPrefix,
    onLog,
    ...spawnOptions
  } = options;

  // Create a prefixed logger - only logs if onLog callback is provided
  const prefix = logPrefix ? `[${logPrefix}] ` : '';
  const log = {
    debug: (msg: string) => onLog?.('debug', `${prefix}${msg}`),
    error: (msg: string) => onLog?.('error', `${prefix}${msg}`),
  };

  // Use sandbox-exec for OS-level isolation on macOS
  if (process.platform === 'darwin') {
    const profile = generateSandboxProfile({
      instanceDir,
      allowDirectNetwork,
      filesystemPolicy,
      dockerGrants,
    });

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

    // Remove the profile whatever the exit was. These used to live in the
    // system temp directory, which the OS clears; they live in the app's own
    // directory now, so keeping them on failure would accumulate forever.
    // Set LOCALMOST_KEEP_SANDBOX_PROFILES to keep them for debugging.
    child.on('exit', (code, signal) => {
      log.debug(`sandbox-exec exited with code=${code}, signal=${signal}`);
      if (!process.env.LOCALMOST_KEEP_SANDBOX_PROFILES) {
        try {
          fs.unlinkSync(profilePath);
        } catch (unlinkErr) {
          log.debug(`Failed to cleanup sandbox profile: ${(unlinkErr as Error).message}`);
        }
      } else {
        log.debug(`Keeping sandbox profile for debugging: ${profilePath}`);
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
