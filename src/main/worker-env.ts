/**
 * What goes into a runner worker's environment, beyond what RunnerManager
 * sets for the runner itself.
 */

import * as path from 'path';

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
