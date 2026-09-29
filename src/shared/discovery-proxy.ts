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
  hostPatternAllows,
  hostPatternDenies,
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
  /** Hosts refused whatever the allowlist says, read as the runner's proxy reads network.deny. */
  denylist?: string[];
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
  private denylist: string[];
  private lookup: HostLookup;
  /**
   * Required in Proxy-Authorization, and handed to steps in the proxy URL.
   * The proxy listens on loopback, which a runner job's sandbox allows when its
   * policy grants loopback, so without it a job live while `localmost test`
   * runs could use this proxy - under --updaterc, one with no allowlist at
   * all - and add hosts to what discovery writes into .localmostrc. New for
   * every run.
   */
  private readonly authToken = crypto.randomBytes(32).toString('hex');

  constructor(options: DiscoveryProxyOptions = {}) {
    this.port = options.port || 0;
    this.onAccess = options.onAccess || (() => {});
    this.allowlist = options.allowlist ?? null;  // null = discovery mode (allow all)
    this.denylist = options.denylist ?? [];
    this.lookup = options.lookup ?? dnsLookup;
  }

  /**
   * Whether the policy lets a step reach host:port, asked for through a
   * CONNECT tunnel or as a plain HTTP request: 'allowed', 'denied' or
   * 'not-allowlisted'. As the runner's proxy reads a policy, so a run here
   * holds what a runner job would: a denied host is refused first, whatever
   * an allow entry covers, and an allowed host is reached on its scheme's
   * port and on another only when an entry spells host:port. Discovery, with
   * no allowlist, observes every host on every port.
   */
  private checkHost(host: string, port: number, via: 'connect' | 'http'): 'allowed' | 'denied' | 'not-allowlisted' {
    if (this.denylist.some((entry) => hostPatternDenies(entry, host, port))) return 'denied';
    if (this.allowlist === null) return 'allowed';
    return this.allowlist.some((entry) => hostPatternAllows(entry, host, port, via)) ? 'allowed' : 'not-allowlisted';
  }

  /** The body of a refusal the policy made, naming which part of it. */
  private static refusal(host: string, port: number, verdict: 'denied' | 'not-allowlisted'): string {
    return verdict === 'denied'
      ? `Blocked by sandbox: host '${host}' is denied by the policy`
      : `Blocked by sandbox: '${host}' on port ${port} is not in the allowlist`;
  }

  /**
   * The network entry that allows host:port, reached this way: the bare host
   * on its scheme's port - 443 through CONNECT, 80 for plain HTTP - and
   * host:port on any other, an IPv6 address in brackets, as
   * hostPatternAllows reads an entry.
   */
  private static entryFor(host: string, port: number, via: 'connect' | 'http'): string {
    if (port === (via === 'connect' ? 443 : 80)) return host;
    return `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  }

  /**
   * Record an access once its outcome is known.
   *
   * A host the address screen refused is blocked but not an accessed host:
   * discovery offers the accessed hosts for .localmostrc, and one the screen
   * refuses would be a grant that can never work. An accessed host is kept
   * as the entry that allows it, port and all, so what discovery writes is
   * what the next, enforcing run lets through.
   */
  private recordAccess(
    host: string,
    port: number,
    via: 'connect' | 'http',
    outcome: 'allowed' | 'denied' | 'not-allowlisted' | 'unroutable'
  ): void {
    if (outcome !== 'unroutable') this.accessedHosts.add(DiscoveryProxy.entryFor(host, port, via));
    if (outcome === 'allowed') {
      this.allowedHosts.add(host);
    } else {
      this.blockedHosts.add(host);
    }
    this.onAccess(host, port, outcome === 'allowed');
  }

  /**
   * The addresses it is safe to dial for a host, or null. Loopback is refused
   * even as a literal, unlike the runner's proxy: a step reaches the loopback
   * ports its policy grants directly, and through this proxy it would reach
   * the ones its sandbox denies, such as the broker's.
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
   * Every host that was accessed, once each, as the network entry that
   * allows it: host, or host:port for a port its scheme does not use.
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

    const verdict = this.checkHost(host, port, 'connect');
    if (verdict !== 'allowed') {
      this.recordAccess(host, port, 'connect', verdict);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.write(`${DiscoveryProxy.refusal(host, port, verdict)}\r\n`);
      clientSocket.destroy();
      return;
    }

    this.connections.add(clientSocket);
    clientSocket.once('close', () => this.connections.delete(clientSocket));
    void this.connectScreened(host, port, clientSocket, head);
  }

  private async connectScreened(host: string, port: number, clientSocket: Duplex, head: Buffer): Promise<void> {
    const screened = await this.screen(host);
    this.recordAccess(host, port, 'connect', screened ? 'allowed' : 'unroutable');
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

      const verdict = this.checkHost(host, port, 'http');
      if (verdict !== 'allowed') {
        this.recordAccess(host, port, 'http', verdict);
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end(DiscoveryProxy.refusal(host, port, verdict));
        req.resume();
        return;
      }

      void this.screen(host).then((screened) => {
        this.recordAccess(host, port, 'http', screened ? 'allowed' : 'unroutable');
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
