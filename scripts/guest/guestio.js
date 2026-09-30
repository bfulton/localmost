'use strict';

// Talking to a booted guest from the Mac, through vzrun's unix sockets: the
// agent's control protocol (contract §3.4) and the Docker API. Used by the
// build's smoke boot and by the acceptance harness.

const http = require('http');
const net = require('net');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An agent connection: `request(op, fields)` resolves with the answer object. */
class AgentConn {
  constructor(sock) {
    this.sock = sock;
    this.buf = '';
    this.nextId = 1;
    this.waiting = new Map();
    sock.on('data', (d) => {
      this.buf += d.toString('utf8');
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const w = this.waiting.get(msg.id);
        if (w) {
          this.waiting.delete(msg.id);
          w.resolve(msg);
        }
      }
    });
    const failAll = (err) => {
      for (const w of this.waiting.values()) w.reject(err);
      this.waiting.clear();
    };
    sock.on('close', () => failAll(new Error('agent connection closed')));
    sock.on('error', failAll);
  }

  request(op, fields = {}, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`agent ${op}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.sock.write(JSON.stringify({ v: 1, id, op, ...fields }) + '\n');
    });
  }

  /** Sends a raw line (for protocol tests). */
  raw(line) {
    this.sock.write(line);
  }

  close() {
    this.sock.destroy();
  }
}

/**
 * Connects to the agent through `path`, retrying until the guest listens
 * (each failed dial is closed at once by vzrun) and hello answers.
 */
async function connectAgent(path, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const sock = await new Promise((resolve, reject) => {
        const s = net.connect(path);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      });
      const conn = new AgentConn(sock);
      const hello = await conn.request('hello', {}, 2000);
      if (hello.ok) return { conn, hello };
      conn.close();
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`the agent did not answer hello within ${timeoutMs} ms`);
    await sleep(20);
  }
}

/** One Docker API request over the unix socket; resolves with status, headers and the body. */
function docker(socketPath, method, path, { body, headers = {}, maxBytes = 64 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, headers: { Host: 'docker', ...headers } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) req.destroy(new Error('answer too large'));
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

module.exports = { connectAgent, docker, sleep };
