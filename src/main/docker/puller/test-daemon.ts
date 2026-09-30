/**
 * A mock Docker daemon, for the puller's and the cache
 * refresh's tests: it records image loads (parsing the archive the way
 * dockerd would read it), tags, inspects, lists and removals, and can be
 * switched to answer the ways a hostile daemon could.
 *
 * Test-only: nothing in the app imports it.
 */

import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';

export interface DaemonCall {
  method: string;
  path: string;
}

export interface LoadedArchive {
  /** Every entry of the tar, by name. */
  entries: Map<string, Buffer>;
  /** The image id: the digest of the config manifest.json names. */
  id: string;
}

export interface DaemonSwitches {
  /** Answer this endpoint with more than 1 MiB. */
  oversize?: 'load' | 'tag' | 'inspect' | 'list';
  /** Answer the load with this error message. */
  loadError?: string;
  /** Name this image id in the load answer instead of the real one. */
  loadedId?: string;
  /** Answer the inspect of any image with this Id. */
  inspectId?: string;
}

function untar(bytes: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf-8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('utf-8').replace(/\0.*$/s, '').trim(), 8);
    entries.set(name, bytes.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export class TestDaemon {
  readonly calls: DaemonCall[] = [];
  readonly loads: LoadedArchive[] = [];
  readonly switches: DaemonSwitches = {};
  /** The images the daemon holds: id → tags. */
  readonly images = new Map<string, string[]>();

  private constructor(
    private readonly server: http.Server,
    readonly port: number
  ) {}

  /**
   * Listen on TCP 127.0.0.1. The code under test is handed `connect` as its
   * DaemonConnector: a unix socket path under a job's TMPDIR can exceed the
   * 103-byte limit, and a job may bind a local TCP port.
   */
  static async start(): Promise<TestDaemon> {
    let daemon: TestDaemon | null = null;
    const server = http.createServer((req, res) => daemon!.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    daemon = new TestDaemon(server, (server.address() as net.AddressInfo).port);
    return daemon;
  }

  /** A connection to this daemon, whatever socket path it is asked for. */
  readonly connect = (): net.Socket => net.connect(this.port, '127.0.0.1');

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(bytes);
  }

  private oversized(res: http.ServerResponse): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(Buffer.alloc(2 * 1024 * 1024, 0x20));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://docker');
    this.calls.push({ method: req.method ?? 'GET', path: url.pathname + url.search });
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => this.route(req.method ?? 'GET', url, Buffer.concat(chunks), res));
  }

  private route(method: string, url: URL, body: Buffer, res: http.ServerResponse): void {
    const inspect = /^\/images\/(sha256:[0-9a-f]{64})\/json$/.exec(url.pathname);
    const tag = /^\/images\/(sha256:[0-9a-f]{64})\/tag$/.exec(url.pathname);
    if (method === 'GET' && inspect) {
      if (this.switches.oversize === 'inspect') return this.oversized(res);
      if (this.switches.inspectId) return this.send(res, 200, { Id: this.switches.inspectId });
      if (!this.images.has(inspect[1])) return this.send(res, 404, { message: `No such image: ${inspect[1]}` });
      return this.send(res, 200, { Id: inspect[1], RepoTags: this.images.get(inspect[1]) });
    }
    if (method === 'POST' && url.pathname === '/images/load') {
      if (this.switches.oversize === 'load') return this.oversized(res);
      if (this.switches.loadError) {
        return this.send(res, 200, JSON.stringify({ errorDetail: { message: this.switches.loadError }, error: this.switches.loadError }) + '\n');
      }
      const entries = untar(body);
      const manifest = JSON.parse(entries.get('manifest.json')?.toString() ?? '[]') as Array<{ Config: string; Layers: string[] }>;
      const config = entries.get(manifest[0]?.Config ?? '');
      if (!config || !manifest[0].Layers.every((l) => entries.has(l))) {
        return this.send(res, 200, JSON.stringify({ errorDetail: { message: 'invalid archive' }, error: 'invalid archive' }) + '\n');
      }
      const id = `sha256:${crypto.createHash('sha256').update(config).digest('hex')}`;
      this.loads.push({ entries, id });
      if (!this.images.has(id)) this.images.set(id, []);
      return this.send(res, 200, JSON.stringify({ stream: `Loaded image ID: ${this.switches.loadedId ?? id}\n` }) + '\n');
    }
    if (method === 'POST' && tag) {
      if (this.switches.oversize === 'tag') return this.oversized(res);
      if (!this.images.has(tag[1])) return this.send(res, 404, { message: `No such image: ${tag[1]}` });
      this.images.get(tag[1])!.push(`${url.searchParams.get('repo')}:${url.searchParams.get('tag')}`);
      res.writeHead(201).end();
      return;
    }
    if (method === 'GET' && url.pathname === '/images/json') {
      if (this.switches.oversize === 'list') return this.oversized(res);
      return this.send(res, 200, [...this.images].map(([Id, RepoTags]) => ({ Id, RepoTags: RepoTags.length ? RepoTags : null })));
    }
    if (method === 'DELETE' && url.pathname.startsWith('/images/')) {
      const name = decodeURIComponent(url.pathname.slice('/images/'.length));
      if (this.images.delete(name)) return this.send(res, 200, [{ Deleted: name }]);
      for (const tags of this.images.values()) {
        const at = tags.indexOf(name);
        if (at >= 0) {
          tags.splice(at, 1);
          return this.send(res, 200, [{ Untagged: name }]);
        }
      }
      return this.send(res, 404, { message: `No such image: ${name}` });
    }
    return this.send(res, 404, { message: 'page not found' });
  }
}
