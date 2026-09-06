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

import * as yaml from 'js-yaml';

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
  } else if (value.privileged === true) {
    // Kept in the grammar so the capability gap stays visible, and refused
    // until a backend exists that can contain it. Accepting the declaration
    // here and then refusing every request it implies would read as a broken
    // policy rather than a stage that has not shipped.
    push(
      `${path}.privileged requires a managed VM backend, which this build does not have; ` +
        'remove it, or run the work without privileged containers'
    );
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
  } else if (value.network === 'host' || (typeof value.network === 'string' && value.network.startsWith('container:'))) {
    // Host networking reaches the host, and a shared namespace reaches another
    // container; neither can be named, so neither can be requested.
    push(`${path}.network cannot be ${value.network}: it reaches outside the container and cannot be granted`);
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

// =============================================================================
// Diffing
// =============================================================================

/** Structurally the parser's PolicyDiff, declared here to avoid importing it. */
export interface DockerPolicyDiff {
  path: string;
  type: 'added' | 'removed' | 'changed';
  oldValue?: string;
  newValue?: string;
}

/** A mount as one string, in the shape a -v flag takes, so it diffs per grant. */
const mountKey = (m: DockerMount): string => `${m.path}:${m.mode}`;

function diffLists(oldList: string[] | undefined, newList: string[] | undefined, path: string, diffs: DockerPolicyDiff[]): void {
  const oldSet = new Set(oldList ?? []);
  const newSet = new Set(newList ?? []);
  for (const item of newSet) {
    if (!oldSet.has(item)) diffs.push({ path, type: 'added', newValue: item });
  }
  for (const item of oldSet) {
    if (!newSet.has(item)) diffs.push({ path, type: 'removed', oldValue: item });
  }
}

function diffScalar(oldValue: string | undefined, newValue: string | undefined, path: string, diffs: DockerPolicyDiff[]): void {
  if (oldValue === newValue) return;
  if (oldValue === undefined) diffs.push({ path, type: 'added', newValue });
  else if (newValue === undefined) diffs.push({ path, type: 'removed', oldValue });
  else diffs.push({ path, type: 'changed', oldValue, newValue });
}

/**
 * Every grant that changed between two docker policies, one entry per image,
 * registry or mount. With the repository as the only gate, the approval diff
 * is the whole of the access control, so nothing under docker: collapses
 * into a single line.
 */
export function diffDockerPolicy(
  oldP: DockerPolicy | undefined,
  newP: DockerPolicy | undefined,
  prefix: string
): DockerPolicyDiff[] {
  const diffs: DockerPolicyDiff[] = [];
  diffLists(oldP?.pull?.registries, newP?.pull?.registries, `${prefix}.pull.registries`, diffs);
  diffLists(oldP?.run?.images, newP?.run?.images, `${prefix}.run.images`, diffs);
  diffLists(oldP?.run?.mounts?.map(mountKey), newP?.run?.mounts?.map(mountKey), `${prefix}.run.mounts`, diffs);
  diffScalar(oldP?.run?.network, newP?.run?.network, `${prefix}.run.network`, diffs);
  diffScalar(oldP?.build?.context, newP?.build?.context, `${prefix}.build.context`, diffs);
  // false grants nothing, the same as absent.
  diffScalar(oldP?.privileged ? 'true' : undefined, newP?.privileged ? 'true' : undefined, `${prefix}.privileged`, diffs);

  // An action block with no conditions is still a grant - `run: {}` permits
  // creating and running containers - and diffing only conditions showed an
  // approver nothing for it at all. Named here only when the block is
  // otherwise invisible, so a block that changed its conditions is not
  // reported twice.
  for (const action of ['pull', 'run', 'build'] as const) {
    const had = oldP?.[action] !== undefined;
    const has = newP?.[action] !== undefined;
    if (had === has) continue;
    if (diffs.some((d) => d.path.startsWith(`${prefix}.${action}.`))) continue;
    diffs.push(
      has
        ? { path: `${prefix}.${action}`, type: 'added', newValue: action }
        : { path: `${prefix}.${action}`, type: 'removed', oldValue: action }
    );
  }
  return diffs;
}

// =============================================================================
// Serialization
// =============================================================================

const quote = (value: string): string => JSON.stringify(value);

/**
 * The docker block as .localmostrc lines under `indent`, in the shape the
 * documentation shows. Empty when the policy grants nothing.
 */
export function serializeDockerPolicy(policy: DockerPolicy, indent: string): string[] {
  if (isEmptyDockerPolicy(policy)) return [];
  const lines: string[] = [`${indent}docker:`];
  const i1 = `${indent}  `;
  const i2 = `${indent}    `;
  const i3 = `${indent}      `;

  if (policy.pull) {
    lines.push(`${i1}pull:`);
    if (policy.pull.registries.length === 0) {
      lines.push(`${i2}registries: []`);
    } else {
      lines.push(`${i2}registries:`);
      for (const registry of policy.pull.registries) lines.push(`${i3}- ${quote(registry)}`);
    }
  }

  if (policy.run) {
    const { images, mounts, network } = policy.run;
    if (!images?.length && !mounts?.length && network === undefined) {
      lines.push(`${i1}run: {}`);
    } else {
      lines.push(`${i1}run:`);
      if (images?.length) {
        lines.push(`${i2}images:`);
        for (const image of images) lines.push(`${i3}- ${quote(image)}`);
      }
      if (mounts?.length) {
        lines.push(`${i2}mounts:`);
        for (const mount of mounts) {
          lines.push(`${i3}- path: ${quote(mount.path)}`);
          lines.push(`${i3}  mode: ${mount.mode}`);
        }
      }
      if (network !== undefined) lines.push(`${i2}network: ${quote(network)}`);
    }
  }

  if (policy.build) {
    if (policy.build.context === undefined) {
      lines.push(`${i1}build: {}`);
    } else {
      lines.push(`${i1}build:`);
      lines.push(`${i2}context: ${quote(policy.build.context)}`);
    }
  }

  if (policy.privileged) lines.push(`${i1}privileged: true`);

  return lines;
}

// =============================================================================
// Discovery
// =============================================================================

/**
 * Read a policy hint back into the policy it names. A hint is what a denial
 * logs: the YAML fragment, rooted at `docker:`, that would have permitted the
 * request. It ends up written into a checked-in policy, so anything that is
 * not exactly a valid docker block - a parse error, another key, an action
 * the grammar rejects - yields nothing rather than widening the file.
 */
export function parseDockerPolicyHint(hint: string): DockerPolicy | undefined {
  let loaded: unknown;
  try {
    loaded = yaml.load(hint);
  } catch {
    return undefined;
  }
  if (!isPlainObject(loaded) || Object.keys(loaded).length !== 1 || !('docker' in loaded)) return undefined;
  const errors: string[] = [];
  validateDockerPolicy(loaded.docker, 'docker', (m) => errors.push(m));
  if (errors.length > 0) return undefined;
  return loaded.docker as DockerPolicy;
}
