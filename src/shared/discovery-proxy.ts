/**
 * Discovery Proxy for CLI Test Command
 *
 * A simple HTTP/HTTPS proxy that logs all accessed hosts.
 * Used by `localmost test --updaterc` to discover what network
 * access a workflow actually needs.
 *
 * Also supports filtering mode with an allowlist for enforcement.
 */

import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';
import { Duplex } from 'stream';
import {
  HostLookup,
  dnsLookup,
  isProxyAuthorized,
  parseConnectTarget,
  pinnedLookup,
  screenAddresses,
  stripProxyAuth,
} from './egress-screen';

export interface DiscoveryProxyOptions {
  /** Port to listen on (0 = auto-assign) */
  port?: number;
  /** Callback for each network access */
  onAccess?: (host: string, port: number, allowed: boolean) => void;
  /** Optional allowlist for filtering mode (if not provided, all traffic is allowed) */
  allowlist?: string[];
  /** Resolve a host to its addresses. Injectable for tests; defaults to DNS. */
  lookup?: HostLookup;
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
  private lookup: HostLookup;
  /**
   * Required in Proxy-Authorization, and handed to steps in the proxy URL.
   * The proxy listens on loopback, which every runner job's sandbox allows, so
   * without it a job live while `localmost test` runs could use this proxy -
   * under --updaterc, one with no allowlist at all - and add hosts to what
   * discovery writes into .localmostrc. New for every run.
   */
  private readonly authToken = crypto.randomBytes(32).toString('hex');

  constructor(options: DiscoveryProxyOptions = {}) {
    this.port = options.port || 0;
    this.onAccess = options.onAccess || (() => {});
    this.allowlist = options.allowlist ?? null;  // null = discovery mode (allow all)
    this.lookup = options.lookup ?? dnsLookup;
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

  /** Record an access and report whether the allowlist permits it. */
  private recordAccess(host: string, port: number): boolean {
    this.accessedHosts.add(host);
    const allowed = this.isHostAllowed(host);
    if (allowed) {
      this.allowedHosts.add(host);
    } else {
      this.blockedHosts.add(host);
    }
    this.onAccess(host, port, allowed);
    return allowed;
  }

  /**
   * The addresses it is safe to dial for a host, or null. Loopback is refused
   * even as a literal, unlike the runner's proxy: a step already reaches
   * loopback directly, and through this proxy it would reach the ports its
   * sandbox denies, such as the broker's.
   */
  private screen(host: string): Promise<string[] | null> {
    return screenAddresses(host, this.lookup, { allowLiteralLoopback: false });
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
   * Get the proxy URL for use in HTTP_PROXY/HTTPS_PROXY, carrying the token.
   */
  getProxyUrl(): string {
    return `http://localmost:${this.authToken}@127.0.0.1:${this.port}`;
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
    head: Buffer
  ): void {
    // Before anything is recorded: a request without the token is not the
    // workflow's, and must not become a host in .localmostrc.
    if (!isProxyAuthorized(req.headers['proxy-authorization'], this.authToken)) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="localmost"\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // Parsed strictly, so the host that is recorded and screened is exactly
    // the host dialled. Splitting on ':' read an IPv6 literal as '[' and let
    // an out-of-range port through to a throw.
    const target = parseConnectTarget(req.url || '');
    if (!target) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    const { host, port } = target;

    // Block if not allowed
    if (!this.recordAccess(host, port)) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.write(`Blocked by sandbox: host '${host}' not in allowlist\r\n`);
      clientSocket.destroy();
      return;
    }

    this.connections.add(clientSocket);
    clientSocket.once('close', () => this.connections.delete(clientSocket));
    void this.connectScreened(host, port, clientSocket, head);
  }

  private async connectScreened(host: string, port: number, clientSocket: Duplex, head: Buffer): Promise<void> {
    const screened = await this.screen(host);
    if (clientSocket.destroyed) return;
    if (!screened) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.write(`Blocked by sandbox: host '${host}' does not resolve to a routable address\r\n`);
      clientSocket.destroy();
      return;
    }

    // Dialled by name with the screened addresses pinned, so a second
    // resolution cannot send it somewhere else.
    const serverSocket = net.connect({ host, port, lookup: pinnedLookup(screened), autoSelectFamily: true }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    this.connections.add(serverSocket);

    serverSocket.on('error', () => {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
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
    if (!isProxyAuthorized(req.headers['proxy-authorization'], this.authToken)) {
      res.writeHead(407, { 'Content-Type': 'text/plain', 'Proxy-Authenticate': 'Basic realm="localmost"' });
      res.end('Proxy authentication required');
      req.resume();
      return;
    }

    try {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      // WHATWG URL keeps the brackets on an IPv6 hostname; the screen and
      // http.request want the bare literal.
      const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
      const port = parseInt(url.port, 10) || 80;

      // Block if not allowed
      if (!this.recordAccess(host, port)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end(`Blocked by sandbox: host '${host}' not in allowlist`);
        req.resume();
        return;
      }

      void this.screen(host).then((screened) => {
        if (!screened) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end(`Blocked by sandbox: host '${host}' does not resolve to a routable address`);
          req.resume();
          return;
        }

        // Forward the request, without the credentials meant for this proxy.
        const proxyReq = http.request(
          {
            hostname: host,
            port,
            path: url.pathname + url.search,
            method: req.method,
            headers: stripProxyAuth(req.headers),
            lookup: pinnedLookup(screened),
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
      });
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Bad Request: ${(err as Error).message}`);
    }
  }
}
