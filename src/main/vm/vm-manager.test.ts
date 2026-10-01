/**
 * VmManager against the fake helper, spawned directly (contract §5.1, §5.4,
 * §5.6; the design's Edge cases).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { DockerVmConfig } from '../config';
import { GuestImage } from './guest-image';
import { DefaultVmManager, processExecutableOf, VmManagerOptions } from './vm-manager';
import type { VmError, VmHandle, VmRequest } from './types';
import { assertVmSocketsFit, dockerOnPath, FAKE_HELPER, fakeHelperSpawn, layOutVmData, shortTempDir, VmLayout } from '../test-utils/vm-fixtures';

// Each test spawns real processes - the fake helper is a node - and these
// suites also run inside a job's sandbox on a loaded CI machine: jest's 5 s
// default is not a bound any test here means to assert.
jest.setTimeout(30_000);

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

describe('the VM test fixtures', () => {
  it("say so when a VM's socket path under the test's data directory would be too long", () => {
    // Inside a job TMPDIR is deep in the sandbox; this says why a connect
    // would fail, rather than letting it fail later with ENAMETOOLONG or worse.
    expect(() => assertVmSocketsFit(`/${'x'.repeat(67)}`)).toThrow(/104 bytes, past the 103 a unix socket's path may have/);
    expect(() => assertVmSocketsFit(`/${'x'.repeat(66)}`)).not.toThrow();
  });

  describe("find where docker resolves on a job's PATH", () => {
    let root: string;
    let bin: string;
    let cli: string;
    let other: string;

    beforeEach(() => {
      root = shortTempDir();
      bin = path.join(root, 'node_modules', '.bin');
      cli = path.join(root, 'Resources', 'docker-cli');
      other = path.join(root, 'usr-local-bin');
      for (const dir of [bin, cli, other]) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(bin, 'jest'), '', { mode: 0o755 });
      fs.writeFileSync(path.join(cli, 'docker'), '', { mode: 0o755 });
      fs.writeFileSync(path.join(other, 'docker'), '', { mode: 0o755 });
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('resolves to the bundled CLI behind a directory with no docker, as npm puts node_modules/.bin first', () => {
      expect(dockerOnPath(`${bin}:${cli}:${other}:/usr/bin`)).toEqual({ bundledDir: cli, resolved: path.join(cli, 'docker') });
    });

    it('resolves to another docker that comes before the bundled one', () => {
      expect(dockerOnPath(`${other}:${cli}`)).toEqual({ bundledDir: cli, resolved: path.join(other, 'docker') });
    });

    it('has no bundled directory when the PATH has none', () => {
      expect(dockerOnPath(`${bin}:${other}`)).toEqual({ bundledDir: undefined, resolved: path.join(other, 'docker') });
    });

    it('passes over a docker that is not an executable file, as the shell does', () => {
      fs.chmodSync(path.join(other, 'docker'), 0o644);
      fs.mkdirSync(path.join(bin, 'docker'));
      expect(dockerOnPath(`${bin}:${other}:${cli}`).resolved).toBe(path.join(cli, 'docker'));
    });
  });
});

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
  let runnerSlots: number;

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
    runnerSlots = 1;
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
      runnerSlots: () => runnerSlots,
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

  /** The pid of a VM's helper, from the file the manager wrote. */
  const helperPid = (vm: VmHandle): number =>
    Number(fs.readFileSync(path.join(layout.data, 'vm', 'jobs', vm.vmId, 'helper.pid'), 'utf-8'));

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
      // The profile and the pid file are the VM's; the configure carried the
      // share and the relay. The fake logs it on its stderr, which may be read
      // after the agent's answer on the socket.
      await eventually(() => logs.some((l) => l.message.includes('configure {')), "the fake's log of the configure");
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

    describe("at the helper: the share checks Electron makes before the helper's", () => {
      /** A device number for each path, as stat(2) follows it, with the ones given changed. */
      const devices = (moved: Record<string, number>) => (p: string) => moved[p] ?? fs.statSync(p).dev;

      const expectShareRefused = async (vm: VmHandle, why: string) => {
        await expectFailure(vm, 'helper', 'E_SHARE');
        expect(vm.failure()!.message).toContain(why);
        expect(spawned).toBe(0);
      };

      it('refuses a share with something mounted over it', async () => {
        const m = manager({ deviceOf: devices({ [layout.share]: 999 }) });
        await expectShareRefused(m.start(jobRequest()), 'something is mounted over it');
      });

      it('refuses a sandbox with something mounted over it, which puts the share on its device too', async () => {
        const m = manager({ deviceOf: devices({ [layout.share]: 999, [layout.sandbox]: 999 }) });
        await expectShareRefused(m.start(jobRequest()), 'something is mounted over its sandbox');
      });

      it('refuses a sandbox that was replaced by a link to another sandbox', async () => {
        // The VM asked for the share the link leads to, as a worker that
        // resolved its sandbox after the swap would.
        const other = layOutVmData(root, '2-abcdef012345');
        const real = `${layout.sandbox}-real`;
        fs.renameSync(layout.sandbox, real);
        fs.symlinkSync(other.sandbox, layout.sandbox);
        await expectShareRefused(manager().start(jobRequest({ shareRealPath: other.share })), 'its path runs through a link');
      });

      it('refuses a request for a share that is not the one its sandbox id names', async () => {
        const other = layOutVmData(root, '2-abcdef012345');
        await expectShareRefused(manager().start(jobRequest({ shareRealPath: other.share })), 'not the share the VM was asked for');
      });
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

    it('at configure: a blank disk the guest cannot use', async () => {
      scripts.push({ configure: { error: { code: 'E_DISK', message: 'mke2fs failed' } } });
      await expectFailure(manager().start(jobRequest()), 'configure', 'E_DISK');
      expect(discarded).toEqual([]);
    });

    it('at configure: a firewall self-test that did not pass', async () => {
      scripts.push({ configure: { answer: { selftest: { rules: true, internalNoRelay: true, internalForgedRejected: false, gatewayRejected: true, bridgeReachesRelay: true, outsideRejected: true } } } });
      const vm = manager().start(jobRequest());
      await expectFailure(vm, 'configure', 'E_SELFTEST');
      expect(vm.failure()!.message).toContain('internalForgedRejected');
    });

    it('at configure: a job whose connection off the guest was not reset at once', async () => {
      scripts.push({ configure: { answer: { selftest: { rules: true, internalNoRelay: true, internalForgedRejected: true, gatewayRejected: true, bridgeReachesRelay: true, outsideRejected: false } } } });
      const vm = manager().start(jobRequest());
      await expectFailure(vm, 'configure', 'E_SELFTEST');
      expect(vm.failure()!.message).toContain('outsideRejected');
    });

    it('at configure: a refresh VM checks the firewall rules alone, which is all its self-test runs', async () => {
      const notRun = { internalNoRelay: false, internalForgedRejected: false, gatewayRejected: false, bridgeReachesRelay: false, outsideRejected: false };
      scripts.push({ configure: { answer: { selftest: { rules: true, ...notRun } } } });
      await expect(manager().start(refreshRequest()).ready()).resolves.toMatchObject({ docker: { version: '29.5.3' } });
      scripts.push({ configure: { answer: { selftest: { rules: false, ...notRun } } } });
      const vm = managers[0].start(refreshRequest());
      await expectFailure(vm, 'configure', 'E_SELFTEST');
      expect(vm.failure()!.message).toContain('rules');
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

  it('discards a corrupt cache disk and boots once more, on a blank disk', async () => {
    // The guest could not use the clone of the repository's golden disk: the
    // golden disk goes, and the job still gets its VM.
    scripts.push({ configure: { error: { code: 'E_DISK', message: 'e2fsck found errors' } } }, {});
    const kinds: Array<'clone' | 'blank'> = ['clone', 'blank'];
    const m = manager();
    (m as unknown as { opts: VmManagerOptions }).opts.cacheDisks.prepareJobDisk = async (repoKey, dest, sizeGiB) => {
      prepared.push({ repoKey, dest, sizeGiB });
      fs.writeFileSync(dest, '');
      return kinds.shift()!;
    };
    const vm = m.start(jobRequest());
    await expect(vm.ready()).resolves.toMatchObject({ docker: { version: '29.5.3' } });
    expect(discarded).toEqual([{ repoKey: '0123456789abcdef', reason: 'corrupt' }]);
    expect(spawned).toBe(2);
    expect(prepared).toHaveLength(2);
    expect(logs.some((l) => l.level === 'warn' && /cache disk was corrupt and has been discarded; it boots again on a blank disk/.test(l.message))).toBe(true);
  });

  it('boots a corrupt clone again only once', async () => {
    scripts.push(
      { configure: { error: { code: 'E_DISK', message: 'e2fsck found errors' } } },
      { configure: { error: { code: 'E_DISK', message: 'e2fsck found errors' } } }
    );
    const m = manager();
    (m as unknown as { opts: VmManagerOptions }).opts.cacheDisks.prepareJobDisk = async (_repoKey, dest) => {
      fs.writeFileSync(dest, '');
      return 'clone';
    };
    const vm = m.start(jobRequest());
    expect(await failureOf(vm)).toMatchObject({ stage: 'configure' });
    expect(spawned).toBe(2);
  });

  it('leaves nothing behind when stopped mid-boot', async () => {
    scripts.push({ helper: { agentAfterMs: 60_000 } });
    const m = manager();
    const vm = m.start(jobRequest());
    const dir = path.join(layout.data, 'vm', 'jobs', vm.vmId);
    await eventually(() => fs.existsSync(path.join(dir, 'helper.pid')), 'the helper to start');
    const pid = Number(fs.readFileSync(path.join(dir, 'helper.pid'), 'utf-8'));
    // The VM has started and the manager is saying hello to its agent: not
    // the socket's existence, which comes before the helper's started event.
    const trying = `[vm ${vm.vmId}] agent.sock: the agent is not up yet`;
    await eventually(() => logs.some((l) => l.message === trying), 'the manager to try the agent');
    await vm.stop('the job was cancelled');
    // The stage the stop interrupted: the helper had started, the agent not answered.
    expect(await failureOf(vm)).toMatchObject({ stage: 'agent', code: 'E_CANCELLED' });
    expect(vm.state()).toBe('stopped');
    expect(fs.existsSync(dir)).toBe(false);
    expect(alive(pid)).toBe(false);
  });

  it('leaves no directory when stopped while a stage is still making it', async () => {
    // The stage a stop abandons still runs to its end; the teardown waits for
    // it, or it would make the VM's directory again after it was removed.
    let excluding!: () => void;
    const excluded = new Promise<void>((resolve) => (excluding = resolve));
    let entered!: () => void;
    const inStage = new Promise<void>((resolve) => (entered = resolve));
    const m = manager({
      excludeFromBackup: async () => {
        entered();
        await excluded;
      },
    });
    const vm = m.start(jobRequest());
    await inStage;
    const stopping = vm.stop('the job was cancelled');
    excluding();
    await stopping;
    expect(fs.existsSync(path.join(layout.data, 'vm', 'jobs', vm.vmId))).toBe(false);
    expect(spawned).toBe(0);
    expect(await failureOf(vm)).toMatchObject({ stage: 'disk', code: 'E_CANCELLED' });
  });

  it('holds its slot at the gate while it fails, until its helper has gone', async () => {
    // Stopped for the host with a helper that ignores SIGTERM: it is failed
    // at once, but still holds its memory until the SIGKILL.
    // The helper goes when the test kills it, not on a timer a loaded machine may miss.
    config.maxRunning = 1;
    scripts.push({ helper: { ignoreSigterm: true, stopDelayMs: 600_000 } }, {}, {});
    let free = 500 * GiB;
    const m = manager({ freeBytes: async () => free, killAfterMs: 600_000 });
    const failing = m.start(jobRequest());
    await failing.ready();
    const pid = helperPid(failing);
    const waiting = m.start(jobRequest({ slot: 2 }));
    free = 1 * GiB;
    const stopping = m.checkFreeSpace();
    await eventually(() => failing.state() === 'failed', 'the VM to fail');
    // Anything that pumps the gate: another start.
    const later = m.start(jobRequest({ slot: 3 }));
    expect(waiting.state()).toBe('queued');
    free = 500 * GiB;
    process.kill(pid, 'SIGKILL');
    await stopping;
    await failing.stopped();
    await waiting.ready();
    await waiting.stop('done');
    await later.ready();
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

    it('is stopped, not failed, when a refresh VM powers off after its shutdown', async () => {
      const m = manager();
      const refresh = m.start(refreshRequest());
      await refresh.ready();
      await refresh.agent().shutdown();
      await expect(refresh.stopped()).resolves.toEqual({ reason: 'guest', synced: true });
      expect(refresh.state()).toBe('stopped');
      expect(refresh.failure()).toBeUndefined();
      expect(logs.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
    });

    it('is failed when a refresh VM stops without syncing its disk', async () => {
      const refresh = manager().start(refreshRequest());
      await refresh.ready();
      process.kill(helperPid(refresh), 'SIGUSR2');
      await expect(refresh.stopped()).resolves.toEqual({ reason: 'guest', synced: false });
      expect(refresh.state()).toBe('failed');
    });

    it('is failed when its agent exits and the guest powers off', async () => {
      const vm = manager().start(jobRequest());
      await vm.ready();
      process.kill(helperPid(vm), 'SIGUSR2');
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

    it('is one in all: a second is refused while the first lives, and allowed once it is claimed or gone', async () => {
      config.maxRunning = 4;
      const m = manager();
      const first = m.start(jobRequest({ spare: true }));
      expect(() => m.start(jobRequest({ slot: 2, spare: true }))).toThrow(/already a spare/);
      await first.ready();
      expect(() => m.start(jobRequest({ slot: 2, spare: true }))).toThrow(/already a spare/);
      // Claimed, it is a job's VM, and the next idle worker may have a spare.
      expect(m.claimSpare(first.vmId)).toBe(true);
      const second = m.start(jobRequest({ slot: 2, spare: true }));
      await second.ready();
      await second.stop('the worker exited');
      const third = m.start(jobRequest({ slot: 3, spare: true }));
      await third.ready();
      expect(spawned).toBe(3);
    });

    it('gives its slot to a job that finds the gate full', async () => {
      config.maxRunning = 1;
      const m = manager();
      const spare = m.start(jobRequest({ spare: true }));
      await spare.ready();
      const job = m.start(jobRequest({ slot: 2 }));
      await job.ready();
      await expect(spare.stopped()).resolves.toMatchObject({ reason: 'requested' });
      expect(spare.state()).toBe('stopped');
      expect(logs.some((l) => l.message === `Docker VM ${spare.vmId} stopping: a job needs its slot`)).toBe(true);
    });

    it('is not stopped for a job while the gate has room', async () => {
      config.maxRunning = 2;
      const m = manager();
      const spare = m.start(jobRequest({ spare: true }));
      await spare.ready();
      await m.start(jobRequest({ slot: 2 })).ready();
      expect(spare.state()).toBe('ready');
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
    /** What each job VM's data disk was set aside, in GiB, in the order they were sized. */
    const setAsideGiB = (): number[] =>
      logs.flatMap((l) => {
        const match = /^Docker VM \S+ data disk: \d+ GiB, (\d+) GiB of it set aside/.exec(l.message);
        return match ? [Number(match[1])] : [];
      });

    const dataDiskOf = (vm: VmHandle): string => path.join(layout.data, 'vm', 'jobs', vm.vmId, 'data.img');

    it("makes a lone job's disk dockerVm.dataDiskGiB, the golden disk's size, and sets aside its share of free space", async () => {
      // 200 GiB free, four slots and a refresh: a share of 36 GiB. A disk of
      // that size could not clone the 64 GiB golden disk (§6.5) and would
      // boot blank; nor need a job running alone stop at 36 while the other
      // slots sit idle.
      config.maxRunning = 8;
      runnerSlots = 4;
      const m = manager({ freeBytes: async () => 200 * GiB, allocatedBytes: async () => 0 });
      await m.start(jobRequest()).ready();
      expect(prepared.map((p) => p.sizeGiB)).toEqual([64]);
      expect(setAsideGiB()).toEqual([36]);
    });

    it('sets aside a share, less what running VMs were promised and have not used', async () => {
      let allocated = 0;
      const m = manager({ freeBytes: async () => 100 * GiB, allocatedBytes: async () => allocated });
      await m.start(jobRequest()).ready();
      allocated = 10 * GiB;
      await m.start(jobRequest({ slot: 2 })).ready();
      // One runner slot and a refresh, under maxRunning 2: (100 free - 20
      // floor) / 2 = 40; then 80 - (40 promised - 10 used) = 50, all left
      // to the one claimant still without a disk.
      expect(setAsideGiB()).toEqual([40, 50]);
      expect(prepared.map((p) => p.sizeGiB)).toEqual([64, 64]);
    });

    it('shares the free space between VMs booting at once, rather than giving the first nearly all of it', async () => {
      // CI's first live run: 79 GiB free, four slots. The first VM was
      // promised 59 GiB and the next two were refused.
      config.maxRunning = 8;
      runnerSlots = 4;
      const m = manager({ freeBytes: async () => 79 * GiB, allocatedBytes: async () => 0 });
      const vms = [1, 2, 3].map((slot) => m.start(jobRequest({ slot })));
      await Promise.all(vms.map((vm) => vm.ready()));
      // Four slots and a refresh share 59 GiB: about 12 each.
      const shares = setAsideGiB();
      expect(shares).toHaveLength(3);
      for (const share of shares) expect(share).toBeGreaterThanOrEqual(11);
      expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
      // And the fourth slot's VM still fits.
      await m.start(jobRequest({ slot: 4 })).ready();
      expect(setAsideGiB()[3]).toBeGreaterThanOrEqual(11);
      expect(prepared.map((p) => p.sizeGiB)).toEqual([64, 64, 64, 64]);
    });

    it('counts the spare, and never more VMs than maxRunning lets run', async () => {
      config.maxRunning = 8;
      config.prewarm = true;
      runnerSlots = 1;
      await manager({ freeBytes: async () => 80 * GiB, allocatedBytes: async () => 0 }).start(jobRequest()).ready();
      // A slot, the spare and a refresh: 60 / 3.
      config.maxRunning = 2;
      config.prewarm = false;
      runnerSlots = 4;
      await manager({ freeBytes: async () => 80 * GiB, allocatedBytes: async () => 0 }).start(jobRequest({ slot: 2 })).ready();
      // Four slots, but only two VMs can run at once: 60 / 2.
      expect(setAsideGiB()).toEqual([20, 30]);
    });

    it('counts what a clone shares with the golden disk as already there, not as used', async () => {
      // APFS counts a clone's shared blocks as allocated from the start, but
      // they take no free space: only what the guest writes past them does.
      const m = manager({
        freeBytes: async () => 100 * GiB,
        allocatedBytes: async (file) => (fs.existsSync(file) ? 15 * GiB : 0),
      });
      await m.start(jobRequest()).ready();
      await m.start(jobRequest({ slot: 2 })).ready();
      // (100 - 20) / 2 = 40, all of it still promised: 40 left for the second.
      expect(setAsideGiB()).toEqual([40, 40]);
    });

    it('reads free space after the disks, so that a disk growing between the reads is not taken for free space', async () => {
      let allocated = 0;
      let growAfterNextRead = false;
      const read = (value: () => number): number => {
        const result = value();
        if (growAfterNextRead) {
          growAfterNextRead = false;
          allocated += 10 * GiB;
        }
        return result;
      };
      const m = manager({
        freeBytes: async () => read(() => 100 * GiB - allocated),
        allocatedBytes: async () => read(() => allocated),
      });
      await m.start(jobRequest()).ready();
      growAfterNextRead = true;
      await m.start(jobRequest({ slot: 2 })).ready();
      // The first disk, set aside 40, grows 10 GiB between the two reads: 90
      // free, 70 above the floor, 30 still promised - 40 at most for the
      // second. Free space read before the disks would be 100, with 10 of
      // the 40 used: 50.
      expect(setAsideGiB()[0]).toBe(40);
      expect(setAsideGiB()[1]).toBeLessThanOrEqual(40);
    });

    it("keeps what a running cache refresh may load out of a job's share", async () => {
      config.maxRunning = 8;
      runnerSlots = 1;
      const m = manager({ freeBytes: async () => 79 * GiB, allocatedBytes: async () => 0 });
      await m.start(refreshRequest()).ready();
      await m.start(jobRequest()).ready();
      // A refresh loads at most cacheLimitGiB, 20 of the 59 above the floor;
      // the job's share is the 39 left.
      expect(setAsideGiB()).toEqual([39]);
    });

    it('sets a refresh aside only what it may add to the golden disk it cloned', async () => {
      config.maxRunning = 8;
      runnerSlots = 1;
      const m = manager({
        freeBytes: async () => 79 * GiB,
        allocatedBytes: async (file) => (file.endsWith('data.img.new') ? 15 * GiB : 0),
      });
      await m.start(refreshRequest()).ready();
      await m.start(jobRequest()).ready();
      // 15 of the 20 GiB limit are on the clone already: 5 set aside, 54 left.
      expect(setAsideGiB()).toEqual([54]);
    });

    it('sets a refresh aside less than it may load rather than leave a job under the smallest disk', async () => {
      config.maxRunning = 8;
      runnerSlots = 1;
      const m = manager({ freeBytes: async () => 45 * GiB, allocatedBytes: async () => 0 });
      await m.start(refreshRequest()).ready();
      await m.start(jobRequest()).ready();
      // 25 above the floor: the refresh is set aside 17 of its 20, so the
      // job still has 8.
      expect(setAsideGiB()).toEqual([8]);
    });

    it('sets aside the smallest disk when the share is under it, and refuses once that is not left above the floor', async () => {
      config.maxRunning = 8;
      runnerSlots = 4;
      // A slow statfs, as on a busy disk: both boots read free space while
      // the other's is still being read.
      const slowFree = () => new Promise<number>((resolve) => setTimeout(() => resolve(35 * GiB), 100));
      const m = manager({ freeBytes: slowFree, allocatedBytes: async () => 0 });
      // Both at once: whichever is sized second must see what the first was
      // promised. Either may reach its disk first.
      const vms = [m.start(jobRequest()), m.start(jobRequest({ slot: 2 }))];
      const outcomes = await Promise.all(vms.map((vm) => vm.ready().then(() => 'ready', (err: VmError) => err.code)));
      expect(outcomes.sort()).toEqual(['E_NO_DISK', 'ready']);
      // 15 GiB above the floor among five claimants is 3 each: under 8, so
      // 8; then 7 GiB are left, and no second disk.
      expect(setAsideGiB()).toEqual([8]);
      expect(prepared.map((p) => p.sizeGiB)).toEqual([64]);
      expect(vms.find((vm) => vm.state() !== 'ready')!.failure()).toMatchObject({ stage: 'disk', code: 'E_NO_DISK' });
    });

    it('stops the VM whose disk grew most when free space falls under half the floor', async () => {
      let free = 500 * GiB;
      const sizes = new Map<string, number>();
      const m = manager({ freeBytes: async () => free, allocatedBytes: async (file) => sizes.get(file) ?? 0 });
      const small = m.start(jobRequest());
      const large = m.start(jobRequest({ slot: 2 }));
      await Promise.all([small.ready(), large.ready()]);
      sizes.set(dataDiskOf(small), 1 * GiB);
      sizes.set(dataDiskOf(large), 30 * GiB);
      free = 9 * GiB;
      await m.checkFreeSpace();
      expect(large.state()).toBe('failed');
      expect(large.failure()!.message).toBe('host disk nearly full');
      expect(small.state()).toBe('ready');
    });

    it('stops the VM that wrote most, not the clone that shares most with the golden disk', async () => {
      let free = 500 * GiB;
      const sizes = new Map<string, number>();
      const m = manager({ freeBytes: async () => free, allocatedBytes: async (file) => sizes.get(file) ?? 0 });
      const clone = m.start(jobRequest());
      const blank = m.start(jobRequest({ slot: 2 }));
      sizes.set(dataDiskOf(clone), 30 * GiB);
      await Promise.all([clone.ready(), blank.ready()]);
      sizes.set(dataDiskOf(clone), 31 * GiB);
      sizes.set(dataDiskOf(blank), 5 * GiB);
      free = 9 * GiB;
      await m.checkFreeSpace();
      expect(blank.state()).toBe('failed');
      expect(clone.state()).toBe('ready');
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

    it('reads a process\'s executable, not the argv[0] it gave itself', async () => {
      // A process can call itself anything, the helper's path included; the
      // sweep kills by the file it runs. macOS only: the app runs nowhere else.
      const named = spawn('/bin/sleep', ['60'], { argv0: FAKE_HELPER });
      try {
        if (process.platform === 'darwin') {
          // Until it has exec'd sleep, the child is a copy of this node. Not
          // waited for with ps: it is setuid, and a job's sandbox - where
          // this suite also runs - refuses to exec it (EPERM).
          await new Promise((resolve, reject) => named.once('spawn', resolve).once('error', reject));
          // Polled until it reads sleep: before that it reads node, or
          // nothing when lsof times out on a loaded machine.
          let executable = await processExecutableOf(named.pid!);
          for (const deadline = Date.now() + 10_000; executable !== '/bin/sleep' && Date.now() < deadline; ) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            executable = await processExecutableOf(named.pid!);
          }
          expect(executable).toBe('/bin/sleep');
        } else {
          // Elsewhere nothing is swept: no process is ever taken for the helper.
          expect(await processExecutableOf(named.pid!)).toBeNull();
        }
        expect(await processExecutableOf(999_999)).toBeNull();
      } finally {
        named.kill('SIGKILL');
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
      // Bounded by shutdownAllMs, not the stubborn helper's minute; generous for a loaded machine.
      expect(Date.now() - began).toBeLessThan(20_000);
      await Promise.all([stubborn.stopped(), plain.stopped()]);
      expect([stubborn.state(), plain.state()]).toEqual(['stopped', 'stopped']);
    });
  });

  it('refuses a job request missing what a job VM needs', () => {
    expect(() => manager().start(jobRequest({ shareNonce: undefined }))).toThrow(/nonce/);
  });
});
