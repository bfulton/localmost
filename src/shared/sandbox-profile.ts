/**
 * Sandbox Profile Generator
 *
 * Generates macOS sandbox-exec profiles based on .localmostrc policies.
 * Used for enforcing least-privilege sandbox in both CLI test mode and
 * background runner execution.
 */

import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { DockerPolicy } from './docker-policy';
import { getAppDataDirWithoutElectron, getCliSocketPath } from './paths';

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
  /** Container work, checked per request by the filtering socket - see docker-policy.ts. */
  docker?: DockerPolicy;
}

/**
 * A `network.loopback` grant: every loopback port, or a list of them.
 * Seatbelt matches one port or all of them, so there are no ranges.
 */
export type LoopbackGrant = true | number[];

export interface SandboxProfileOptions {
  /** Working directory for the workflow */
  workDir: string;
  /** Directories readable and never writable, such as a fetched action's code */
  readOnlyPaths?: string[];
  /** Port of the proxy server - network traffic is restricted to this port */
  proxyPort: number;
  /**
   * Loopback ports a step may connect to besides the proxy's: all of them
   * (true) or these. The checkout's shared network.loopback, once the user
   * has confirmed it; absent, loopback is the proxy only.
   */
  loopback?: LoopbackGrant;
  /** Policy to enforce */
  policy?: SandboxPolicy;
  /** Whether to run in permissive mode (log violations but don't block) */
  permissive?: boolean;
  /** Log file for sandbox violations */
  logFile?: string;
  /** The files that mark a process as running under this run's profiles; see processMarkerRules. */
  processMarker?: ProcessMarker;
}

/**
 * Two files, alike but for their random names, that a step's profile reads
 * one of and not the other.
 */
export interface ProcessMarker {
  granted: string;
  withheld: string;
}

/**
 * The last rules of a step's profile, and of a runner worker's: how the app
 * finds the job's processes when it ends, including one that left its
 * process group.
 *
 * A process can leave its group with setsid() and close every descriptor it
 * inherited, but it cannot leave its sandbox. So the profile carries a mark
 * the kernel will answer for: it reads one file and not its twin. No other
 * profile tells the two apart - one that reaches their directory reaches
 * both - and an unsandboxed process reads both. Last, so no policy rule can
 * change the answer.
 */
export function processMarkerRules(marker?: ProcessMarker): string[] {
  if (!marker) return [];
  return [
    ';; How the app finds this run\'s processes when the job ends, even one that',
    ';; has left its process group: this profile reads one file and not its twin',
    `(deny file-read* (literal "${escapePath(marker.withheld)}"))`,
    `(allow file-read* (literal "${escapePath(marker.granted)}"))`,
  ];
}

// =============================================================================
// Profile Generation
// =============================================================================

/**
 * Expand a leading ~ to the user's home directory.
 *
 * Only ~; wildcards in a pattern are handled where sandbox rules are built.
 * Shared with the runner profile so a policy path means the same thing on both
 * paths - a declared "~/.npm" must not become a directory called ~.
 */
export function expandPath(pattern: string): string {
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
  // Backslash first, then quote: a path reaching this DSL must neither escape
  // out of its string literal nor close it. Policy paths are validated to
  // carry neither (see validatePathArray), so this is the backstop for paths
  // from every other source.
  return pathStr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * A policy path with `*` in it, as the body of a seatbelt (regex ...) rule.
 *
 * `*` matches anything, as it always has here; everything else is literal.
 * This used to swap `*` for `.*` and leave the rest as regex syntax, so the
 * dot in "~/.npm" matched any character and a `+` or `(` in a path changed
 * what the rule meant. Anchored at both ends, since seatbelt searches rather
 * than matches. Escaped again for the string literal it lands in, where a
 * backslash is itself an escape.
 */
function globToProfileRegex(expanded: string): string {
  const literal = (part: string) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return escapePath(`^${expanded.split('*').map(literal).join('.*')}$`);
}

// Note: macOS sandbox-exec does NOT support hostname-based network filtering.
// The (remote ...) filter only supports IP addresses and ports, not domain names.
// Network filtering by hostname is handled by the proxy server, not the sandbox.

/**
 * The read paths a macOS workflow needs before it can run anything.
 *
 * Nothing grants these implicitly - a policy has to declare them, so that
 * reading a .localmostrc tells you everything a job may touch. They are
 * offered as the starting point for a new policy (`localmost policy init`),
 * and discovery records them like any other access.
 *
 * These are subpaths of the OS install, deliberately not their parents:
 * /usr would include /usr/local, and /Library would include
 * /Library/Application Support, both of which hold third-party software and
 * application data that a workflow has no reason to read.
 *
 * /etc, /var and /tmp are the symlink nodes into /private that those paths are
 * reached through. /usr/bin/git and /usr/bin/python3 are shims that execute
 * out of the active developer directory, hence Xcode.app.
 */
export const MACOS_BASELINE_READ_PATHS = [
  '/etc',
  '/var',
  '/tmp',
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/lib',
  '/usr/libexec',
  '/usr/sbin',
  '/usr/share',
  '/System',
  '/Library/Developer',
  '/Library/Preferences',
  '/private/etc',
  '/private/var/db',
  '/private/var/select',
  '/Applications/Xcode.app',
];

/**
 * The broker's port, BrokerProxyService's default. Defined here, where the CLI
 * can reach it, so the runner's profile and the test profiles deny the same one.
 */
export const DEFAULT_BROKER_PORT = 8787;

/**
 * The network rules both test-mode profiles share, mirroring the runner's.
 *
 * Hostname filtering happens in the proxy, since seatbelt cannot express it;
 * the sandbox's job is to make the proxy the only way out. `(local ip)` did
 * not do that: it names the local end of any IP socket, so as an outbound
 * filter it matched a connection to anywhere, and a step that ignored
 * HTTP_PROXY went straight past the allowlist.
 *
 * Loopback is the proxy's port and no other, unless the checkout's policy
 * grants more and the user has confirmed it: loopback is not only the step's
 * own test servers but everything else the machine runs there - a database,
 * a debugger port, another app's control port - none of which checks who is
 * calling. A test suite that starts a server and talks to it needs
 * `network.loopback: true` in its shared policy, or the fixed ports it uses.
 * The app's broker, which carries job payloads, is denied last whatever is
 * granted, as seatbelt takes the last matching rule.
 *
 * Only whole port numbers from the grant reach the profile; anything else in
 * it is dropped, never read as every port.
 */
function loopbackNetworkRules(proxyPort: number, escapedWorkDir: string, loopback?: LoopbackGrant): string[] {
  const isPort = (port: unknown): port is number =>
    typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
  const granted =
    loopback === true ? ['*'] : Array.isArray(loopback) ? [...new Set(loopback.filter(isPort))].map(String) : [];
  return [
    `;; Network: loopback only; the proxy at port ${proxyPort} is the way out`,
    '(deny network*)',
    ...(isPort(proxyPort) ? [`(allow network-outbound (remote ip "localhost:${proxyPort}"))`] : []),
    ...(granted.length > 0 ? [';; Loopback the policy grants beyond the proxy'] : []),
    ...granted.map((port) => `(allow network-outbound (remote ip "localhost:${port}"))`),
    `(deny network-outbound (remote ip "localhost:${DEFAULT_BROKER_PORT}"))`,
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    ';; Unix sockets: only in the working directory, never a system socket like',
    ';; Docker\'s or the SSH agent\'s. TMPDIR points there so tools create them there.',
    `(allow network-bind (subpath "${escapedWorkDir}"))`,
    `(allow network-outbound (subpath "${escapedWorkDir}"))`,
  ];
}

/**
 * Which processes a step may signal: those under its own sandbox.
 *
 * An unfiltered (allow signal) let a step stop or kill any process of the
 * user's - the app, a runner, an editor with unsaved work. Each step runs
 * under a sandbox of its own, so this also means a step cannot signal a
 * server an earlier step left running; the job's end reaps that instead
 * (see reapStepProcesses).
 */
function signalRules(): string[] {
  return ['(allow signal (target same-sandbox))'];
}

/**
 * The per-user temp directory confstr hands out, once a lookup has answered.
 * A failed lookup is tried again at the next profile.
 */
let userTempDir: string | undefined;

/**
 * Where macOS `mktemp` puts a file when it is given no template. It ignores
 * TMPDIR and asks confstr for the per-user temp directory instead, so pointing
 * TMPDIR into the workspace does not move it. Only a /var/folders/<a>/<b>/T
 * path is accepted: the answer lands in a regex in the profile.
 */
function darwinUserTempDir(): string | undefined {
  if (userTempDir !== undefined) return userTempDir;
  try {
    const answer = String(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf-8' }))
      .trim()
      .replace(/\/+$/, '')
      .replace(/^\/private/, '');
    if (/^\/var\/folders\/[A-Za-z0-9_+-]+\/[A-Za-z0-9_+-]+\/T$/.test(answer)) userTempDir = answer;
  } catch {
    // Left unset: bare mktemp is not granted this time.
  }
  return userTempDir;
}

/**
 * What a step gets of the shared temp directories, as the runner's job does:
 * only the entries a bare `mktemp` creates.
 *
 * /tmp and the per-user /var/folders tree belong to every process the user
 * runs, and some of what lives there is trusted by their own tools - the
 * xcrun lookup cache, the clang module cache. A step's TMPDIR is in its
 * workspace, and the caches tools would otherwise keep there are pointed into
 * it too (see buildStepEnvironment). But mktemp with no template ignores
 * TMPDIR, and scripts call it that way constantly, so names of exactly the
 * shape it generates are granted: ten random characters no other process can
 * guess, and without read on the directory itself a step cannot list it to
 * find one. Both spellings, as /var is a symlink.
 */
function sharedTempRules(): string[] {
  const dir = darwinUserTempDir();
  if (!dir) return [';; Per-user temp directory unknown: mktemp without a template is not granted'];
  const escapeForRegex = (value: string) => value.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&');
  const generated = `/tmp\\.${'[A-Za-z0-9]'.repeat(10)}(/|$)`;
  return [
    ';; No shared temp directory; only what mktemp itself creates, by the name it generated',
    '(allow file-write* file-read*',
    `  (regex #"^${escapeForRegex(`/private${dir}`)}${generated}")`,
    `  (regex #"^${escapeForRegex(dir)}${generated}"))`,
  ];
}

/**
 * The app data directory this process uses, and the installed app's own.
 *
 * LOCALMOST_CONFIG_DIR and the App Sandbox container move the first, but the
 * app keeps its runner template, approvals and socket in ~/.localmost whatever
 * this process was started with, so that is denied either way.
 */
function appDataDirs(): string[] {
  return [...new Set([getAppDataDirWithoutElectron(), path.join(os.homedir(), '.localmost')])];
}

/** Denies for the CLI sockets: this process's, and the installed app's. */
function cliSocketRules(): string[] {
  const name = path.basename(getCliSocketPath());
  return appDataDirs().map((dir) => `(deny network-outbound (literal "${escapePath(path.join(dir, name))}"))`);
}

/**
 * What a step never reaches, whatever the policy declares, then the workspace.
 *
 * The app data directory holds the runner template every worker's sandbox is
 * copied from, the approval cache, settings, the CLI socket and other runs'
 * workspaces; the Electron user data directory holds the credential store. A
 * test run that could write the template would reach every later real job,
 * and one that could write the approvals would approve its own policy. The
 * developer's own credentials are the same list the runner denies a job at
 * every level: a policy can never grant them there, so it cannot here either.
 *
 * A checkout's .localmostrc is applied in test mode without approval, so this
 * comes after every policy grant: seatbelt takes the last matching rule. The
 * workspace lives under the app data directory, so it is reopened last.
 */
function neverReachablePaths(): { subpaths: string[]; literals: string[] } {
  const home = os.homedir();
  return {
    subpaths: [
      ...appDataDirs(),
      path.join(home, 'Library', 'Application Support', 'localmost'),
      `${home}/.ssh`,
      `${home}/.aws`,
      `${home}/.gnupg`,
      `${home}/.kube`,
      `${home}/.docker`,
      `${home}/.config`,
      `${home}/Library/Keychains`,
    ],
    literals: [
      `${home}/.netrc`,
      `${home}/.npmrc`,
      `${home}/.m2/settings.xml`,
      `${home}/.m2/settings-security.xml`,
      `${home}/.gradle/gradle.properties`,
      `${home}/.cargo/credentials`,
      `${home}/.cargo/credentials.toml`,
      `${home}/.nuget/NuGet/NuGet.Config`,
    ],
  };
}

/** Whether a path is one no policy can grant, so discovery never suggests it. */
function isNeverReachable(p: string): boolean {
  const { subpaths, literals } = neverReachablePaths();
  return literals.includes(p) || subpaths.some((root) => p === root || p.startsWith(`${root}/`));
}

function neverReachableRules(escapedWorkDir: string, readOnlyPaths: string[] = []): string[] {
  const { subpaths, literals } = neverReachablePaths();
  const entries = [
    ...subpaths.map((p) => `  (subpath "${escapePath(p)}")`),
    ...literals.map((p) => `  (literal "${escapePath(p)}")`),
  ];
  entries[entries.length - 1] += ')';
  return [
    ';; Never reachable, whatever a policy declares above: the app\'s own data',
    ';; and the credentials a developer machine keeps',
    '(deny file-read* file-write*',
    ...entries,
    ';; ...except this run\'s workspace, which lives inside the app data directory',
    '(allow file-read* file-write*',
    `  (subpath "${escapedWorkDir}"))`,
    ';; ...but not the workspace directory itself: the app writes into it',
    ';; unsandboxed, and a step that could remove it could leave a link there',
    `(deny file-write* (literal "${escapedWorkDir}"))`,
    ...(readOnlyPaths.length > 0
      ? [
          ';; ...and the code of the actions this step runs, read-only: a fetched',
          ';; action is cached in the app data directory for every run',
          '(allow file-read*',
          ...readOnlyPaths.map((p, i) => `  (subpath "${escapePath(p)}")${i === readOnlyPaths.length - 1 ? ')' : ''}`),
        ]
      : []),
  ];
}

/**
 * Generate a macOS sandbox-exec profile from a policy.
 */
export function generateSandboxProfile(options: SandboxProfileOptions): string {
  const { workDir, policy, permissive = false, logFile } = options;
  const escapedWorkDir = escapePath(workDir);

  const modeDescription = permissive
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
  // process with SIGABRT before it runs. This is the one thing granted without
  // being declared, and it is not an access grant: it permits reading the root
  // directory entry so that absolute paths resolve. It is a literal, never a
  // subpath - (subpath "/") would grant the entire disk.
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

  // Policy-defined read paths (system paths, user caches, etc.)
  if (policy?.filesystem?.read && policy.filesystem.read.length > 0) {
    lines.push(';; Policy-defined read access');
    lines.push('(allow file-read*');
    for (const pattern of policy.filesystem.read) {
      const expanded = expandPath(pattern);
      if (expanded === '/') {
        // Declaring "/" means the root node, which is already granted. Writing
        // it as a subpath would silently hand over the whole disk.
        continue;
      }
      if (expanded.includes('**')) {
        const base = expanded.replace('/**', '').replace('**/', '');
        lines.push(`  (subpath "${escapePath(base)}")`);
      } else if (expanded.includes('*')) {
        lines.push(`  (regex "${globToProfileRegex(expanded)}")`);
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

  lines.push(...sharedTempRules());
  lines.push('');

  // No home directory cache is granted unless the policy declares it. Steps
  // run with HOME inside the workspace, so these only ever served tools that
  // bypass it - and each was a store the user's own builds later execute
  // from (~/.cargo/bin, ~/.local/bin, Gradle init scripts, Maven settings),
  // handed to any checkout that carried a .localmostrc.

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
        lines.push(`  (regex "${globToProfileRegex(expanded)}")`);
      } else {
        lines.push(`  (subpath "${escapePath(expanded)}")`);
      }
    }
    lines.push(')');
    lines.push('');
  }

  lines.push(...neverReachableRules(escapedWorkDir, options.readOnlyPaths));
  lines.push('');

  // Policy-defined denies, after the workspace is reopened above so a deny
  // the policy names inside the workspace still holds. A deny only ever
  // narrows, so it can come last.
  if (policy?.filesystem?.deny) {
    lines.push(';; Policy-defined filesystem deny');
    for (const pattern of policy.filesystem.deny) {
      const expanded = expandPath(pattern);
      if (expanded.includes('*')) {
        const regex = globToProfileRegex(expanded);
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

  lines.push(...loopbackNetworkRules(options.proxyPort, escapedWorkDir, options.loopback));
  lines.push(...cliSocketRules());
  lines.push('');

  // No daemon socket is opened here. A docker policy is a set of requests the
  // filtering socket may forward, not a level that unlocks the daemon, and
  // handing the daemon over would let a container reach every host path the
  // profile denies. The runner serves that socket per worker; the test-mode
  // profile does not yet, so a job under localmost test runs without Docker.

  // ------------------------------------------------------------
  // PROCESS OPERATIONS
  // ------------------------------------------------------------
  lines.push(';; ------------------------------------------------------------');
  lines.push(';; PROCESS OPERATIONS - Permissive (runner spawns build tools)');
  lines.push(';; ------------------------------------------------------------');
  lines.push('(allow process*)');
  lines.push(...signalRules());
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

  lines.push(...processMarkerRules(options.processMarker));

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
  readOnlyPaths?: string[];
  proxyPort: number;
  logFile: string;  // Not used - reports go to system log, not a file
  processMarker?: ProcessMarker;
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
    ';; FILE ACCESS - Reads everywhere and workspace writes, reported',
    ';; ------------------------------------------------------------',
    ';; Discovery has to see what a workflow reads, so reads are allowed and',
    ';; reported. Writes are not: the checkout under discovery is no more',
    ';; trusted than any other, and a write outside the workspace is observed',
    ';; just as well refused - a denial is logged too, and reported as a path',
    ';; the policy would need.',
    '(allow file-read* (with report))',
    '(allow file-write* (with report)',
    `  (subpath "${escapedWorkDir}"))`,
    ...sharedTempRules(),
    '(allow file-write*',
    '  (literal "/dev/null")',
    '  (literal "/dev/random")',
    '  (literal "/dev/urandom")',
    '  (literal "/dev/tty")',
    '  (literal "/dev/dtracehelper"))',
    '(allow file-ioctl (with report)',
    `  (subpath "${escapedWorkDir}"))`,
    '',
    ...neverReachableRules(escapedWorkDir, options.readOnlyPaths),
    ';; Metadata stays broad, as in the enforcement profile: tools walk paths',
    ';; they cannot open, and existence is not the secret.',
    '(allow file-read-metadata)',
    '',
    ';; ------------------------------------------------------------',
    ';; NETWORK ACCESS - Localhost only (proxy handles filtering)',
    ';; ------------------------------------------------------------',
    ';; Deliberately no blanket (allow network-* (with report)): that would let',
    ';; a tool ignoring HTTP_PROXY reach the internet directly, bypassing the',
    ';; proxy that records which hosts a workflow actually needs. Loopback is',
    ';; open: discovery applies no policy, runs the workflow to see what it',
    ';; needs, test servers included, and is confirmed on every run.',
    ...loopbackNetworkRules(proxyPort, escapedWorkDir, true),
    ...cliSocketRules(),
    '',
    ';; ------------------------------------------------------------',
    ';; PROCESS/SYSTEM OPERATIONS - Allow all (no reporting needed)',
    ';; ------------------------------------------------------------',
    '(allow process*)',
    ...signalRules(),
    '(allow mach*)',
    '(allow ipc*)',
    '(allow sysctl*)',
    '(allow iokit*)',
    '(allow pseudo-tty)',
    '(allow user-preference-read)',
    '(allow user-preference-write',
    '  (preference-domain "com.apple.dt.Xcode"))',
    '',
    ...processMarkerRules(options.processMarker),
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
  // Process names routinely contain hyphens and dots (git-remote-https,
  // com.apple.WebKit), so \w alone silently skips those lines and leaves the
  // discovered policy incomplete.
  //
  // A refusal reads `deny(1)`, with a count. The discovery profile refuses
  // writes outside the workspace, so a refused write is still a write the
  // workflow wanted, and is reported like an allowed one.
  const traceRegex = /Sandbox:\s+([^(\s]+)\((\d+)\)\s+(allow|deny)(?:\(\d+\))?\s+(\S+)\s+(.+)$/gm;

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

    // Refused writes count; a refused read is one of the paths no policy can
    // grant, and anything else refused is not something discovery asked about.
    // A refusal counts only from a pid known to be the workflow's: every
    // sandboxed process on the machine logs its own, and without the pids
    // any of them could add a write to what --updaterc proposes.
    const isWrite = operation.includes('write') || operation.includes('create') || operation.includes('unlink');
    if (action !== 'allow' && !(operation.startsWith('file-') && isWrite && collectedPids?.has(pid))) continue;

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

    // Never offer what no policy can grant.
    if (isNeverReachable(filePath)) continue;

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
    if (isWrite) {
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
  /**
   * Reduce recorded paths to the shortest set that expresses the same policy.
   *
   * The trace records every ancestor directory as well as each file touched,
   * and each entry is written back as a (subpath ...) rule, so any path under
   * one already listed adds nothing. Keeping them produced .localmostrc files
   * with thousands of lines where a few dozen say the same thing.
   *
   * The filesystem root is dropped entirely: reading it is required and the
   * generated profile always allows it as a literal, whereas recording it here
   * would be written back as (subpath "/") and grant the whole disk.
   */
  const consolidate = (paths: Set<string>): string[] => {
    const candidates = Array.from(paths)
      // "/" is the one thing granted without being declared, so recording it
      // adds nothing - and as a policy entry it would be written back as
      // (subpath "/"), granting the whole disk.
      .filter(p => p !== '/' && p !== '~' && p !== '')
      .sort();

    const kept: string[] = [];
    for (const candidate of candidates) {
      const covered = kept.some(
        existing => candidate === existing || candidate.startsWith(`${existing}/`)
      );
      if (!covered) {
        kept.push(candidate);
      }
    }
    return kept;
  };

  const consolidateReads = consolidate;

  return {
    writePaths: consolidate(consolidateWrites(writePaths).reduce((set, p) => set.add(p), new Set<string>())),
    readPaths: consolidateReads(readPaths),
    socketPaths: Array.from(socketPaths).sort(),
  };
}

/** @deprecated Use MODERATE_SANDBOX_POLICY instead */
export const DEFAULT_SANDBOX_POLICY = MODERATE_SANDBOX_POLICY;
