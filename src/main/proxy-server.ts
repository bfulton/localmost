/**
 * HTTP/HTTPS Proxy Server for Runner Network Monitoring
 *
 * Provides a local proxy that:
 * - Logs all outbound connections (destination host:port)
 * - Supports HTTP CONNECT for HTTPS tunneling
 * - Can be configured to allow/deny specific hosts
 */

import * as http from 'http';
import * as net from 'net';
import { URL } from 'url';

export interface ProxyLogEntry {
  timestamp: string;
  method: string;
  host: string;
  port: number;
  path?: string;
  blocked: boolean;
}

export type ProxyLogCallback = (entry: ProxyLogEntry) => void;

export interface ProxyServerOptions {
  port?: number;
  onLog?: ProxyLogCallback;
  allowedHosts?: string[];
}

// Default allowed hosts for GitHub Actions runners
const DEFAULT_ALLOWED_HOSTS = [
  // GitHub API and services
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-registry-files.githubusercontent.com',
  'ghcr.io',
  'pkg.github.com',

  // Node.js (for actions/setup-node)
  'nodejs.org',

  // GitHub Actions specific
  '*.actions.githubusercontent.com', // Covers all regional pipeline hosts (pipelinesghubeus22, etc.)
  'pipelines.actions.githubusercontent.com',
  'results-receiver.actions.githubusercontent.com',
  'vstoken.actions.githubusercontent.com',
  'token.actions.githubusercontent.com',
  'artifactcache.actions.githubusercontent.com',
  '*.blob.core.windows.net', // Azure blob storage for caches/artifacts

  // Common package registries (runners often need these)
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'rubygems.org',
  'crates.io',
  'static.crates.io',
];

export class ProxyServer {
  private server: http.Server | null = null;
  private port: number;
  private onLog: ProxyLogCallback;
  private allowedHosts: string[];
  private connections: Set<net.Socket> = new Set();

  constructor(options: ProxyServerOptions = {}) {
    this.port = options.port || 0; // 0 = auto-assign
    this.onLog = options.onLog || (() => {});
    this.allowedHosts = options.allowedHosts || DEFAULT_ALLOWED_HOSTS;
  }

  /**
   * Check if a host is allowed through the proxy
   */
  private isHostAllowed(host: string): boolean {
    const normalizedHost = host.toLowerCase();

    return this.allowedHosts.some(pattern => {
      if (pattern.startsWith('*.')) {
        // Wildcard match: *.example.com matches sub.example.com
        const suffix = pattern.slice(1); // Remove *
        return normalizedHost.endsWith(suffix);
      }
      return normalizedHost === pattern.toLowerCase();
    });
  }

  /**
   * Log a proxy request
   */
  private log(entry: Omit<ProxyLogEntry, 'timestamp'>): void {
    this.onLog({
      timestamp: new Date().toISOString(),
      ...entry,
    });
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

    const allowed = this.isHostAllowed(host);
    this.log({ method: 'CONNECT', host, port, blocked: !allowed });

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

    serverSocket.on('error', (err) => {
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

      const allowed = this.isHostAllowed(host);
      this.log({ method: req.method || 'GET', host, port, path, blocked: !allowed });

      if (!allowed) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Blocked by proxy: host not in allowlist');
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
