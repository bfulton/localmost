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
  MODERATE_NETWORK_ALLOWLIST,
  STRICT_NETWORK_ALLOWLIST,
  RUNNER_INFRASTRUCTURE_ALLOWLIST,
} from '../shared/network-allowlist';

export interface ProxyLogEntry {
  timestamp: string;
  method: string;
  host: string;
  port: number;
  path?: string;
  blocked: boolean;
  /** Why the request was allowed/blocked */
  reason?: 'infrastructure' | 'policy' | 'allowlist' | 'moderate-default' | 'permissive';
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

export class ProxyServer {
  private server: http.Server | null = null;
  private port: number;
  private onLog: ProxyLogCallback;
  private policyAllowedHosts: string[];
  private static readonly MAX_ACQUIRE_BODY_BYTES = 64 * 1024;

  private policyLevel: SandboxPolicyLevel;
  private onJobAcquired?: (jobId: string) => Promise<void>;
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
  }

  /**
   * Check if a host is allowed through the proxy based on policy level.
   * Returns { allowed: boolean, reason: string } for logging.
   */
  private checkHostAccess(host: string): { allowed: boolean; reason: ProxyLogEntry['reason'] } {
    const normalizedHost = host.toLowerCase();

    // Permissive: allow everything
    if (this.policyLevel === 'permissive') {
      return { allowed: true, reason: 'permissive' };
    }

    // Helper to check if host matches a pattern
    const matchesPattern = (pattern: string): boolean => {
      if (pattern.startsWith('*.')) {
        // Lowercase the suffix too: patterns come from .localmostrc and are
        // hand-written, so *.GitHub.com must match api.github.com.
        const suffix = pattern.slice(1).toLowerCase(); // Remove *
        return normalizedHost.endsWith(suffix);
      }
      return normalizedHost === pattern.toLowerCase();
    };

    // Runner infrastructure is allowed at every level - without it the runner
    // daemon cannot register or poll for jobs.
    if (RUNNER_INFRASTRUCTURE_ALLOWLIST.some(matchesPattern)) {
      return { allowed: true, reason: 'infrastructure' };
    }

    // Check policy allowlist (from .localmostrc)
    if (this.policyAllowedHosts.some(matchesPattern)) {
      return { allowed: true, reason: 'policy' };
    }

    // For moderate policy, also check the moderate defaults
    if (this.policyLevel === 'moderate') {
      if (MODERATE_NETWORK_ALLOWLIST.some(matchesPattern)) {
        return { allowed: true, reason: 'moderate-default' };
      }
    }

    // For strict policy, nothing beyond infrastructure unless declared
    if (this.policyLevel === 'strict') {
      if (STRICT_NETWORK_ALLOWLIST.some(matchesPattern)) {
        return { allowed: true, reason: 'allowlist' };
      }
    }

    // Not allowed
    return { allowed: false, reason: undefined };
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
    const [host, portStr] = (req.url || '').split(':');
    const port = parseInt(portStr, 10) || 443;

    const { allowed, reason } = this.checkHostAccess(host);
    this.log({ method: 'CONNECT', host, port, blocked: !allowed, reason });

    if (!allowed) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const serverSocket = net.connect(port, host, () => {
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
   * Handle regular HTTP requests (proxy them)
   */
  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    try {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const host = url.hostname;
      const port = parseInt(url.port, 10) || 80;
      const path = url.pathname + url.search;

      // A worker takes a job by POSTing acquirejob through its own proxy. That
      // is where this proxy learns which repository it is serving, before the
      // runner fetches a single action for it.
      if (this.onJobAcquired && req.method === 'POST' && url.pathname.endsWith('/acquirejob')) {
        this.handleAcquireJobRequest(req, res, host, port, path);
        return;
      }

      const { allowed, reason } = this.checkHostAccess(host);
      this.log({ method: req.method || 'GET', host, port, path, blocked: !allowed, reason });

      if (!allowed) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end(`Blocked by sandbox policy (${this.policyLevel}): host '${host}' not in allowlist`);
        return;
      }

      const proxyReq = http.request(
        {
          hostname: host,
          port,
          path,
          method: req.method,
          headers: req.headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );

      proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`Proxy error: ${err.message}`);
      });

      req.pipe(proxyReq);
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
    path: string
  ): void {
    // Check the destination before reading anything. Buffering first would let
    // any request to a path ending in /acquirejob consume memory even when the
    // host is blocked outright.
    const { allowed, reason } = this.checkHostAccess(host);
    if (!allowed) {
      this.log({ method: req.method || 'POST', host, port, path, blocked: true, reason });
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(`Blocked by sandbox policy (${this.policyLevel}): host '${host}' not in allowlist`);
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
        this.forwardBufferedRequest(req, res, host, port, path, body);
      });
    });
  }

  private forwardBufferedRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    host: string,
    port: number,
    path: string,
    body: Buffer
  ): void {
    const { allowed, reason } = this.checkHostAccess(host);
    this.log({ method: req.method || 'POST', host, port, path, blocked: !allowed, reason });
    if (!allowed) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(`Blocked by sandbox policy (${this.policyLevel}): host '${host}' not in allowlist`);
      return;
    }

    // The body is replayed whole, so it is no longer chunked. Leaving both
    // headers on the request makes some servers reject it or frame it wrongly.
    const headers = { ...req.headers, 'content-length': String(body.length) };
    delete headers['transfer-encoding'];
    const proxyReq = http.request(
      { hostname: host, port, path, method: req.method, headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Proxy error: ${err.message}`);
    });
    proxyReq.end(body);
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
   * Uses localhost to match sandbox-exec network rules
   */
  getProxyUrl(): string {
    return `http://localhost:${this.port}`;
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
    // Close all active connections
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();

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
