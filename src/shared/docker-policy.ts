/**
 * The docker policy grammar, declared per repository in .localmostrc.
 *
 * Actions are CLI-shaped (`pull`, `run`, `build`) because that is how a
 * workflow author thinks and how an approval diff reads. Each action carries
 * the conditions the filtering socket checks against the request. Anything a
 * policy does not name is denied. See
 * docs/superpowers/specs/2026-09-05-docker-isolation-design.md.
 *
 * Pure and shared between the main process and the CLI.
 */

export type MountMode = 'ro' | 'rw';

/** A workspace path the container may bind, and whether it may write to it. */
export interface DockerMount {
  path: string;
  mode: MountMode;
}

/** Container create, start, attach, wait and remove. */
export interface DockerRunPolicy {
  images?: string[];
  mounts?: DockerMount[];
  network?: string;
}

/** Image pulls, gated by the registry the image comes from. */
export interface DockerPullPolicy {
  registries: string[];
}

/** Image builds, gated by where the build context resolves. */
export interface DockerBuildPolicy {
  context?: string;
}

export interface DockerPolicy {
  pull?: DockerPullPolicy;
  run?: DockerRunPolicy;
  build?: DockerBuildPolicy;
  /** Grammar-present but rejected at approval unless the backend is a managed VM. */
  privileged?: boolean;
}

/** True when the policy grants nothing (used to keep `off` == `{}`/absent). */
export const isEmptyDockerPolicy = (p?: DockerPolicy): boolean =>
  !p || (!p.pull && !p.run && !p.build && !p.privileged);

// =============================================================================
// Validation
// =============================================================================

const KNOWN_ACTIONS = ['pull', 'run', 'build', 'privileged'] as const;
const MOUNT_MODES: readonly MountMode[] = ['ro', 'rw'];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validate a `docker:` block, reporting each problem through `push` under the
 * given path. Takes a callback rather than localmostrc's error list so this
 * module stays free of an import cycle with the parser.
 *
 * The 0.3.0 levels (`socket`, `contexts`, `credentials`) and `true` are
 * rejected outright: guessing which grant a coarse level meant is worse than
 * failing in a key that governs what a container may reach.
 */
export function validateDockerPolicy(value: unknown, path: string, push: (message: string) => void): void {
  if (typeof value === 'string' || typeof value === 'boolean') {
    push(`${path} is no longer a level; use \`pull\`, \`run\`, \`build\` actions instead (was: ${value})`);
    return;
  }
  if (!isPlainObject(value)) {
    push(`${path} must be an object of docker actions (pull, run, build)`);
    return;
  }

  for (const key of Object.keys(value)) {
    if (!(KNOWN_ACTIONS as readonly string[]).includes(key)) {
      push(`${path}: unknown docker action "${key}" (expected one of: ${KNOWN_ACTIONS.join(', ')})`);
    }
  }

  if (value.run !== undefined) validateRun(value.run, `${path}.run`, push);
  if (value.pull !== undefined) validatePull(value.pull, `${path}.pull`, push);
  if (value.build !== undefined) validateBuild(value.build, `${path}.build`, push);
  if (value.privileged !== undefined && typeof value.privileged !== 'boolean') {
    push(`${path}.privileged must be a boolean`);
  }
}

function validateRun(value: unknown, path: string, push: (message: string) => void): void {
  if (!isPlainObject(value)) {
    push(`${path} must be an object`);
    return;
  }
  if (value.images !== undefined) validateStringArray(value.images, `${path}.images`, push);
  if (value.mounts !== undefined) validateMounts(value.mounts, `${path}.mounts`, push);
  if (value.network !== undefined && typeof value.network !== 'string') {
    push(`${path}.network must be a string`);
  }
}

function validateMounts(value: unknown, path: string, push: (message: string) => void): void {
  if (!Array.isArray(value)) {
    push(`${path} must be an array`);
    return;
  }
  value.forEach((mount, i) => {
    if (!isPlainObject(mount)) {
      push(`${path}[${i}] must be an object with path and mode`);
      return;
    }
    if (typeof mount.path !== 'string') {
      push(`${path}[${i}].path must be a string`);
    }
    if (!(MOUNT_MODES as readonly unknown[]).includes(mount.mode)) {
      push(`${path}[${i}].mode: mount mode must be 'ro' or 'rw' (was: ${mount.mode})`);
    }
  });
}

function validatePull(value: unknown, path: string, push: (message: string) => void): void {
  if (!isPlainObject(value)) {
    push(`${path} must be an object`);
    return;
  }
  validateStringArray(value.registries, `${path}.registries`, push);
}

function validateBuild(value: unknown, path: string, push: (message: string) => void): void {
  if (!isPlainObject(value)) {
    push(`${path} must be an object`);
    return;
  }
  if (value.context !== undefined && typeof value.context !== 'string') {
    push(`${path}.context must be a string`);
  }
}

function validateStringArray(value: unknown, path: string, push: (message: string) => void): void {
  if (!Array.isArray(value)) {
    push(`${path} must be an array`);
    return;
  }
  value.forEach((item, i) => {
    if (typeof item !== 'string') push(`${path}[${i}] must be a string`);
  });
}

// =============================================================================
// Merging
// =============================================================================

function mergeStrings(base?: string[], override?: string[]): string[] | undefined {
  if (!base && !override) return undefined;
  return Array.from(new Set([...(base ?? []), ...(override ?? [])]));
}

function mergeMounts(base?: DockerMount[], override?: DockerMount[]): DockerMount[] | undefined {
  if (!base && !override) return undefined;
  const seen = new Set<string>();
  const merged: DockerMount[] = [];
  for (const mount of [...(base ?? []), ...(override ?? [])]) {
    // An rw grant is a different grant from an ro one on the same path, so
    // both survive; the evaluator picks the one that permits the request.
    const key = `${mount.path}:${mount.mode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ path: mount.path, mode: mount.mode });
  }
  return merged;
}

function mergePull(base?: DockerPullPolicy, override?: DockerPullPolicy): DockerPullPolicy | undefined {
  if (!base && !override) return undefined;
  return { registries: mergeStrings(base?.registries, override?.registries) ?? [] };
}

function mergeRun(base?: DockerRunPolicy, override?: DockerRunPolicy): DockerRunPolicy | undefined {
  if (!base && !override) return undefined;
  const run: DockerRunPolicy = {};
  const images = mergeStrings(base?.images, override?.images);
  if (images) run.images = images;
  const mounts = mergeMounts(base?.mounts, override?.mounts);
  if (mounts) run.mounts = mounts;
  const network = override?.network ?? base?.network;
  if (network !== undefined) run.network = network;
  return run;
}

function mergeBuild(base?: DockerBuildPolicy, override?: DockerBuildPolicy): DockerBuildPolicy | undefined {
  if (!base && !override) return undefined;
  const context = override?.context ?? base?.context;
  return context !== undefined ? { context } : {};
}

/**
 * Compose a shared docker policy with a workflow's. Additive, like the rest
 * of the policy: lists concatenate (deduplicated), `network` and `context`
 * take the workflow's value when it gives one, and `privileged` is granted
 * if either side asks for it. Undefined when neither side grants anything.
 */
export function mergeDockerPolicy(base?: DockerPolicy, override?: DockerPolicy): DockerPolicy | undefined {
  if (isEmptyDockerPolicy(base) && isEmptyDockerPolicy(override)) return undefined;
  const merged: DockerPolicy = {};
  const pull = mergePull(base?.pull, override?.pull);
  if (pull) merged.pull = pull;
  const run = mergeRun(base?.run, override?.run);
  if (run) merged.run = run;
  const build = mergeBuild(base?.build, override?.build);
  if (build) merged.build = build;
  if (base?.privileged || override?.privileged) merged.privileged = true;
  return merged;
}
