/**
 * What goes into a runner worker's environment, beyond what RunnerManager
 * sets for the runner itself.
 */

import * as os from 'os';
import * as path from 'path';
import type { EnvPolicy } from '../shared/sandbox-profile';
import type { SandboxPolicyLevel } from '../shared/types';
import type { LocalmostrcConfig } from '../shared/localmostrc';

/**
 * The variables of the app's own environment every worker inherits: what the
 * runner, a shell and the locale machinery need to know who and where they
 * are. Everything else the app was launched with - a shell's tokens, an agent
 * socket, NODE_OPTIONS, a NO_PROXY that would route around the job's proxy -
 * reaches a job only if its repository's approved policy allows it by name.
 */
const BASELINE_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_*',
  'TERM',
  'TZ',
  '__CF_USER_TEXT_ENCODING',
];

/** Whether a variable name matches a policy pattern: a name, `*` standing for any run of characters. */
function matchesEnvPattern(name: string, pattern: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(name);
}

/**
 * The part of the app's environment a worker inherits: the baseline and
 * whatever the repository's env policy allows, less whatever it denies. A
 * deny wins over both. The variables the app sets for the runner itself are
 * added afterwards by the caller, so no policy can replace them.
 */
export function inheritedWorkerEnv(hostEnv: NodeJS.ProcessEnv, policy?: EnvPolicy): NodeJS.ProcessEnv {
  const allow = [...BASELINE_ENV, ...(policy?.allow ?? [])];
  const deny = policy?.deny ?? [];
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (!allow.some((pattern) => matchesEnvPattern(name, pattern))) continue;
    if (deny.some((pattern) => matchesEnvPattern(name, pattern))) continue;
    env[name] = value;
  }
  return env;
}

/**
 * The env policy a worker can be spawned under. The environment is fixed at
 * spawn, before the workflow is known - the same constraint as the sandbox
 * profile - so allow comes from the shared section only: a per-workflow
 * allow cannot be honoured, and is not applied. A deny can be honoured
 * conservatively, so every workflow's deny applies to every job: a deny that
 * silently did not apply would be the unsafe way to be wrong.
 */
export function spawnEnvPolicy(config: LocalmostrcConfig): { allow: string[]; deny: string[] } {
  const deny = [...(config.shared?.env?.deny ?? [])];
  for (const workflow of Object.values(config.workflows ?? {})) {
    for (const name of workflow?.env?.deny ?? []) {
      if (!deny.includes(name)) deny.push(name);
    }
  }
  return { allow: [...(config.shared?.env?.allow ?? [])], deny };
}

/**
 * Where a job's package managers and toolchains keep what they download,
 * redirected into its target's own cache directory.
 *
 * moderate and permissive used to grant write on the user's own trees for
 * these - ~/.cargo, ~/.gradle, ~/go, ~/.local, ~/Library/Caches and the like
 * - which are not only caches: they hold directories on the user's PATH and
 * config their unsandboxed tools load. Each tool is pointed here instead, by
 * the variable it honours, and the user's trees stay readable so the
 * toolchains installed there still run - of ~/.local, only bin and lib, the
 * rest being where tools keep their state. rustup has no entry: its toolchains
 * are read from ~/.rustup where they are installed, and a job cannot add one.
 */
export function packageCacheEnv(dir: string): Record<string, string> {
  const at = (...parts: string[]) => path.join(dir, ...parts);
  return {
    // ~/.npm, ~/.yarn, ~/.pnpm-store
    npm_config_cache: at('npm'),
    YARN_CACHE_FOLDER: at('yarn', 'cache'),
    YARN_GLOBAL_FOLDER: at('yarn', 'global'),
    npm_config_store_dir: at('pnpm-store'),
    // ~/.cache and ~/.local/share, for the tools that follow XDG (uv, pnpm's
    // metadata, pipx, pre-commit and others). The data home also hides what
    // the user installed there - mise's tools, uv's Pythons - so a job
    // installs its own copy here instead of failing to write ~/.local.
    XDG_CACHE_HOME: at('cache'),
    XDG_DATA_HOME: at('local', 'share'),
    // ~/.cargo, ~/.gradle, ~/.m2, ~/go
    CARGO_HOME: at('cargo'),
    GRADLE_USER_HOME: at('gradle'),
    // Maven has no variable for its repository, only a property. MAVEN_OPTS
    // carries it for every version, but a workflow that sets MAVEN_OPTS for
    // its JVM flags replaces it; Maven 3.9 and later also read MAVEN_ARGS,
    // which workflows rarely set.
    MAVEN_OPTS: `-Dmaven.repo.local=${at('m2', 'repository')}`,
    MAVEN_ARGS: `-Dmaven.repo.local=${at('m2', 'repository')}`,
    GOPATH: at('go'),
    // ~/.nuget, ~/.dotnet
    NUGET_PACKAGES: at('nuget', 'packages'),
    NUGET_HTTP_CACHE_PATH: at('nuget', 'http-cache'),
    DOTNET_CLI_HOME: at('dotnet'),
    // ~/Library/Caches, for the tools that keep theirs there
    GOCACHE: at('go-build'),
    PIP_CACHE_DIR: at('pip'),
    electron_config_cache: at('electron'),
    npm_config_devdir: at('node-gyp'),
  };
}

/**
 * JAVA_TOOL_OPTIONS for a job's JVMs, which read neither TMPDIR nor
 * HTTPS_PROXY, and every JVM the job starts picks up.
 *
 * - java.io.tmpdir in the job's temp: the JVM's default is the per-user
 *   temp directory, which the sandbox does not grant, so createTempFile
 *   failed with "Operation not permitted".
 * - user.home the job's home: the JVM takes it from the user database, not
 *   HOME, so Maven (~/.m2/settings.xml), Gradle without GRADLE_USER_HOME,
 *   sbt and Ivy looked in the real home, where the floor denies their
 *   credential files, and failed on them.
 * - IPv4 only: a dual-stack socket's connection to 127.0.0.1 is reported
 *   with no host, so the sandbox cannot attribute it to loopback and denies
 *   it - the same reason .NET is given DOTNET_SYSTEM_NET_DISABLEIPV6.
 * - The job's proxy for http and https, and its credentials. The JDK's own
 *   HTTP clients do not read http(s).proxyUser/Password - they ask an
 *   Authenticator, which only the job's code can install - but Gradle and
 *   clients that take their proxy from the system properties (Apache
 *   HttpClient's) do. Basic is the proxy's scheme, which the JDK refuses on
 *   a CONNECT tunnel unless jdk.http.auth.tunneling.disabledSchemes says
 *   otherwise; set empty, an Authenticator the job installs works.
 *
 * The JVM splits JAVA_TOOL_OPTIONS on whitespace, so a value with any in it
 * is left out rather than passed in pieces. The JVM prints the whole value
 * to stderr as it starts ("Picked up JAVA_TOOL_OPTIONS"), proxy token
 * included; the token is good only for this job's proxy, on loopback, and
 * is replaced when the job ends. A workflow that sets JAVA_TOOL_OPTIONS
 * itself replaces all of this.
 */
export function javaToolOptions(options: { tmpDir: string; home: string; proxyUrl: string }): string {
  const whole = (value: string) => !/\s/.test(value);
  const flags: string[] = [];
  if (whole(options.tmpDir)) flags.push(`-Djava.io.tmpdir=${options.tmpDir}`);
  if (whole(options.home)) flags.push(`-Duser.home=${options.home}`);
  flags.push('-Djava.net.preferIPv4Stack=true');
  let proxy: URL | undefined;
  try {
    proxy = new URL(options.proxyUrl);
  } catch {
    proxy = undefined;
  }
  if (proxy && proxy.hostname && proxy.port) {
    for (const scheme of ['http', 'https']) {
      flags.push(`-D${scheme}.proxyHost=${proxy.hostname}`, `-D${scheme}.proxyPort=${proxy.port}`);
    }
    const user = decodeURIComponent(proxy.username);
    const password = decodeURIComponent(proxy.password);
    if (user && password && whole(user) && whole(password)) {
      for (const scheme of ['http', 'https']) {
        flags.push(`-D${scheme}.proxyUser=${user}`, `-D${scheme}.proxyPassword=${password}`);
      }
      flags.push('-Djdk.http.auth.tunneling.disabledSchemes=', '-Djdk.http.auth.proxying.disabledSchemes=');
    }
  }
  return flags.join(' ');
}

/**
 * The toolchains and package-manager caches a level lets a job read.
 *
 * A convenience for jobs, not something the runner needs. Under strict a
 * repository declares what it wants; moderate and permissive can read them,
 * which is the same split the network allowlists already use. Read only:
 * these trees hold directories on the user's PATH and config their own tools
 * load, so a job that could write them could plant code the user later runs
 * outside any sandbox. The job's package managers write to its target's own
 * directory instead. `homeDir` is used as given, already escaped for the
 * profile where that is where it goes.
 *
 * Of ~/.local, only bin and lib: the rest is where tools keep their state,
 * tokens included - uv's index credentials, the SSH key into a Podman
 * machine, atuin's sync key, all under ~/.local/share. The job's package
 * managers keep their data in its own package cache (XDG_DATA_HOME), so no
 * ~/.local/share/<tool> is read for them; a tool linked from ~/.local/bin
 * into one, or a job that wants one for another reason, declares it. Those
 * three secrets are on the floor (developerCredentialPaths), so declaring
 * ~/.local/share/uv to run a uv tool does not read uv's credentials.
 */
export function levelToolchainPaths(level: SandboxPolicyLevel, homeDir: string = os.homedir()): string[] {
  if (level === 'strict') return [];
  return [
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
    `${homeDir}/.local/bin`,
    `${homeDir}/.local/lib`,
    `${homeDir}/go`,
    `${homeDir}/Library/Caches`,
  ];
}
