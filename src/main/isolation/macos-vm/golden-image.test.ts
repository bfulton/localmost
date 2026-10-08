/**
 * The golden image's life against the fake helper: the build's phases in
 * order on either kind of host, its failures and cancellation, the startup
 * check and sweep, and removal.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import type { MacVmSetupStatus } from '../../../shared/macos-vm-setup';
import { guidedSetupSteps } from '../../../shared/macos-vm-setup';
import { MacVmImageManager, type ImageManagerDeps } from './golden-image';
import { MacVmHelper, type HelperInvocation } from './helper-client';
import type { HostInfo } from './host';
import { MacVmSlots } from './slots';
import { fakeMacVmSpawn, macVmDataDir, readRecord } from '../../test-utils/macvm-fixtures';
import type { BootstrapOptions } from './bootstrap';

jest.setTimeout(30_000);

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const sonoma26: HostInfo = { platform: 'darwin', arch: 'arm64', darwin: '25.6.0', build: '25G83', totalMemoryBytes: 16 * 2 ** 30 };
const tahoe27: HostInfo = { ...sonoma26, darwin: '26.0.0', build: '26A434' };
const LEASES = '{\n\tip_address=192.168.64.7\n\thw_address=1,2:11:22:33:44:55\n\tlease=0x7fffffff\n}\n';

describe('MacVmImageManager', () => {
  let data: string;
  let record: string;
  let arc: string;
  let statuses: MacVmSetupStatus[];
  let bootstraps: BootstrapOptions[];
  let inUse: Set<string>;
  let launched: MacVmHelper[];
  const managers: MacVmImageManager[] = [];

  beforeEach(() => {
    data = macVmDataDir();
    record = path.join(data, 'record.jsonl');
    arc = path.join(data, 'arc');
    fs.mkdirSync(arc);
    fs.writeFileSync(path.join(arc, 'run.sh'), '#!/bin/sh\n');
    statuses = [];
    bootstraps = [];
    inUse = new Set();
    launched = [];
  });

  afterEach(() => {
    for (const m of managers.splice(0)) m.cancel();
    fs.rmSync(data, { recursive: true, force: true });
  });

  const manager = (
    opts: {
      host?: HostInfo;
      provisioning?: boolean;
      script?: Record<string, unknown>;
      helperExists?: boolean;
      bootstrap?: (o: BootstrapOptions) => Promise<void>;
      readLeases?: () => string;
      leaseTimeoutMs?: number;
    } = {}
  ) => {
    const deps: ImageManagerDeps = {
      dataDir: data,
      host: () => opts.host ?? sonoma26,
      helperExists: () => opts.helperExists ?? true,
      helperHasProvisioning: async () => opts.provisioning ?? false,
      agentBinary: () => path.join(data, 'agent'),
      launch: (invocation: HelperInvocation, launchOpts) => {
        const helper = new MacVmHelper({
          helper: '/unused/localmost-macvm',
          invocation,
          spawn: fakeMacVmSpawn(opts.script ?? {}, record),
          env: { PATH: '/usr/bin:/bin', TMPDIR: data },
          log: () => {},
          ...(launchOpts?.expectAgentSocket ? { expectAgentSocket: launchOpts.expectAgentSocket } : {}),
        });
        launched.push(helper);
        return helper;
      },
      slots: new MacVmSlots(() => 2),
      runnerArc: () => ({ version: '2.330.0', dir: arc }),
      packRunner: async (_version, dest) => fs.writeFileSync(dest, 'runner tarball'),
      freeBytes: async () => 100 * 2 ** 30,
      imageInUse: (id) => inUse.has(id),
      jobsRunning: () => inUse.size > 0,
      log: () => {},
      download: async (o) => fs.writeFileSync(o.dest, 'ipsw'),
      sha1For: async () => null,
      readLeases: opts.readLeases ?? (() => LEASES),
      bootstrap: opts.bootstrap ?? (async (o) => void bootstraps.push(o)),
      leasePollMs: 5,
      ...(opts.leaseTimeoutMs !== undefined ? { leaseTimeoutMs: opts.leaseTimeoutMs } : {}),
      setupGraceMs: 2000,
    };
    const m = new MacVmImageManager(deps);
    m.on('status', (s: MacVmSetupStatus) => statuses.push(s));
    managers.push(m);
    return m;
  };

  const settled = (m: MacVmImageManager, states: string[]) =>
    new Promise<MacVmSetupStatus>((resolve) => {
      if (states.includes(m.status().state)) return resolve(m.status());
      const on = (s: MacVmSetupStatus) => {
        if (states.includes(s.state)) {
          m.off('status', on);
          resolve(s);
        }
      };
      m.on('status', on);
    });

  const commands = () => readRecord(record).filter((r) => r.argv).map((r) => (r.argv as string[])[0]);
  const images = () => fs.readdirSync(path.join(data, 'macos-vm', 'images')).filter((n) => /^[0-9a-f]{12}$/.test(n));

  it('says this Mac cannot run macOS VMs, and why, before anything else', async () => {
    const intel = manager({ host: { ...sonoma26, arch: 'x64' } });
    await intel.start();
    expect(intel.status()).toMatchObject({ state: 'unsupported', reason: expect.stringMatching(/Apple silicon/) });
    expect(() => intel.build()).toThrow(/Apple silicon/);
    const noHelper = manager({ helperExists: false });
    await noHelper.start();
    expect(noHelper.status()).toMatchObject({ state: 'unsupported', reason: expect.stringMatching(/no macOS VM helper/) });
  });

  it('builds headless on macOS 27: catalog, download, verify, install, provision, setup, both slots, check', async () => {
    const m = manager({ host: tahoe27, provisioning: true, script: { provision: { guestStopsAfterMs: 300 } } });
    await m.start();
    expect(m.status()).toMatchObject({ state: 'not-built', provisioning: 'headless' });
    expect(m.status().disk.neededBytes).toBeGreaterThan(50 * 2 ** 30);
    m.build();
    const done = await settled(m, ['ready', 'failed']);
    expect(done).toMatchObject({ state: 'ready', image: { os: '26.6.2', build: '25G83', slots: [1, 2], stale: false } });
    expect(commands()).toEqual(['catalog', 'inspect', 'install', 'provision', 'save-state', 'save-state', 'check']);
    const phases = [...new Set(statuses.map((s) => s.phase).filter(Boolean))];
    expect(phases).toEqual(['catalog', 'download', 'verify', 'install', 'provision', 'setup', 'save-state', 'check']);
    // The account went to the helper on stdin, and its password to the setup.
    const provisioned = readRecord(record).find((r) => (r.stdin as { op?: string } | undefined)?.op === 'provision')?.stdin as Record<string, string>;
    expect(provisioned).toMatchObject({ username: 'localmost-admin', fullName: 'localmost setup' });
    expect(bootstraps).toHaveLength(1);
    expect(bootstraps[0]).toMatchObject({ ip: '192.168.64.7', account: { password: provisioned.password }, inputs: { runnerVersion: '2.330.0', osVersion: '26.6.2', osBuild: '25G83' } });
    expect(bootstraps[0].inputs.jobPassword).not.toBe(bootstraps[0].inputs.discardedAdminPassword);
    // The image is current; the restore image and the setup's files are gone.
    const current = JSON.parse(fs.readFileSync(path.join(data, 'macos-vm', 'images', 'current.json'), 'utf8'));
    expect(current).toMatchObject({ schema: 1, os: '26.6.2', build: '25G83', hostMajor: 27, runnerVersion: '2.330.0' });
    expect(images()).toEqual([current.imageId]);
    expect(fs.readdirSync(path.join(data, 'macos-vm', 'ipsw'))).toEqual([]);
    expect(fs.readdirSync(path.join(data, 'macos-vm', 'bootstrap'))).toEqual([]);
    expect(m.ready()).toEqual({ imageId: current.imageId, slots: [1, 2] });
  });

  it('waits on macOS 26 for the operator to open the guided setup, then shows the values in its window', async () => {
    const m = manager({ script: { provision: { guestStopsAfterMs: 300 } } });
    await m.start();
    expect(m.status().provisioning).toBe('guided');
    m.build();
    const waiting = await settled(m, ['needs-guided-setup', 'failed']);
    expect(waiting.guided).toMatchObject({ username: 'localmost-admin', fullName: 'localmost setup', windowOpen: false });
    expect(waiting.guided?.steps).toEqual(guidedSetupSteps(waiting.guided!));
    expect(commands()).not.toContain('provision');
    m.openGuidedSetup();
    const done = await settled(m, ['ready', 'failed']);
    expect(done.state).toBe('ready');
    const argv = readRecord(record).find((r) => (r.argv as string[] | undefined)?.[0] === 'provision')?.argv as string[];
    expect(argv.slice(-2)).toEqual(['--display', 'window']);
    const guide = readRecord(record).find((r) => (r.stdin as { op?: string } | undefined)?.op === 'guide')?.stdin as Record<string, string>;
    expect(guide.password).toBe(waiting.guided?.password);
  });

  it('serves one job at a time when slot 2 cannot be saved', async () => {
    const one = { 1: { hostBuild: '26A434', cpus: 4, memoryMiB: 6144, helperVersion: '1.0.0', stateBytes: 1 } };
    const m = manager({ host: tahoe27, provisioning: true, script: { provision: { guestStopsAfterMs: 300 }, 'save-state': { failSlot: 2 }, check: { end: { states: one } } } });
    await m.start();
    m.build();
    expect(await settled(m, ['ready', 'failed'])).toMatchObject({ state: 'ready', image: { slots: [1] } });
  });

  it('fails a build whose install fails, leaving no image but keeping the restore image for the next try', async () => {
    const m = manager({ host: tahoe27, provisioning: true, script: { install: { fail: 'E_INSTALL' } } });
    await m.start();
    m.build();
    expect(await settled(m, ['failed', 'ready'])).toMatchObject({ state: 'failed', reason: 'install failed as scripted' });
    expect(images()).toEqual([]);
    expect(fs.readdirSync(path.join(data, 'macos-vm', 'ipsw'))).toEqual(['25G83.ipsw']);
    expect(fs.readdirSync(path.join(data, 'macos-vm', 'bootstrap'))).toEqual([]);
  });

  it('fails when the VM stops before its setup finished', async () => {
    const m = manager({ host: tahoe27, provisioning: true, script: { provision: { guestStopsAfterMs: 50 } }, bootstrap: () => new Promise(() => {}) });
    await m.start();
    m.build();
    expect(await settled(m, ['failed', 'ready'])).toMatchObject({ state: 'failed', reason: 'the VM stopped before its setup finished' });
    expect(images()).toEqual([]);
  });

  // The provisioning VM stays up (no guestStopsAfterMs) so that only the
  // build's own teardown can stop it: a leak leaves this helper running.
  const provisionHelper = () => launched.find((h) => h.command === 'provision');
  const untilSetupWaiting = () =>
    new Promise<void>((resolve) => {
      const check = () => (statuses.some((s) => /Remote Login/.test(s.step ?? '')) ? resolve() : setTimeout(check, 10));
      check();
    });

  it('stops the provisioning VM when the setup over Remote Login fails', async () => {
    const m = manager({ host: tahoe27, provisioning: true, script: { provision: {} }, bootstrap: () => Promise.reject(new Error('setup boom')) });
    await m.start();
    m.build();
    expect(await settled(m, ['failed', 'ready'])).toMatchObject({ state: 'failed', reason: expect.stringMatching(/setup boom/) });
    const provision = provisionHelper();
    expect(provision).toBeDefined();
    await provision!.exited();
    expect(provision!.hasExited()).toBe(true);
    expect(images()).toEqual([]);
  });

  it('stops the provisioning VM when it never gets an address', async () => {
    const m = manager({ host: tahoe27, provisioning: true, script: { provision: {} }, readLeases: () => '', leaseTimeoutMs: 20 });
    await m.start();
    m.build();
    expect(await settled(m, ['failed', 'ready'])).toMatchObject({ state: 'failed', reason: expect.stringMatching(/no address/) });
    const provision = provisionHelper();
    expect(provision).toBeDefined();
    await provision!.exited();
    expect(provision!.hasExited()).toBe(true);
  });

  it('stops the provisioning VM when the build is cancelled during setup', async () => {
    const m = manager({ host: tahoe27, provisioning: true, script: { provision: {} }, bootstrap: () => new Promise(() => {}) });
    await m.start();
    m.build();
    await untilSetupWaiting();
    m.cancel();
    expect(await settled(m, ['not-built', 'failed'])).toMatchObject({ state: 'not-built' });
    const provision = provisionHelper();
    expect(provision).toBeDefined();
    await provision!.exited();
    expect(provision!.hasExited()).toBe(true);
    expect(images()).toEqual([]);
  });

  it('cancels a build waiting for the guided setup, and removes what it made', async () => {
    const m = manager();
    await m.start();
    m.build();
    await settled(m, ['needs-guided-setup']);
    expect(images()).toHaveLength(1);
    m.cancel();
    expect(await settled(m, ['not-built', 'failed'])).toMatchObject({ state: 'not-built' });
    expect(images()).toEqual([]);
  });

  it('checks the current image at start, sweeps every other, and saves states again for a new host build', async () => {
    const id = 'a1b2c3d4e5f6';
    for (const dir of [id, 'ffffffffffff', `${id}/slot1`, `${id}/slot2`]) fs.mkdirSync(path.join(data, 'macos-vm', 'images', dir), { recursive: true });
    fs.writeFileSync(path.join(data, 'macos-vm', 'images', id, 'config.json'), '{}');
    fs.writeFileSync(
      path.join(data, 'macos-vm', 'images', 'current.json'),
      JSON.stringify({ schema: 1, imageId: id, os: '26.6.2', build: '25G83', hostMajor: 26, hostBuild: '25G83', runnerVersion: '2.330.0', createdAt: 'x' })
    );
    const m = manager({ host: { ...tahoe27, build: '26A434' } });
    await m.start();
    expect(m.status()).toMatchObject({ state: 'ready', image: { slots: [1, 2], stale: true } });
    expect(images()).toEqual([id]);
    // The fake's states were saved on 25G83; this Mac now runs 26A434.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(commands().filter((c) => c === 'save-state')).toHaveLength(2);
  });

  it('reports a current image that fails its check', async () => {
    const id = 'a1b2c3d4e5f6';
    fs.mkdirSync(path.join(data, 'macos-vm', 'images', id));
    fs.writeFileSync(
      path.join(data, 'macos-vm', 'images', 'current.json'),
      JSON.stringify({ schema: 1, imageId: id, os: '26.6.2', build: '25G83', hostMajor: 26, hostBuild: '25G83', runnerVersion: '2.330.0', createdAt: 'x' })
    );
    const m = manager();
    await m.start();
    expect(m.status()).toMatchObject({ state: 'failed', reason: expect.stringMatching(/failed its check/) });
    expect(m.ready()).toBeNull();
  });

  it('removes the current image only when no job runs on it', async () => {
    const id = 'a1b2c3d4e5f6';
    fs.mkdirSync(path.join(data, 'macos-vm', 'images', id));
    fs.writeFileSync(path.join(data, 'macos-vm', 'images', id, 'config.json'), '{}');
    fs.writeFileSync(
      path.join(data, 'macos-vm', 'images', 'current.json'),
      JSON.stringify({ schema: 1, imageId: id, os: '26.6.2', build: '25G83', hostMajor: 26, hostBuild: '25G83', runnerVersion: '2.330.0', createdAt: 'x' })
    );
    const m = manager();
    await m.start();
    inUse.add(id);
    expect(() => m.remove()).toThrow(/running/);
    inUse.clear();
    m.remove();
    expect(images()).toEqual([]);
    expect(fs.existsSync(path.join(data, 'macos-vm', 'images', 'current.json'))).toBe(false);
  });

  it('shows the same guided steps the window does', () => {
    const swift = fs.readFileSync(path.join(REPO, 'native', 'localmost-macvm', 'Sources', 'MacVMCore', 'GuidedSetup.swift'), 'utf8');
    const account = { username: 'localmost-admin', fullName: 'localmost setup', password: 'abcd-efgh' };
    const rendered = [...swift.matchAll(/^\s+"(.*)",$/gm)].map((m) =>
      m[1].replace(/\\\(account\.(\w+)\)/g, (_all, key: 'username' | 'fullName' | 'password') => account[key])
    );
    expect(rendered).toEqual(guidedSetupSteps(account));
  });
});
