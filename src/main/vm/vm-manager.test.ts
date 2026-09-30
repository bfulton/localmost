/**
 * VmManager against the fake helper, spawned directly (contract §5.1, §5.4,
 * §5.6; the design's Edge cases).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { DockerVmConfig } from '../config';
import { GuestImage } from './guest-image';
import { DefaultVmManager, VmManagerOptions } from './vm-manager';
import type { VmError, VmHandle, VmRequest } from './types';
import { FAKE_HELPER, fakeHelperSpawn, layOutVmData, shortTempDir, VmLayout } from '../test-utils/vm-fixtures';

const GiB = 1024 ** 3;

const baseConfig: DockerVmConfig = {
  prewarm: false,
  cpus: 1,
  memoryMiB: 1024,
  maxRunning: 2,
  dataDiskGiB: 64,
  bootTimeoutSec: 60,
  cacheLimitGiB: 20,
  pullMaxGiB: 10,
  jobPullMaxGiB: 30,
  minFreeGiB: 20,
};

/** Resolve once `check` holds, polling; the fake helper is a real process. */
async function eventually(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('DefaultVmManager', () => {
  let root: string;
  let layout: VmLayout;
  let config: DockerVmConfig;
  let scripts: Array<Record<string, unknown>>;
  let spawned: number;
  let logs: Array<{ level: string; message: string }>;
  let prepared: Array<{ repoKey: string; dest: string; sizeGiB: number }>;
  let discarded: Array<{ repoKey: string; reason: string }>;
  let managers: DefaultVmManager[];

  beforeEach(() => {
    root = shortTempDir();
    layout = layOutVmData(root);
    config = { ...baseConfig };
    scripts = [];
    spawned = 0;
    logs = [];
    prepared = [];
    discarded = [];
    managers = [];
  });

  afterEach(async () => {
    for (const manager of managers) await manager.shutdownAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const manager = (overrides: Partial<VmManagerOptions> = {}) => {
    const m = new DefaultVmManager({
      dataDir: layout.data,
      resources: layout.resources,
      helperPath: () => FAKE_HELPER,
      guest: new GuestImage(path.join(layout.resources, 'guest')),
      config: () => config,
      cacheDisks: {
        prepareJobDisk: async (repoKey, dest, sizeGiB) => {
          prepared.push({ repoKey, dest, sizeGiB });
          fs.writeFileSync(dest, '');
          return 'blank';
        },
        discard: async (repoKey, reason) => {
          discarded.push({ repoKey, reason });
        },
      },
      log: (level, message) => logs.push({ level, message }),
      spawnHelper: () => (helper, args, env) => {
        spawned++;
        return fakeHelperSpawn(scripts.shift() ?? {})(helper, args, env);
      },
      freeBytes: async () => 500 * GiB,
      excludeFromBackup: async () => {},
      ...overrides,
    });
    managers.push(m);
    return m;
  };

  const jobRequest = (overrides: Partial<VmRequest> = {}): VmRequest => ({
    mode: 'job',
    slot: 1,
    sandboxId: layout.sandboxId,
    shareRealPath: layout.share,
    shareNonce: layout.nonce,
    repository: 'owner/repo',
    repoKey: '0123456789abcdef',
    proxyPort: 5000,
    ...overrides,
  });

  const refreshRequest = (): VmRequest => {
    fs.mkdirSync(path.join(layout.data, 'vm', 'cache', '0123456789abcdef'), { recursive: true });
    fs.writeFileSync(path.join(layout.data, 'vm', 'cache', '0123456789abcdef', 'data.img.new'), '');
    return { mode: 'refresh', slot: 0, repository: 'owner/repo', repoKey: '0123456789abcdef' };
  };

  const failureOf = async (vm: VmHandle): Promise<VmError> => (await vm.ready().catch((err: VmError) => err)) as VmError;

  describe('a job VM', () => {
    it('boots to ready, reports the guest, and is gone once stopped', async () => {
      const m = manager();
      const vm = m.start(jobRequest());
      expect(vm.dockerSocketPath).toBe(path.join(layout.data, 'vm', 'jobs', vm.vmId, 'docker.sock'));
      const ready = await vm.ready();
      expect(ready).toMatchObject({ docker: { version: '29.5.3', apiVersion: '1.54' }, rosetta: 'absent' });
      expect(vm.state()).toBe('ready');
      await expect(vm.agent().status()).resolves.toMatchObject({ dockerd: 'running' });
      expect(logs.some((l) => l.level === 'info' && l.message.startsWith(`Docker VM ${vm.vmId} ready in `))).toBe(true);
      // The profile and the pid file are the VM's; the configure carried the share and the relay.
      const configure = logs.find((l) => l.message.includes('configure {'))!.message;
      expect(configure).toContain(`"mountPath":"${layout.share}"`);
      expect(configure).toContain('"relay":{"address":"198.18.0.1","port":3128,"vsockPort":3128}');

      await vm.stop('the job ended');
      expect(vm.state()).toBe('stopped');
      expect(fs.existsSync(path.join(layout.data, 'vm', 'jobs', vm.vmId))).toBe(false);
      await expect(vm.stopped()).resolves.toMatchObject({ reason: 'requested' });
    });

    it('writes its profile and pid file into its own directory, readable by the app alone', async () => {
      const m = manager();
      const vm = m.start(jobRequest());
      await vm.ready();
      const dir = path.join(layout.data, 'vm', 'jobs', vm.vmId);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.readFileSync(path.join(dir, 'helper.sb'), 'utf-8')).toContain(`(subpath "${layout.share}")`);
      expect(Number(fs.readFileSync(path.join(dir, 'helper.pid'), 'utf-8'))).toBeGreaterThan(1);
      expect(fs.statSync(path.join(layout.data, 'vm')).mode & 0o777).toBe(0o700);
    });
  });

  describe('admission', () => {
    it('runs at most maxRunning, and starts the rest in the order they came', async () => {
      config.maxRunning = 1;
      const m = manager();
      const a = m.start(jobRequest());
      const b = m.start(jobRequest({ slot: 2 }));
      const c = m.start(jobRequest({ slot: 3 }));
      await a.ready();
      expect([b.state(), c.state()]).toEqual(['queued', 'queued']);
      await a.stop('done');
      await b.ready();
      expect(c.state()).toBe('queued');
      await b.stop('done');
      await c.ready();
    });

    it('starts a refresh only after every job waiting', async () => {
      config.maxRunning = 1;
      const m = manager();
      const a = m.start(jobRequest());
      await a.ready();
      const refresh = m.start(refreshRequest());
      const job = m.start(jobRequest({ slot: 2 }));
      await a.stop('done');
      await job.ready();
      expect(refresh.state()).toBe('queued');
      await job.stop('done');
      await refresh.ready();
    });

    it('lets a queued VM leave the queue without booting', async () => {
      config.maxRunning = 1;
      const m = manager();
      const a = m.start(jobRequest());
      const b = m.start(jobRequest({ slot: 2 }));
      await b.stop('the job ended');
      expect(b.state()).toBe('stopped');
      expect(await failureOf(b)).toMatchObject({ stage: 'admission', code: 'E_CANCELLED' });
      await a.ready();
      expect(spawned).toBe(1);
    });
  });

  describe('a boot that fails', () => {
    const expectFailure = async (vm: VmHandle, stage: string, code: string) => {
      const failure = await failureOf(vm);
      expect({ stage: failure.stage, code: failure.code }).toEqual({ stage, code });
      await vm.stopped();
      expect(vm.state()).toBe('failed');
      expect(vm.failure()).toBe(failure);
      expect(logs.some((l) => l.message.startsWith(`Docker VM ${vm.vmId} failed at ${stage} (${code})`))).toBe(true);
      expect(fs.existsSync(path.join(layout.data, 'vm', 'jobs', vm.vmId))).toBe(false);
    };

    it('at the disk: too little free space, never into the floor', async () => {
      const m = manager({ freeBytes: async () => 27 * GiB });
      const vm = m.start(jobRequest());
      await expectFailure(vm, 'disk', 'E_NO_DISK');
      expect(vm.failure()!.message).toBe('not enough free disk for a Docker VM');
      expect(spawned).toBe(0);
    });

    it('at the disk: the clone could not be made', async () => {
      const m = manager();
      (m as unknown as { opts: VmManagerOptions }).opts.cacheDisks.prepareJobDisk = async () => {
        throw new Error('clonefile: ENOSPC');
      };
      await expectFailure(m.start(jobRequest()), 'disk', 'E_DISK');
    });

    it('at the helper: a guest whose artifact changed', async () => {
      fs.appendFileSync(path.join(layout.resources, 'guest', 'vmlinux'), 'x');
      await expectFailure(manager().start(jobRequest()), 'helper', 'E_GUEST_IMAGE');
      expect(spawned).toBe(0);
    });

    it('at the helper: a share that became a link, checked before the helper is spawned', async () => {
      fs.renameSync(layout.share, `${layout.share}-real`);
      fs.symlinkSync(`${layout.share}-real`, layout.share);
      await expectFailure(manager().start(jobRequest()), 'helper', 'E_SHARE');
      expect(spawned).toBe(0);
    });

    it('at the helper: VZ would not start', async () => {
      scripts.push({ helper: { exitAfterListening: 69 } });
      await expectFailure(manager().start(jobRequest()), 'helper', 'E_VZ_START');
    });

    it('at the agent: silent past the limit', async () => {
      scripts.push({ helper: { agentAfterMs: 60_000 } });
      await expectFailure(manager({ agentSilentMs: 500 }).start(jobRequest()), 'agent', 'E_AGENT_SILENT');
    });

    it('at configure: dockerd did not come up', async () => {
      scripts.push({ configure: { error: { code: 'E_DOCKERD', message: 'dockerd: no\u001b[2J' } } });
      const vm = manager().start(jobRequest());
      await expectFailure(vm, 'configure', 'E_DOCKERD');
      expect(vm.failure()!.message).toBe('dockerd: no');
    });

    it('at configure: a corrupt cache disk, which is discarded', async () => {
      scripts.push({ configure: { error: { code: 'E_DISK', message: 'e2fsck found errors' } } });
      await expectFailure(manager().start(jobRequest()), 'configure', 'E_DISK');
      expect(discarded).toEqual([{ repoKey: '0123456789abcdef', reason: 'corrupt' }]);
    });

    it('at configure: a firewall self-test that did not pass', async () => {
      scripts.push({ configure: { answer: { selftest: { rules: true, internalNoRelay: true, internalForgedRejected: false, gatewayRejected: true, bridgeReachesRelay: true } } } });
      const vm = manager().start(jobRequest());
      await expectFailure(vm, 'configure', 'E_SELFTEST');
      expect(vm.failure()!.message).toContain('internalForgedRejected');
    });

    it('at the nonce: a guest that did not read back what the app wrote is torn down, and logged at error', async () => {
      scripts.push({ configure: { answer: { nonce: 'f'.repeat(32) } } });
      const vm = manager().start(jobRequest());
      await expectFailure(vm, 'nonce', 'E_NONCE');
      expect(logs.find((l) => l.message.includes('failed at nonce'))!.level).toBe('error');
    });

    it('is never retried', async () => {
      scripts.push({ helper: { exitAfterListening: 69 } });
      const vm = manager().start(jobRequest());
      await vm.stopped();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(spawned).toBe(1);
    });
  });

  it('leaves nothing behind when stopped mid-boot', async () => {
    scripts.push({ helper: { agentAfterMs: 60_000 } });
    const m = manager();
    const vm = m.start(jobRequest());
    const dir = path.join(layout.data, 'vm', 'jobs', vm.vmId);
    await eventually(() => fs.existsSync(path.join(dir, 'helper.pid')), 'the helper to start');
    const pid = Number(fs.readFileSync(path.join(dir, 'helper.pid'), 'utf-8'));
    await eventually(() => fs.existsSync(path.join(dir, 'agent.sock')), 'the helper to listen');
    await vm.stop('the job was cancelled');
    expect(await failureOf(vm)).toMatchObject({ code: 'E_CANCELLED' });
    expect(vm.state()).toBe('stopped');
    expect(fs.existsSync(dir)).toBe(false);
    expect(alive(pid)).toBe(false);
  });

  describe('a VM that stops after it was ready', () => {
    it('is failed when its helper crashes', async () => {
      const vm = manager().start(jobRequest());
      await vm.ready();
      const pid = Number(fs.readFileSync(path.join(layout.data, 'vm', 'jobs', vm.vmId, 'helper.pid'), 'utf-8'));
      process.kill(pid, 'SIGKILL');
      await vm.stopped();
      expect(vm.state()).toBe('failed');
      expect(vm.failure()).toMatchObject({ stage: 'running', code: 'E_HELPER_KILLED', message: "the job's Docker VM stopped unexpectedly" });
    });

    it('is failed when its agent exits and the guest powers off', async () => {
      scripts.push({ helper: { guestExitAfterMs: 800 } });
      const vm = manager().start(jobRequest());
      await vm.ready();
      await expect(vm.stopped()).resolves.toMatchObject({ reason: 'guest' });
      expect(vm.state()).toBe('failed');
      expect(vm.failure()).toMatchObject({ stage: 'running', message: "the job's Docker VM stopped unexpectedly" });
    });
  });

  describe('the spare', () => {
    it('starts only after the jobs waiting, and is claimed once', async () => {
      config.maxRunning = 1;
      const m = manager();
      const job = m.start(jobRequest({ slot: 2 }));
      const spare = m.start(jobRequest({ spare: true }));
      await job.ready();
      expect(spare.state()).toBe('queued');
      await job.stop('done');
      await spare.ready();
      expect(m.claimSpare(spare.vmId)).toBe(true);
      expect(m.claimSpare(spare.vmId)).toBe(false);
      expect(m.claimSpare('9-0123456789ab')).toBe(false);
    });
  });

  describe('waking from sleep', () => {
    it('sets every ready VM\'s clock, and stops the spare', async () => {
      const m = manager();
      const vm = m.start(jobRequest());
      const spare = m.start(jobRequest({ slot: 2, spare: true }));
      await Promise.all([vm.ready(), spare.ready()]);
      const before = Date.now();
      m.onResume();
      await eventually(() => logs.some((l) => l.message.startsWith(`[vm ${vm.vmId}] set-time `)), 'set-time');
      const setTo = Number(logs.find((l) => l.message.startsWith(`[vm ${vm.vmId}] set-time `))!.message.split(' ').pop());
      expect(setTo).toBeGreaterThanOrEqual(before);
      await spare.stopped();
      expect(spare.state()).toBe('stopped');
      expect(vm.state()).toBe('ready');
    });
  });

  describe('memory pressure', () => {
    it('starts no spare and no refresh at warn, and boots no job at critical, until it eases', async () => {
      config.maxRunning = 4;
      const m = manager();
      m.onMemoryPressure('warn');
      const spare = m.start(jobRequest({ spare: true }));
      const refresh = m.start(refreshRequest());
      const job = m.start(jobRequest({ slot: 2 }));
      await job.ready();
      expect([spare.state(), refresh.state()]).toEqual(['queued', 'queued']);

      // Rising pressure stops the spare, even one still waiting.
      m.onMemoryPressure('critical');
      await spare.stopped();
      expect(spare.state()).toBe('stopped');
      const late = m.start(jobRequest({ slot: 3 }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(late.state()).toBe('queued');

      m.onMemoryPressure('normal');
      await Promise.all([late.ready(), refresh.ready()]);
    });

    it('stops a running spare when pressure rises', async () => {
      const m = manager();
      const spare = m.start(jobRequest({ spare: true }));
      await spare.ready();
      m.onMemoryPressure('warn');
      await spare.stopped();
      expect(spare.state()).toBe('stopped');
    });
  });

  describe('disk space', () => {
    it('gives a data disk the configured size, less what running VMs were promised', async () => {
      let allocated = 0;
      const m = manager({ freeBytes: async () => 100 * GiB, allocatedBytes: async () => allocated });
      await m.start(jobRequest()).ready();
      allocated = 10 * GiB;
      await m.start(jobRequest({ slot: 2 })).ready();
      // 100 free - 20 floor - (64 promised - 10 used) = 26.
      expect(prepared.map((p) => p.sizeGiB)).toEqual([64, 26]);
    });

    it('stops the VM whose disk grew most when free space falls under half the floor', async () => {
      let free = 500 * GiB;
      const sizes = new Map<string, number>();
      const m = manager({ freeBytes: async () => free, allocatedBytes: async (file) => sizes.get(file) ?? 0 });
      const small = m.start(jobRequest());
      const large = m.start(jobRequest({ slot: 2 }));
      await Promise.all([small.ready(), large.ready()]);
      sizes.set(path.join(layout.data, 'vm', 'jobs', small.vmId, 'data.img'), 1 * GiB);
      sizes.set(path.join(layout.data, 'vm', 'jobs', large.vmId, 'data.img'), 30 * GiB);
      free = 9 * GiB;
      await m.checkFreeSpace();
      expect(large.state()).toBe('failed');
      expect(large.failure()!.message).toBe('host disk nearly full');
      expect(small.state()).toBe('ready');
    });
  });

  describe('the startup sweep', () => {
    it("kills only a live process at the helper's path, and removes every VM directory and unfinished refresh", async () => {
      const jobs = path.join(layout.data, 'vm', 'jobs');
      const stranger = spawn('/bin/sleep', ['60']);
      const helperLike = spawn('/bin/sleep', ['60']);
      const leftovers: Record<string, number> = {
        '1-aaaaaaaaaaaa': helperLike.pid!,
        '2-bbbbbbbbbbbb': stranger.pid!,
        '3-cccccccccccc': 999_999,
      };
      for (const [vmId, pid] of Object.entries(leftovers)) {
        fs.mkdirSync(path.join(jobs, vmId), { recursive: true });
        fs.writeFileSync(path.join(jobs, vmId, 'helper.pid'), `${pid}\n`);
      }
      fs.mkdirSync(path.join(jobs, 'not-a-vm'), { recursive: true });
      refreshRequest();
      const killed: Array<[number, string]> = [];
      const m = manager({
        processExecutable: async (pid) => (pid === helperLike.pid ? FAKE_HELPER : pid === stranger.pid ? '/bin/sleep' : null),
        kill: (pid, signal) => {
          killed.push([pid, signal]);
          process.kill(pid, signal);
        },
      });
      try {
        await m.sweep();
        expect(killed).toEqual([[helperLike.pid, 'SIGKILL']]);
        expect(fs.readdirSync(jobs)).toEqual(['not-a-vm']);
        expect(fs.existsSync(path.join(layout.data, 'vm', 'cache', '0123456789abcdef', 'data.img.new'))).toBe(false);
        expect(alive(stranger.pid!)).toBe(true);
      } finally {
        stranger.kill('SIGKILL');
        helperLike.kill('SIGKILL');
      }
    });

    it('finds nothing to do on a first run', async () => {
      await expect(manager().sweep()).resolves.toBeUndefined();
    });
  });

  describe('shutdownAll', () => {
    it('stops every VM, and gives up waiting at its bound, killing what is left', async () => {
      scripts.push({ helper: { ignoreSigterm: true, stopDelayMs: 60_000 } }, {});
      const m = manager({ shutdownAllMs: 1000, killAfterMs: 60_000 });
      const stubborn = m.start(jobRequest());
      const plain = m.start(jobRequest({ slot: 2 }));
      await Promise.all([stubborn.ready(), plain.ready()]);
      const began = Date.now();
      await m.shutdownAll();
      expect(Date.now() - began).toBeLessThan(5000);
      await Promise.all([stubborn.stopped(), plain.stopped()]);
      expect([stubborn.state(), plain.state()]).toEqual(['stopped', 'stopped']);
    });
  });

  it('refuses a job request missing what a job VM needs', () => {
    expect(() => manager().start(jobRequest({ shareNonce: undefined }))).toThrow(/nonce/);
  });
});
