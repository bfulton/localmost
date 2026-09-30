/**
 * HelperClient against the fake helper, spawned directly (contract §2.4, §8).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { HelperClient, HelperRunArgs, exitErrorCode, helperArgs } from './helper-client';
import { fakeHelperSpawn, layOutVmData, shortTempDir, VmLayout } from '../test-utils/vm-fixtures';

describe('the helper argument line', () => {
  it('is exactly the §2.1 flags for each mode', () => {
    const common = { vmId: '1-0123456789ab', dataDir: '/d', resources: '/r', cpus: 4, memoryMiB: 8192, rosetta: 'auto' as const };
    expect(helperArgs({ ...common, mode: 'job', sandboxId: '1-abcdefabcdef', proxyPort: 5000 })).toEqual([
      'run', '--vm-id', '1-0123456789ab', '--mode', 'job', '--data-dir', '/d', '--resources', '/r',
      '--sandbox-id', '1-abcdefabcdef', '--proxy-port', '5000', '--cpus', '4', '--memory-mib', '8192', '--rosetta', 'auto',
    ]);
    expect(helperArgs({ ...common, vmId: '0-0123456789ab', mode: 'refresh', repoKey: '0123456789abcdef' })).toEqual([
      'run', '--vm-id', '0-0123456789ab', '--mode', 'refresh', '--data-dir', '/d', '--resources', '/r',
      '--repo-key', '0123456789abcdef', '--cpus', '4', '--memory-mib', '8192', '--rosetta', 'auto',
    ]);
  });
});

describe('exitErrorCode', () => {
  it('maps every §2.4 exit code, and names its own for the rest', () => {
    expect(exitErrorCode(0, null)).toBeUndefined();
    const table: Array<[number, string]> = [
      [64, 'E_ARGS'], [65, 'E_SHARE'], [66, 'E_GUEST_IMAGE'], [67, 'E_DISK'], [68, 'E_VZ_CONFIG'],
      [69, 'E_VZ_START'], [70, 'E_SOCKET'], [71, 'E_GUEST_ERROR'], [72, 'E_SYNC'],
    ];
    for (const [code, name] of table) expect([code, exitErrorCode(code, null)]).toEqual([code, name]);
    expect(exitErrorCode(1, null)).toBe('E_HELPER_EXIT');
    expect(exitErrorCode(null, 'SIGKILL')).toBe('E_HELPER_KILLED');
  });
});

describe('HelperClient with the fake helper', () => {
  let root: string;
  let layout: VmLayout;
  const vmId = '1-0123456789ab';
  const clients: HelperClient[] = [];

  beforeEach(() => {
    root = shortTempDir();
    layout = layOutVmData(root);
    fs.mkdirSync(path.join(layout.data, 'vm', 'jobs', vmId), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(layout.data, 'vm', 'jobs', vmId, 'data.img'), '');
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.kill();
      await client.exited();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const vmDir = () => path.join(layout.data, 'vm', 'jobs', vmId);
  const runArgs = (overrides: Partial<HelperRunArgs> = {}): HelperRunArgs => ({
    vmId,
    mode: 'job',
    dataDir: layout.data,
    resources: layout.resources,
    sandboxId: layout.sandboxId,
    proxyPort: 5000,
    cpus: 2,
    memoryMiB: 1024,
    rosetta: 'auto',
    ...overrides,
  });

  const client = (script: Record<string, unknown> = {}, args: Partial<HelperRunArgs> = {}, killAfterMs?: number) => {
    const logs: Array<{ level: string; message: string }> = [];
    const events: string[] = [];
    const c = new HelperClient({
      helper: '/unused/localmost-vm',
      args: runArgs(args),
      spawn: fakeHelperSpawn(script),
      env: { PATH: '/usr/bin:/bin', TMPDIR: vmDir() },
      expectSockets: { dockerSocket: path.join(vmDir(), 'docker.sock'), agentSocket: path.join(vmDir(), 'agent.sock') },
      log: (level, message) => logs.push({ level, message }),
      ...(killAfterMs !== undefined ? { killAfterMs } : {}),
    });
    for (const name of ['listening', 'started', 'stopped', 'exit']) c.on(name, () => events.push(name));
    clients.push(c);
    return { c, logs, events };
  };
  const startedOf = (c: HelperClient) => new Promise<void>((resolve) => c.once('started', () => resolve()));

  it('reports listening, then started, then stopped, and exits cleanly when its stdin closes', async () => {
    const { c, events, logs } = client();
    c.start();
    await startedOf(c);
    expect(c.listening()).toEqual({ dockerSocket: path.join(vmDir(), 'docker.sock'), agentSocket: path.join(vmDir(), 'agent.sock') });
    expect(c.started()).toMatchObject({ pid: c.pid(), rosetta: 'notInstalled' });
    c.closeStdin();
    const exit = await c.exited();
    expect(exit).toMatchObject({ code: 0, stopped: { reason: 'requested', synced: false } });
    expect(exit.errorCode).toBeUndefined();
    expect(events).toEqual(['listening', 'started', 'stopped', 'exit']);
    expect(logs.some((l) => l.message === 'stdin closed')).toBe(true);
  });

  it('kills a helper that writes a line that is not a valid event', async () => {
    for (const bad of ['not json', '{"v":2,"event":"started"}', '{"v":1,"event":"started","pid":-1,"rosetta":"off","startMs":1}', '{"v":1,"event":"teleported"}', '{"v":1,"id":99,"ok":true}']) {
      const { c } = client({ helper: { stdout: [bad] } });
      c.start();
      const exit = await c.exited();
      expect([bad, exit.errorCode, exit.signal]).toEqual([bad, 'E_HELPER_PROTOCOL', 'SIGKILL']);
    }
  });

  it('kills a helper that reports sockets other than its own', async () => {
    const { c } = client();
    // Told to expect other sockets than the fake binds.
    (c as unknown as { opts: { expectSockets: { dockerSocket: string } } }).opts.expectSockets.dockerSocket = '/elsewhere/docker.sock';
    c.start();
    expect((await c.exited()).errorCode).toBe('E_HELPER_PROTOCOL');
  });

  it('stops with no grace at once, asking and then signalling', async () => {
    const { c, logs } = client();
    c.start();
    await startedOf(c);
    const exit = await c.stop(0);
    expect(exit).toMatchObject({ code: 0, stopped: { reason: 'requested' } });
    expect(logs.map((l) => l.message)).toContain('stop graceMs=0');
  });

  it('stops with a grace by asking, and signals nothing while the guest is given its time', async () => {
    const { c, logs } = client({ helper: { stopDelayMs: 300 } });
    c.start();
    await startedOf(c);
    const exit = await c.stop(10_000);
    expect(exit).toMatchObject({ code: 0, stopped: { reason: 'requested' } });
    const messages = logs.map((l) => l.message);
    expect(messages).toContain('stop graceMs=10000');
    expect(messages).not.toContain('SIGTERM');
  });

  it('SIGKILLs a helper that has not exited 5 s after SIGTERM', async () => {
    const { c, logs } = client({ helper: { ignoreSigterm: true, stopDelayMs: 60_000 } });
    c.start();
    await startedOf(c);
    const began = Date.now();
    const exit = await c.stop(0);
    expect(exit.signal).toBe('SIGKILL');
    expect(exit.errorCode).toBe('E_HELPER_KILLED');
    expect(Date.now() - began).toBeGreaterThanOrEqual(4900);
    expect(logs.map((l) => l.message)).toContain('SIGTERM');
  }, 30_000);

  it('maps its exit code to the error it names', async () => {
    const cases: Array<[Record<string, unknown>, Partial<HelperRunArgs>, string]> = [
      [{ helper: { exitAfterListening: 69 } }, {}, 'E_VZ_START'],
      [{}, { vmId: '0-0123456789ab' }, 'E_ARGS'],
      [{}, { sandboxId: '2-abcdef012345' }, 'E_SHARE'],
    ];
    for (const [script, args, code] of cases) {
      const { c } = client(script, args);
      c.start();
      expect([code, (await c.exited()).errorCode]).toEqual([code, code]);
    }
  });

  it('refuses a share that is a link, and a missing disk, before listening', async () => {
    fs.renameSync(layout.share, `${layout.share}-real`);
    fs.symlinkSync(`${layout.share}-real`, layout.share);
    const linked = client();
    linked.c.start();
    expect((await linked.c.exited()).errorCode).toBe('E_SHARE');
    expect(linked.events).toEqual(['exit']);

    fs.unlinkSync(layout.share);
    fs.renameSync(`${layout.share}-real`, layout.share);
    fs.rmSync(path.join(vmDir(), 'data.img'));
    const diskless = client();
    diskless.c.start();
    expect((await diskless.c.exited()).errorCode).toBe('E_DISK');
  });

  it('answers ping with its state', async () => {
    const { c } = client();
    c.start();
    await startedOf(c);
    expect(await c.ping()).toBe('running');
  });

  it('logs its stderr under the level it names, stripped of control characters', async () => {
    const { c, logs } = client({ helper: { exitAfterListening: 69 } });
    c.start();
    await c.exited();
    expect(logs).toContainEqual({ level: 'error', message: 'start failed' });
  });
});
