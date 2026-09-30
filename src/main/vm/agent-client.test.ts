/**
 * The guest agent's client against a mock agent on a unix socket (§3.4).
 * Every answer is hostile input: these are the ways one can be wrong.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { UnixAgentClient, AgentClientError } from './agent-client';
import type { AgentConfigureRequest } from './types';
import { shortTempDir } from '../test-utils/vm-fixtures';

type Answer = (request: Record<string, unknown>) => string | Record<string, unknown> | null;

describe('UnixAgentClient', () => {
  let dir: string;
  let socketPath: string;
  let server: net.Server;
  let answer: Answer;
  let lastConnection: net.Socket | null = null;
  const received: Array<Record<string, unknown>> = [];
  const clients: UnixAgentClient[] = [];

  beforeEach(async () => {
    dir = shortTempDir();
    socketPath = path.join(dir, 'agent.sock');
    received.length = 0;
    answer = () => ({});
    server = net.createServer((connection) => {
      lastConnection = connection;
      let buffered = '';
      connection.on('error', () => {});
      connection.on('data', (chunk) => {
        buffered += chunk.toString();
        for (let nl = buffered.indexOf('\n'); nl !== -1; nl = buffered.indexOf('\n')) {
          const request = JSON.parse(buffered.slice(0, nl)) as Record<string, unknown>;
          buffered = buffered.slice(nl + 1);
          received.push(request);
          const reply = answer(request);
          if (reply === null) continue;
          connection.write(typeof reply === 'string' ? `${reply}\n` : `${JSON.stringify({ v: 1, id: request.id, ok: true, ...reply })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const client = (options: Partial<ConstructorParameters<typeof UnixAgentClient>[0]> = {}) => {
    const logs: string[] = [];
    const c = new UnixAgentClient({ socketPath, log: (_level, message) => logs.push(message), ...options });
    clients.push(c);
    return { c, logs };
  };

  const hello = { agent: '0.1.0', guestVersion: '2026.10.0', kernel: '6.18.54-0-virt', agentProtocol: 1 };
  const configured = {
    docker: { version: '29.5.3', apiVersion: '1.54', minApiVersion: '1.24' },
    disk: 'formatted',
    nonce: 'a'.repeat(32),
    rosetta: 'ok',
    selftest: { rules: true, internalNoRelay: true, internalForgedRejected: true, gatewayRejected: true, bridgeReachesRelay: true },
  };
  const jobConfigure: AgentConfigureRequest = {
    vmId: '1-0123456789ab',
    mode: 'job',
    timeUnixMs: 1_700_000_000_000,
    share: { tag: 'work', mountPath: '/Users/me/.localmost/runner/sandbox/1-abcdef012345/_work', nonceFile: '.localmost-share' },
    rosetta: true,
    relay: { address: '198.18.0.1', port: 3128, vsockPort: 3128 },
  };

  it('sends each op with "v":1 and an id, and returns the checked answer', async () => {
    answer = (r) => (r.op === 'hello' ? hello : r.op === 'configure' ? configured : r.op === 'status' ? { dockerd: 'running', uptimeMs: 5 } : {});
    const { c } = client();
    await expect(c.hello()).resolves.toEqual(hello);
    await expect(c.configure(jobConfigure)).resolves.toEqual(configured);
    await c.approveBinds('f'.repeat(64), [{ source: '/s', destination: '/d', readOnly: true }]);
    await c.setTime(123.9);
    await expect(c.status()).resolves.toEqual({ dockerd: 'running', uptimeMs: 5 });
    await c.shutdown();
    expect(received.map((r) => [r.v, r.op])).toEqual([
      [1, 'hello'], [1, 'configure'], [1, 'approve-binds'], [1, 'set-time'], [1, 'status'], [1, 'shutdown'],
    ]);
    expect(new Set(received.map((r) => r.id)).size).toBe(6);
    expect(received[1]).toMatchObject({ vmId: '1-0123456789ab', mode: 'job', share: jobConfigure.share, relay: jobConfigure.relay });
    expect(received[2]).toMatchObject({ container: 'f'.repeat(64), binds: [{ source: '/s', destination: '/d', readOnly: true }] });
    expect(received[3]).toMatchObject({ unixMs: 123 });
  });

  it('drops fields an answer adds beyond its schema', async () => {
    answer = () => ({ ...hello, extra: { path: '/Users/me' } });
    const { c } = client();
    expect(await c.hello()).toEqual(hello);
  });

  it.each([
    ['an oversized string', { ...hello, agent: '1'.repeat(65) }],
    ['a string with a control character', { ...hello, kernel: '6.18\u001b[31m' }],
    ['a field of the wrong type', { ...hello, guestVersion: 2026 }],
    ['another protocol', { ...hello, agentProtocol: 2 }],
    ['a missing field', { agent: '0.1.0', agentProtocol: 1 }],
  ])('rejects a hello answer with %s, and closes the connection', async (_what, reply) => {
    answer = () => reply;
    const { c } = client();
    await expect(c.hello()).rejects.toMatchObject({ code: 'E_AGENT_PROTOCOL' });
    await expect(c.status()).rejects.toMatchObject({ code: 'E_AGENT_PROTOCOL' });
  });

  it.each([
    ['a selftest that is not all booleans', { ...configured, selftest: { ...configured.selftest, rules: 'yes' } }],
    ['an unknown disk state', { ...configured, disk: 'fine' }],
    ['a nonce over 64 characters', { ...configured, nonce: 'n'.repeat(65) }],
    ['a job answer with no nonce', { ...configured, nonce: undefined }],
    ['an API version that is not one', { ...configured, docker: { ...configured.docker, apiVersion: '1.54; rm -rf /' } }],
  ])('rejects a configure answer with %s', async (_what, reply) => {
    answer = () => reply;
    const { c } = client();
    await expect(c.configure(jobConfigure)).rejects.toMatchObject({ code: 'E_AGENT_PROTOCOL' });
  });

  it('rejects an answer to a request it did not send', async () => {
    answer = (r) => JSON.stringify({ v: 1, id: (r.id as number) + 100, ok: true });
    const { c, logs } = client();
    await expect(c.hello()).rejects.toMatchObject({ code: 'E_AGENT_PROTOCOL' });
    expect(logs.some((l) => /not waiting/.test(l))).toBe(true);
  });

  it('rejects a line that is not an answer, or one over 64 KiB', async () => {
    answer = () => 'not json';
    await expect(client().c.hello()).rejects.toMatchObject({ code: 'E_AGENT_PROTOCOL' });
    answer = () => JSON.stringify({ v: 1, id: 1, ok: true, pad: 'x'.repeat(70_000) });
    await expect(client().c.hello()).rejects.toMatchObject({ code: 'E_AGENT_PROTOCOL' });
  });

  it("returns the agent's refusal with its code, and strips control characters from its message before logging", async () => {
    answer = (r) => JSON.stringify({ v: 1, id: r.id, ok: false, code: 'E_DOCKERD', message: 'dockerd:\u001b[31m failed\r\nFAKE LOG LINE' });
    const { c, logs } = client();
    const err = (await c.configure(jobConfigure).catch((e: unknown) => e)) as AgentClientError;
    expect(err.code).toBe('E_DOCKERD');
    expect(err.message).toBe('dockerd: failed  FAKE LOG LINE');
    expect(logs.join('\n')).not.toMatch(/[\u0000-\u001f]/);
    expect(logs.some((l) => l.includes('dockerd: failed  FAKE LOG LINE'))).toBe(true);
  });

  it('keeps an unknown error code out of what it returns', async () => {
    answer = (r) => JSON.stringify({ v: 1, id: r.id, ok: false, code: 'E_../../X', message: 'no' });
    const { c } = client();
    await expect(c.status()).rejects.toMatchObject({ code: 'E_AGENT_UNKNOWN' });
  });

  it('times out each op on its own clock, and drops a late answer without breaking the connection', async () => {
    let first = true;
    answer = (r) => {
      if (r.op === 'status' && first) {
        first = false;
        // Answered, but only after the client has given up on it.
        const id = r.id;
        setTimeout(() => lastConnection?.write(`${JSON.stringify({ v: 1, id, ok: true, dockerd: 'exited', uptimeMs: 9 })}\n`), 200);
        return null;
      }
      return r.op === 'status' ? { dockerd: 'running', uptimeMs: 1 } : {};
    };
    const { c } = client({ timeoutsMs: { status: 100 } });
    const began = Date.now();
    await expect(c.status()).rejects.toMatchObject({ code: 'E_AGENT_TIMEOUT', message: expect.stringMatching(/status/) });
    expect(Date.now() - began).toBeGreaterThanOrEqual(90);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(c.status()).resolves.toEqual({ dockerd: 'running', uptimeMs: 1 });
  });

  it('uses the contract timeouts by default', async () => {
    const { AGENT_TIMEOUTS_MS } = await import('./agent-client');
    expect(AGENT_TIMEOUTS_MS).toEqual({ hello: 5000, configure: 60000, 'approve-binds': 10000, 'set-time': 10000, status: 10000, shutdown: 10000 });
  });

  it('fails every waiting request when the agent goes away', async () => {
    answer = () => null;
    server.on('connection', (connection) => setTimeout(() => connection.destroy(), 20));
    const { c } = client();
    await expect(c.status()).rejects.toMatchObject({ code: 'E_AGENT_CLOSED' });
  });

  it('refuses to send an approval that is not one', async () => {
    const { c } = client();
    await expect(c.approveBinds('../x', [])).rejects.toMatchObject({ code: 'E_BINDS' });
    const many = Array.from({ length: 65 }, (_, i) => ({ source: `/s${i}`, destination: `/d${i}`, readOnly: false }));
    await expect(c.approveBinds('a'.repeat(64), many)).rejects.toMatchObject({ code: 'E_BINDS' });
    expect(received).toEqual([]);
  });
});
