/**
 * MacAgentClient against a scripted agent on a unix socket: the protocol's
 * order, and every way a hostile guest's answer is refused.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { MacAgentClient, jobEnvNameAllowed } from './agent-client';
import { shortTempDir } from '../../test-utils/vm-fixtures';

const HELLO = { v: 1, event: 'hello', agent: '1.0.0', ready: true, os: '26.6.2', runnerVersions: ['2.330.0'] };

describe('MacAgentClient', () => {
  let dir: string;
  let socketPath: string;
  let server: net.Server;
  let received: Array<Record<string, unknown>>;
  let rawReceived: Buffer;
  let onRequest: (msg: Record<string, unknown>, send: (body: unknown) => void, conn: net.Socket) => void;
  let hello: unknown;
  const clients: MacAgentClient[] = [];

  beforeEach(async () => {
    dir = shortTempDir();
    socketPath = path.join(dir, 'agent.sock');
    received = [];
    rawReceived = Buffer.alloc(0);
    hello = HELLO;
    onRequest = (msg, send) => send({ v: 1, id: msg.id, ok: true });
    server = net.createServer((conn) => {
      const send = (body: unknown) => conn.write(`${typeof body === 'string' ? body : JSON.stringify(body)}\n`);
      if (hello !== null) send(hello);
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString('latin1');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line);
          } catch {
            rawReceived = Buffer.concat([rawReceived, Buffer.from(`${line}\n`, 'latin1')]);
            continue;
          }
          received.push(msg);
          onRequest(msg, send, conn);
        }
        if (buf.length > 0 && !buf.startsWith('{')) {
          rawReceived = Buffer.concat([rawReceived, Buffer.from(buf, 'latin1')]);
          buf = '';
        }
      });
      conn.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const client = (timeoutsMs = {}) => {
    const logs: string[] = [];
    const c = new MacAgentClient({ socketPath, log: (_l, m) => logs.push(m), timeoutsMs });
    clients.push(c);
    return { c, logs };
  };

  it('reads the hello, then prepares the guest with the host time, entropy and both ports', async () => {
    const { c } = client();
    expect(await c.connect()).toEqual({ agent: '1.0.0', ready: true, os: '26.6.2', runnerVersions: ['2.330.0'] });
    const entropy = crypto.randomBytes(32);
    await c.prepare({ timeMs: 1_790_000_000_123, entropy, proxyPort: 5000, brokerPort: 8787 });
    expect(received[0]).toEqual({ v: 1, id: 1, op: 'prepare', timeMs: 1_790_000_000_123, entropy: entropy.toString('base64'), proxyPort: 5000, brokerPort: 8787 });
  });

  it('closes on a hello that is not of its form', async () => {
    for (const bad of [
      { ...HELLO, agent: '1.0.0; rm -rf /' },
      { ...HELLO, ready: 'yes' },
      { ...HELLO, runnerVersions: ['2.330.0', '../x'] },
      { ...HELLO, runnerVersions: Array(17).fill('2.330.0') },
      'not json',
    ]) {
      hello = bad;
      const { c } = client();
      await expect(c.connect()).rejects.toMatchObject({ code: 'E_AGENT_PROTOCOL' });
    }
  });

  it('times out an agent that never says hello', async () => {
    hello = null;
    const { c } = client({ hello: 100 });
    await expect(c.connect()).rejects.toMatchObject({ code: 'E_AGENT_TIMEOUT' });
  });

  it('uploads a runner once the agent says to send, and waits for it to be installed', async () => {
    const bytes = crypto.randomBytes(5000);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    onRequest = (msg, send, conn) => {
      if (msg.op !== 'runner') return;
      send({ v: 1, id: msg.id, ok: true, send: true });
      const collected: Buffer[] = [];
      let total = 0;
      conn.removeAllListeners('data');
      conn.on('data', (chunk: Buffer) => {
        collected.push(chunk);
        total += chunk.length;
        if (total >= (msg.bytes as number)) {
          const got = Buffer.concat(collected).subarray(0, msg.bytes as number);
          expect(crypto.createHash('sha256').update(got).digest('hex')).toBe(sha256);
          send({ v: 1, id: msg.id, ok: true, installed: msg.version });
        }
      });
    };
    const { c } = client();
    await c.connect();
    await c.uploadRunner('2.331.0', bytes, sha256);
    expect(received[0]).toEqual({ v: 1, id: 1, op: 'runner', version: '2.331.0', bytes: 5000, sha256 });
  });

  it('starts a job and passes on its output, cleaned, and its exit', async () => {
    onRequest = (msg, send) => {
      if (msg.op !== 'job') return;
      send({ v: 1, id: msg.id, ok: true, pid: 4242 });
      send({ v: 1, event: 'output', stream: 'stdout', data: 'step \u001b[31mone\u001b[0m\u0007 done' });
      send({ v: 1, event: 'output', stream: 'stderr', data: 'warn' });
      send({ v: 1, event: 'exit', code: 3, signal: null });
    };
    const { c } = client();
    await c.connect();
    const lines: string[] = [];
    c.on('output', (stream, line) => lines.push(`${stream}: ${line}`));
    const exit = new Promise((resolve) => c.once('exit', (code, signal) => resolve([code, signal])));
    const files = { '.runner': '{}', '.credentials': '{}', '.credentials_rsaparams': '{}' };
    expect(await c.job({ runnerVersion: '2.330.0', files, env: { LANG: 'C' }, args: ['--once'] })).toBe(4242);
    expect(await exit).toEqual([3, null]);
    expect(lines).toEqual(['stdout: step one  done', 'stderr: warn']);
    expect(received[0]).toMatchObject({ op: 'job', runnerVersion: '2.330.0', files, env: { LANG: 'C' }, args: ['--once'] });
  });

  it('closes on output or an exit from no job, an answer to no request, or a malformed exit', async () => {
    for (const bad of [
      { v: 1, event: 'output', stream: 'stdout', data: 'x' },
      { v: 1, event: 'exit', code: 0, signal: null },
      { v: 1, id: 99, ok: true },
      { v: 1, event: 'teleported' },
    ]) {
      onRequest = (msg, send) => {
        send({ v: 1, id: msg.id, ok: true, jobStarted: false });
        send(bad);
      };
      const { c } = client();
      await c.connect();
      const closed = new Promise((resolve) => c.once('closed', resolve));
      await c.ping();
      expect(await closed).toMatchObject({ code: 'E_AGENT_PROTOCOL' });
    }
    onRequest = (msg, send) => {
      send({ v: 1, id: msg.id, ok: true, pid: 4242 });
      send({ v: 1, event: 'exit', code: 0, signal: 'SIGKILL' });
    };
    const { c } = client();
    await c.connect();
    const files = { '.runner': '', '.credentials': '', '.credentials_rsaparams': '' };
    const closed = new Promise((resolve) => c.once('closed', resolve));
    await c.job({ runnerVersion: '2.330.0', files, env: {}, args: ['--once'] });
    expect(await closed).toMatchObject({ code: 'E_AGENT_PROTOCOL' });
  });

  it('rejects a refused request with the guest\'s message, cleaned', async () => {
    onRequest = (msg, send) => send({ v: 1, id: msg.id, ok: false, code: 'E_PROTO', message: 'a job already\nran in this VM' });
    const { c } = client();
    await c.connect();
    await expect(c.signal('TERM')).rejects.toMatchObject({ code: 'E_AGENT_REFUSED', message: 'a job already ran in this VM' });
  });

  it('closes when a request is not answered in time', async () => {
    onRequest = () => {};
    const { c } = client({ prepare: 100 });
    await c.connect();
    await expect(c.prepare({ timeMs: 1_790_000_000_000, entropy: crypto.randomBytes(32), proxyPort: 1, brokerPort: 2 })).rejects.toMatchObject({
      code: 'E_AGENT_TIMEOUT',
    });
  });
});

describe('jobEnvNameAllowed', () => {
  // The rule the agent holds every job to (MacVMAgentCore.jobEnvNameAllowed):
  // what the backend sends past it the agent refuses, and the job with it.
  it("allows the runner's settings, and a name a repository's env policy passes", () => {
    for (const name of ['HTTPS_PROXY', 'ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT', 'RUNNER_DEBUG', 'LANG', 'DEVELOPER_DIR', 'FASTLANE_USER', '_FLAG']) {
      expect([name, jobEnvNameAllowed(name)]).toEqual([name, true]);
    }
  });

  it("refuses what the agent sets, and what reaches the loader, the shell or the runner's own code", () => {
    for (const name of [
      'PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'IFS', 'NODE_OPTIONS',
      'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'DOTNET_STARTUP_HOOKS', 'COMPlus_EnableDiagnostics',
      'RUNNER_ALLOW_RUNASROOT', 'ACTIONS_RUNNER_HOOK_JOB_STARTED', 'GITHUB_TOKEN', 'BASH_FUNC_x%%',
    ]) {
      expect([name, jobEnvNameAllowed(name)]).toEqual([name, false]);
    }
  });

  it('refuses anything but a plain name of at most 128 characters', () => {
    for (const name of ['', '1ABC', 'A-B', 'A B', 'É', 'A=B', 'A'.repeat(129)]) {
      expect([name, jobEnvNameAllowed(name)]).toEqual([name, false]);
    }
    expect(jobEnvNameAllowed('A'.repeat(128))).toBe(true);
  });
});
