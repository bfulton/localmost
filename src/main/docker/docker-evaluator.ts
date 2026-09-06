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
import { DockerPolicy, DockerMount, DockerNetworkPolicy, MountMode } from '../../shared/docker-policy';
import { DockerRequest, DockerAction, classifyDockerRequest, containerIdFrom, imageRefFrom, networkIdFrom } from './docker-request';

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
  /**
   * Networks created through this socket, by id and by name. A container may
   * join one of these as well as the declared `run.network`, which is the
   * whole point of letting a job create one.
   */
  ownNetworkIds?: ReadonlySet<string>;
  /** Injected for tests; defaults to fs.realpathSync. Must throw when the path does not exist. */
  realpath?: (p: string) => string;
}

export interface DockerVerdict {
  allowed: boolean;
  /** Why it was refused, as the Docker API error message the client sees. */
  reason?: string;
  /** The policy that would permit it, as YAML under `docker:` (for --updaterc discovery). */
  policyHint?: string;
  /**
   * A create body whose mount sources are rewritten to the paths this verdict
   * actually checked. Forwarding the spelling the client sent would let the
   * daemon resolve it a second time, and the job can swap a symlink in the gap
   * between the two resolutions; forwarding what was checked closes that.
   */
  rewrittenBody?: unknown;
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
  network_declaration: (name: string, internal: boolean) =>
    `docker:\n  run:\n    networks:\n      - name: ${yamlString(name)}\n        internal: ${internal}`,
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
/**
 * HostConfig keys the filter understands and will forward.
 *
 * An allowlist, not a blocklist: enumerating the dangerous keys means every
 * key nobody thought of - and every key a future API version adds - is
 * forwarded unexamined. PortBindings was exactly that, publishing a container
 * port on the operator's interfaces, outside the proxy that controls the job's
 * egress. A key absent from this list is refused, which is the same principle
 * the grammar applies to itself: what cannot be named cannot be requested.
 *
 * These are the keys an ordinary `docker run` sends. Each is either inert
 * (resource limits, logging, restart behaviour) or gated below.
 */
const HOST_CONFIG_KNOWN: ReadonlySet<string> = new Set([
  // Gated below by value, or checked by the mount and network logic.
  'privileged', 'binds', 'mounts', 'networkmode', 'containeridfile', 'portbindings', 'publishallports',
  'pidmode', 'ipcmode', 'utsmode', 'usernsmode', 'cgroupnsmode', 'cgroupparent', 'cgroup',
  'devices', 'devicerequests', 'devicecgrouprules', 'securityopt', 'capadd', 'sysctls', 'runtime',
  'isolation', 'maskedpaths', 'readonlypaths', 'volumesfrom', 'extrahosts', 'groupadd', 'links',
  'volumedriver',
  // Inert: they bound the container, they do not widen it. Dropping capabilities
  // and setting resource limits or DNS search only ever restricts.
  'capdrop', 'autoremove', 'restartpolicy', 'logconfig', 'consolesize', 'readonlyrootfs', 'init',
  'oomscoreadj', 'oomkilldisable', 'shmsize', 'memory', 'memoryswap', 'memoryreservation',
  'memoryswappiness', 'kernelmemory', 'nanocpus', 'cpushares', 'cpuperiod', 'cpuquota',
  'cpurealtimeperiod', 'cpurealtimeruntime', 'cpusetcpus', 'cpusetmems', 'cpucount', 'cpupercent',
  'blkioweight', 'blkioweightdevice', 'blkiodevicereadbps', 'blkiodevicewritebps',
  'blkiodevicereadiops', 'blkiodevicewriteiops', 'pidslimit', 'dns', 'dnsoptions', 'dnssearch',
  'annotations', 'tmpfs', 'ulimits', 'iomaximumbandwidth', 'iomaximumiops',
]);

const HOST_CONFIG_GATES: ReadonlyArray<{ key: string; permitted: (v: unknown) => boolean; flag: string }> = [
  // The daemon writes the new container's id to this HOST path, so a non-empty
  // value creates or truncates a file anywhere the daemon can reach. The CLI
  // always sends it, empty.
  { key: 'ContainerIDFile', permitted: isEmptyString, flag: '--cidfile' },
  // Publishing binds a listening socket on the operator's interfaces, exposing
  // a container service to their network and outside the proxy that controls
  // this job's egress. The CLI sends both, empty, on every run.
  { key: 'PortBindings', permitted: isEmptyObject, flag: '-p/--publish' },
  { key: 'PublishAllPorts', permitted: (v: unknown) => isUnset(v) || v === false, flag: '-P/--publish-all' },
  { key: 'PidMode', permitted: isEmptyString, flag: '--pid' },
  // Each is sent empty by every ordinary run, and each reaches outside the
  // container when it is not: a cgroup to join, hosts entries, extra groups,
  // a link to another job's container, or a volume driver that can bind-mount.
  { key: 'Cgroup', permitted: isEmptyString, flag: '--cgroup' },
  { key: 'ExtraHosts', permitted: isEmptyArray, flag: '--add-host' },
  { key: 'GroupAdd', permitted: isEmptyArray, flag: '--group-add' },
  { key: 'Links', permitted: isEmptyArray, flag: '--link' },
  { key: 'VolumeDriver', permitted: isEmptyString, flag: '--volume-driver' },
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
  const type = pick(mount, 'Type');
  if (type === 'tmpfs') return null;
  if (type === 'volume') {
    // A volume is only container-lifecycle storage while it uses the default
    // driver with no options. The built-in local driver with
    // type=none,o=bind,device=<path> IS a bind mount - the mechanism compose
    // exposes as driver_opts - so an "anonymous" volume carrying driver
    // options reaches an arbitrary host path, read-write, having skipped every
    // mount check because it declares no Source.
    const volumeOptions = pick(mount, 'VolumeOptions');
    if (isPlainObject(volumeOptions) && !isUnset(pick(volumeOptions, 'DriverConfig'))) {
      return 'a volume with DriverConfig is not permitted: a volume driver can bind-mount a host path, which only a declared workspace mount may do';
    }
    if (isEmptyString(pick(mount, 'Source'))) return null; // anonymous: lives with the container
    return `"${String(pick(mount, 'Source'))}" is a named volume, not a workspace path; only declared workspace mounts are permitted`;
  }
  if (type !== 'bind') return `mount type "${String(type)}" is not permitted`;
  const source = pick(mount, 'Source');
  if (typeof source !== 'string' || !path.isAbsolute(source)) {
    return 'a bind mount needs an absolute Source';
  }
  const options = pick(mount, 'BindOptions');
  if (options !== undefined && options !== null) {
    if (!isPlainObject(options)) return 'BindOptions must be an object';
    const propagation = pick(options, 'Propagation') ?? '';
    if (!PROPAGATIONS.has(propagation as string)) {
      return `mount propagation "${String(propagation)}" is not permitted`;
    }
  }
  // Any casing that says read-only counts; a mount is rw only when none does.
  const readOnly = valuesFor(mount, 'ReadOnly').some((v) => v === true);
  return { source, mode: readOnly ? 'ro' : 'rw' };
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

function checkMounts(
  hostConfig: Record<string, unknown>,
  ctx: DockerEvalContext,
  declared: DockerMount[],
  resolutions?: Map<string, string>
): DockerVerdict {
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
    resolutions?.set(source, resolved);
  }
  return ALLOW;
}

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

/** A copy of the create body with every bind source replaced by its resolved path. */
function pinMountSources(body: Record<string, unknown>, resolved: Map<string, string>): unknown {
  const pinned: Record<string, unknown> = { ...body };
  for (const hostConfigKey of Object.keys(pinned)) {
    if (hostConfigKey.toLowerCase() !== 'hostconfig') continue;
    const hostConfig = pinned[hostConfigKey];
    if (!isPlainObject(hostConfig)) continue;
    const copy: Record<string, unknown> = { ...hostConfig };
    for (const key of Object.keys(copy)) {
      const name = key.toLowerCase();
      if (name === 'binds' && Array.isArray(copy[key])) {
        copy[key] = (copy[key] as unknown[]).map((bind) => {
          if (typeof bind !== 'string') return bind;
          const parts = bind.split(':');
          const target = resolved.get(parts[0]);
          if (target === undefined) return bind;
          return [target, ...parts.slice(1)].join(':');
        });
      }
      if (name === 'mounts' && Array.isArray(copy[key])) {
        copy[key] = (copy[key] as unknown[]).map((mount) => {
          if (!isPlainObject(mount)) return mount;
          const entry: Record<string, unknown> = { ...mount };
          for (const mountKey of Object.keys(entry)) {
            if (mountKey.toLowerCase() !== 'source') continue;
            const source = entry[mountKey];
            if (typeof source === 'string' && resolved.has(source)) entry[mountKey] = resolved.get(source);
          }
          return entry;
        });
      }
    }
    pinned[hostConfigKey] = copy;
  }
  return pinned;
}

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
  for (const key of Object.keys(hostConfig)) {
    if (!HOST_CONFIG_KNOWN.has(key.toLowerCase())) {
      return deny(
        `HostConfig.${key} is not a setting the localmost docker socket understands, so it cannot be forwarded`
      );
    }
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
    if (!(policy.run.images ?? []).some((declared) => globMatches(normalizeImage(declared), wanted))) {
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
  // A network this job created is as good as the declared one: creating it was
  // already checked against run.networks, and refusing to join it would make
  // declaring one pointless.
  if (mode !== 'none' && mode !== policy.run.network && !ctx.ownNetworkIds?.has(mode)) {
    return deny(
      `network mode "${mode}" is not declared in the repository docker policy (run.network)`,
      hints.network(mode)
    );
  }

  // Pin every mount source to the path that was actually checked, so the
  // daemon mounts what the filter judged rather than re-resolving a name the
  // job can point somewhere else in between.
  const resolutions = new Map<string, string>();
  const verdict = checkMounts(hostConfig, ctx, policy.run.mounts ?? [], resolutions);
  if (!verdict.allowed || resolutions.size === 0) return verdict;
  return { allowed: true, rewrittenBody: pinMountSources(body, resolutions) };
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

/**
 * Build query parameters the filter understands.
 *
 * An allowlist for the same reason HostConfig is one: `docker build` carries
 * its whole configuration in the query string, so anything not enumerated is
 * forwarded unexamined. `networkmode` is gated separately below, since it is
 * the same host reach the run path already refuses.
 */
const BUILD_PARAMS_KNOWN: ReadonlySet<string> = new Set([
  't', 'dockerfile', 'q', 'nocache', 'rm', 'forcerm', 'pull', 'buildargs', 'labels', 'target',
  'shmsize', 'memory', 'memswap', 'cpushares', 'cpusetcpus', 'cpuperiod', 'cpuquota', 'squash',
  'platform', 'version', 'buildid', 'session',
]);

/** Keys a network create may carry freely: they name the network or are inert. */
const NETWORK_CREATE_KNOWN: ReadonlySet<string> = new Set(['name', 'internal', 'checkduplicate', 'labels', 'driver']);

/** Is an IPAM block the default one the CLI always sends, granting nothing? */
const isDefaultIpam = (v: unknown): boolean => {
  if (isUnset(v)) return true;
  if (!isPlainObject(v)) return false;
  const driver = pick(v, 'Driver');
  if (!isUnset(driver) && driver !== '' && driver !== 'default') return false;
  return isEmptyObject(pick(v, 'Options')) && isEmptyArray(pick(v, 'Config'));
};

/**
 * Keys the docker CLI sends on every `network create` with an inert value.
 *
 * Refusing them outright made the feature reachable only from a hand-written
 * API client - the CLI sends all of these unconditionally. So they are gated by
 * value, exactly as HostConfig gates the keys a plain `docker run` always
 * sends: the default passes, anything meaningful is refused.
 */
const NETWORK_CREATE_GATES: ReadonlyArray<{ key: string; permitted: (v: unknown) => boolean; why: string }> = [
  { key: 'Scope', permitted: isEmptyString, why: 'a scope reaches beyond this daemon' },
  { key: 'IPAM', permitted: isDefaultIpam, why: 'an IPAM driver or subnet places the network on a chosen address range' },
  { key: 'Options', permitted: isEmptyObject, why: 'driver options can bind a bridge to a host address' },
  { key: 'Attachable', permitted: (v) => isUnset(v) || v === false, why: 'an attachable network can be joined from outside this job' },
  { key: 'Ingress', permitted: (v) => isUnset(v) || v === false, why: 'an ingress network is swarm routing mesh' },
  { key: 'ConfigOnly', permitted: (v) => isUnset(v) || v === false, why: 'a config-only network is a template for others' },
  { key: 'ConfigFrom', permitted: (v) => isUnset(v) || isEmptyObject(v), why: 'it copies configuration from another network' },
  { key: 'EnableIPv6', permitted: (v) => isUnset(v) || v === false, why: 'IPv6 is not part of what the grammar can describe' },
];

/**
 * An anchored glob. `*` matches any run of characters except `/`, and nothing
 * else is special.
 *
 * Anchored so a declared name cannot be widened by a prefix: `vk-*` does not
 * match `other-vk-abc`. Stopping at `/` for the same reason one level down - a
 * glob that silently spans path separators reads as narrower than it is, so
 * `vk/*` reaches one level under `vk` and no further, and each extra segment
 * has to be asked for. A tag glob is unaffected, since a tag cannot contain a
 * slash: `vk/grader:*` still covers a content-addressed tag.
 */
function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '\u0000' : `\\${c}`));
  return new RegExp(`^${escaped.split('\u0000').join('[^/]*')}$`).test(value);
}

function evaluateNetworkCreate(req: DockerRequest, policy: DockerPolicy): DockerVerdict {
  const declared: DockerNetworkPolicy[] = policy.run?.networks ?? [];
  if (declared.length === 0) {
    return deny(
      'the repository docker policy declares no networks',
      hints.network_declaration('name-of-your-network', true)
    );
  }
  const body = req.body;
  if (!isPlainObject(body)) return deny('network create requires a JSON body');

  const gatedKeys = new Set(NETWORK_CREATE_GATES.map((g) => g.key.toLowerCase()));
  for (const key of Object.keys(body)) {
    const name = key.toLowerCase();
    if (NETWORK_CREATE_KNOWN.has(name) || gatedKeys.has(name)) continue;
    return deny(`network create parameter "${key}" is not one the localmost docker socket understands`);
  }
  for (const gate of NETWORK_CREATE_GATES) {
    // Every casing must pass: the daemon decodes these case-insensitively.
    if (!valuesFor(body, gate.key).every((v) => gate.permitted(v))) {
      return deny(`network ${gate.key} is not permitted: ${gate.why}`);
    }
  }

  // The filter creates a plain bridge or nothing. macvlan and ipvlan put a
  // container on the physical LAN, which is worse than host networking.
  for (const driver of valuesFor(body, 'Driver')) {
    if (!isUnset(driver) && driver !== '' && driver !== 'bridge') {
      return deny(`network driver "${String(driver)}" is not permitted; the localmost docker socket creates bridge networks only`);
    }
  }

  const names = valuesFor(body, 'Name');
  if (names.length === 0) return deny('network create requires a Name');
  const internalValues = valuesFor(body, 'Internal');
  const internal = internalValues.length > 0 && internalValues.every((v) => v === true);

  // Every casing must name a declared network, since which one the daemon uses
  // is not worth depending on.
  for (const name of names) {
    if (typeof name !== 'string' || name === '') return deny('network create requires a Name');
    const match = declared.find((n) => globMatches(n.name, name));
    if (!match) {
      return deny(
        `network "${name}" is not declared in the repository docker policy (run.networks)`,
        hints.network_declaration(name, internal)
      );
    }
    if (match.internal && !internal) {
      return deny(
        `network "${name}" is declared internal, so it cannot be created routable`,
        hints.network_declaration(match.name, false)
      );
    }
  }
  return ALLOW;
}

/** Permit a per-network request only against a network this socket created. */
function evaluateOwnNetwork(req: DockerRequest, ctx: DockerEvalContext): DockerVerdict {
  const id = networkIdFrom(req);
  if (!id) return deny(`${req.method} ${req.path} is not permitted through the localmost docker socket`);
  if (ctx.ownNetworkIds?.has(id)) return ALLOW;
  return deny(`network "${id}" was not created through this job's docker socket`);
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

  for (const key of Object.keys(req.query)) {
    const name = key.toLowerCase();
    if (name === 'networkmode') continue;
    if (!BUILD_PARAMS_KNOWN.has(name)) {
      return deny(`build parameter "${key}" is not one the localmost docker socket understands, so it cannot be forwarded`);
    }
  }

  // A build runs containers, and its network is chosen here rather than in a
  // HostConfig - so the same rule the run path applies has to apply here too,
  // or `docker build --network host` walks through a door create keeps shut.
  const rawMode = req.query.networkmode ?? req.query.NetworkMode;
  if (rawMode !== undefined && rawMode !== '' && rawMode !== 'default') {
    if (rawMode === 'host' || rawMode.startsWith('container:')) {
      return deny(`--network=${rawMode} on a build reaches the host and cannot be permitted by policy`);
    }
    if (rawMode !== 'none' && rawMode !== policy.run?.network) {
      return deny(
        `build network "${rawMode}" is not declared in the repository docker policy (run.network)`,
        hints.network(rawMode)
      );
    }
  }

  return ALLOW;
}

/**
 * Permit a per-container request only against a container this socket created,
 * addressed by the id the daemon assigned or the name the job asked for.
 * Anything else is another job's container, or the operator's, and is refused.
 */
function evaluateOwnContainer(req: DockerRequest, ctx: DockerEvalContext): DockerVerdict {
  const id = containerIdFrom(req);
  if (!id) return deny(`${req.method} ${req.path} is not permitted through the localmost docker socket`);

  // Exact match only. A bare prefix used to count, on the reasoning that the
  // daemon accepts one - but a prefix of a container this job has since
  // removed can resolve on the shared daemon to somebody else's.
  if (ctx.ownContainerIds?.has(id)) return ALLOW;

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
    case 'image-inspect': {
      // Scoped by the policy, not by a second ownership ledger: an inspect of
      // an image run.images already names discloses nothing the policy has not
      // granted, and the container ledger has already produced one defect.
      if (!policy.run) return deny('the repository docker policy declares no run action', hints.run);
      const ref = imageRefFrom(req);
      if (!ref) return deny(`${req.method} ${req.path} is not permitted through the localmost docker socket`);
      const wanted = normalizeImage(ref);
      if (!(policy.run.images ?? []).some((declared) => globMatches(normalizeImage(declared), wanted))) {
        return deny(
          `image "${ref}" is not declared in the repository docker policy (run.images)`,
          hints.image(ref)
        );
      }
      return ALLOW;
    }
    case 'network-create':
      return evaluateNetworkCreate(req, policy);
    case 'network-inspect':
    case 'network-remove':
      return evaluateOwnNetwork(req, ctx);
    case 'buildkit':
      return deny(
        'BuildKit builds cannot be filtered: the build streams over a gRPC session that exports host ' +
          'filesystem access to the daemon, so no request carries the paths it reads. Jobs are pinned to ' +
          'the classic builder with DOCKER_BUILDKIT=0, which `build:` policy does describe - seeing this ' +
          'means something set DOCKER_BUILDKIT back on.'
      );
    case 'network-list':
      return deny(
        'listing networks is not permitted through the localmost docker socket; it would enumerate networks outside this job'
      );
    default:
      return deny(`${req.method} ${req.path} is not permitted through the localmost docker socket`);
  }
}
