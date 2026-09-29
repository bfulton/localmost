/**
 * Process Sandbox - Controlled Process Execution (macOS only)
 *
 * This module provides controlled process execution by:
 * - Only allowing execution of known, trusted binaries
 * - Restricting execution to the app's data directory
 * - Using macOS sandbox-exec for OS-level process isolation
 * - Using Node.js native APIs instead of shell commands where possible
 */

import { spawn, execFileSync, ChildProcess, SpawnOptions } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { SandboxPolicyLevel } from '../shared/types';
import { expandPath, DEFAULT_BROKER_PORT } from '../shared/sandbox-profile';
import {
  getAppDataDir,
  getConfigPath,
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
 * The profile restricts file writes and reads to allowlists, confines network
 * access to this worker's own proxy and the loopback ports its policy
 * declares, and lets a job signal only its own processes. Process spawning and
 * IPC remain permissive because CI runners genuinely require them.
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
export { DEFAULT_BROKER_PORT };

/**
 * The per-user temp directory confstr hands out, once a lookup has answered.
 * A failed lookup is not remembered: it is tried again at the next spawn, so
 * one transient failure does not cost every later job its bare mktemp.
 */
let userTempDir: string | undefined;
/** Whether a failed lookup has been logged, so a lasting failure logs once. */
let userTempDirFailureLogged = false;

/**
 * Where macOS `mktemp` puts a file when it is given no template. It ignores
 * TMPDIR and asks confstr for the per-user temp directory instead, so pointing
 * TMPDIR into the sandbox does not move it. Only a /var/folders/<a>/<b>/T path
 * is accepted: the answer lands in a regex in the profile.
 */
function darwinUserTempDir(onLog?: SandboxLogCallback): string | undefined {
  if (userTempDir !== undefined) return userTempDir;
  let failure: string;
  try {
    const answer = String(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf-8' }))
      .trim()
      .replace(/\/+$/, '')
      .replace(/^\/private/, '');
    if (/^\/var\/folders\/[A-Za-z0-9_+-]+\/[A-Za-z0-9_+-]+\/T$/.test(answer)) {
      userTempDir = answer;
      return userTempDir;
    }
    failure = `unexpected answer ${JSON.stringify(answer)}`;
  } catch (err) {
    failure = (err as Error).message;
  }
  if (!userTempDirFailureLogged && onLog) {
    userTempDirFailureLogged = true;
    onLog('error', `Per-user temp directory lookup failed, so jobs cannot use mktemp without a template: ${failure}`);
  }
  return undefined;
}

/** What a repository's approved policy contributes to the sandbox profile. */
export interface SandboxFilesystemPolicy {
  /** The level the repository declared; strict when it declared none. */
  level: SandboxPolicyLevel;
  /** Paths the policy declares readable, beyond the floor. */
  read: string[];
  /** Paths the policy declares writable, beyond the workspace. */
  write: string[];
  /** Paths the policy denies, read and write, over every grant. */
  deny?: string[];
  /**
   * Loopback the job may connect to beyond its own proxy: every port, or
   * these ones. Absent means only the proxy.
   */
  loopback?: true | number[];
}

/** Everything the runner profile is built from. */
export interface RunnerProfileOptions {
  /** The instance directory this worker runs in. */
  instanceDir: string;
  /** The broker's port, denied to jobs because it carries job payloads. */
  brokerPort?: number;
  /** This worker's own egress proxy port, the one loopback port always open. */
  proxyPort?: number;
  /** Registration only: reach the network without going through a proxy. */
  allowDirectNetwork?: boolean;
  /** The repository's approved policy; strict with nothing declared by default. */
  filesystemPolicy?: SandboxFilesystemPolicy;
  /** The filtering docker socket the app serves this worker, if it has one. */
  dockerSocket?: string;
  /** This worker's target's tool cache, if it keeps one across jobs. */
  toolCacheDir?: string;
  /** This worker's target's package-manager cache; ignored under strict. */
  packageCacheDir?: string;
  /** Optional log sink for notes such as a policy path being ignored. */
  onLog?: SandboxLogCallback;
}

export function generateSandboxProfile({
  instanceDir,
  brokerPort = DEFAULT_BROKER_PORT,
  proxyPort,
  allowDirectNetwork = false,
  filesystemPolicy = { level: 'strict', read: [], write: [] },
  dockerSocket,
  toolCacheDir: toolCache,
  packageCacheDir: packageCache,
  onLog,
}: RunnerProfileOptions): string {
  // The worker's own docker socket, served by the app: every request on it is
  // checked against the repository policy before it reaches a daemon. Connect
  // and read, never write - the sandbox directory around it is writable, so
  // the socket is subtracted by name after that allow (seatbelt takes the last
  // matching rule) and the job cannot unlink it and bind its own in its place.
  // The daemon's socket is never granted: it lives under ~/.docker, which the
  // deny block keeps closed in full.
  const dockerRules = ((socket?: string): string => {
    if (!socket) return '';
    // Built from the sandbox directory and landing in a security DSL, so it
    // is escaped like every other path interpolated into this profile.
    const quoted = socket.replace(/"/g, '\\"');
    return [
      ';; This worker\'s filtering docker socket, served by the app. Every request',
      ';; is checked against the repository policy before it reaches a daemon.',
      `(allow network-outbound (literal "${quoted}"))`,
      `(allow file-read* (literal "${quoted}"))`,
      ';; Not writable, so the job cannot replace it with a socket of its own.',
      `(deny file-write* (literal "${quoted}"))`,
      '',
    ].join('\n');
  })(dockerSocket);

  const escapedDir = instanceDir.replace(/"/g, '\\"');
  const homeDir = os.homedir().replace(/"/g, '\\"');
  const appDataDir = getRunnerBaseDir().replace(/"/g, '\\"');
  // The app's own control plane: approvals and settings. Named for the read
  // denies below; for writes the whole app data directory is closed.
  const policiesDir = `${appDataDir}/policies`;
  const configFile = getConfigPath().replace(/"/g, '\\"');
  const runnerDir = getRunnerDir().replace(/"/g, '\\"');
  const userDataDir = getUserDataDir().replace(/"/g, '\\"');
  // Both spellings of the app's own data, once each: under the App Sandbox
  // they are the same directory.
  const appDirsDenied = [...new Set([appDataDir, userDataDir])]
    .map((dir) => `  (subpath "${dir}")`)
    .join('\n');

  // Toolchains and package-manager caches are a convenience for jobs, not
  // something the runner needs. Under strict a repository declares what it
  // wants; moderate and permissive can read them, which is the same split the
  // network allowlists already use. Read only: these trees hold directories on
  // the user's PATH and config their own tools load, so a job that could write
  // them could plant code the user later runs outside any sandbox. The job's
  // package managers write to its target's own directory instead.
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
  // Backslash first, then quote, so a policy path (validated to carry neither,
  // but escaped here as the backstop) cannot escape or close its DSL literal.
  const escapeForProfile = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const subpaths = (paths: string[]) =>
    paths
      .map((entry) => `  (subpath "${escapeForProfile(expandPath(entry))}")`)
      .join('\n');
  // A repository policy has no business reading or writing the app's own
  // directories - the runner's credentials, registrations, session tokens and
  // pid files, other workers' sandboxes, the logs, the job history, the
  // browser profile and the credential store. Drop any policy path that is
  // one of them, lies inside one, or contains one (a grant of ~ contains
  // ~/.localmost), so a declared read path cannot reopen a sibling sandbox
  // (which a profile deny cannot cover without also blocking the traversal
  // into this job's own sandbox) and a declared write path cannot reach the
  // app's bookkeeping. The write side is also denied in the profile as a
  // backstop.
  const runnerRoot = path.resolve(getRunnerDir());
  // seatbelt matches paths as the default APFS volume does, whatever their
  // case or Unicode normalization, so ~/.LOCALMOST grants what ~/.localmost
  // would. Both sides are folded before comparing; on a case-sensitive volume
  // that only drops more than it had to.
  const fold = (dir: string): string => path.resolve(dir).normalize('NFD').toLowerCase();
  // And it matches the real path, so a grant of /private/var/... reaches an
  // app directory configured through the /var symlink: each directory is
  // compared as configured and as it really is. One that does not exist yet
  // has no real path to reach.
  const realPath = (dir: string): string[] => {
    try {
      return [fs.realpathSync(dir)];
    } catch {
      return [];
    }
  };
  const appRoots = [getRunnerBaseDir(), getUserDataDir()]
    .flatMap((dir) => [dir, ...realPath(dir)])
    .map(fold);
  const within = (inner: string, outer: string): boolean =>
    inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
  const touchesAppDirs = (entry: string): boolean => {
    // Resolve `..` and `.` before comparing: a path like
    // "<x>/runner-parent/../runner/proxies" resolves inside the runner dir,
    // and seatbelt would canonicalize it, so the check must too.
    const resolved = fold(expandPath(entry));
    return appRoots.some((root) => within(resolved, root) || within(root, resolved));
  };
  const traversing = (entry: string): boolean => {
    // A ".." segment could climb out of the workspace into the runner
    // directory, and the profile resolves a relative one from the worker's
    // directory, not from wherever this process runs. Validation already
    // rejects these; this is the backstop.
    if (!expandPath(entry).split('/').includes('..')) return false;
    onLog?.('error', `Ignoring traversing policy path: ${entry}`);
    return true;
  };
  const outsideRunner = (entry: string): boolean => {
    if (traversing(entry)) return false;
    // A relative path is kept as written: seatbelt accepts a relative subpath
    // but never matches it against a real path, so it grants nothing and
    // cannot widen anything. Resolving it here would resolve it against this
    // process's directory instead - "/" for an app launched from the Finder,
    // which contains everything.
    if (!path.isAbsolute(expandPath(entry))) return true;
    if (touchesAppDirs(entry)) {
      onLog?.('error', `Ignoring policy path that reaches the app's own directories: ${entry}`);
      return false;
    }
    return true;
  };
  const policyReads = subpaths(filesystemPolicy.read.filter(outsideRunner));
  const policyWrites = subpaths(filesystemPolicy.write.filter(outsideRunner));
  // A deny only narrows, so none is dropped for what it covers: one over an
  // app directory stays, since dropping it, as a grant there is dropped,
  // would quietly widen what the approved policy says. (Frozen contract C2
  // says denies are filtered like grants; this is a deliberate departure, so
  // the own sandbox and caches are re-allowed after the denies instead.) For
  // the same reason a deny list that cannot be read stops the spawn rather
  // than being skipped. An absolute ".." is resolved, as seatbelt resolves the
  // path it guards; a relative entry never matches in seatbelt, so it is
  // dropped and said to have no effect.
  const declaredDenies = filesystemPolicy.deny ?? [];
  if (!Array.isArray(declaredDenies)) {
    throw new Error("The policy's deny list is not a list, so the job cannot be confined as approved");
  }
  const policyDenies = subpaths(declaredDenies.flatMap((entry: string) => {
    const expanded = expandPath(entry);
    if (path.isAbsolute(expanded)) return [path.resolve(expanded)];
    onLog?.('error', `Ignoring relative policy deny path, which would have no effect: ${entry}`);
    return [];
  }));

  // Loopback reaches every service on this machine, not just the job's own:
  // databases, a debugger listening on 9229, a browser's remote debugging on
  // 9222, local proxies. So a job gets this worker's own egress proxy, and
  // beyond it only what its repository's approved policy declares. seatbelt
  // takes a single port or "*", never a range. The ports are validated where
  // the policy is parsed; this drops anything else as the backstop, since the
  // value lands in the profile. Dropping narrows, so it is safe here.
  const isPort = (port: unknown): port is number =>
    typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
  const loopbackRule = (port: number | '*') => `(allow network-outbound (remote ip "localhost:${port}"))`;
  const loopbackRules = ((): string => {
    const declared: unknown = filesystemPolicy.loopback;
    if (declared === true) {
      return [';; The repository declares all of loopback.', loopbackRule('*')].join('\n');
    }
    if (declared !== undefined && !Array.isArray(declared)) {
      onLog?.('error', `Ignoring a loopback declaration that is neither true nor a list of ports: ${JSON.stringify(declared)}`);
    }
    const listed: unknown[] = Array.isArray(declared) ? declared : [];
    if (!isPort(proxyPort)) {
      if (allowDirectNetwork) return ';; Registration: no proxy, and direct network below';
      // Nothing to confine the job to, so it gets nothing: a worker that
      // cannot reach its proxy fails, one that could reach all of loopback
      // would not.
      onLog?.('error', 'No egress proxy port for this worker, so its job can reach nothing on loopback');
      return ';; No proxy port known: nothing on loopback is reachable';
    }
    const notPorts = listed.filter((port) => !isPort(port));
    if (notPorts.length) onLog?.('error', `Ignoring loopback entries that are not ports: ${notPorts.join(', ')}`);
    const ports = [...new Set(listed.filter(isPort))].filter((port) => port !== proxyPort);
    return [
      ';; This worker\'s own egress proxy.',
      loopbackRule(proxyPort),
      ...(ports.length ? [';; Ports the repository declares.', ...ports.map(loopbackRule)] : []),
    ].join('\n');
  })();
  const toolchainRules = subpaths(toolchainPaths);
  // `mktemp` with no template creates tmp.XXXXXXXXXX in the per-user temp
  // directory whatever TMPDIR says, and scripts call it that way constantly.
  // That directory is shared with every process the user runs - the xcrun
  // cache that their own clang trusts lives there - so it is not granted.
  // Names of exactly the shape mktemp generates are: ten random characters no
  // other process can guess, and without read on the directory itself a job
  // cannot list it to find one. Both spellings, as /var is a symlink.
  const mktempRules = ((dir?: string): string => {
    if (!dir) return ';; Per-user temp directory unknown: mktemp without a template is not granted';
    const escapeForRegex = (value: string) => value.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&');
    const generated = `/tmp\\.${'[A-Za-z0-9]'.repeat(10)}(/|$)`;
    return [
      '(allow file-write* file-read*',
      `  (regex #"^${escapeForRegex(`/private${dir}`)}${generated}")`,
      `  (regex #"^${escapeForRegex(dir)}${generated}"))`,
    ].join('\n');
  })(darwinUserTempDir(onLog));
  // This worker's target's own caches, when it keeps any across jobs. Never
  // one shared with another target: what a job leaves in a cache, the next
  // job to find it executes. The directories above them are readable as
  // nodes only (.NET reads every ancestor of what it opens), so another
  // target's caches are not opened along the way. The package cache is a
  // moderate and permissive convenience; strict keeps what it declares.
  const ownCaches = [toolCache, filesystemPolicy.level === 'strict' ? undefined : packageCache]
    .filter((dir): dir is string => Boolean(dir));
  const ownCacheRules = (operation: string) =>
    ownCaches.length
      ? `(allow ${operation}\n${ownCaches.map((dir) => `  (subpath "${dir.replace(/"/g, '\\"')}")`).join('\n')})`
      : `;; No cache kept across jobs: nothing outside the sandbox for ${operation}`;
  const ownCacheNodes = [...new Set(ownCaches.flatMap((dir) => {
    const nodes: string[] = [];
    for (let node = path.dirname(dir); node.startsWith(runnerRoot + path.sep); node = path.dirname(node)) {
      nodes.push(node);
    }
    return nodes;
  }))];
  const ownCacheReads = [
    ...ownCacheNodes.map((node) => `  (literal "${node.replace(/"/g, '\\"')}")`),
    ...ownCaches.map((dir) => `  (subpath "${dir.replace(/"/g, '\\"')}")`),
  ].join('\n');

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

;; This target's own caches only. The rest of the app data directory holds the
;; approval cache, settings and the CLI socket - a job that can write those can
;; approve its own policy - and every other target's caches, which a job that
;; could write would poison for that target's next job.
${ownCacheRules('file-write*')}

;; File ioctl for git file locking in those caches
${ownCacheRules('file-ioctl')}

;; No shared temp directory. /tmp and the per-user /var/folders tree belong to
;; every process the user runs; the job's TMPDIR is in its own sandbox, and
;; the caches tools would otherwise keep there are pointed into it too.
;; Only what mktemp itself creates, by the name it generated:
${mktempRules}

;; No package-manager cache in the user's home. Under strict a repository
;; declares what it needs; moderate and permissive get their target's own
;; package cache above, with the package managers pointed at it.

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
  ;; The directory nodes on the way to this job's own sandbox. .NET reads each
  ;; ancestor directory to open anything beneath it. These are the nodes, not
  ;; their subtrees: sibling sandboxes and the credential directories below are
  ;; not granted, and the ones that hold secrets are denied by name below.
  (literal "${runnerDir}")
  (literal "${runnerDir}/sandbox")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/usr/bin")
  (subpath "/usr/lib")
  (subpath "/usr/libexec")
  (subpath "/usr/sbin")
  (subpath "/usr/share")
  (subpath "/System")
  (subpath "/Library/Developer")
  ;; OS frameworks installed outside /System: xcodebuild links one, and xcrun
  ;; runs it to find a tool whenever its cache does not already know the way.
  (subpath "/Library/Apple")
  (subpath "/Library/Preferences")
  (subpath "/Library/Frameworks")
  (subpath "/private/etc")
  ;; Only the parts of /private/var the toolchain reads (the xcode-select
  ;; link, the shell selection). Not the rest: it holds logs, other
  ;; processes' state and the per-user temp and cache directories.
  (subpath "/private/var/db")
  (subpath "/private/var/select")
  (subpath "/etc")
  ;; This job's own workspace and its target's own caches. Not the runner
  ;; directory as a whole: it holds every target's proxy credentials, every
  ;; instance's registration, the broker's session tokens, the other workers'
  ;; sandboxes and the other targets' caches. The job's own sandbox already
  ;; carries the runner it runs, so it needs nothing else from there.
  (subpath "${escapedDir}")
${ownCacheReads}
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
  ;; The runner directory's own secrets, denied by name so that neither a
  ;; toolchain grant nor a policy-declared read path can reopen them. Sibling
  ;; sandboxes are not granted in the first place (reads reach this job's own
  ;; sandbox by subpath and the parent nodes by literal, never the sandbox
  ;; root as a subtree), so no read-deny on the sandbox root is needed here.
  (subpath "${runnerDir}/proxies")
  (subpath "${runnerDir}/config")
  (subpath "${runnerDir}/sandbox-profiles")
  (literal "${runnerDir}/broker-sessions.json")
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

;; Paths the repository's approved policy denies, read and write. After every
;; grant above - the policy's own and the toolchains a level brings - so the
;; deny is what matches last.
${policyDenies ? `(deny file-read* file-write*\n${policyDenies})` : ';; No policy-declared deny paths'}

;; Never writable, whatever matched above - including a policy-declared write
;; path, since this is the last word: the app's own data directory and
;; Electron's. They hold the app's control plane (a job that writes it
;; approves its own policy), the runner's secrets and bookkeeping (proxy
;; credentials, registrations, session tokens, the pid files the startup sweep
;; trusts, other workers' sandboxes), the runner template every worker is
;; copied from with the record it is checked against, the logs, the job
;; history, the CLI the user runs and the credential store. Denied whole, so
;; nothing added there later is writable by default, and the directories'
;; own nodes with them so neither can be renamed away and replaced.
(deny file-write*
${appDirsDenied})
;; The places a job does write in there, re-allowed after both denies: its
;; target's own caches and its own sandbox, which a policy deny covering them
;; would only stop the runner from using.
${ownCacheRules('file-read* file-write*')}
(allow file-read* file-write*
  (subpath "${escapedDir}"))
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
;; Signals only to processes in this sandbox: the job's own children and its
;; own process group, which inherit it. Not the app, another worker's job or
;; anything else the user runs, which a bare (allow signal) let it kill.
(allow signal (target same-sandbox))

;; ------------------------------------------------------------
;; NETWORK ACCESS - Through this worker's proxy (runner contacts many services)
;; Hostname filtering is done at the proxy layer - sandbox-exec cannot express
;; it - so the sandbox's job is to make the proxy the only way out.
;; ------------------------------------------------------------
;; Outbound traffic is confined to this instance's filtering proxy. The proxy
;; is what enforces the host policy; leaving raw sockets open made that policy
;; advisory, since a workflow could simply ignore HTTP_PROXY and connect out
;; directly. sandbox-exec cannot filter by hostname, which is why the proxy
;; exists - but it can make the proxy the only way out.
(deny network*)

;; Loopback is not open as a whole. It reaches every service on this machine,
;; not only the job's own: databases, debuggers (node --inspect on 9229), a
;; browser's remote debugging (9222), local proxies. The job reaches this
;; worker's own proxy, and the loopback ports its repository's approved policy
;; declares - all of them if it declares true, for test suites that bind
;; ephemeral ports and talk to themselves. This confines direct connections
;; only: what the proxy forwards to a literal loopback address is the proxy's
;; to decide.
${loopbackRules}
${allowDirectNetwork ? ';; Runner registration talks to GitHub directly: app-driven, no workflow\n;; code involved, and there is no instance proxy at configuration time.\n(allow network-outbound)' : ''}

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
  ;; Sockets the job itself created, in its own sandbox. The job's TMPDIR is
  ;; set there too, so a test suite that binds a socket under TMPDIR lands
  ;; here. The shared temp directories are deliberately absent: a unix socket
  ;; under them belongs to one of the user's own processes - an editor, a
  ;; daemon, an agent - and connecting to it reaches outside the sandbox.
  (subpath "${escapedDir}"))

;; Binding a local port is how test servers and build tools talk to themselves,
;; and a unix socket is how many test suites do the same. Binding creates a
;; socket where the job can already write; connecting to this app's own socket
;; stays denied above.
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
;; Test suites bind unix sockets in the workspace; the job's TMPDIR is in the
;; sandbox, so a socket bound under TMPDIR is here too. Scoped to the sandbox,
;; where the job can already write, and not to the shared temp directories the
;; user's own processes keep their sockets in.
(allow network-bind
  (subpath "${escapedDir}"))

;; The broker's port, whatever loopback allows above, so this is the last
;; network rule. It carries job payloads including secrets; the runner reaches
;; it through the proxy, where the per-worker session key is what guards it,
;; so a job has no reason to open it directly.
(deny network-outbound (remote ip "localhost:${brokerPort}"))

;; ------------------------------------------------------------
;; MACH/IPC OPERATIONS - Permissive (required by system frameworks)
;; ------------------------------------------------------------
(allow mach*)
;; ...except the pasteboard. A job has no reason to read what the user copied,
;; and the clipboard routinely holds passwords and tokens. Denied by name after
;; the blanket allow, which every system framework still needs.
(deny mach-lookup
  (global-name "com.apple.pasteboard.1")
  (global-name "com.apple.pbs.fetch_services"))
;; ...and this app's own MachPortRendezvousServer, through which Chromium hands
;; the app's helper processes their ports. Named by this process's pid, which
;; no other process holds while the app runs, rather than by bundle id: a
;; development build runs as Electron's bundle, and a signed one may carry a
;; team prefix. Other processes' servers - a browser the job's tests drive -
;; stay reachable.
(deny mach-lookup (global-name-regex #"\\.MachPortRendezvousServer\\.${process.pid}$"))
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
   * This worker's own egress proxy port: the loopback port its job can always
   * reach. Absent means none on loopback at all, unless the policy declares
   * all of it.
   */
  proxyPort?: number;
  /**
   * The repository's approved policy, which decides how much filesystem the
   * job gets, what it denies, and which loopback ports it opens. Absent means
   * strict with nothing declared.
   */
  filesystemPolicy?: SandboxFilesystemPolicy;
  /**
   * The filtering docker socket the app serves this worker. The job connects
   * to it and nothing else; the daemon's own socket stays denied.
   */
  dockerSocket?: string;
  /**
   * The worker's target's own tool cache, kept across that target's jobs.
   * Absent means none: the runner keeps its tools in the job's work directory.
   */
  toolCacheDir?: string;
  /**
   * The worker's target's own package-manager cache, which the job's package
   * managers are pointed at under moderate and permissive. Not granted under
   * strict, whatever is passed.
   */
  packageCacheDir?: string;
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
    proxyPort,
    filesystemPolicy,
    dockerSocket,
    toolCacheDir,
    packageCacheDir,
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
      proxyPort,
      allowDirectNetwork,
      filesystemPolicy,
      dockerSocket,
      toolCacheDir,
      packageCacheDir,
      onLog,
    });

    // The profile is the thing that confines the job, so it must not live
    // anywhere a job can write. It used to go in os.tmpdir(), which every
    // sandbox could then write, under a name predictable from the clock: a job
    // could plant a symlink at the next path and have the app write through
    // it, or swap the profile used by the next spawn. It goes in the app's own
    // directory instead, created exclusively so an existing entry is never
    // followed.
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
