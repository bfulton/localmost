/**
 * The filtering docker socket served to one worker.
 *
 * Each worker gets a unix socket of its own, inside its sandbox directory,
 * and DOCKER_HOST points the job at it. Every Docker Engine API request that
 * arrives is parsed, checked against the policy bound to this socket, and
 * forwarded to the backend daemon only if permitted. Mirrors ProxyServer's
 * shape, with one difference that removes a bug class: a socket is born
 * denying everything and is bound to exactly one repository's policy when
 * the job is claimed, so there is no state to reset between jobs. See
 * docs/superpowers/specs/2026-09-05-docker-isolation-design.md.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import * as zlib from 'zlib';
import { DockerPolicy } from '../../shared/docker-policy';
import { ApprovedBind, DockerBackend, DockerProgress, NO_DAEMON_MESSAGE, WorkerDocker } from './docker-backend';
import { DockerAction, DockerRequest, classifyDockerRequest, containerIdFrom, imageRefFrom, networkIdFrom, parseDockerRequest } from './docker-request';
import { evaluateDockerRequest, pullRequestOf } from './docker-evaluator';

export interface DockerFilterProxyLogEntry {
  level: 'info' | 'warn' | 'debug';
  message: string;
  /** On a denial, the policy that would have permitted the request (for --updaterc). */
  policyHint?: string;
}

export interface DockerFilterProxyOptions {
  backend: DockerBackend;
  /** This worker's daemon: its VM, its pulls, its approvals. From backend.forWorker. */
  worker: WorkerDocker;
  onLog?: (entry: DockerFilterProxyLogEntry) => void;
  /** Oldest API version forwarded. Default v1.24. */
  minApiVersion?: string;
  /** Newest API version forwarded, and the one the job is told to negotiate to. Default v1.45. */
  maxApiVersion?: string;
  /** How long a request waits for the job's VM to be ready. Default 60 s (dockerVm.bootTimeoutSec). */
  bootTimeoutMs?: number;
  /** Injected for tests; defaults to fs.realpathSync. */
  realpath?: (p: string) => string;
  /** How long one removal waits for the daemon when the socket stops. Injected for tests; default 10s. */
  removeTimeoutMs?: number;
}

/** macOS caps sun_path at 104 bytes including the terminator, and truncates silently. */
const MAX_SOCKET_PATH_BYTES = 103;

/** A real create body is a few KB. Anything larger is not one. */
const MAX_JSON_BODY_BYTES = 1024 * 1024;

/** How much of an upload is drained so an early answer reaches the client, before the connection is cut. */
const MAX_DRAIN_BYTES = 8 * MAX_JSON_BODY_BYTES;

/** A response head larger than this is not an upgrade handshake. */
const MAX_UPGRADE_HEAD_BYTES = 64 * 1024;

/** Hop-by-hop headers: each leg of the relay decides these for itself. */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection'];

/**
 * The fields of /info a job is shown. Clients read these to decide how to talk
 * to the daemon (version, platform, storage driver, cgroup and seccomp
 * support) and to size what they start. The rest describes the operator's
 * machine and setup rather than the daemon: the host name, the proxy URLs
 * with any credentials in them, registry mirrors and insecure ranges, labels,
 * how many containers and images other jobs and the operator have, swarm
 * membership. An allowlist, so a field a newer daemon adds is withheld until
 * someone decides it is harmless.
 */
const INFO_FIELDS: ReadonlySet<string> = new Set([
  'ServerVersion',
  'OSType',
  'Architecture',
  'OperatingSystem',
  'KernelVersion',
  'NCPU',
  'MemTotal',
  'Driver',
  'CgroupVersion',
  'SecurityOptions',
]);

/**
 * A real /info is a few KB. It is held whole to be rewritten, in the main
 * process, so a body - or a gzip body once inflated - past this is refused
 * rather than buffered.
 */
const MAX_INFO_BYTES = 1024 * 1024;

/**
 * Every daemon answer the filter holds to parse - a create, a network create,
 * /version, /info - is capped at this. With guest root, dockerd's answers are
 * the job's to choose, and Electron main is shared by every job.
 */
const MAX_DAEMON_ANSWER_BYTES = MAX_JSON_BODY_BYTES;

const OVERSIZED_ANSWER_MESSAGE = 'the Docker VM sent an oversized answer';

const APPROVAL_FAILED_MESSAGE = "could not register the approved binds with the job's Docker VM";

const DEFAULT_BOOT_TIMEOUT_MS = 60_000;

/** A container id as the daemon assigns one. */
const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;
/** A network's id is the same form. */
const NETWORK_ID_RE = CONTAINER_ID_RE;

/**
 * A build that failed looking up a registry: the classic builder pulling a
 * FROM image from inside the VM, which reaches no registry.
 */
const REGISTRY_LOOKUP_FAILURE = /lookup [^\s"]+ on 198\.18\.0\.1|dial tcp: lookup [^\s"]+|no such host/;

/**
 * How long one removal may take when the socket stops. A forced remove kills
 * the container first, which a daemon does in well under this; one that has
 * not answered by then is logged rather than waited on.
 */
const REMOVE_TIMEOUT_MS = 10_000;

/**
 * How many removals are in flight at once. A job can leave as many containers
 * as it likes, and a removal each at once would open that many connections to
 * the daemon from the main process.
 */
const REMOVE_CONCURRENCY = 8;

/**
 * The pause before a failed removal is asked for again. Long enough for the
 * daemon to finish removing a `--rm` container that raced the first attempt.
 */
const REMOVE_RETRY_DELAY_MS = 250;

const DEFAULT_MIN_API_VERSION = 'v1.24';
const DEFAULT_MAX_API_VERSION = 'v1.45';

/** An image id, as dockerd names a loaded image: `sha256:` and the config digest. */
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

type ApiVersion = [number, number];

function parseApiVersion(value: string): ApiVersion {
  const m = /^v?(\d+)\.(\d+)$/.exec(value);
  if (!m) throw new Error(`not a Docker API version: ${value}`);
  return [Number(m[1]), Number(m[2])];
}

const compareApiVersions = (a: ApiVersion, b: ApiVersion): number => a[0] - b[0] || a[1] - b[1];

const bareVersion = (v: ApiVersion): string => `${v[0]}.${v[1]}`;

/** Headers as the parser wants them: one string per name, lower-cased. */
function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * A key read the way the daemon reads it, for the one field this file records.
 *
 * The evaluator judges every body case-insensitively because Go's decoder
 * does; recording ownership case-sensitively meant a client that sent `name`
 * created a network the evaluator had approved and the proxy then refused to
 * let it address. Unambiguous by construction: a body with two casings of one
 * key never reaches here, the evaluator refuses it.
 */
const readFolded = (obj: Record<string, unknown>, name: string): unknown => {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(obj)) if (key.toLowerCase() === wanted) return value;
  return undefined;
};

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isJsonContentType = (contentType: string | undefined): boolean =>
  contentType !== undefined && contentType.split(';')[0].trim().toLowerCase() === 'application/json';

/**
 * A response body as text, undoing the one compression a daemon (or a proxy
 * in front of it) might apply. Throws on any other encoding: a body the filter
 * cannot read is one it cannot rewrite. Throws too on a gzip body that inflates
 * past MAX_INFO_BYTES, which a few KB on the wire can.
 */
function decodeBody(raw: Buffer, contentEncoding: string | undefined): string {
  const encoding = (contentEncoding ?? '').trim().toLowerCase();
  if (encoding === '' || encoding === 'identity') return raw.toString('utf8');
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    return zlib.gunzipSync(raw, { maxOutputLength: MAX_INFO_BYTES }).toString('utf8');
  }
  throw new Error(`unsupported content encoding: ${encoding}`);
}

/** Run `task` over every item, with at most `limit` in progress at once. */
async function eachAtMost<T>(limit: number, items: T[], task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export class DockerFilterProxy {
  private server: http.Server | null = null;
  private socketPath: string | null = null;
  /**
   * The directory the socket is served in - the job's sandbox - resolved
   * through symlinks when the socket starts. The app made it, before the job
   * existed, so that answer is the app's; resolved again later, it would be
   * whatever the job had made of it by then.
   */
  private sandboxDir: string | null = null;
  private policy: DockerPolicy | null = null;
  /**
   * Containers created through this socket. The daemon is shared with the
   * operator and with other jobs, so a per-container request is permitted only
   * against one of these - otherwise a job could read, start or remove another
   * job's container by naming its id.
   */
  private readonly ownContainerIds = new Set<string>();
  /** Each identifier this socket may address, mapped to the container it names. */
  private readonly ownContainerAliases = new Map<string, string>();
  /** Networks created through this socket, by id and by the name the job asked for. */
  private readonly ownNetworkIds = new Set<string>();
  private readonly ownNetworkAliases = new Map<string, string>();
  /** The ids of owned networks created internal: no proxy is injected into their containers. */
  private readonly internalNetworkIds = new Set<string>();
  private repository: string | undefined;
  private readonly backend: DockerBackend;
  private readonly worker: WorkerDocker;
  private readonly onLog: (entry: DockerFilterProxyLogEntry) => void;
  private readonly minApiVersion: ApiVersion;
  private readonly maxApiVersion: ApiVersion;
  private readonly bootTimeoutMs: number;
  private readonly realpath: (p: string) => string;
  private readonly removeTimeoutMs: number;
  private readonly connections: Set<net.Socket> = new Set();
  /**
   * Never keep-alive. A pooled client socket sheds its http error listener
   * the moment a response completes, and a daemon that answers before a
   * large streamed body has arrived then turns the still-pending write into
   * an uncaught EPIPE - in the main process. Without pooling the listener
   * stays for the life of the socket and the error reaches the request.
   */
  private readonly upstreamAgent = new http.Agent({ keepAlive: false });
  private warnedNoDaemon = false;
  private warnedBaseImage = false;
  /** The stop in progress, so a second caller waits for the same removals. */
  private stopping: Promise<void> | null = null;

  constructor(options: DockerFilterProxyOptions) {
    this.backend = options.backend;
    this.worker = options.worker;
    this.onLog = options.onLog ?? (() => {});
    this.minApiVersion = parseApiVersion(options.minApiVersion ?? DEFAULT_MIN_API_VERSION);
    this.maxApiVersion = parseApiVersion(options.maxApiVersion ?? DEFAULT_MAX_API_VERSION);
    if (compareApiVersions(this.minApiVersion, this.maxApiVersion) > 0) {
      throw new Error('minApiVersion is above maxApiVersion');
    }
    this.bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    this.realpath = options.realpath ?? ((p) => fs.realpathSync(p));
    this.removeTimeoutMs = options.removeTimeoutMs ?? REMOVE_TIMEOUT_MS;
  }

  /** Record an identifier the job may use for a container it created. */
  private own(alias: string, containerId: string): void {
    this.ownContainerAliases.set(alias, containerId);
    this.ownContainerIds.add(alias);
  }

  /** Record an identifier for a network the job created. */
  private ownNetwork(alias: string, networkId: string): void {
    this.ownNetworkAliases.set(alias, networkId);
    this.ownNetworkIds.add(alias);
  }

  /** Forget every identifier for a network the job has removed. */
  private disownNetwork(alias: string): void {
    const networkId = this.ownNetworkAliases.get(alias);
    if (networkId === undefined) return;
    for (const [known, owner] of [...this.ownNetworkAliases]) {
      if (owner !== networkId) continue;
      this.ownNetworkAliases.delete(known);
      this.ownNetworkIds.delete(known);
    }
    this.internalNetworkIds.delete(networkId);
  }

  /** Forget every identifier for a container the job has removed. */
  private disown(alias: string): void {
    const containerId = this.ownContainerAliases.get(alias);
    if (containerId === undefined) return;
    for (const [known, owner] of [...this.ownContainerAliases]) {
      if (owner !== containerId) continue;
      this.ownContainerAliases.delete(known);
      this.ownContainerIds.delete(known);
    }
  }

  /**
   * Bind the socket to a repository and its policy. Until this is called the
   * socket denies everything but the baseline; the caller binds only once
   * the claimed job's repository is known to match.
   */
  bind(repository: string, policy: DockerPolicy): void {
    this.repository = repository;
    this.policy = policy;
    this.onLog({ level: 'info', message: `docker socket bound to ${repository}` });
    // The worker decides whether this is the bind that boots its VM: the
    // first one with grants does, and no other (contract §5.1).
    this.worker.bind(repository, policy);
  }

  /**
   * A claim this socket stays closed for - a job of another repository than
   * the spawn's, or a policy that drifted - so nothing is bound, and the
   * worker stops its spare, which no job of this worker will use.
   */
  staysClosed(reason: string): void {
    this.worker.dropSpare(reason);
  }

  /** The repository this socket is bound to, or undefined while it denies all. */
  boundRepository(): string | undefined {
    return this.repository;
  }

  async start(socketPath: string): Promise<void> {
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
      throw new Error(
        `docker socket path is ${Buffer.byteLength(socketPath)} bytes; macOS truncates unix socket paths over 104`
      );
    }
    // The sandbox directory is rebuilt per job, so a file here is a leftover
    // of our own, never something else's socket.
    fs.rmSync(socketPath, { force: true });
    const sandboxDir = this.realpath(path.dirname(path.resolve(socketPath)));

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      // Every answer here arrives after a round trip to the daemon, so it is
      // written after a client that half-closes on sending (an HTTP/1.0
      // client, `nc -U`, a health probe) has already sent its FIN. By default
      // an http.Server treats that FIN as the end of the exchange and ends its
      // own side, and the late response is dropped on the floor: the client
      // reads nothing and waits for a close that never comes. Keep the write
      // side open until the response is ended. The flag is a real property of
      // http.Server (the HTTP-layer counterpart of net's allowHalfOpen) that
      // @types/node does not declare, hence the cast.
      (server as http.Server & { httpAllowHalfOpen: boolean }).httpAllowHalfOpen = true;
      server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as net.Socket, head));
      server.on('connection', (socket) => {
        this.connections.add(socket);
        socket.on('close', () => this.connections.delete(socket));
      });
      server.on('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        this.server = server;
        this.socketPath = socketPath;
        this.sandboxDir = sandboxDir;
        resolve();
      });
    });
  }

  /**
   * Stop serving, then remove what the job created through this socket.
   *
   * A container outlives the process that started it: `docker run -d` returns
   * at once, and the container keeps its unfiltered egress and its route to
   * the host long after the job has ended. So the containers go with the
   * socket - forced, since a running one is the case that matters, and with
   * their anonymous volumes - and then the networks the job created. The
   * socket closes first, so the job cannot create another during the sweep. A
   * create still in flight then may reach the daemon, but its answer, and so
   * its id, is lost with the job's connection, and its start, which needs
   * this socket too, cannot happen: that container is created and never runs.
   *
   * A removal that fails is asked for once more, then logged, and the stop
   * still completes. A second call while one is in progress waits for the
   * same removals.
   */
  stop(): Promise<void> {
    this.stopping ??= this.teardown().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async teardown(): Promise<void> {
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(resolve, 1000);
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
      });
      if (this.socketPath) fs.rmSync(this.socketPath, { force: true });
    }
    // A daemon thrown away with the worker needs no sweep: the VM, and every
    // container and network in it, goes when the worker's VM is released.
    if (!this.backend.disposable) await this.removeOwned();
    else this.forgetOwned();
    this.upstreamAgent.destroy();
    try {
      await this.worker.release();
    } catch (err) {
      this.onLog({ level: 'warn', message: `could not release the job's Docker VM: ${(err as Error).message}` });
    }
  }

  private forgetOwned(): void {
    this.ownContainerAliases.clear();
    this.ownContainerIds.clear();
    this.ownNetworkAliases.clear();
    this.ownNetworkIds.clear();
    this.internalNetworkIds.clear();
  }

  /** Force-remove every container, then every network, this socket created. */
  private async removeOwned(): Promise<void> {
    const containers = [...new Set(this.ownContainerAliases.values())];
    const networks = [...new Set(this.ownNetworkAliases.values())];
    this.forgetOwned();
    if (containers.length === 0 && networks.length === 0) return;

    // Now or never: nothing is waited for at stop.
    const state = await this.worker.endpoint(0);
    const endpoint = state.kind === 'ready' ? { socketPath: state.socketPath } : null;
    if (!endpoint) {
      const what = [...containers.map((id) => `container ${id}`), ...networks.map((id) => `network ${id}`)];
      this.onLog({ level: 'warn', message: `could not remove ${what.join(', ')} the job created: ${NO_DAEMON_MESSAGE}` });
      return;
    }
    // Unversioned, so the daemon serves them at its own API version. The job's
    // requests carry the version it negotiated, but these are the socket's
    // own, and a daemon older than maxApiVersion refuses that one with a 400;
    // a fixed older one fails the other way once a daemon's minimum passes it.
    // Neither endpoint, nor force and v, has changed across versions.
    const remove = (targets: Array<{ what: string; url: string }>): Promise<void> =>
      eachAtMost(REMOVE_CONCURRENCY, targets, ({ what, url }) => this.removeWithRetry(endpoint.socketPath, what, url));
    // A network with a container still attached cannot be removed, so the
    // containers go first.
    await remove(containers.map((id) => ({ what: `container ${id}`, url: `/containers/${encodeURIComponent(id)}?force=1&v=1` })));
    await remove(networks.map((id) => ({ what: `network ${id}`, url: `/networks/${encodeURIComponent(id)}` })));
  }

  /**
   * Remove one thing, asking once more after a pause if the first attempt
   * fails; resolves whatever happens, logging a removal that failed twice.
   * The second attempt also settles a `--rm` container the daemon was already
   * removing, which it answers with a 409 and then, once it is gone, a 404.
   */
  private async removeWithRetry(socketPath: string, what: string, url: string): Promise<void> {
    if ((await this.removeFromDaemon(socketPath, url)) === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_DELAY_MS));
    const problem = await this.removeFromDaemon(socketPath, url);
    if (problem !== undefined) this.onLog({ level: 'warn', message: `could not remove ${what} the job created: ${problem}` });
  }

  /** One DELETE against the daemon; resolves with what went wrong, if anything. */
  private removeFromDaemon(socketPath: string, url: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (problem?: string): void => {
        if (settled) return;
        settled = true;
        resolve(problem);
      };
      const req = http.request(
        { socketPath, path: url, method: 'DELETE', agent: this.upstreamAgent, timeout: this.removeTimeoutMs },
        (res) => {
          const status = res.statusCode ?? 502;
          res.resume();
          res.on('error', (err) => done(err.message));
          // Already gone - an AutoRemove container that exited, say - is removed.
          res.on('end', () => done((status >= 200 && status < 300) || status === 404 ? undefined : `the daemon answered ${status}`));
        }
      );
      req.on('timeout', () => req.destroy(new Error(`no answer in ${this.removeTimeoutMs / 1000}s`)));
      req.on('error', (err) => done(err.message));
      req.end();
    });
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  // ---------------------------------------------------------------------------
  // Deciding
  // ---------------------------------------------------------------------------

  /** Write a Docker API error the job can act on, leaving the response open. */
  private writeRefusal(res: http.ServerResponse, status: number, message: string): void {
    const body = JSON.stringify({ message });
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.write(body);
  }

  private refuse(res: http.ServerResponse, status: number, message: string): void {
    this.writeRefusal(res, status, message);
    res.end();
  }

  /**
   * End the response once the request body has been read to its end.
   *
   * An answer can be ready while the job is still uploading - a refusal on
   * the request line, or a daemon that answered early. Ending the response
   * then would close the connection with unread data on it, and a client
   * whose write fails first may never read the answer. So the upload is
   * drained, up to a limit, and the response ends after it.
   */
  private endAfterDrain(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.readableEnded || req.destroyed) {
      res.end();
      return;
    }
    let drained = 0;
    req.on('data', (chunk: Buffer) => {
      drained += chunk.length;
      if (drained > MAX_DRAIN_BYTES) req.destroy();
    });
    req.on('end', () => res.end());
    req.on('close', () => {
      if (!res.writableEnded) res.end();
    });
    req.resume();
  }

  /** Null when the request may proceed; otherwise the status and message that refuse it. */
  private decide(req: DockerRequest): {
    refusal: { status: number; message: string } | null;
    rewrittenBody?: unknown;
    approvedBinds?: ApprovedBind[];
  } {
    // A target the parser could not read is a request the filter cannot judge.
    // Before this, the parse threw out of the request handler: no refusal was
    // written and the connection sat open until the client gave up.
    if (req.targetError) {
      this.onLog({ level: 'info', message: `refused ${req.method} ${req.raw.url}: ${req.targetError}` });
      return { refusal: { status: 400, message: req.targetError } };
    }
    if (req.apiVersion) {
      const version = parseApiVersion(req.apiVersion);
      if (
        compareApiVersions(version, this.minApiVersion) < 0 ||
        compareApiVersions(version, this.maxApiVersion) > 0
      ) {
        const message =
          `API version ${req.apiVersion} is not supported by the localmost docker socket ` +
          `(supported: v${bareVersion(this.minApiVersion)} to v${bareVersion(this.maxApiVersion)})`;
        this.onLog({ level: 'info', message: `refused ${req.method} ${req.path}: ${message}` });
        return { refusal: { status: 400, message } };
      }
    }

    const sandboxDir = this.sandboxDir;
    if (sandboxDir === null) return { refusal: { status: 503, message: 'the localmost docker socket is not serving' } };
    const verdict = evaluateDockerRequest(req, {
      policy: this.policy,
      sandboxDir,
      // Joined, never resolved: every directory below the sandbox is the
      // job's to replace with a link, and a root resolved through one moves
      // wherever the link points.
      workspaceRoot: this.backend.workspaceMountRoot(sandboxDir, this.repository),
      supportsPrivileged: this.backend.supportsPrivileged,
      ownContainerIds: this.ownContainerIds,
      ownNetworkIds: this.ownNetworkIds,
      realpath: this.realpath,
    });
    if (!verdict.allowed) {
      const message = verdict.reason ?? 'request not permitted by the repository docker policy';
      this.onLog({
        level: 'info',
        message: `denied ${req.method} ${req.path}: ${message}`,
        ...(verdict.policyHint !== undefined ? { policyHint: verdict.policyHint } : {}),
      });
      return { refusal: { status: 403, message } };
    }
    if (classifyDockerRequest(req) === 'create') {
      return {
        refusal: null,
        rewrittenBody: this.pinnedNetworks(verdict.rewrittenBody ?? req.body),
        approvedBinds: verdict.approvedBinds ?? [],
      };
    }
    return { refusal: null, rewrittenBody: verdict.rewrittenBody };
  }

  /**
   * Whether a create's container reaches the job's proxy: on the default
   * bridge, or on a network this job created routable. None, an internal
   * network the job created, and any name that is not one of those, do not.
   * One routable network among several is enough.
   */
  private isRoutable(body: Record<string, unknown>): boolean {
    const networks: string[] = [];
    for (const [key, section] of Object.entries(body)) {
      if (!isPlainRecord(section)) continue;
      if (key.toLowerCase() === 'hostconfig') {
        for (const [field, value] of Object.entries(section)) {
          if (field.toLowerCase() === 'networkmode' && typeof value === 'string') networks.push(value);
        }
      } else if (key.toLowerCase() === 'networkingconfig') {
        for (const [field, endpoints] of Object.entries(section)) {
          if (field.toLowerCase() !== 'endpointsconfig' || !isPlainRecord(endpoints)) continue;
          networks.push(...Object.keys(endpoints));
        }
      }
    }
    if (networks.length === 0) return true;
    return networks.some((name) => {
      if (name === '' || name === 'default' || name === 'bridge') return true;
      const id = this.ownNetworkAliases.get(name);
      return id !== undefined && !this.internalNetworkIds.has(id);
    });
  }

  /**
   * An approved create body with the job's proxy settings in its Env when
   * the container is routable (contract §5.3): the VM has no network card,
   * and the proxy is how a container reaches anything. A variable the job set
   * itself is kept.
   */
  private withProxyEnv(body: unknown): unknown {
    if (!isPlainRecord(body) || !this.isRoutable(body)) return body;
    const proxyEnv = this.worker.containerProxyEnv();
    if (Object.keys(proxyEnv).length === 0) return body;
    const envKey = Object.keys(body).find((key) => key.toLowerCase() === 'env') ?? 'Env';
    const current = Array.isArray(body[envKey]) ? (body[envKey] as unknown[]) : [];
    const set = new Set(
      current.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.split('=')[0])
    );
    const added = Object.entries(proxyEnv)
      .filter(([name]) => !set.has(name))
      .map(([name, value]) => `${name}=${value}`);
    return { ...body, [envKey]: [...current, ...added] };
  }

  /**
   * The image id a pull by digest in this job resolved `ref` to, or undefined
   * for a reference by tag, one no pull of this job resolved, or an answer
   * that is not an image id (contract §5.3 "Digest references"). The daemon
   * in the VM cannot find a loaded image by `name@sha256:…`: only a registry
   * pull records a repo digest, and the puller loads images instead. Called
   * only after the policy allowed the reference as the job wrote it.
   */
  private digestImage(ref: string): string | undefined {
    if (!ref.includes('@')) return undefined;
    const request = pullRequestOf({ fromImage: ref });
    if (typeof request === 'string' || request.digest === undefined) return undefined;
    const id = this.worker.imageForDigest(request);
    return id !== undefined && IMAGE_ID.test(id) ? id : undefined;
  }

  /** An approved create body whose `Image`, a digest reference this job pulled, is named by its image id. */
  private withDigestImage(body: unknown): unknown {
    if (!isPlainRecord(body)) return body;
    const imageKey = Object.keys(body).find((key) => key.toLowerCase() === 'image');
    const image = imageKey === undefined ? undefined : body[imageKey];
    if (imageKey === undefined || typeof image !== 'string') return body;
    const id = this.digestImage(image);
    return id === undefined ? body : { ...body, [imageKey]: id };
  }

  /** An approved image inspect's URL naming the image id, when it asks for a digest reference this job pulled. */
  private digestImageUrl(parsed: DockerRequest): string | undefined {
    const ref = imageRefFrom(parsed);
    const id = ref === undefined ? undefined : this.digestImage(ref);
    if (id === undefined) return undefined;
    const queryStart = parsed.raw.url.indexOf('?');
    const query = queryStart === -1 ? '' : parsed.raw.url.slice(queryStart);
    return `/${parsed.apiVersion ?? `v${bareVersion(this.maxApiVersion)}`}/images/${id}/json${query}`;
  }

  /**
   * An approved create body with each owned network named by the id it was
   * created with, for the same reason pinnedPath pins a URL: the name is freed
   * when anyone removes the network, and the next network of that name is not
   * this job's. NetworkMode is replaced outright; an EndpointsConfig entry
   * keeps its key and gains the id as its NetworkID, which the daemon prefers
   * over the key. The evaluator has already required any NetworkID there to
   * be empty or the key itself, so this only narrows what the key meant.
   */
  private pinnedNetworks(body: unknown): unknown {
    if (!isPlainRecord(body)) return body;
    const idFor = (name: unknown): string | undefined => {
      if (typeof name !== 'string') return undefined;
      const id = this.ownNetworkAliases.get(name);
      return id !== undefined && id !== name ? id : undefined;
    };
    // Spread copies keep every key the client sent, and only the keys found
    // below are assigned, so nothing else in the body changes.
    const pinned: Record<string, unknown> = { ...body };
    for (const key of Object.keys(pinned)) {
      const section = pinned[key];
      if (!isPlainRecord(section)) continue;
      if (key.toLowerCase() === 'hostconfig') {
        const hostConfig: Record<string, unknown> = { ...section };
        for (const field of Object.keys(hostConfig)) {
          if (field.toLowerCase() !== 'networkmode') continue;
          const id = idFor(hostConfig[field]);
          if (id !== undefined) hostConfig[field] = id;
        }
        pinned[key] = hostConfig;
      } else if (key.toLowerCase() === 'networkingconfig') {
        const networkingConfig: Record<string, unknown> = { ...section };
        for (const field of Object.keys(networkingConfig)) {
          const endpoints = networkingConfig[field];
          if (field.toLowerCase() !== 'endpointsconfig' || !isPlainRecord(endpoints)) continue;
          const pinnedEndpoints: Record<string, unknown> = { ...endpoints };
          for (const name of Object.keys(pinnedEndpoints)) {
            const id = idFor(name);
            if (id === undefined) continue;
            const endpoint = pinnedEndpoints[name];
            const entry: Record<string, unknown> = isPlainRecord(endpoint) ? { ...endpoint } : {};
            for (const endpointField of Object.keys(entry)) {
              if (endpointField.toLowerCase() === 'networkid') delete entry[endpointField];
            }
            entry.NetworkID = id;
            pinnedEndpoints[name] = entry;
          }
          networkingConfig[field] = pinnedEndpoints;
        }
        pinned[key] = networkingConfig;
      }
    }
    return pinned;
  }

  /** Said once per socket: a declaration is a permission, not a requirement. */
  private warnNoDaemon(reason: string): void {
    if (this.warnedNoDaemon) return;
    this.warnedNoDaemon = true;
    this.onLog({ level: 'warn', message: `no Docker daemon for this job (${this.backend.name} backend): ${reason}` });
  }

  /**
   * Where a permitted request goes: the worker's daemon once it is ready,
   * waited for up to the boot timeout. Null, with a 503 written, when there
   * is none - the VM failed, never booted, or did not boot in time - and the
   * first such answer is also logged at warn.
   */
  private async endpointOr503(res: http.ServerResponse): Promise<string | null> {
    let state;
    try {
      state = await this.worker.endpoint(this.bootTimeoutMs);
    } catch (err) {
      state = { kind: 'none' as const, reason: (err as Error).message };
    }
    if (state.kind === 'ready') return state.socketPath;
    this.warnNoDaemon(state.reason);
    this.writeRefusal(res, 503, state.reason);
    return null;
  }

  /**
   * /_ping, /version and /info with no VM running: the synthesised answers of
   * contract §5.3, with the API version clamped as a forwarded one is.
   */
  private answerBaseline(parsed: DockerRequest, res: http.ServerResponse): void {
    const action = classifyDockerRequest(parsed);
    const path = action === 'ping' ? '/_ping' : action === 'version' ? '/version' : '/info';
    const answer = this.worker.baseline(path);
    const headers: Record<string, string> = { ...answer.headers };
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'api-version') headers[name] = this.clampVersion(headers[name]);
    }
    let body = answer.body;
    if (action === 'version' && isPlainRecord(body) && typeof body.ApiVersion === 'string') {
      body = { ...body, ApiVersion: this.clampVersion(body.ApiVersion) };
    }
    const payload = parsed.method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(answer.status, { ...headers, 'Content-Length': String(payload.length) });
    res.write(payload);
  }

  // ---------------------------------------------------------------------------
  // Plain requests
  // ---------------------------------------------------------------------------

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const headers = flattenHeaders(req.headers);
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    // Only a JSON body is read before deciding; anything else - a build
    // context tar, say - is judged on the request line and headers and
    // streamed through if permitted, never buffered.
    if (!isJsonContentType(headers['content-type'])) {
      this.dispatch(parseDockerRequest({ method, url, headers, body: Buffer.alloc(0) }), req, res, null);
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on('data', (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        refused = true;
        chunks.length = 0;
        this.writeRefusal(res, 413, 'request body too large for the localmost docker socket');
        this.endAfterDrain(req, res);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (refused) return;
      const body = Buffer.concat(chunks);
      this.dispatch(parseDockerRequest({ method, url, headers, body }), req, res, body);
    });
    req.on('error', () => {
      if (!res.headersSent) this.refuse(res, 400, 'request body could not be read');
    });
  }

  /** Decide, then forward with either the buffered body or the live stream. */
  private dispatch(
    parsed: DockerRequest,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bufferedBody: Buffer | null
  ): void {
    this.dispatchAsync(parsed, req, res, bufferedBody).catch((err: Error) => {
      this.onLog({ level: 'warn', message: `could not answer ${parsed.method} ${parsed.path}: ${err.message}` });
      if (!res.headersSent) this.writeRefusal(res, 500, 'the localmost docker socket failed to answer');
      if (!res.writableEnded) res.end();
    });
  }

  private async dispatchAsync(
    parsed: DockerRequest,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bufferedBody: Buffer | null
  ): Promise<void> {
    const finish = (): void => {
      if (bufferedBody === null) this.endAfterDrain(req, res);
      else res.end();
    };
    const { refusal, rewrittenBody, approvedBinds } = this.decide(parsed);
    if (refusal) {
      this.writeRefusal(res, refusal.status, refusal.message);
      finish();
      return;
    }
    const action = classifyDockerRequest(parsed);
    // A socket with no VM behind it still answers what every client asks
    // first, without booting one.
    if ((action === 'ping' || action === 'version' || action === 'info') && !this.worker.running()) {
      this.answerBaseline(parsed, res);
      finish();
      return;
    }
    const socketPath = await this.endpointOr503(res);
    if (socketPath === null) {
      finish();
      return;
    }
    if (action === 'pull') {
      await this.pull(parsed, req, res);
      finish();
      return;
    }
    // A permitted JSON body is forwarded as the object the verdict judged, not
    // as the bytes received: the daemon reads a repeated key's earlier copies,
    // which JSON.parse dropped. A create's is pinned further - mount sources
    // resolved to the paths actually checked - so the daemon mounts what the
    // filter judged rather than re-resolving a name the job can repoint - and
    // given the proxy, now that the VM that relays it is up.
    // A digest reference this job's pull resolved is named by the image id,
    // which is how the VM's daemon finds an image the puller loaded.
    const judged = action === 'create' ? this.withDigestImage(this.withProxyEnv(rewrittenBody)) : rewrittenBody;
    const body = judged !== undefined ? Buffer.from(JSON.stringify(judged)) : bufferedBody;
    const url =
      action === 'build' ? this.withProxyBuildArgs(parsed) : action === 'image-inspect' ? this.digestImageUrl(parsed) : undefined;
    this.forward(parsed, req, res, body, socketPath, { approvedBinds, url });
  }

  /**
   * An allowed pull, done by the worker on the Mac rather than forwarded: the
   * daemon in the VM never contacts a registry, and the job's own
   * X-Registry-Auth, like every credential, is dropped. The answer is
   * Docker's usual progress stream, one JSON object per line; a failure after
   * the headers is the stream's last line, as dockerd reports one.
   */
  private async pull(parsed: DockerRequest, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const request = pullRequestOf(parsed.query);
    if (typeof request === 'string') {
      this.writeRefusal(res, 400, request);
      return;
    }
    const abort = new AbortController();
    const onClose = (): void => {
      if (!res.writableFinished) abort.abort();
    };
    res.on('close', onClose);
    // Read to the end, though a pull has no body, so that the job hanging up
    // is seen while the pull runs.
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders();
    const write = (p: DockerProgress): void => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(p)}\n`);
    };
    try {
      this.onLog({ level: 'debug', message: `pulled ${parsed.method} ${parsed.path} through the worker, not forwarded` });
      await this.worker.pull(request, write, abort.signal);
    } catch (err) {
      const message = (err as Error).message;
      this.onLog({ level: 'info', message: `pull of ${parsed.query.fromImage} failed: ${message}` });
      write({ errorDetail: { message }, error: message });
    } finally {
      res.off('close', onClose);
    }
  }

  /**
   * A build's URL with the job's proxy settings merged into its buildargs,
   * keeping any the job set: the classic builder runs each RUN step in a
   * routable container, which reaches out only through the proxy.
   */
  private withProxyBuildArgs(parsed: DockerRequest): string | undefined {
    const proxyEnv = this.worker.containerProxyEnv();
    if (Object.keys(proxyEnv).length === 0) return undefined;
    const raw = parsed.raw.url;
    const queryStart = raw.indexOf('?');
    const params = new URLSearchParams(queryStart === -1 ? '' : raw.slice(queryStart + 1));
    let buildArgs: Record<string, unknown> = {};
    const current = params.get('buildargs');
    if (current) {
      try {
        const decoded: unknown = JSON.parse(current);
        if (isPlainRecord(decoded)) buildArgs = decoded;
      } catch {
        // The evaluator passed it; a value that is not JSON the daemon refuses anyway.
        return undefined;
      }
    }
    for (const [name, value] of Object.entries(proxyEnv)) if (!(name in buildArgs)) buildArgs[name] = value;
    params.set('buildargs', JSON.stringify(buildArgs));
    const path = queryStart === -1 ? raw : raw.slice(0, queryStart);
    const versioned = parsed.apiVersion ? path : `/v${bareVersion(this.maxApiVersion)}${path}`;
    return `${versioned}?${params.toString()}`;
  }

  /**
   * The URL as forwarded: an unversioned request is pinned to the version we
   * understand, and an owned container or network is named by its id. The
   * query is the one judged: a target with a fragment, where the two could
   * differ, never gets this far.
   */
  private forwardedUrl(parsed: DockerRequest): string {
    const pinnedPath = this.pinnedPath(parsed);
    if (pinnedPath !== undefined) {
      const queryStart = parsed.raw.url.indexOf('?');
      const query = queryStart === -1 ? '' : parsed.raw.url.slice(queryStart);
      return `/${parsed.apiVersion ?? `v${bareVersion(this.maxApiVersion)}`}${pinnedPath}${query}`;
    }
    if (parsed.apiVersion) return parsed.raw.url;
    return `/v${bareVersion(this.maxApiVersion)}${parsed.raw.url}`;
  }

  /**
   * The request's path with an owned alias replaced by the id it was created
   * with, or undefined when it addresses nothing by alias.
   *
   * Ownership is recorded when a name is created and forgotten only when the
   * job removes it through this socket. The daemon frees a name sooner than
   * that - an AutoRemove container the moment it exits, a network whenever
   * anyone deletes it - and hands it to whoever asks next. Forwarding the name
   * would then reach that next holder. The id is never reused, so a removed
   * container or network answers 404 instead.
   */
  private pinnedPath(parsed: DockerRequest): string | undefined {
    const pin = (prefix: string, alias: string | undefined, owned: Map<string, string>): string | undefined => {
      if (alias === undefined) return undefined;
      const id = owned.get(alias);
      if (id === undefined || id === alias) return undefined;
      return `${prefix}${encodeURIComponent(id)}${parsed.path.slice(prefix.length + alias.length)}`;
    };
    return (
      pin('/containers/', containerIdFrom(parsed), this.ownContainerAliases) ??
      pin('/networks/', networkIdFrom(parsed), this.ownNetworkAliases)
    );
  }

  /** The headers as forwarded: credentials the job may have set are replaced with ours. */
  private forwardedHeaders(parsed: DockerRequest, req: http.IncomingMessage): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    // Keep-alive is decided by the upstream agent, never by the job: an
    // explicit keep-alive here would put the upstream socket back into the
    // pool and its error listener back on the floor.
    for (const name of HOP_BY_HOP) delete headers[name];
    // The job never holds registry credentials; whatever it sent is not ours.
    delete headers['x-registry-auth'];
    delete headers['x-registry-config'];
    // /info is rewritten on the way back, so it is asked for in a form that
    // can be read; relayInfo still copes with a daemon that compresses anyway.
    if (classifyDockerRequest(parsed) === 'info') delete headers['accept-encoding'];
    return headers;
  }

  private forward(
    parsed: DockerRequest,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bufferedBody: Buffer | null,
    socketPath: string,
    extra: { approvedBinds?: ApprovedBind[]; url?: string } = {}
  ): void {
    const headers = this.forwardedHeaders(parsed, req);
    if (bufferedBody !== null) {
      // Replayed whole, so no longer chunked.
      headers['content-length'] = String(bufferedBody.length);
      delete headers['transfer-encoding'];
    }

    // The daemon may answer before a streamed body has all arrived - a build
    // refused on its request line, say. The answer is relayed as it comes,
    // but the response is not ended until the upload has been drained too:
    // closing with unread data on the socket can discard the answer before
    // the client has read it.
    let answered = false;
    const action = classifyDockerRequest(parsed);
    const upstream = http.request(
      { socketPath, path: extra.url ?? this.forwardedUrl(parsed), method: parsed.method, headers, agent: this.upstreamAgent },
      (upstreamRes) => {
        upstreamRes.on('error', () => res.destroy());
        // A container the daemon actually removed is no longer this job's to
        // address; its name in particular may be handed to anyone next.
        const removedStatus = upstreamRes.statusCode ?? 502;
        if (action === 'remove' && removedStatus >= 200 && removedStatus < 300) {
          const addressed = containerIdFrom(parsed);
          if (addressed) this.disown(addressed);
        }
        if (action === 'network-remove' && removedStatus >= 200 && removedStatus < 300) {
          const addressed = networkIdFrom(parsed);
          if (addressed) this.disownNetwork(addressed);
        }
        this.relayFor(action, upstreamRes, res, parsed, { socketPath, approvedBinds: extra.approvedBinds ?? [] }).then(() => {
          answered = true;
          if (bufferedBody !== null) {
            res.end();
          } else {
            // Whatever is left of the upload is of no interest to a daemon
            // that has answered; it is drained here so the answer completes.
            req.unpipe(upstream);
            this.endAfterDrain(req, res);
          }
        });
      }
    );
    upstream.on('error', (err) => {
      // A daemon that hung up after answering leaves the rest of a streamed
      // upload with nowhere to go; that is not an error the job needs to see.
      if (answered) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      this.writeRefusal(res, 502, `docker daemon unreachable: ${err.message}`);
      if (bufferedBody !== null) {
        res.end();
      } else {
        req.unpipe(upstream);
        this.endAfterDrain(req, res);
      }
    });
    // The job's side can go away mid-stream too. Each end is torn down with
    // the other; none of it is an error the app should see.
    res.on('error', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    this.onLog({ level: 'debug', message: `forwarded ${parsed.method} ${parsed.path}` });

    if (bufferedBody !== null) upstream.end(bufferedBody);
    else req.pipe(upstream);
  }

  /** Relay the daemon's answer, rewritten where the action calls for it. */
  private relayFor(
    action: DockerAction,
    upstreamRes: http.IncomingMessage,
    res: http.ServerResponse,
    parsed: DockerRequest,
    context: { socketPath: string; approvedBinds: ApprovedBind[] }
  ): Promise<void> {
    switch (action) {
      case 'ping':
        return this.relayPing(upstreamRes, res);
      case 'version':
        return this.relayVersion(upstreamRes, res);
      case 'info':
        return this.relayInfo(upstreamRes, res);
      case 'create':
        return this.relayCreate(upstreamRes, res, parsed, context);
      case 'network-create':
        return this.relayNetworkCreate(upstreamRes, res, parsed);
      case 'build':
        return this.relayBuild(upstreamRes, res);
      default:
        return this.relay(upstreamRes, res);
    }
  }

  /** The daemon's response headers as relayed to the job. */
  private relayedHeaders(upstreamRes: http.IncomingMessage): http.IncomingHttpHeaders {
    const headers = { ...upstreamRes.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    return headers;
  }

  /**
   * Relay the daemon's answer without ending the response; resolves once it
   * is all written. Headers go out at once: a wait's 200 arrives long before
   * its body, and the CLI will not start the container until it has it.
   */
  private relay(upstreamRes: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.writeHead(upstreamRes.statusCode ?? 502, this.relayedHeaders(upstreamRes));
    res.flushHeaders();
    upstreamRes.pipe(res, { end: false });
    return new Promise((resolve) => upstreamRes.on('end', resolve));
  }

  /**
   * A build's stream, relayed as it comes and read on the way for the one
   * failure the job cannot act on without being told: the classic builder
   * pulling a FROM image from inside the VM, which reaches no registry.
   */
  private relayBuild(upstreamRes: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let tail = '';
    upstreamRes.on('data', (chunk: Buffer) => {
      if (this.warnedBaseImage) return;
      tail = (tail + chunk.toString('utf8')).slice(-4096);
      if (REGISTRY_LOOKUP_FAILURE.test(tail)) {
        this.warnedBaseImage = true;
        this.onLog({
          level: 'warn',
          message:
            "docker build could not reach a registry from inside the job's Docker VM, which has no route to one: " +
            'pull the base images with docker pull before docker build',
        });
      }
    });
    return this.relay(upstreamRes, res);
  }

  /**
   * A daemon answer held whole to be parsed, never past
   * MAX_DAEMON_ANSWER_BYTES: past it the connection is destroyed, and
   * resolves null. With guest root, the daemon's answers are the job's to
   * choose.
   */
  private readCapped(upstreamRes: http.IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      upstreamRes.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_DAEMON_ANSWER_BYTES) {
          chunks.length = 0;
          upstreamRes.destroy();
          resolve(null);
          return;
        }
        chunks.push(c);
      });
      upstreamRes.on('end', () => resolve(Buffer.concat(chunks)));
      upstreamRes.on('close', () => resolve(size > MAX_DAEMON_ANSWER_BYTES ? null : Buffer.concat(chunks)));
    });
  }

  /** Write a whole answer read with readCapped, as the daemon's with its length. */
  private writeWhole(upstreamRes: http.IncomingMessage, res: http.ServerResponse, status: number, body: Buffer): void {
    const headers = { ...this.relayedHeaders(upstreamRes), 'content-length': String(body.length) };
    delete headers['transfer-encoding'];
    res.writeHead(status, headers);
    if (body.length > 0) res.write(body);
  }

  /** The daemon's ping, with the API version clamped so the client negotiates down to ours. */
  private relayPing(upstreamRes: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const headers = this.relayedHeaders(upstreamRes);
    const advertised = headers['api-version'];
    if (typeof advertised === 'string') headers['api-version'] = this.clampVersion(advertised);
    res.writeHead(upstreamRes.statusCode ?? 502, headers);
    res.flushHeaders();
    upstreamRes.pipe(res, { end: false });
    return new Promise((resolve) => upstreamRes.on('end', resolve));
  }

  /**
   * Relay a network create and record the network, by id, by requested name,
   * and whether it is internal. The id is schema-checked like a container's
   * (contract §5.3): it becomes an alias key, a path in forwarded URLs, and
   * the NetworkMode pinned into later creates, so an answer whose id is not
   * 64 hex - "host", with guest root - is refused, and nothing is owned.
   */
  private async relayNetworkCreate(upstreamRes: http.IncomingMessage, res: http.ServerResponse, requested: DockerRequest): Promise<void> {
    const raw = await this.readCapped(upstreamRes);
    if (raw === null) {
      this.writeRefusal(res, 502, OVERSIZED_ANSWER_MESSAGE);
      return;
    }
    const status = upstreamRes.statusCode ?? 502;
    if (status < 200 || status >= 300) {
      this.writeWhole(upstreamRes, res, status, raw);
      return;
    }
    let id: string | undefined;
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      if (typeof parsed.Id === 'string' && NETWORK_ID_RE.test(parsed.Id)) id = parsed.Id;
    } catch {
      // Handled below: a create answer without an id is not one.
    }
    if (id === undefined) {
      this.writeRefusal(res, 502, 'the Docker daemon sent a network create answer without a network id');
      return;
    }
    this.ownNetwork(id, id);
    const body = requested.body;
    const name = isPlainRecord(body) ? readFolded(body, 'Name') : undefined;
    if (typeof name === 'string' && name.length > 0) this.ownNetwork(name, id);
    // Internal only when every casing says so, as the evaluator judged it.
    if (isPlainRecord(body) && readFolded(body, 'Internal') === true) this.internalNetworkIds.add(id);
    this.writeWhole(upstreamRes, res, status, raw);
  }

  /**
   * Relay a container create, and make the container the job's own only once
   * the VM has its approved binds (contract §5.3): the daemon's answer is held
   * until the guest agent has them, and a start by name that arrives first is
   * refused, since the container is not yet the job's. The argument does not
   * rest on this ordering - lm-bindpin fails a container whose share-backed
   * mounts were not approved - but a container the VM cannot account for is
   * never handed to the job: if the approval fails, it is removed.
   */
  private async relayCreate(
    upstreamRes: http.IncomingMessage,
    res: http.ServerResponse,
    requested: DockerRequest,
    context: { socketPath: string; approvedBinds: ApprovedBind[] }
  ): Promise<void> {
    const raw = await this.readCapped(upstreamRes);
    if (raw === null) {
      this.writeRefusal(res, 502, OVERSIZED_ANSWER_MESSAGE);
      return;
    }
    const status = upstreamRes.statusCode ?? 502;
    if (status < 200 || status >= 300) {
      this.writeWhole(upstreamRes, res, status, raw);
      return;
    }
    let id: string | undefined;
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      if (typeof parsed.Id === 'string' && CONTAINER_ID_RE.test(parsed.Id)) id = parsed.Id;
    } catch {
      // Handled below: a create answer without an id is not one.
    }
    if (id === undefined) {
      this.writeRefusal(res, 502, 'the Docker daemon sent a create answer without a container id');
      return;
    }
    try {
      await this.worker.approveBinds(id, context.approvedBinds);
    } catch (err) {
      this.onLog({ level: 'warn', message: `${APPROVAL_FAILED_MESSAGE} for container ${id}: ${(err as Error).message}` });
      await this.removeFromDaemon(context.socketPath, `/containers/${id}?force=1`);
      this.writeRefusal(res, 500, APPROVAL_FAILED_MESSAGE);
      return;
    }
    // A job addresses its container by whichever identifier it knows: the id
    // the daemon just assigned, or the --name it asked for, which is the only
    // one it ever sees when it uses one.
    this.own(id, id);
    const name = requested.query.name;
    if (name) this.own(name, id);
    this.writeWhole(upstreamRes, res, status, raw);
  }

  /** The daemon's /version, with ApiVersion clamped the same way. */
  private async relayVersion(upstreamRes: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = await this.readCapped(upstreamRes);
    if (raw === null) {
      this.writeRefusal(res, 502, OVERSIZED_ANSWER_MESSAGE);
      return;
    }
    let body: Buffer;
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      if (typeof parsed.ApiVersion === 'string') parsed.ApiVersion = this.clampVersion(parsed.ApiVersion);
      body = Buffer.from(JSON.stringify(parsed));
    } catch {
      this.writeRefusal(res, 502, 'docker daemon returned an unreadable version response');
      return;
    }
    this.writeWhole(upstreamRes, res, upstreamRes.statusCode ?? 502, body);
  }

  /**
   * The daemon's /info, cut down to INFO_FIELDS. It is a baseline read, so
   * any job can make it with no policy at all, and in full it tells the job
   * about the machine it runs on - down to proxy credentials. An error keeps
   * only its message. Anything that cannot be read as a JSON object, in an
   * encoding this understands, is refused rather than passed on unread.
   */
  private relayInfo(upstreamRes: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      // Past the limit the rest is read and dropped, so the daemon's answer
      // still completes and the refusal goes out on a clean connection.
      let chunks: Buffer[] = [];
      let size = 0;
      upstreamRes.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_INFO_BYTES) chunks = [];
        else chunks.push(c);
      });
      upstreamRes.on('end', () => {
        const status = upstreamRes.statusCode ?? 502;
        let body: Buffer;
        try {
          if (size > MAX_INFO_BYTES) throw new Error('too large');
          const parsed: unknown = JSON.parse(decodeBody(Buffer.concat(chunks), upstreamRes.headers['content-encoding']));
          if (!isPlainRecord(parsed)) throw new Error('not an object');
          const kept: Record<string, unknown> = {};
          if (status >= 200 && status < 300) {
            for (const [key, value] of Object.entries(parsed)) if (INFO_FIELDS.has(key)) kept[key] = value;
          } else if (typeof parsed.message === 'string') {
            kept.message = parsed.message;
          }
          body = Buffer.from(JSON.stringify(kept));
        } catch {
          this.refuse(res, 502, 'docker daemon returned an unreadable info response');
          resolve();
          return;
        }
        // The rewritten body is sent plain and whole, whatever the daemon's was.
        const headers = { ...this.relayedHeaders(upstreamRes), 'content-length': String(body.length) };
        delete headers['transfer-encoding'];
        delete headers['content-encoding'];
        res.writeHead(status, headers);
        res.write(body);
        resolve();
      });
    });
  }

  private clampVersion(advertised: string): string {
    try {
      const v = parseApiVersion(advertised);
      return compareApiVersions(v, this.maxApiVersion) > 0 ? bareVersion(this.maxApiVersion) : advertised;
    } catch {
      return bareVersion(this.maxApiVersion);
    }
  }

  // ---------------------------------------------------------------------------
  // Upgraded connections (attach): the request is judged, then the bytes are
  // relayed raw in both directions.
  // ---------------------------------------------------------------------------

  private refuseRaw(socket: net.Socket, status: number, message: string): void {
    const body = JSON.stringify({ message });
    const reason = status === 403 ? 'Forbidden' : status === 503 ? 'Service Unavailable' : 'Bad Request';
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Connection: close\r\n\r\n' +
        body
    );
  }

  private handleUpgrade(req: http.IncomingMessage, client: net.Socket, head: Buffer): void {
    const headers = flattenHeaders(req.headers);
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const parsed = parseDockerRequest({ method, url, headers, body: Buffer.alloc(0) });

    // Only attach is an upgrade. Without this, any request the policy permits
    // - including a baseline /_ping - could be sent with an Upgrade header to
    // open a raw pipe to the daemon, and everything pipelined over that pipe
    // would bypass the filter entirely.
    const action = classifyDockerRequest(parsed);
    if (action !== 'attach') {
      const message = `${parsed.method} ${parsed.path} cannot be upgraded through the localmost docker socket`;
      this.onLog({ level: 'info', message: `denied upgrade ${parsed.method} ${parsed.path}: ${message}` });
      this.refuseRaw(client, 400, message);
      return;
    }

    const { refusal } = this.decide(parsed);
    if (refusal) {
      this.refuseRaw(client, refusal.status, refusal.message);
      return;
    }
    // The client's bytes wait in the socket while the VM boots.
    client.pause();
    this.worker
      .endpoint(this.bootTimeoutMs)
      .catch((err: Error) => ({ kind: 'none' as const, reason: err.message }))
      .then((state) => {
        if (state.kind !== 'ready') {
          this.warnNoDaemon(state.reason);
          this.refuseRaw(client, 503, state.reason);
          return;
        }
        client.resume();
        this.upgradeTo(state.socketPath, parsed, req, client, head);
      });
  }

  /** Relay an approved attach raw, once the daemon has agreed to upgrade. */
  private upgradeTo(socketPath: string, parsed: DockerRequest, req: http.IncomingMessage, client: net.Socket, head: Buffer): void {
    const method = req.method ?? 'GET';
    const upstream = net.connect(socketPath, () => {
      // Replay the request line and headers as received, then hand both
      // sides to each other; the daemon's 101 travels back over the same pipe.
      const lines = [`${method} ${this.forwardedUrl(parsed)} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        if (/^x-registry-(auth|config)$/i.test(name)) continue;
        lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length > 0) upstream.write(head);

      // Pipe only once the daemon has actually agreed to upgrade. Piping on
      // connect would hand the job a raw socket even when the daemon answered
      // with an ordinary response, which is a tunnel by another name.
      let banner = '';
      const onUpstreamHead = (chunk: Buffer): void => {
        banner += chunk.toString('latin1');
        const end = banner.indexOf('\r\n\r\n');
        if (end === -1) {
          // A daemon that never finishes a response head is not upgrading.
          if (banner.length > MAX_UPGRADE_HEAD_BYTES) {
            upstream.destroy();
            client.destroy();
          }
          return;
        }
        upstream.off('data', onUpstreamHead);

        const statusLine = banner.slice(0, banner.indexOf('\r\n'));
        if (!/^HTTP\/1\.[01] 101\b/.test(statusLine)) {
          // Relay what the daemon said, then close. No raw pipe is established.
          client.write(Buffer.from(banner, 'latin1'));
          client.end();
          upstream.destroy();
          return;
        }

        client.write(Buffer.from(banner, 'latin1'));
        upstream.pipe(client);
        client.pipe(upstream);
      };
      upstream.on('data', onUpstreamHead);
    });
    this.connections.add(upstream);
    upstream.on('close', () => this.connections.delete(upstream));
    upstream.on('error', (err) => {
      if (client.writable) this.refuseRaw(client, 502, `docker daemon unreachable: ${err.message}`);
      client.destroy();
    });
    client.on('error', () => upstream.destroy());
    this.onLog({ level: 'debug', message: `forwarded ${parsed.method} ${parsed.path} (upgraded)` });
  }
}
