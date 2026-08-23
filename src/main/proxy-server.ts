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
  private policyLevel: SandboxPolicyLevel;
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
        const suffix = pattern.slice(1); // Remove *
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
