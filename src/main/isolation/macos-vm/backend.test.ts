/**
 * The macOS VM backend against the fake helper and its scripted guest
 * agent: a job's VM from prepare to release, what reaches the guest, the
 * two-VM limit, and the sweep.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { MacVmBackend, readJobFiles, type MacVmBackendDeps } from './backend';
import { MacVmHelper, type HelperInvocation } from './helper-client';
import type { HostInfo } from './host';
import { MacVmSlots } from './slots';
import type { IsolationJob, WorkerHandle } from './types';
import { fakeMacVmSpawn, macVmDataDir, readRecord } from '../../test-utils/macvm-fixtures';

jest.setTimeout(30_000);

const host: HostInfo = { platform: 'darwin', arch: 'arm64', darwin: '25.6.0', build: '25G83', totalMemoryBytes: 16 * 2 ** 30 };
const IMAGE = 'a1b2c3d4e5f6';

describe('MacVmBackend', () => {
  let data: string;
  let record: string;
  let sandbox: string;
  let ready: { imageId: string; slots: Array<1 | 2> } | null;
  let imageState: { state: string; reason?: string };
  const backends: MacVmBackend[] = [];
  const jobs: IsolationJob[] = [];

  beforeEach(() => {
    data = macVmDataDir();
    record = path.join(data, 'record.jsonl');
    fs.mkdirSync(path.join(data, 'macos-vm', 'images', IMAGE), { recursive: true });
    fs.writeFileSync(path.join(data, 'macos-vm', 'images', IMAGE, 'config.json'), '{}');
    sandbox = path.join(data, 'sandbox');
    fs.mkdirSync(sandbox);
    fs.writeFileSync(path.join(sandbox, '.runner'), '{"serverUrlV2":"http://127.0.0.1:8787/k"}');
    fs.writeFileSync(path.join(sandbox, '.credentials'), '{"scheme":"OAuth"}');
    fs.writeFileSync(path.join(sandbox, '.credentials_rsaparams'), '{"d":"x"}');
    fs.writeFileSync(path.join(sandbox, 'other-secret'), 'not for the guest');
    ready = { imageId: IMAGE, slots: [1, 2] };
    imageState = { state: 'ready' };
  });

  afterEach(async () => {
    // release() is a no-op for a job another backend holds.
    const all = jobs.splice(0);
    for (const b of backends.splice(0)) for (const j of all) await b.release(j);
    fs.rmSync(data, { recursive: true, force: true });
  });

  const backend = (script: Record<string, unknown> = {}, overrides: Partial<MacVmBackendDeps> = {}) => {
    const logs: string[] = [];
    const slots = new MacVmSlots(() => 2);
    const b = new MacVmBackend({
      dataDir: data,
      images: { ready: () => ready, status: () => imageState },
      slots,
      host: () => host,
      helperExists: () => true,
      launch: (invocation: HelperInvocation, opts) =>
        new MacVmHelper({
          helper: '/unused/localmost-macvm',
          invocation,
          spawn: fakeMacVmSpawn(script, record),
          env: { PATH: '/usr/bin:/bin', TMPDIR: data },
          log: () => {},
          ...(opts?.expectAgentSocket ? { expectAgentSocket: opts.expectAgentSocket } : {}),
        }),
      runnerArchive: async () => {
        const bytes = Buffer.from('runner archive');
        return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
      },
      log: (level, message) => logs.push(`${level} ${message}`),
      processExecutable: async () => null,
      helperPath: () => '/Applications/localmost.app/Contents/Resources/localmost-macvm',
      agentRetryMs: 20,
      freeBytes: async () => 100 * 2 ** 30,
      ...overrides,
    });
    backends.push(b);
    return { b, logs, slots };
  };

  const job = (key: string): IsolationJob => {
    const j = { key, proxyPort: 51000, brokerPort: 8787, sandboxDir: sandbox, runnerVersion: '2.330.0' };
    jobs.push(j);
    return j;
  };
  const vms = () => fs.readdirSync(path.join(data, 'macos-vm', 'vms'));
  const agentLines = () => readRecord(record).filter((r) => r.agent).map((r) => r.agent as Record<string, unknown>);
  const exitOf = (w: WorkerHandle) => new Promise<[number | null, string | null]>((resolve) => w.once('exit', (c, s) => resolve([c, s])));

  it('is available only with a usable golden image, and says why not', () => {
    const { b } = backend();
    expect(b.available()).toEqual({ ok: true });
    ready = null;
    imageState = { state: 'not-built' };
    expect(b.available()).toEqual({ ok: false, reason: expect.stringMatching(/build one in Settings/) });
    imageState = { state: 'building' };
    expect(b.available().reason).toMatch(/still being built/);
    imageState = { state: 'failed', reason: 'disk.img is missing' };
    expect(b.available().reason).toMatch(/disk.img is missing/);
    const intel = backend({}, { host: () => ({ ...host, arch: 'x64' }) });
    expect(intel.b.available().reason).toMatch(/Apple silicon/);
  });

  it("runs a job's runner in a fresh VM with only its three runner files and the environment a job may set, then removes the VM", async () => {
    const { b } = backend({ agent: { jobOutput: ['Listening for Jobs', 'Job build completed with result: Succeeded'] } });
    const j = job('slot1-job7');
    await b.prepare(j);
    expect(vms()).toHaveLength(1);
    const run = readRecord(record).find((r) => (r.argv as string[] | undefined)?.[0] === 'run')?.argv as string[];
    expect(run).toEqual(expect.arrayContaining(['--image-id', IMAGE, '--proxy-port', '51000', '--broker-port', '8787', '--cpus', '4', '--memory-mib', '6144', '--boot', 'restore']));
    const prepared = agentLines().find((a) => a.op === 'prepare')!;
    expect(prepared).toMatchObject({ proxyPort: 51000, brokerPort: 8787 });
    expect(Buffer.from(prepared.entropy as string, 'base64')).toHaveLength(64);
    expect(Math.abs((prepared.timeMs as number) - Date.now())).toBeLessThan(10_000);

    // DEVELOPER_DIR as a repository's env policy passes it; PATH, HOME and
    // GITHUB_TOKEN are names no job may set.
    const env = {
      PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/me', HTTPS_PROXY: 'http://t:secret@127.0.0.1:51000', LANG: 'en_US.UTF-8',
      GITHUB_TOKEN: 'ghp_x', DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer',
    };
    const worker = await b.spawnWorker(j, ['--once'], env);
    const lines: string[] = [];
    worker.on('stdout', (line) => lines.push(line));
    expect(await exitOf(worker)).toEqual([0, null]);
    expect(lines).toEqual(['Listening for Jobs', 'Job build completed with result: Succeeded']);
    const sent = agentLines().find((a) => a.op === 'job')!;
    expect(sent.files).toEqual({ '.runner': '{"serverUrlV2":"http://127.0.0.1:8787/k"}', '.credentials': '{"scheme":"OAuth"}', '.credentials_rsaparams': '{"d":"x"}' });
    expect(sent.env).toEqual({
      HTTPS_PROXY: 'http://t:secret@127.0.0.1:51000', LANG: 'en_US.UTF-8', DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer',
    });
    expect(sent.args).toEqual(['--once']);
    expect(worker.pid).toBe(4242);

    await b.release(j);
    expect(vms()).toEqual([]);
    expect(b.jobsRunning()).toBe(false);
  });

  it('lends a localmost test run a prepared VM: its agent socket, from the same slots, gone at release', async () => {
    const { b, slots } = backend();
    const lease = { key: 'test-0a1b2c3d4e5f', proxyPort: 52000, brokerPort: 52001 };
    try {
      const socket = await b.prepareTestRun(lease);
      expect(vms()).toHaveLength(1);
      expect(socket).toBe(path.join(data, 'macos-vm', 'vms', vms()[0], 'agent.sock'));
      expect(agentLines().find((a) => a.op === 'prepare')).toMatchObject({ proxyPort: 52000, brokerPort: 52001 });
      expect(agentLines().some((a) => a.op === 'job')).toBe(false);
      expect(slots.holders()).toEqual([{ slot: expect.any(Number), owner: 'job test-0a1b2c3d4e5f' }]);
    } finally {
      await b.release(lease);
    }
    expect(vms()).toEqual([]);
    expect(slots.holders()).toEqual([]);
  });

  it('sends the guest the host runner when the golden image has another version', async () => {
    const { b } = backend({ agent: { runnerVersions: ['2.329.0'] } });
    const j = job('a');
    await b.prepare(j);
    await exitOf(await b.spawnWorker(j, ['--once'], {}));
    expect(agentLines().find((a) => 'upload' in a)).toEqual({ upload: '2.330.0', bytes: 14, sha256ok: true });
  });

  it('makes a third job wait for one of the two VMs to be released', async () => {
    const { b } = backend();
    await b.prepare(job('a'));
    await b.prepare(job('b'));
    let third = false;
    const c = job('c');
    const pending = b.prepare(c).then(() => (third = true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(third).toBe(false);
    expect(vms()).toHaveLength(2);
    await b.release(jobs[0]);
    await pending;
    expect(third).toBe(true);
    expect(vms().map((v) => v[0]).sort()).toEqual(['1', '2']);
  });

  it('refuses a VM whose agent says it is not fresh, and leaves nothing behind', async () => {
    const { b } = backend({ agent: { ready: false } });
    await expect(b.prepare(job('a'))).rejects.toThrow(/not fresh/);
    expect(vms()).toEqual([]);
    expect(b.jobsRunning()).toBe(false);
  });

  it('waits for an agent that comes up after the boot, as on a cold boot', async () => {
    const { b } = backend({ run: { agentAfterMs: 300 } });
    await b.prepare(job('a'));
    expect(agentLines().some((a) => a.op === 'prepare')).toBe(true);
  });

  it('ends the job with SIGKILL when its VM stops under it, and passes signals to the runner', async () => {
    const stopping = backend({ agent: { jobHold: true }, run: { guestStopsAfterMs: 400 } });
    const j = job('a');
    await stopping.b.prepare(j);
    expect(await exitOf(await stopping.b.spawnWorker(j, ['--once'], {}))).toEqual([null, 'SIGKILL']);

    const signalled = backend({ agent: { jobHold: true } });
    const k = job('b');
    await signalled.b.prepare(k);
    const worker = await signalled.b.spawnWorker(k, ['--once'], {});
    const exit = exitOf(worker);
    await signalled.b.signal(k, 'SIGTERM');
    expect(await exit).toEqual([null, 'SIGTERM']);
  });

  it("refuses to start a VM, and stops a running one, when the Mac's free disk falls below the reserve", async () => {
    let free = 5 * 2 ** 30;
    const low = backend({ agent: { jobHold: true } }, { freeBytes: async () => free, diskCheckMs: 20 });
    await expect(low.b.prepare(job('a'))).rejects.toThrow(/5.0 GiB free.*at least 10.0 GiB/);
    expect(vms()).toEqual([]);
    expect(low.b.jobsRunning()).toBe(false);

    free = 50 * 2 ** 30;
    const j = job('b');
    await low.b.prepare(j);
    const worker = await low.b.spawnWorker(j, ['--once'], {});
    const exit = exitOf(worker);
    free = 9 * 2 ** 30;
    expect(await exit).toEqual([null, 'SIGKILL']);
    expect(low.logs.some((l) => /^warn .*9.0 GiB free.*stopping its VM/.test(l))).toBe(true);
  });

  it('refuses a second runner, or any arguments but --once', async () => {
    const { b } = backend({ agent: { jobHold: true } });
    const j = job('a');
    await b.prepare(j);
    await expect(b.spawnWorker(j, ['--startuptype', 'service'], {})).rejects.toThrow(/--once/);
    await b.spawnWorker(j, ['--once'], {});
    await expect(b.spawnWorker(j, ['--once'], {})).rejects.toThrow(/one job/);
    await expect(b.prepare(j)).rejects.toThrow(/already has/);
  });

  it('frees the slot and forgets the job even when stopping its VM fails, and still reports the failure', async () => {
    const helpers: MacVmHelper[] = [];
    const { b, slots } = backend({}, {
      launch: (invocation: HelperInvocation, opts) => {
        const h = new MacVmHelper({
          helper: '/unused/localmost-macvm',
          invocation,
          spawn: fakeMacVmSpawn({}, record),
          env: { PATH: '/usr/bin:/bin', TMPDIR: data },
          log: () => {},
          ...(opts?.expectAgentSocket ? { expectAgentSocket: opts.expectAgentSocket } : {}),
        });
        helpers.push(h);
        return h;
      },
    });
    const j = job('a');
    await b.prepare(j);
    const stop = helpers[0].stop.bind(helpers[0]);
    helpers[0].stop = async () => {
      throw new Error('the helper would not stop');
    };
    try {
      await expect(b.release(j)).rejects.toThrow(/would not stop/);
      expect(slots.holders()).toEqual([]);
      expect(b.jobsRunning()).toBe(false);
      // The next job gets a VM rather than waiting on the leaked slot.
      await b.prepare(job('b'));
    } finally {
      await stop(0);
    }
  });

  it("counts as job capacity only the VMs this Mac's memory and the image's saved slots allow, less those the image or a test run holds", async () => {
    const { b, slots } = backend();
    expect(b.vmLimit()).toBe(2);
    expect(b.jobCapacity()).toBe(2);
    // A runner job's own VM is not taken off: the runner counts its workers.
    const j = job('a');
    await b.prepare(j);
    expect(b.jobCapacity()).toBe(2);
    await b.release(j);
    // The golden image re-saving a slot's state holds a VM no job can use.
    const held = await slots.acquire('save-state 2', [2]);
    expect(b.jobCapacity()).toBe(1);
    slots.release(held);
    // So does a localmost test run.
    const lease = { key: 'test-0a1b2c3d4e5f', proxyPort: 52000, brokerPort: 52001 };
    await b.prepareTestRun(lease);
    expect(b.jobCapacity()).toBe(1);
    await b.release(lease);
    // An image with one saved state runs one job at once.
    ready = { imageId: IMAGE, slots: [1] };
    expect(b.jobCapacity()).toBe(1);
    // A Mac whose memory fits one VM runs one.
    const small = backend({}, { host: () => ({ ...host, totalMemoryBytes: 12 * 2 ** 30 }) });
    ready = { imageId: IMAGE, slots: [1, 2] };
    expect(small.b.vmLimit()).toBe(1);
    expect(small.b.jobCapacity()).toBe(1);
    ready = null;
    expect(b.jobCapacity()).toBe(0);
  });

  it('fails a job that waits longer than its bound for a slot, and leaves nothing behind', async () => {
    const { b, slots } = backend();
    await slots.acquire('save-state 1', [1]);
    await slots.acquire('save-state 2', [2]);
    await expect(b.prepare(job('a'), undefined, 50)).rejects.toThrow('no macOS VM became free within 0.05s');
    expect(vms()).toEqual([]);
    expect(b.jobsRunning()).toBe(false);
    expect(slots.queued()).toBe(0);
  });

  it('gives up a job cancelled while it waits for a slot', async () => {
    const { b, slots } = backend();
    await slots.acquire('x');
    await slots.acquire('y');
    const abort = new AbortController();
    const pending = b.prepare(job('a'), abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(vms()).toEqual([]);
    expect(b.jobsRunning()).toBe(false);
  });

  it("sweeps VM directories an earlier run left, killing only a live process that is this app's helper", async () => {
    const helper = '/Applications/localmost.app/Contents/Resources/localmost-macvm';
    for (const [name, pid] of [['1-0123456789ab', 4001], ['2-0123456789ab', 4002]] as const) {
      fs.mkdirSync(path.join(data, 'macos-vm', 'vms', name));
      fs.writeFileSync(path.join(data, 'macos-vm', 'vms', name, 'helper.pid'), `${pid}\n`);
    }
    fs.mkdirSync(path.join(data, 'macos-vm', 'vms', 'not-a-vm'));
    const killed: number[] = [];
    const { b } = backend({}, {
      processExecutable: async (pid) => (pid === 4001 ? helper : '/usr/bin/something-else'),
      kill: (pid) => void killed.push(pid),
    });
    await b.sweep();
    expect(killed).toEqual([4001]);
    expect(vms()).toEqual(['not-a-vm']);
  });

  it("reads the runner files without following a link, and refuses one that is too big", () => {
    expect(readJobFiles(sandbox)['.credentials']).toBe('{"scheme":"OAuth"}');
    fs.rmSync(path.join(sandbox, '.credentials'));
    fs.symlinkSync(path.join(sandbox, 'other-secret'), path.join(sandbox, '.credentials'));
    expect(() => readJobFiles(sandbox)).toThrow();
    fs.rmSync(path.join(sandbox, '.credentials'));
    fs.writeFileSync(path.join(sandbox, '.credentials'), 'x'.repeat(17 << 10));
    expect(() => readJobFiles(sandbox)).toThrow(/at most/);
  });
});
