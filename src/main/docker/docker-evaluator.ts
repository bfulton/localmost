/**
 * Decide whether one Docker Engine API request is permitted by the docker
 * policy bound to a worker's socket. The security core of the filter.
 *
 * Pure: the request is already parsed, the policy is already bound, and the
 * only filesystem question - what a mount source resolves to - is injected.
 * Every deny carries a Docker-API-shaped reason, and where a policy line
 * could permit the request, the YAML that would. Anything the evaluator does
 * not understand is refused: a filter that fails open is worse than none,
 * because it is trusted. See
 * docs/superpowers/specs/2026-09-05-docker-isolation-design.md.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DockerPolicy, DockerMount, MountMode } from '../../shared/docker-policy';
import { DockerRequest, DockerAction, classifyDockerRequest, containerIdFrom } from './docker-request';

export interface DockerEvalContext {
  /** The bound policy; null until the worker claims a job, which denies all. */
  policy: DockerPolicy | null;
  /**
   * The job workspace, absolute and already resolved through symlinks. Mount
   * sources must resolve inside it; the evaluator does not resolve the root
   * itself, so that a stubbed realpath in tests cannot move the boundary.
   */
  workspaceRoot: string;
  /** Whether the backend may honour `privileged`. Stage 1: false. */
  supportsPrivileged: boolean;
  /**
   * Ids of containers created through this socket. Per-container reads and
   * writes are permitted only against these: the daemon is shared with the
   * operator and with other jobs, so an unscoped id reaches outside this job.
   */
  ownContainerIds?: ReadonlySet<string>;
  /** Injected for tests; defaults to fs.realpathSync. Must throw when the path does not exist. */
  realpath?: (p: string) => string;
}

export interface DockerVerdict {
  allowed: boolean;
  /** Why it was refused, as the Docker API error message the client sees. */
  reason?: string;
  /** The policy that would permit it, as YAML under `docker:` (for --updaterc discovery). */
  policyHint?: string;
}

const ALLOW: DockerVerdict = { allowed: true };
const deny = (reason: string, policyHint?: string): DockerVerdict =>
  policyHint === undefined ? { allowed: false, reason } : { allowed: false, reason, policyHint };

/** Permitted with no declaration: every client needs them to start, and none reach the host. */
// Reads that tell a client nothing about the host: every client needs them to
// start. Container reads are NOT here - the baseline is reads about the job's
// OWN containers, which is enforced per id below.
const BASELINE: ReadonlySet<DockerAction> = new Set(['ping', 'version', 'info']);

/**
 * Every value whose key case-insensitively equals `name`.
 *
 * The daemon decodes these bodies with Go's encoding/json, which matches a
 * struct field by exact name and then, as a documented fallback, case
 * -insensitively. Reading `hostConfig.Privileged` in JS therefore sees nothing
 * in a body that says "privileged", while the daemon honours it - so the
 * filter must consider every casing, not the one it expects.
 */
function valuesFor(obj: Record<string, unknown>, name: string): unknown[] {
  const wanted = name.toLowerCase();
  const out: unknown[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key.toLowerCase() === wanted) out.push(value);
  }
  return out;
}

/** The value the daemon would use: the exact-cased key if present, else any case-insensitive match. */
function pick(obj: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  const matches = valuesFor(obj, name);
  return matches.length > 0 ? matches[0] : undefined;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// -----------------------------------------------------------------------------
// Policy hints: the YAML fragment, under `docker:`, that would permit a request.
// -----------------------------------------------------------------------------

const yamlString = (value: string): string => JSON.stringify(value);

const hints = {
  run: 'docker:\n  run: {}',
  image: (image: string) => `docker:\n  run:\n    images:\n      - ${yamlString(image)}`,
  mount: (relative: string, mode: MountMode) =>
    `docker:\n  run:\n    mounts:\n      - path: ${yamlString(relative)}\n        mode: ${mode}`,
  network: (mode: string) => `docker:\n  run:\n    network: ${yamlString(mode)}`,
  registry: (registry: string) => `docker:\n  pull:\n    registries:\n      - ${registry}`,
  build: 'docker:\n  build:\n    context: "./"',
  privileged: 'docker:\n  privileged: true',
};

// -----------------------------------------------------------------------------
// Image references
// -----------------------------------------------------------------------------

const DEFAULT_REGISTRY = 'docker.io';

/** Split a reference into registry and remainder, by the daemon's rule. */
function splitRegistry(reference: string): { registry: string; remainder: string } {
  const slash = reference.indexOf('/');
  if (slash === -1) return { registry: DEFAULT_REGISTRY, remainder: reference };
  const first = reference.slice(0, slash);
  // A first component is a registry only when it looks like a host.
  if (!first.includes('.') && !first.includes(':') && first !== 'localhost') {
    return { registry: DEFAULT_REGISTRY, remainder: reference };
  }
  const registry = first === 'index.docker.io' ? DEFAULT_REGISTRY : first;
  return { registry, remainder: reference.slice(slash + 1) };
}

/** The registry an image reference pulls from, as the daemon reads it. */
export const registryOf = (reference: string): string => splitRegistry(reference).registry;

/**
 * The canonical form of an image reference, so that `postgres:16` and
 * `docker.io/library/postgres:16` name the same image on both sides.
 */
function normalizeImage(reference: string): string {
  const { registry, remainder } = splitRegistry(reference);
  let name = remainder;
  if (registry === DEFAULT_REGISTRY && !name.includes('/')) name = `library/${name}`;
  const hasDigest = name.includes('@');
  const lastColon = name.lastIndexOf(':');
  const hasTag = !hasDigest && lastColon > name.lastIndexOf('/');
  if (!hasDigest && !hasTag) name = `${name}:latest`;
  return `${registry}/${name}`;
}

// -----------------------------------------------------------------------------
// HostConfig: the keys that reach the host, and the values that do not.
// -----------------------------------------------------------------------------

const isUnset = (v: unknown): boolean => v === undefined || v === null;
const isEmptyString = (v: unknown): boolean => isUnset(v) || v === '';
const isEmptyArray = (v: unknown): boolean => isUnset(v) || (Array.isArray(v) && v.length === 0);
const isEmptyObject = (v: unknown): boolean => isUnset(v) || (isPlainObject(v) && Object.keys(v).length === 0);
const oneOf = (...allowed: string[]) => (v: unknown): boolean => isUnset(v) || allowed.includes(v as string);

/**
 * Each of these is a host-reaching setting the grammar cannot spell. Its
 * only permitted values are the defaults the docker CLI sends for it; the
 * shapes are bounded by the API version the proxy pins.
 */
const HOST_CONFIG_GATES: ReadonlyArray<{ key: string; permitted: (v: unknown) => boolean; flag: string }> = [
  { key: 'PidMode', permitted: isEmptyString, flag: '--pid' },
  { key: 'IpcMode', permitted: oneOf('', 'private', 'none', 'shareable'), flag: '--ipc' },
  { key: 'UTSMode', permitted: isEmptyString, flag: '--uts' },
  { key: 'UsernsMode', permitted: isEmptyString, flag: '--userns' },
  { key: 'CgroupnsMode', permitted: oneOf('', 'private'), flag: '--cgroupns' },
  { key: 'CgroupParent', permitted: isEmptyString, flag: '--cgroup-parent' },
  { key: 'Devices', permitted: isEmptyArray, flag: '--device' },
  { key: 'DeviceRequests', permitted: isEmptyArray, flag: '--gpus' },
  { key: 'DeviceCgroupRules', permitted: isEmptyArray, flag: '--device-cgroup-rule' },
  { key: 'SecurityOpt', permitted: isEmptyArray, flag: '--security-opt' },
  { key: 'CapAdd', permitted: isEmptyArray, flag: '--cap-add' },
  { key: 'Sysctls', permitted: isEmptyObject, flag: '--sysctl' },
  { key: 'Runtime', permitted: oneOf('', 'runc'), flag: '--runtime' },
  { key: 'Isolation', permitted: oneOf('', 'default'), flag: '--isolation' },
  { key: 'MaskedPaths', permitted: isUnset, flag: 'MaskedPaths' },
  { key: 'ReadonlyPaths', permitted: isUnset, flag: 'ReadonlyPaths' },
  { key: 'VolumesFrom', permitted: isEmptyArray, flag: '--volumes-from' },
];

/** Bind options that do not change what the mount reaches. */
const BIND_OPTIONS: ReadonlySet<string> = new Set([
  'ro', 'rw', 'z', 'Z', 'cached', 'delegated', 'consistent', 'nocopy',
  'bind', 'rbind', 'private', 'rprivate', 'slave', 'rslave',
]);
const PROPAGATIONS: ReadonlySet<string> = new Set(['', 'private', 'rprivate', 'slave', 'rslave']);

// -----------------------------------------------------------------------------
// Mounts
// -----------------------------------------------------------------------------

interface MountRequest {
  /** The host source as the request gave it. */
  source: string;
  mode: MountMode;
}

const inside = (root: string, p: string): boolean => p === root || p.startsWith(root + path.sep);

/** A workspace-relative spelling for a hint: `./` for the root, `./x/y` below it. */
const relativeTo = (root: string, p: string): string => {
  const rel = path.relative(root, p);
  return rel === '' ? './' : `./${rel}`;
};

/** Parse one entry of HostConfig.Binds, or explain why it cannot be permitted. */
function parseBind(bind: string): MountRequest | string {
  const parts = bind.split(':');
  // "src:dst" or "src:dst:opts". A source with no slash is a named volume.
  if (parts.length < 2 || parts.length > 3) return `bind "${bind}" is not of the form source:target[:options]`;
  const [source, , options] = parts;
  if (!path.isAbsolute(source)) {
    return `"${source}" is a named volume, not a workspace path; only declared workspace mounts are permitted`;
  }
  let mode: MountMode = 'rw';
  for (const option of options ? options.split(',') : []) {
    if (!BIND_OPTIONS.has(option)) return `bind option "${option}" on "${bind}" is not permitted`;
    if (option === 'ro') mode = 'ro';
  }
  return { source, mode };
}

/** Parse one entry of HostConfig.Mounts; null when it needs no host check. */
function parseMount(mount: unknown): MountRequest | string | null {
  if (!isPlainObject(mount)) return 'each entry of HostConfig.Mounts must be an object';
  const type = mount.Type;
  if (type === 'tmpfs') return null;
  if (type === 'volume') {
    if (isEmptyString(mount.Source)) return null; // anonymous: lives with the container
    return `"${mount.Source}" is a named volume, not a workspace path; only declared workspace mounts are permitted`;
  }
  if (type !== 'bind') return `mount type "${String(type)}" is not permitted`;
  if (typeof mount.Source !== 'string' || !path.isAbsolute(mount.Source)) {
    return 'a bind mount needs an absolute Source';
  }
  const options = mount.BindOptions;
  if (options !== undefined && options !== null) {
    if (!isPlainObject(options)) return 'BindOptions must be an object';
    const propagation = options.Propagation ?? '';
    if (!PROPAGATIONS.has(propagation as string)) {
      return `mount propagation "${String(propagation)}" is not permitted`;
    }
  }
  return { source: mount.Source, mode: mount.ReadOnly === true ? 'ro' : 'rw' };
}

function collectMounts(hostConfig: Record<string, unknown>): MountRequest[] | string {
  const requests: MountRequest[] = [];
  for (const binds of valuesFor(hostConfig, 'Binds')) {
    if (isUnset(binds)) continue;
    if (!Array.isArray(binds)) return 'HostConfig.Binds must be an array';
    for (const bind of binds) {
      if (typeof bind !== 'string') return 'each entry of HostConfig.Binds must be a string';
      const parsed = parseBind(bind);
      if (typeof parsed === 'string') return parsed;
      requests.push(parsed);
    }
  }
  for (const mounts of valuesFor(hostConfig, 'Mounts')) {
    if (isUnset(mounts)) continue;
    if (!Array.isArray(mounts)) return 'HostConfig.Mounts must be an array';
    for (const mount of mounts) {
      const parsed = parseMount(mount);
      if (typeof parsed === 'string') return parsed;
      if (parsed) requests.push(parsed);
    }
  }
  return requests;
}

/** A declared mount permits a source at or below its path, at or below its mode. */
function declaredMountPermits(declared: DockerMount, root: string, resolved: string, mode: MountMode): boolean {
  const declaredPath = path.resolve(root, declared.path);
  if (!inside(declaredPath, resolved)) return false;
  return declared.mode === 'rw' || mode === 'ro';
}

function checkMounts(hostConfig: Record<string, unknown>, ctx: DockerEvalContext, declared: DockerMount[]): DockerVerdict {
  const requests = collectMounts(hostConfig);
  if (typeof requests === 'string') return deny(requests);
  const realpath = ctx.realpath ?? ((p: string) => fs.realpathSync(p));
  const root = ctx.workspaceRoot;

  for (const { source, mode } of requests) {
    // Resolve before deciding, so `../` and symlinks are judged by where they
    // land, not how they are spelled. A source that does not exist cannot be
    // judged at all, and the daemon would create it on the host.
    let resolved: string;
    try {
      resolved = realpath(path.resolve(source));
    } catch {
      return deny(`mount source "${source}" could not be resolved; create it inside the workspace first`);
    }
    if (!inside(root, resolved)) {
      return deny(`mount source "${source}" is outside the job workspace and cannot be permitted by policy`);
    }
    if (!declared.some((m) => declaredMountPermits(m, root, resolved, mode))) {
      const relative = relativeTo(root, resolved);
      return deny(
        `mount "${source}" (${mode}) is not declared in the repository docker policy (run.mounts)`,
        hints.mount(relative, mode)
      );
    }
  }
  return ALLOW;
}

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

function evaluateCreate(req: DockerRequest, ctx: DockerEvalContext, policy: DockerPolicy): DockerVerdict {
  const body = req.body;
  if (!isPlainObject(body)) return deny('container create requires a JSON object body');
  if (!policy.run) {
    const image = typeof body.Image === 'string' ? body.Image : undefined;
    return deny('the repository docker policy declares no run action', image ? hints.image(image) : hints.run);
  }

  const hostConfig = pick(body, 'HostConfig') ?? {};
  if (!isPlainObject(hostConfig)) return deny('HostConfig must be an object');

  // Host-reaching settings first: none of these can be permitted by policy,
  // so the verdict does not depend on anything else in the request.
  const privilegedValues = valuesFor(hostConfig, 'Privileged');
  if (privilegedValues.some((v) => v === true)) {
    if (!policy.privileged) {
      return deny(
        'privileged containers are not declared in the repository docker policy; `privileged: true` requires a managed VM backend',
        ctx.supportsPrivileged ? hints.privileged : undefined
      );
    }
    if (!ctx.supportsPrivileged) {
      return deny('the repository docker policy declares privileged, which requires a managed VM backend; this daemon is not one');
    }
  } else if (privilegedValues.some((v) => !isUnset(v) && v !== false)) {
    return deny('HostConfig.Privileged must be a boolean');
  }
  for (const gate of HOST_CONFIG_GATES) {
    // Every casing must pass: one that does not is a value the daemon honours.
    if (!valuesFor(hostConfig, gate.key).every((v) => gate.permitted(v))) {
      return deny(`${gate.flag} (HostConfig.${gate.key}) reaches the host and cannot be permitted by policy`);
    }
  }

  // Image.
  const imageValues = valuesFor(body, 'Image');
  const image = pick(body, 'Image');
  if (typeof image !== 'string' || image === '') return deny('container create requires an Image');
  // Every casing must name a declared image: the daemon uses one of them, and
  // which one is not worth depending on.
  for (const candidate of imageValues) {
    if (typeof candidate !== 'string' || candidate === '') return deny('container create requires an Image');
    const wanted = normalizeImage(candidate);
    if (!(policy.run.images ?? []).some((declared) => normalizeImage(declared) === wanted)) {
      return deny(
        `image "${candidate}" is not declared in the repository docker policy (run.images)`,
        hints.image(candidate)
      );
    }
  }

  // Network. Absent, empty and "default" are the daemon default, bridge.
  const modeValues = valuesFor(hostConfig, 'NetworkMode');
  const rawModes: unknown[] = modeValues.length > 0 ? modeValues : [undefined];
  let mode = 'bridge';
  for (const rawMode of rawModes) {
    let candidate: string;
    if (isUnset(rawMode) || rawMode === '' || rawMode === 'default') candidate = 'bridge';
    else if (typeof rawMode === 'string') candidate = rawMode;
    else return deny('HostConfig.NetworkMode must be a string');
    if (candidate === 'host' || candidate.startsWith('container:')) {
      return deny(`--network=${candidate} (HostConfig.NetworkMode) reaches the host and cannot be permitted by policy`);
    }
    // The most restrictive reading wins when casings disagree.
    if (candidate !== 'bridge') mode = candidate;
  }
  if (mode !== 'none' && mode !== policy.run.network) {
    return deny(
      `network mode "${mode}" is not declared in the repository docker policy (run.network)`,
      hints.network(mode)
    );
  }

  return checkMounts(hostConfig, ctx, policy.run.mounts ?? []);
}

function evaluatePull(req: DockerRequest, policy: DockerPolicy): DockerVerdict {
  const fromImage = req.query.fromImage;
  if (req.query.fromSrc !== undefined) {
    return deny('importing an image (fromSrc) is not permitted; only pulls from a declared registry are');
  }
  if (!fromImage) return deny('image pull requires fromImage');
  const registry = registryOf(fromImage);
  if (!policy.pull) {
    return deny('the repository docker policy declares no pull action', hints.registry(registry));
  }
  if (!policy.pull.registries.includes(registry)) {
    return deny(
      `registry "${registry}" is not declared in the repository docker policy (pull.registries)`,
      hints.registry(registry)
    );
  }
  return ALLOW;
}

function evaluateBuild(req: DockerRequest, policy: DockerPolicy): DockerVerdict {
  if (!policy.build) return deny('the repository docker policy declares no build action', hints.build);
  // The Engine API carries the context as a tar the client assembled from
  // inside its sandbox. A remote context would have the daemon fetch it
  // itself - from the network, or from its own filesystem - which is the
  // one way a build reaches past the workspace.
  if (req.query.remote !== undefined) {
    return deny('a remote build context is not permitted; send the context with the request');
  }
  return ALLOW;
}

/**
 * Permit a per-container request only against a container this socket created.
 * The daemon accepts a unique id prefix, so a known id whose prefix was given
 * counts as the same container; anything else is another job's, or the
 * operator's, and is refused.
 */
function evaluateOwnContainer(req: DockerRequest, ctx: DockerEvalContext): DockerVerdict {
  const id = containerIdFrom(req);
  if (!id) return deny(`${req.method} ${req.path} is not permitted through the localmost docker socket`);

  const own = ctx.ownContainerIds;
  if (own && (own.has(id) || [...own].some((known) => known.startsWith(id)))) return ALLOW;

  return deny(
    `container "${id}" was not created through this job's docker socket; only this job's own containers can be addressed`
  );
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

export function evaluateDockerRequest(req: DockerRequest, ctx: DockerEvalContext): DockerVerdict {
  const action = classifyDockerRequest(req);
  if (BASELINE.has(action)) return ALLOW;

  const { policy } = ctx;
  if (!policy) return deny('no docker policy is bound to this socket');

  // A body the parser could not read is a request the filter cannot judge.
  if (req.bodyError) return deny(req.bodyError);

  switch (action) {
    case 'create':
      return evaluateCreate(req, ctx, policy);
    case 'inspect':
    case 'logs':
      // Reads about the job's own container: the documented baseline, scoped.
      return evaluateOwnContainer(req, ctx);
    case 'list':
      // No policy key grants it: it would enumerate the whole daemon.
      return deny(
        'listing containers is not permitted through the localmost docker socket; it would enumerate containers outside this job'
      );
    case 'start':
    case 'attach':
    case 'wait':
    case 'remove':
    case 'kill':
    case 'stop':
      if (!policy.run) return deny('the repository docker policy declares no run action', hints.run);
      return evaluateOwnContainer(req, ctx);
    case 'pull':
      return evaluatePull(req, policy);
    case 'build':
      return evaluateBuild(req, policy);
    default:
      return deny(`${req.method} ${req.path} is not permitted through the localmost docker socket`);
  }
}
