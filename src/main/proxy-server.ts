/**
 * HTTP/HTTPS Proxy Server for Runner Network Monitoring
 *
 * Provides a local proxy that:
 * - Logs all outbound connections (destination host:port)
 * - Supports HTTP CONNECT for HTTPS tunneling
 * - Enforces network access based on sandbox policy level
 */

import * as http from 'http';
import * as net from 'net';
import { URL } from 'url';
import { SandboxPolicyLevel } from '../shared/types';
import {
  HostLookup,
  denyForm,
  dnsLookup,
  hostPatternAllows,
  hostPatternDenies,
  hostPatternMatches,
  isBlockedAddress,
  isLoopbackAddress,
  isProxyAuthorized,
  parseConnectTarget,
  parseHostPattern,
  pinnedLookup,
  screenAddresses,
  stripProxyAuth,
} from '../shared/egress-screen';
import {
  MODERATE_NETWORK_ALLOWLIST,
  STRICT_NETWORK_ALLOWLIST,
  RUNNER_INFRASTRUCTURE_ALLOWLIST,
} from '../shared/network-allowlist';
import { DEFAULT_BROKER_PORT } from '../shared/constants';

export interface ProxyLogEntry {
  timestamp: string;
  method: string;
  host: string;
  port: number;
  path?: string;
  blocked: boolean;
  /**
   * Why the request was allowed/blocked. 'port' is a refusal of a host that
   * is allowed, but not on the port asked for; 'denied' of a host the
   * repository's policy denies; 'loopback' of a port on this machine that
   * is not open to the job.
   */
  reason?: 'infrastructure' | 'policy' | 'allowlist' | 'moderate-default' | 'permissive' | 'port' | 'denied' | 'loopback';
}

export type ProxyLogCallback = (entry: ProxyLogEntry) => void;

export interface ProxyServerOptions {
  port?: number;
  onLog?: ProxyLogCallback;
  /** Hosts allowed by .localmostrc policy (used in strict mode, merged in moderate mode) */
  allowedHosts?: string[];
  /** Sandbox policy level - controls network access restrictions */
  policyLevel?: SandboxPolicyLevel;
  /**
   * Called when the worker behind this proxy announces which job it is taking.
   * Awaited before the request is forwarded, so the job's policy is in place
   * before the runner can fetch anything for it.
   */
  onJobAcquired?: (jobId: string) => Promise<void>;
  /**
   * A shared secret this proxy requires in Proxy-Authorization. Set per worker
   * so a job cannot route its traffic through another worker's proxy - every
   * proxy is on loopback, where anything on this Mac can reach it. A job's VM
   * is relayed only to its own proxy's port; the token holds should that
   * change. Unset means no auth (test-only).
   */
  authToken?: string;
  /**
   * Resolve a host to its addresses. Injectable for tests; defaults to DNS.
   * The proxy screens what a name resolves to and connects to that address,
   * so a name cannot be re-resolved to somewhere else between check and
   * connect.
   */
  lookup?: (host: string) => Promise<string[]>;
}

/** Statistics tracked per proxy session for job summary */
export interface ProxyStats {
  allowedCount: number;
  blockedCount: number;
  /** Unique hosts that were allowed */
  allowedHosts: Set<string>;
  /** Unique hosts that were blocked */
  blockedHosts: Set<string>;
}

// Re-export for backwards compatibility
export { MODERATE_NETWORK_ALLOWLIST } from '../shared/network-allowlist';

// Moved to src/shared so the test-mode proxy screens the same way; re-exported
// for existing importers.
export { parseConnectTarget } from '../shared/egress-screen';

/**
 * Whether a target names this machine: localhost or a name under it
 * (RFC 6761 reserves them all for loopback), or a loopback address in any
 * spelling isLoopbackAddress reads - 127/8, ::1, and their IPv4-mapped forms,
 * each compared as a deny compares it (see denyForm).
 */
function isLoopbackTarget(host: string): boolean {
  const name = denyForm(host);
  return name === 'localhost' || name.endsWith('.localhost') || isLoopbackAddress(name);
}

export class ProxyServer {
  private server: http.Server | null = null;
  private port: number;
  private onLog: ProxyLogCallback;
  private policyAllowedHosts: string[];
  private policyDeniedHosts: string[] = [];
  /** The broker's port: the one loopback port open, whatever the policy. */
  private brokerPort = DEFAULT_BROKER_PORT;
  private static readonly MAX_ACQUIRE_BODY_BYTES = 64 * 1024;

  private policyLevel: SandboxPolicyLevel;
  private onJobAcquired?: (jobId: string) => Promise<void>;
  private authToken?: string;
  private lookup: HostLookup;
  private connections: Set<net.Socket> = new Set();
  private stats: ProxyStats = {
    allowedCount: 0,
    blockedCount: 0,
    allowedHosts: new Set(),
    blockedHosts: new Set(),
  };

  constructor(options: ProxyServerOptions = {}) {
    this.port = options.port || 0; // 0 = auto-assign
    this.onLog = options.onLog || (() => {});
    this.policyAllowedHosts = options.allowedHosts || [];
    this.policyLevel = options.policyLevel || 'strict';
    this.onJobAcquired = options.onJobAcquired;
    this.authToken = options.authToken;
    this.lookup = options.lookup ?? dnsLookup;
  }

  /** See isBlockedAddress in egress-screen. */
  private isBlockedAddress(ip: string): boolean {
    return isBlockedAddress(ip);
  }

  /**
   * Whether it is safe to connect to a host: it must resolve, and every
   * address it resolves to must be routable off this machine. The connection
   * is then made by name so Node still falls back across a host's IPv4 and
   * IPv6 addresses; pinning a single address broke that fallback and stalled
   * real downloads.
   *
   * A literal target is trusted as written - the broker is reached at the
   * literal 127.0.0.1. Every job can reach that port, through the proxy or
   * directly (the runner dials it directly, so the profile opens it): what
   * guards the broker is the per-worker key in its URL, not the proxy or the
   * port. A
   * name is not trusted as written: it must resolve entirely to
   * routable, off-box addresses, so a repository-controlled hostname cannot
   * rebind to loopback (or any internal range) and reach a local service.
   */
  private screenAddresses(host: string): Promise<string[] | null> {
    return screenAddresses(host, this.lookup, { allowLiteralLoopback: true });
  }

  /** See pinnedLookup in egress-screen. */
  private pinnedLookup(addresses: string[]) {
    return pinnedLookup(addresses);
  }

  /**
   * Check if a host is allowed through the proxy based on policy level.
   * Returns { allowed: boolean, reason: string } for logging.
   *
   * `via` is how the host is asked for: a CONNECT tunnel or a plain HTTP
   * request. An allowed host is reached on that scheme's port - 443 through
   * CONNECT, 80 for plain HTTP - and on any other only when a policy entry
   * spells host:port. Allowing a name used to allow every port on it, so
   * github.com on the infrastructure list opened github.com:22 to every job.
   * A target on this machine is decided by port alone, at every level: see
   * setBrokerPort.
   */
  private checkHostAccess(
    host: string,
    port: number,
    via: 'connect' | 'http'
  ): { allowed: boolean; reason: ProxyLogEntry['reason'] } {
    const normalizedHost = host.toLowerCase();
    const onSchemePort = port === (via === 'connect' ? 443 : 80);

    // Patterns are lowercased as they are read: they come from .localmostrc
    // and are hand-written, so *.GitHub.com must match api.github.com.
    const names = (entry: string): boolean => hostPatternMatches(parseHostPattern(entry), normalizedHost);
    // The built-in lists never spell a port.
    const builtIn = (entry: string): boolean => onSchemePort && names(entry);
    // A policy entry that spells a port allows that port, and only that one
    // (see hostPatternAllows).
    const policyAllows = (entry: string): boolean => hostPatternAllows(entry, normalizedHost, port, via);

    // A host the repository denies is refused whatever its allow list or the
    // level says (see hostPatternDenies).
    const denies = (entry: string): boolean => hostPatternDenies(entry, normalizedHost, port);

    // This machine, on the broker's port and no other, whatever the level:
    // the runner reaches the broker through this proxy, and its per-worker
    // key rather than the port guards it. A job's macOS VM has a loopback of
    // its own; asked of this proxy, a literal loopback target is this Mac's,
    // and without this the job had only to ask - localhost and 127.0.0.1 are
    // on the infrastructure list, and permissive allows anything.
    if (isLoopbackTarget(normalizedHost)) {
      if (port === this.brokerPort) return { allowed: true, reason: 'infrastructure' };
      return { allowed: false, reason: 'loopback' };
    }

    // Runner infrastructure is allowed at every level - without it the runner
    // daemon cannot register or poll for jobs.
    if (RUNNER_INFRASTRUCTURE_ALLOWLIST.some(builtIn)) {
      return { allowed: true, reason: 'infrastructure' };
    }

    if (this.policyDeniedHosts.some(denies)) {
      return { allowed: false, reason: 'denied' };
    }

    // Permissive: allow everything, on any port
    if (this.policyLevel === 'permissive') {
      return { allowed: true, reason: 'permissive' };
    }

    // Check policy allowlist (from .localmostrc)
    if (this.policyAllowedHosts.some(policyAllows)) {
      return { allowed: true, reason: 'policy' };
    }

    // For moderate policy, also check the moderate defaults
    if (this.policyLevel === 'moderate' && MODERATE_NETWORK_ALLOWLIST.some(builtIn)) {
      return { allowed: true, reason: 'moderate-default' };
    }

    // For strict policy, nothing beyond infrastructure unless declared
    if (this.policyLevel === 'strict' && STRICT_NETWORK_ALLOWLIST.some(builtIn)) {
      return { allowed: true, reason: 'allowlist' };
    }

    // Not allowed. A host that would have been allowed on its scheme's port
    // is logged as refused for the port, so the log points at the fix.
    const levelList = this.policyLevel === 'moderate' ? MODERATE_NETWORK_ALLOWLIST : STRICT_NETWORK_ALLOWLIST;
    const named = [RUNNER_INFRASTRUCTURE_ALLOWLIST, this.policyAllowedHosts, levelList].some((list) => list.some(names));
    return { allowed: false, reason: named ? 'port' : undefined };
  }

  /** The body of a 403 for a host checkHostAccess refused. */
  private refusal(host: string, port: number, reason: ProxyLogEntry['reason']): string {
    if (reason === 'loopback') {
      return `Blocked by sandbox policy (${this.policyLevel}): port ${port} on this machine is not open to this job`;
    }
    if (reason === 'denied') {
      return `Blocked by sandbox policy (${this.policyLevel}): host '${host}' is denied by the repository's .localmostrc`;
    }
    if (reason === 'port') {
      const authority = net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
      return `Blocked by sandbox policy (${this.policyLevel}): port ${port} is not allowed for host '${host}'; ` +
        `a .localmostrc network entry '${authority}' allows it`;
    }
    return `Blocked by sandbox policy (${this.policyLevel}): host '${host}' not in allowlist`;
  }

  /**
   * Log a proxy request and update stats
   */
  private log(entry: Omit<ProxyLogEntry, 'timestamp'>): void {
    // Update stats
    if (entry.blocked) {
      this.stats.blockedCount++;
      this.stats.blockedHosts.add(entry.host);
    } else {
      this.stats.allowedCount++;
      this.stats.allowedHosts.add(entry.host);
    }

    this.onLog({
      timestamp: new Date().toISOString(),
      ...entry,
    });
  }

  /**
   * Get current proxy statistics
   */
  getStats(): ProxyStats {
    return {
      ...this.stats,
      allowedHosts: new Set(this.stats.allowedHosts),
      blockedHosts: new Set(this.stats.blockedHosts),
    };
  }

  /**
   * Reset statistics (e.g., between jobs)
   */
  resetStats(): void {
    this.stats = {
      allowedCount: 0,
      blockedCount: 0,
      allowedHosts: new Set(),
      blockedHosts: new Set(),
    };
  }

  /**
   * Get the current policy level
   */
  /**
   * Apply the hosts a repository's .localmostrc allows for the current job.
   *
   * The proxy is created when a runner starts, before the job - and therefore
   * the repository - is known, so the policy arrives later. Replaces any
   * previous job's hosts rather than accumulating across jobs.
   */
  setPolicyAllowedHosts(hosts: string[]): void {
    this.policyAllowedHosts = [...hosts];
  }

  getPolicyAllowedHosts(): string[] {
    return [...this.policyAllowedHosts];
  }

  /**
   * Apply the hosts a repository's .localmostrc denies for the current job.
   *
   * Entries read like allowed ones. A denied host is refused at every level,
   * whatever the policy or the level would allow, except the runner
   * infrastructure on its scheme's port, which the runner itself cannot do
   * without. Replaces any previous job's list, as setPolicyAllowedHosts does.
   */
  setPolicyDeniedHosts(hosts: string[]): void {
    this.policyDeniedHosts = [...hosts];
  }

  /**
   * Set the broker's port: the one loopback port of this Mac a job may reach
   * through this proxy, which the runner cannot work without. No policy
   * opens another, since a job's macOS VM has a loopback of its own. Until
   * this is called the default broker port is the one open.
   */
  setBrokerPort(brokerPort: number): void {
    this.brokerPort = brokerPort;
  }

  /**
   * Set the level for the job about to run.
   *
   * A proxy outlives a single job and serves whichever repository the instance
   * picks up next, so the level has to be reset per job the way hosts are.
   */
  setPolicyLevel(level: SandboxPolicyLevel): void {
    this.policyLevel = level;
  }

  getPolicyLevel(): SandboxPolicyLevel {
    return this.policyLevel;
  }

  /**
   * Handle HTTP CONNECT requests (for HTTPS tunneling)
   */
  private handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer
  ): void {
    if (!this.isProxyAuthorized(req)) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="localmost"\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const target = parseConnectTarget(req.url || '');
    if (!target) {
      this.log({ method: 'CONNECT', host: req.url || '', port: 0, blocked: true, reason: undefined });
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    const { host, port } = target;

    const { allowed, reason } = this.checkHostAccess(host, port, 'connect');
    if (!allowed) {
      this.log({ method: 'CONNECT', host, port, blocked: true, reason });
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    void this.connectScreened(host, port, reason, clientSocket, head);
  }

  /**
   * Screen what an allowed CONNECT target resolves to and open the tunnel.
   * The request is logged here, once, when the screen has decided it: an
   * allowed entry written before the screen refused it counted the one
   * request as both allowed and blocked.
   */
  private async connectScreened(
    host: string,
    port: number,
    reason: ProxyLogEntry['reason'],
    clientSocket: net.Socket,
    head: Buffer
  ): Promise<void> {
    // Tracked from here, not from when the upstream exists: a rotation that
    // lands while the name resolves must take this tunnel with it.
    this.connections.add(clientSocket);
    clientSocket.once('close', () => this.connections.delete(clientSocket));
    const screened = await this.screenAddresses(host);
    if (clientSocket.destroyed) return;
    if (!screened) {
      this.log({ method: 'CONNECT', host, port, blocked: true, reason: undefined });
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    this.log({ method: 'CONNECT', host, port, blocked: false, reason });

    const serverSocket = net.connect({ host, port, lookup: this.pinnedLookup(screened), autoSelectFamily: true }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (_err) => {
      clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
      clientSocket.destroy();
    });

    clientSocket.on('error', () => {
      serverSocket.destroy();
    });

    this.connections.add(clientSocket);
    this.connections.add(serverSocket);

    const cleanup = () => {
      this.connections.delete(clientSocket);
      this.connections.delete(serverSocket);
    };

    clientSocket.on('close', cleanup);
    serverSocket.on('close', cleanup);
  }

  /**
   * The headers a plain request carries upstream: the client's, without our
   * credentials, and with Host set to the authority the request line named.
   * That is the host the policy was checked against; the client's own Host
   * header is whatever it chose to write, and forwarded as written it asks a
   * shared front end - a CDN, a cloud load balancer - for a site the policy
   * never allowed.
   */
  private upstreamHeaders(req: http.IncomingMessage, authority: string): http.IncomingHttpHeaders {
    return { ...stripProxyAuth(req.headers), host: authority };
  }

  /**
   * Handle regular HTTP requests (proxy them)
   */
  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    if (!this.isProxyAuthorized(req)) {
      res.writeHead(407, { 'Content-Type': 'text/plain', 'Proxy-Authenticate': 'Basic realm="localmost"' });
      res.end('Proxy authentication required');
      req.resume();
      return;
    }
    try {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      // WHATWG URL keeps the brackets on an IPv6 hostname; net.isIP, the
      // address screen and http.request all want the bare literal.
      const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
      const port = parseInt(url.port, 10) || 80;
      const path = url.pathname + url.search;

      // A worker takes a job by POSTing acquirejob through its own proxy. That
      // is where this proxy learns which repository it is serving, before the
      // runner fetches a single action for it.
      if (this.onJobAcquired && req.method === 'POST' && url.pathname.endsWith('/acquirejob')) {
        this.handleAcquireJobRequest(req, res, host, port, path, url.host);
        return;
      }

      // Logged once, when the decision is final: a refusal here, or the
      // screen's answer below.
      const { allowed, reason } = this.checkHostAccess(host, port, 'http');
      if (!allowed) {
        this.log({ method: req.method || 'GET', host, port, path, blocked: true, reason });
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end(this.refusal(host, port, reason));
        return;
      }

      this.screenAddresses(host).then((screened) => {
        if (!screened) {
          this.log({ method: req.method || 'GET', host, port, path, blocked: true, reason: undefined });
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end(`Blocked by sandbox policy (${this.policyLevel}): host '${host}' resolves to a non-routable address`);
          req.resume();
          return;
        }
        this.log({ method: req.method || 'GET', host, port, path, blocked: false, reason });
        const proxyReq = this.openUpstream(req, res, {
          hostname: host,
          port,
          path,
          method: req.method,
          headers: this.upstreamHeaders(req, url.host),
          lookup: this.pinnedLookup(screened),
        });
        if (proxyReq) req.pipe(proxyReq);
      });
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Bad request: ${(err as Error).message}`);
    }
  }

  /**
   * Forward an acquirejob request, applying the job's policy first.
   *
   * The body has to be buffered to read the job id, so it is replayed to the
   * upstream request rather than piped.
   */
  private handleAcquireJobRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    host: string,
    port: number,
    path: string,
    authority: string
  ): void {
    // Check the destination before reading anything. Buffering first would let
    // any request to a path ending in /acquirejob consume memory even when the
    // host is blocked outright.
    const { allowed, reason } = this.checkHostAccess(host, port, 'http');
    if (!allowed) {
      this.log({ method: req.method || 'POST', host, port, path, blocked: true, reason });
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(this.refusal(host, port, reason));
      req.resume();
      return;
    }

    // A real acquirejob body is a small JSON object. Anything larger is not one,
    // so stop reading rather than buffering whatever a workflow decides to send.
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > ProxyServer.MAX_ACQUIRE_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('acquirejob body too large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) return;
      const body = Buffer.concat(chunks);
      let jobId: string | undefined;
      try {
        const parsed = JSON.parse(body.toString());
        const raw = parsed.jobMessageId || parsed.jobRequestId || parsed.requestId;
        if (raw) jobId = String(raw);
      } catch {
        // Unreadable body: the policy stays as installed. Failing to read an
        // id is not a reason to widen access.
      }

      // The callback resolves the policy, so a rejection must neither become an
      // unhandled rejection nor swallow the request. Forward either way; the
      // policy that is installed is what the forwarded request is checked
      // against, and a failed resolution leaves it no wider than it was.
      const resolved = jobId
        ? Promise.resolve(this.onJobAcquired?.(jobId)).catch(() => undefined)
        : Promise.resolve(undefined);

      resolved.finally(() => {
        this.forwardBufferedRequest(req, res, host, port, path, authority, body);
      });
    });
  }

  private forwardBufferedRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    host: string,
    port: number,
    path: string,
    authority: string,
    body: Buffer
  ): void {
    const { allowed, reason } = this.checkHostAccess(host, port, 'http');
    if (!allowed) {
      this.log({ method: req.method || 'POST', host, port, path, blocked: true, reason });
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(this.refusal(host, port, reason));
      return;
    }

    // Screened and pinned like any other request. This one has its own
    // upstream request because the body is replayed, and without the screen a
    // name on the allowlist that resolves to loopback or a private range
    // reached it, by whatever the system resolver answered at connect time.
    this.screenAddresses(host).then((screened) => {
      if (!screened) {
        this.log({ method: req.method || 'POST', host, port, path, blocked: true, reason: undefined });
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end(`Blocked by sandbox policy (${this.policyLevel}): host '${host}' resolves to a non-routable address`);
        return;
      }
      this.log({ method: req.method || 'POST', host, port, path, blocked: false, reason });
      // The body is replayed whole, so it is no longer chunked. Leaving both
      // headers on the request makes some servers reject it or frame it wrongly.
      const headers = { ...this.upstreamHeaders(req, authority), 'content-length': String(body.length) };
      delete headers['transfer-encoding'];
      const proxyReq = this.openUpstream(req, res, {
        hostname: host, port, path, method: req.method, headers, lookup: this.pinnedLookup(screened),
      });
      proxyReq?.end(body);
    });
  }

  /**
   * Open the upstream request for a plain request, relaying its response,
   * and tie it to the client: when the client's side closes before the
   * response has finished - the client went away, or a rotation dropped its
   * socket - the upstream request is destroyed with it. Otherwise it outlived
   * both, holding a connection the last job's policy opened to a host.
   *
   * Returns null, having dialled nothing, when the client is already gone:
   * a request can wait on a name lookup or on the job's policy, and the
   * client can leave in that time.
   */
  private openUpstream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options: http.RequestOptions
  ): http.ClientRequest | null {
    if (res.destroyed || req.socket.destroyed) return null;
    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      // pipe() does not end its destination when the source fails, so an
      // upstream that dies partway through its body would leave the client
      // waiting on a response that can no longer finish. Cutting the client
      // off is how it learns the body is short.
      proxyRes.on('error', () => res.destroy());
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      // Once the response has started, or the client has gone, there is no
      // one to send a 502 to; writing one would throw on the sent headers.
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Proxy error: ${err.message}`);
    });
    res.on('close', () => {
      if (!res.writableFinished) proxyReq.destroy();
    });
    return proxyReq;
  }

  /**
   * Start the proxy server
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('connect', (req, socket, head) => {
        // Cast is safe: connect event always provides a net.Socket
        this.handleConnect(req, socket as net.Socket, head);
      });

      this.server.on('error', reject);

      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });
    });
  }

  /**
   * Get the proxy URL for environment variables
   */
  getProxyUrl(): string {
    // A literal address, not "localhost". The proxy binds 127.0.0.1 only, and
    // the guest's relay listens on the same address and port; a name could
    // resolve to ::1 first, where neither listens.
    if (this.authToken) {
      return `http://localmost:${this.authToken}@127.0.0.1:${this.port}`;
    }
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Replace this proxy's token. Called when a worker finishes and again when
   * a slot's proxy is reused for a new worker, so a detached orphan of the
   * previous job - still holding the old token in its HTTP_PROXY - is refused
   * once the slot moves to another repository's policy.
   *
   * Live connections are dropped first. Auth is checked when a tunnel or
   * request is opened and never again, so a tunnel (or a request still
   * streaming) the old token opened would otherwise keep carrying bytes
   * under the new token and policy.
   */
  rotateAuthToken(token: string): void {
    this.closeConnections();
    this.authToken = token;
  }

  /**
   * Drop every live connection: CONNECT tunnels (both ends, tracked in
   * `connections`) and plain-HTTP sockets, including a request mid-stream.
   * Nothing legitimate is connected when this runs - the worker that opened
   * them has exited, or the next one has not been spawned yet.
   */
  private closeConnections(): void {
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();
    // A CONNECT-upgraded socket is detached from the http server, so this
    // reaches only plain-HTTP connections; the loop above covers the tunnels.
    this.server?.closeAllConnections();
  }

  /**
   * Whether a request carries this proxy's token. True when no token is set.
   * The password is compared in constant time; the username is not a secret.
   */
  private isProxyAuthorized(req: http.IncomingMessage): boolean {
    if (!this.authToken) return true;
    return isProxyAuthorized(req.headers['proxy-authorization'], this.authToken);
  }

  /**
   * Get the port the proxy is running on
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Stop the proxy server
   */
  async stop(): Promise<void> {
    this.closeConnections();

    return new Promise((resolve) => {
      if (this.server) {
        // Set a short timeout - don't wait forever for server.close()
        const forceResolve = setTimeout(() => {
          this.server = null;
          resolve();
        }, 1000);

        this.server.close(() => {
          clearTimeout(forceResolve);
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Check if the server is running
   */
  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }
}
