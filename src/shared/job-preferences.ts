/**
 * The runner's resource-pause preference: what it holds, its default, and
 * how its section of config.yaml is read into it.
 *
 * Shared by the main process, whose store loads it from config.yaml at
 * launch and which the runner reads at each pause, and the renderer, whose
 * Settings page shows and sets it in that store, so the page shows the value
 * the runner uses - a value the file holds that the runner would take as
 * absent shows as the default it uses instead.
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
