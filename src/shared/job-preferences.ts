/**
 * The runner's resource-pause and job-environment preferences: what each
 * holds, its default, and how a section of config.yaml is read into it.
 *
 * Shared by the main process, whose store loads them from config.yaml at
 * launch and which the runner reads at each pause and each worker spawn, and
 * the renderer, whose Settings page shows and sets them in that store, so the
 * page shows the value the runner uses - a value the file holds that the
 * runner would take as absent shows as the default it uses instead.
 */

/** A section of config.yaml as written: any key, any value. */
export type PreferenceSection<T> = Partial<Record<keyof T, unknown>>;

/**
 * What a resource pause - the runner pausing itself on battery or during a
 * video call, as the `power` settings say - does, as used: every key
 * present. The `resourcePause` section of config.yaml, set from the Power
 * section of Settings, and read from the store at each pause.
 */
export interface ResourcePauseConfig {
  /**
   * What happens to jobs already running when a resource condition pauses
   * the runner. Either way no new job is taken, and the heartbeat that
   * routes workflows here stops.
   *
   * - `'finish'` (default): running jobs carry on to the end.
   * - `'stop'`: the workers are stopped at once, and their jobs fail on
   *   GitHub.
   */
  runningJobs: 'finish' | 'stop';
}

/**
 * Frozen: shared by reference into the store's defaults and the renderer's
 * fallbacks, so a stray write cannot change the runner's default.
 */
export const DEFAULT_RESOURCE_PAUSE_CONFIG: Readonly<ResourcePauseConfig> = Object.freeze({
  runningJobs: 'finish',
});

/**
 * The `resourcePause` section of config.yaml as the app uses it. Every key
 * is optional; a value that is not one of the key's choices is taken as
 * absent, with a line through `log`, and keys it does not know are ignored.
 */
export function resolveResourcePauseConfig(
  raw: PreferenceSection<ResourcePauseConfig> | undefined,
  log: (message: string) => void = () => {}
): ResourcePauseConfig {
  const section: Record<string, unknown> = typeof raw === 'object' && raw !== null ? raw : {};
  const resolved: ResourcePauseConfig = { ...DEFAULT_RESOURCE_PAUSE_CONFIG };
  const { runningJobs } = section;
  if (runningJobs !== undefined) {
    if (runningJobs === 'finish' || runningJobs === 'stop') resolved.runningJobs = runningJobs;
    else log(`resourcePause.runningJobs must be 'finish' or 'stop'; using '${DEFAULT_RESOURCE_PAUSE_CONFIG.runningJobs}'`);
  }
  return resolved;
}

/**
 * The conveniences localmost adds to every job's environment, each of which
 * can be turned off on its own. All are on by default. See
 * docs/roadmap/job-environment.md. The `jobEnvironment` section of
 * config.yaml, set from the Job Environment section of Settings, and read
 * from the store at each worker spawn: a change applies to workers spawned
 * after it.
 */
export interface JobEnvironmentConfig {
  /**
   * `swift` and `xcodebuild` shims first on the job's PATH, which turn off
   * SwiftPM's and Xcode's own manifest and plugin sandbox: the job already
   * runs under one, and macOS refuses to nest them, so a package manifest
   * the job has not compiled before fails to build without this. Off, the
   * job calls the tools as they are. The bundled docker CLI is on PATH
   * either way.
   */
  toolShims: boolean;
  /**
   * JAVA_TOOL_OPTIONS for the JVM: its temp directory in the job's own,
   * IPv4 so its loopback connections are ones the sandbox can attribute, and
   * the job's proxy with its credentials. A workflow that sets
   * JAVA_TOOL_OPTIONS itself replaces this.
   */
  javaToolOptions: boolean;
  /**
   * A per-job directory in the per-user temp directory, named by
   * DIRHELPER_USER_DIR_SUFFIX, so NSTemporaryDirectory() and Foundation's
   * atomic writes - SwiftPM's and Xcode's among them - have a temp directory
   * of the job's own, created before the job and removed after it. Off, the
   * job has no such directory and those writes fail.
   */
  perJobTempDir: boolean;
  /**
   * Create, before the job, a directory its approved policy grants write on
   * under the home directory when it does not exist yet - empty, one level
   * at a time, never through a link. Off, a missing granted directory stays
   * missing, and a job that cannot create it itself fails.
   */
  createMissingGrantedDirs: boolean;
}

/** Every job-environment convenience, on: the defaults. Frozen, as DEFAULT_RESOURCE_PAUSE_CONFIG. */
export const DEFAULT_JOB_ENVIRONMENT_CONFIG: Readonly<JobEnvironmentConfig> = Object.freeze({
  toolShims: true,
  javaToolOptions: true,
  perJobTempDir: true,
  createMissingGrantedDirs: true,
});

/**
 * The `jobEnvironment` section of config.yaml as used. Every key is optional
 * and defaults on; a value that is not true or false is taken as absent,
 * with a line through `log`, and keys it does not know are ignored.
 */
export function resolveJobEnvironmentConfig(
  raw: PreferenceSection<JobEnvironmentConfig> | undefined,
  log: (message: string) => void = () => {}
): JobEnvironmentConfig {
  const section: Record<string, unknown> = typeof raw === 'object' && raw !== null ? raw : {};
  const resolved: JobEnvironmentConfig = { ...DEFAULT_JOB_ENVIRONMENT_CONFIG };
  for (const key of Object.keys(DEFAULT_JOB_ENVIRONMENT_CONFIG) as Array<keyof JobEnvironmentConfig>) {
    const value = section[key];
    if (value === undefined) continue;
    if (typeof value === 'boolean') resolved[key] = value;
    else log(`jobEnvironment.${key} must be true or false; using ${DEFAULT_JOB_ENVIRONMENT_CONFIG[key]}`);
  }
  return resolved;
}
