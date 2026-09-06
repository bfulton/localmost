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
import { DockerPolicy } from '../../shared/docker-policy';
import { DockerBackend } from './docker-backend';
import { DockerRequest, classifyDockerRequest, containerIdFrom, parseDockerRequest } from './docker-request';
import { evaluateDockerRequest, registryOf } from './docker-evaluator';

export interface DockerFilterProxyLogEntry {
  level: 'info' | 'warn' | 'debug';
  message: string;
  /** On a denial, the policy that would have permitted the request (for --updaterc). */
  policyHint?: string;
}

export interface DockerFilterProxyOptions {
  backend: DockerBackend;
  onLog?: (entry: DockerFilterProxyLogEntry) => void;
  /** Oldest API version forwarded. Default v1.24. */
  minApiVersion?: string;
  /** Newest API version forwarded, and the one the job is told to negotiate to. Default v1.45. */
  maxApiVersion?: string;
  /** The X-Registry-Auth value to attach to a pull from a registry, if any. */
  attachRegistryAuth?: (registry: string) => string | undefined;
  /** Injected for tests; defaults to fs.realpathSync. */
  realpath?: (p: string) => string;
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

const NO_DAEMON_MESSAGE = 'no Docker daemon is available to this job';

const DEFAULT_MIN_API_VERSION = 'v1.24';
const DEFAULT_MAX_API_VERSION = 'v1.45';

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

const isJsonContentType = (contentType: string | undefined): boolean =>
  contentType !== undefined && contentType.split(';')[0].trim().toLowerCase() === 'application/json';

export class DockerFilterProxy {
  private server: http.Server | null = null;
  private socketPath: string | null = null;
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
  private repository: string | undefined;
  private readonly backend: DockerBackend;
  private readonly onLog: (entry: DockerFilterProxyLogEntry) => void;
  private readonly minApiVersion: ApiVersion;
  private readonly maxApiVersion: ApiVersion;
  private readonly attachRegistryAuth?: (registry: string) => string | undefined;
  private readonly realpath: (p: string) => string;
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

  constructor(options: DockerFilterProxyOptions) {
    this.backend = options.backend;
    this.onLog = options.onLog ?? (() => {});
    this.minApiVersion = parseApiVersion(options.minApiVersion ?? DEFAULT_MIN_API_VERSION);
    this.maxApiVersion = parseApiVersion(options.maxApiVersion ?? DEFAULT_MAX_API_VERSION);
    if (compareApiVersions(this.minApiVersion, this.maxApiVersion) > 0) {
      throw new Error('minApiVersion is above maxApiVersion');
    }
    this.attachRegistryAuth = options.attachRegistryAuth;
    this.realpath = options.realpath ?? ((p) => fs.realpathSync(p));
  }

  /** Record an identifier the job may use for a container it created. */
  private own(alias: string, containerId: string): void {
    this.ownContainerAliases.set(alias, containerId);
    this.ownContainerIds.add(alias);
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
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(resolve, 1000);
      server.close(() => {
        clearTimeout(force);
        resolve();
      });
    });
    if (this.socketPath) fs.rmSync(this.socketPath, { force: true });
    this.upstreamAgent.destroy();
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  // ---------------------------------------------------------------------------
  // Deciding
  // ---------------------------------------------------------------------------

  /** The workspace the backend roots mounts at, resolved so symlinked sandbox dirs compare equal. */
  private workspaceRoot(): string {
    const root = this.backend.workspaceMountRoot(path.dirname(this.socketPath ?? ''), this.repository);
    try {
      return this.realpath(root);
    } catch {
      // Not created yet: nothing inside it can exist either, so no mount can
      // resolve into it and the unresolved path is a safe boundary.
      return path.resolve(root);
    }
  }

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
  private decide(req: DockerRequest): { refusal: { status: number; message: string } | null; rewrittenBody?: unknown } {
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

    const verdict = evaluateDockerRequest(req, {
      policy: this.policy,
      workspaceRoot: this.workspaceRoot(),
      supportsPrivileged: this.backend.supportsPrivileged,
      ownContainerIds: this.ownContainerIds,
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
    return { refusal: null, rewrittenBody: verdict.rewrittenBody };
  }

  /** Said once per socket: a declaration is a permission, not a requirement. */
  private warnNoDaemon(): void {
    if (this.warnedNoDaemon) return;
    this.warnedNoDaemon = true;
    this.onLog({
      level: 'warn',
      message: `no Docker daemon resolved for the ${this.backend.name} backend; the job runs without Docker`,
    });
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
    const { refusal, rewrittenBody } = this.decide(parsed);
    if (refusal) {
      this.writeRefusal(res, refusal.status, refusal.message);
      if (bufferedBody === null) this.endAfterDrain(req, res);
      else res.end();
      return;
    }
    // The verdict may pin the body it approved - mount sources resolved to the
    // paths actually checked - so the daemon mounts what the filter judged
    // rather than re-resolving a name the job can repoint in between.
    const body = rewrittenBody !== undefined ? Buffer.from(JSON.stringify(rewrittenBody)) : bufferedBody;
    const endpoint = this.backend.resolveEndpoint();
    if (!endpoint) {
      this.warnNoDaemon();
      this.writeRefusal(res, 503, NO_DAEMON_MESSAGE);
      if (bufferedBody === null) this.endAfterDrain(req, res);
      else res.end();
      return;
    }
    this.forward(parsed, req, res, body, endpoint.socketPath);
  }

  /** The URL as forwarded: an unversioned request is pinned to the version we understand. */
  private forwardedUrl(parsed: DockerRequest): string {
    if (parsed.apiVersion) return parsed.raw.url;
    return `/v${bareVersion(this.maxApiVersion)}${parsed.raw.url}`;
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
    if (classifyDockerRequest(parsed) === 'pull' && this.attachRegistryAuth && parsed.query.fromImage) {
      const auth = this.attachRegistryAuth(registryOf(parsed.query.fromImage));
      if (auth) headers['x-registry-auth'] = auth;
    }
    return headers;
  }

  private forward(
    parsed: DockerRequest,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bufferedBody: Buffer | null,
    socketPath: string
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
      { socketPath, path: this.forwardedUrl(parsed), method: parsed.method, headers, agent: this.upstreamAgent },
      (upstreamRes) => {
        upstreamRes.on('error', () => res.destroy());
        // A container the daemon actually removed is no longer this job's to
        // address; its name in particular may be handed to anyone next.
        const removedStatus = upstreamRes.statusCode ?? 502;
        if (action === 'remove' && removedStatus >= 200 && removedStatus < 300) {
          const addressed = containerIdFrom(parsed);
          if (addressed) this.disown(addressed);
        }
        const relayed =
          action === 'ping'
            ? this.relayPing(upstreamRes, res)
            : action === 'version'
              ? this.relayVersion(upstreamRes, res)
              : action === 'create'
                ? this.relayCreate(upstreamRes, res, parsed)
                : this.relay(upstreamRes, res);
        relayed.then(() => {
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

  /** The daemon's /version, with ApiVersion clamped the same way. */
  /**
   * Relay a container create and record the id the daemon assigned, so the
   * verbs that follow - inspect, start, attach, wait, remove - can be scoped
   * to containers this job actually created. The body is small and the client
   * needs the id before it can proceed, so buffering it costs nothing.
   */
  private relayCreate(upstreamRes: http.IncomingMessage, res: http.ServerResponse, requested: DockerRequest): Promise<void> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      upstreamRes.on('data', (c: Buffer) => chunks.push(c));
      upstreamRes.on('end', () => {
        const raw = Buffer.concat(chunks);
        // Only a created container is owned; an error response names none.
        const status = upstreamRes.statusCode ?? 502;
        if (status >= 200 && status < 300) {
          try {
            const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
            if (typeof parsed.Id === 'string' && parsed.Id.length > 0) {
              // A job addresses its container by whichever identifier it
              // knows: the id the daemon just assigned, or the --name it
              // asked for, which is the only one it ever sees when it uses one.
              this.own(parsed.Id, parsed.Id);
              const name = requested.query.name;
              if (name) this.own(name, parsed.Id);
            }
          } catch {
            // An unreadable create response leaves the container unowned: the
            // job cannot address it, which fails closed rather than open.
          }
        }
        const headers = { ...this.relayedHeaders(upstreamRes), 'content-length': String(raw.length) };
        delete headers['transfer-encoding'];
        res.writeHead(status, headers);
        if (raw.length > 0) res.write(raw);
        resolve();
      });
    });
  }

  private relayVersion(upstreamRes: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      upstreamRes.on('data', (c: Buffer) => chunks.push(c));
      upstreamRes.on('end', () => {
        const raw = Buffer.concat(chunks);
        let body: Buffer;
        try {
          const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
          if (typeof parsed.ApiVersion === 'string') parsed.ApiVersion = this.clampVersion(parsed.ApiVersion);
          body = Buffer.from(JSON.stringify(parsed));
        } catch {
          this.refuse(res, 502, 'docker daemon returned an unreadable version response');
          resolve();
          return;
        }
        const headers = { ...this.relayedHeaders(upstreamRes), 'content-length': String(body.length) };
        delete headers['transfer-encoding'];
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
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
    const endpoint = this.backend.resolveEndpoint();
    if (!endpoint) {
      this.warnNoDaemon();
      this.refuseRaw(client, 503, NO_DAEMON_MESSAGE);
      return;
    }

    const upstream = net.connect(endpoint.socketPath, () => {
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
