/**
 * What goes into a runner worker's environment, beyond what RunnerManager
 * sets for the runner itself.
 */

import * as path from 'path';
import type { EnvPolicy } from '../shared/sandbox-profile';
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
 * toolchains installed there still run. rustup has no entry: its toolchains
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
    // metadata, pipx, pre-commit and others)
    XDG_CACHE_HOME: at('cache'),
    XDG_DATA_HOME: at('local', 'share'),
    // ~/.cargo, ~/.gradle, ~/.m2, ~/go
    CARGO_HOME: at('cargo'),
    GRADLE_USER_HOME: at('gradle'),
    MAVEN_OPTS: `-Dmaven.repo.local=${at('m2', 'repository')}`,
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
