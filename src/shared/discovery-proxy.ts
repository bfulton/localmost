/**
 * Discovery Proxy for CLI Test Command
 *
 * A simple HTTP/HTTPS proxy that logs all accessed hosts.
 * Used by `localmost test --updaterc` to discover what network
 * access a workflow actually needs.
 *
 * Also supports filtering mode with an allowlist for enforcement.
 */

import * as http from 'http';
import * as net from 'net';
import { Duplex } from 'stream';

export interface DiscoveryProxyOptions {
  /** Port to listen on (0 = auto-assign) */
  port?: number;
  /** Callback for each network access */
  onAccess?: (host: string, port: number, allowed: boolean) => void;
  /** Optional allowlist for filtering mode (if not provided, all traffic is allowed) */
  allowlist?: string[];
}

/** Statistics about network access during a proxy session */
export interface ProxyAccessStats {
  /** Hosts that were allowed through */
  allowed: string[];
  /** Hosts that were blocked */
  blocked: string[];
}

export class DiscoveryProxy {
  private server: http.Server | null = null;
  private port: number;
  private onAccess: (host: string, port: number, allowed: boolean) => void;
  private connections: Set<Duplex | net.Socket> = new Set();
  private accessedHosts: Set<string> = new Set();
  private allowedHosts: Set<string> = new Set();
  private blockedHosts: Set<string> = new Set();
  private allowlist: string[] | null;

  constructor(options: DiscoveryProxyOptions = {}) {
    this.port = options.port || 0;
    this.onAccess = options.onAccess || (() => {});
    this.allowlist = options.allowlist ?? null;  // null = discovery mode (allow all)
  }

  /**
   * Check if a host is allowed by the allowlist.
   * Returns true if allowed, false if blocked.
   */
  private isHostAllowed(host: string): boolean {
    // If no allowlist, we're in discovery mode - allow everything
    if (this.allowlist === null) {
      return true;
    }

    const normalizedHost = host.toLowerCase();

    // Check against allowlist patterns
    for (const pattern of this.allowlist) {
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(1).toLowerCase(); // Remove *, keep the dot
        if (normalizedHost.endsWith(suffix)) {
          return true;
        }
      } else if (normalizedHost === pattern.toLowerCase()) {
        return true;
      }
    }

    return false;
  }

  /**
   * Start the proxy server.
   * @returns The port the server is listening on.
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('connect', (req, clientSocket, head) => {
        this.handleConnect(req, clientSocket, head);
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server!.address();
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
   * Stop the proxy server.
   */
  async stop(): Promise<void> {
    // Close all active connections
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the proxy URL for use in HTTP_PROXY/HTTPS_PROXY.
   */
  getProxyUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Get all unique hosts that were accessed.
   */
  getAccessedHosts(): string[] {
    return Array.from(this.accessedHosts).sort();
  }

  /**
   * Get statistics about allowed and blocked hosts.
   */
  getAccessStats(): ProxyAccessStats {
    return {
      allowed: Array.from(this.allowedHosts).sort(),
      blocked: Array.from(this.blockedHosts).sort(),
    };
  }

  /**
   * Handle HTTP CONNECT requests (for HTTPS tunneling).
   */
  private handleConnect(
    req: http.IncomingMessage,
    clientSocket: Duplex,
    _head: Buffer
  ): void {
    const [host, portStr] = (req.url || '').split(':');
    const port = parseInt(portStr, 10) || 443;

    // Track this access
    this.accessedHosts.add(host);
    const allowed = this.isHostAllowed(host);
    if (allowed) {
      this.allowedHosts.add(host);
    } else {
      this.blockedHosts.add(host);
    }
    this.onAccess(host, port, allowed);

    // Block if not allowed
    if (!allowed) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.write(`Blocked by sandbox: host '${host}' not in allowlist\r\n`);
      clientSocket.destroy();
      return;
    }

    // Connect to the target
    const serverSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    this.connections.add(clientSocket);
    this.connections.add(serverSocket);

    serverSocket.on('error', () => {
      clientSocket.destroy();
    });

    clientSocket.on('error', () => {
      serverSocket.destroy();
    });

    clientSocket.on('close', () => {
      this.connections.delete(clientSocket);
      this.connections.delete(serverSocket);
      serverSocket.destroy();
    });

    serverSocket.on('close', () => {
      this.connections.delete(clientSocket);
      this.connections.delete(serverSocket);
      clientSocket.destroy();
    });
  }

  /**
   * Handle regular HTTP requests.
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const host = url.hostname;
      const port = parseInt(url.port, 10) || 80;

      // Track this access
      this.accessedHosts.add(host);
      const allowed = this.isHostAllowed(host);
      if (allowed) {
        this.allowedHosts.add(host);
      } else {
        this.blockedHosts.add(host);
      }
      this.onAccess(host, port, allowed);

      // Block if not allowed
      if (!allowed) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end(`Blocked by sandbox: host '${host}' not in allowlist`);
        return;
      }

      // Forward the request
      const proxyReq = http.request(
        {
          hostname: host,
          port,
          path: url.pathname + url.search,
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
        res.end(`Proxy Error: ${err.message}`);
      });

      req.pipe(proxyReq);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Bad Request: ${(err as Error).message}`);
    }
  }
}
