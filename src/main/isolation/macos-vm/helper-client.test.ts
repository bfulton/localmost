/**
 * MacVmHelper against the fake helper, spawned directly, and the parts of
 * the helper's contract Electron holds: the argument line, the exit codes,
 * and the events each command may send.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import {
  HelperInvocation,
  MACVM_EXIT_CODES,
  MacVmHelper,
  exitErrorCode,
  helperArgv,
  isAllowedRestoreImageUrl,
} from './helper-client';
import { fakeMacVmSpawn, macVmDataDir, readRecord } from '../../test-utils/macvm-fixtures';

jest.setTimeout(30_000);

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

describe('the helper argument line', () => {
  it('is exactly the flags MacVMCore parses, for each command', () => {
    expect(helperArgv({ command: 'catalog' })).toEqual(['catalog']);
    expect(helperArgv({ command: 'inspect', ipsw: '/d/macos-vm/ipsw/25G83.ipsw' })).toEqual(['inspect', '--ipsw', '/d/macos-vm/ipsw/25G83.ipsw']);
    expect(helperArgv({ command: 'install', dataDir: '/d', imageId: 'a1b2c3d4e5f6', ipsw: '/d/macos-vm/ipsw/25G83.ipsw', diskGiB: 64, slot: 1 })).toEqual([
      'install', '--data-dir', '/d', '--image-id', 'a1b2c3d4e5f6', '--ipsw', '/d/macos-vm/ipsw/25G83.ipsw', '--disk-gib', '64', '--slot', '1',
    ]);
    expect(helperArgv({ command: 'provision', dataDir: '/d', imageId: 'a1b2c3d4e5f6', slot: 1, display: 'window' })).toEqual([
      'provision', '--data-dir', '/d', '--image-id', 'a1b2c3d4e5f6', '--slot', '1', '--display', 'window',
    ]);
    expect(helperArgv({ command: 'save-state', dataDir: '/d', imageId: 'a1b2c3d4e5f6', slot: 2, cpus: 4, memoryMiB: 6144 })).toEqual([
      'save-state', '--data-dir', '/d', '--image-id', 'a1b2c3d4e5f6', '--slot', '2', '--cpus', '4', '--memory-mib', '6144',
    ]);
    expect(
      helperArgv({ command: 'run', dataDir: '/d', imageId: 'a1b2c3d4e5f6', vmId: '2-0123456789ab', proxyPort: 5000, brokerPort: 8787, cpus: 4, memoryMiB: 6144, boot: 'restore' })
    ).toEqual([
      'run', '--data-dir', '/d', '--image-id', 'a1b2c3d4e5f6', '--vm-id', '2-0123456789ab', '--proxy-port', '5000', '--broker-port', '8787',
      '--cpus', '4', '--memory-mib', '6144', '--boot', 'restore',
    ]);
    expect(helperArgv({ command: 'check', dataDir: '/d', imageId: 'a1b2c3d4e5f6' })).toEqual(['check', '--data-dir', '/d', '--image-id', 'a1b2c3d4e5f6']);
  });

  it('refuses an id, a slot, a size or a port out of its form before anything is spawned', () => {
    const run = { command: 'run' as const, dataDir: '/d', imageId: 'a1b2c3d4e5f6', vmId: '1-0123456789ab', proxyPort: 5000, brokerPort: 8787, cpus: 4, memoryMiB: 6144, boot: 'cold' as const };
    for (const bad of [
      { ...run, imageId: 'A1B2C3D4E5F6' },
      { ...run, vmId: '3-0123456789ab' },
      { ...run, vmId: '1-0123456789ab\n' },
      { ...run, proxyPort: 8787 },
      { ...run, proxyPort: 70000 },
      { ...run, cpus: 1 },
      { ...run, memoryMiB: 1024 },
    ] as HelperInvocation[]) {
      expect(() => helperArgv(bad)).toThrow();
    }
    expect(() => helperArgv({ command: 'install', dataDir: '/d', imageId: 'a1b2c3d4e5f6', ipsw: '/x', diskGiB: 20, slot: 1 })).toThrow(/disk size/);
    expect(() => helperArgv({ command: 'save-state', dataDir: '/d', imageId: 'a1b2c3d4e5f6', slot: 3 as 1, cpus: 4, memoryMiB: 6144 })).toThrow(/slot/);
  });
});

describe('the exit codes', () => {
  it('are the helper\'s own table, read from its source', () => {
    // MacVMCore/Errors.swift: each case's code, then each case's exit code.
    const source = fs.readFileSync(path.join(REPO, 'native', 'localmost-macvm', 'Sources', 'MacVMCore', 'Errors.swift'), 'utf8');
    const codes = Object.fromEntries([...source.matchAll(/case (\w+) = "(E_[A-Z_]+)"/g)].map((m) => [m[1], m[2]]));
    const exits = [...source.matchAll(/case \.(\w+): return (\d+)/g)].map((m) => [Number(m[2]), codes[m[1]]]);
    expect(exits.length).toBeGreaterThan(10);
    expect(Object.fromEntries(exits)).toEqual(MACVM_EXIT_CODES);
  });

  it('name the client\'s own for a crash or a signal', () => {
    expect(exitErrorCode(0, null)).toBeUndefined();
    expect(exitErrorCode(72, null)).toBe('E_SLOT');
    expect(exitErrorCode(1, null)).toBe('E_HELPER_EXIT');
    expect(exitErrorCode(null, 'SIGKILL')).toBe('E_HELPER_KILLED');
  });
});

describe('the restore image URL allowlist', () => {
  it("takes only an https .ipsw on Apple's restore image host", () => {
    expect(isAllowedRestoreImageUrl('https://updates.cdn-apple.com/2026SummerFCS/fullrestores/1/A/UniversalMac_26.6.2_25G83_Restore.ipsw')).toBe(true);
    for (const bad of [
      'http://updates.cdn-apple.com/a/b.ipsw',
      'https://updates.cdn-apple.com.evil.example/a/b.ipsw',
      'https://evil.example/updates.cdn-apple.com/b.ipsw',
      'https://updates.cdn-apple.com:8443/a/b.ipsw',
      'https://user@updates.cdn-apple.com/a/b.ipsw',
      'https://updates.cdn-apple.com/a/b.ipsw?x=1',
      'https://updates.cdn-apple.com/a/b.ipsw#x',
      'https://updates.cdn-apple.com/a/b.zip',
      'https://updates.cdn-apple.com/a/../b.ipsw',
      42,
    ]) {
      expect([bad, isAllowedRestoreImageUrl(bad)]).toEqual([bad, false]);
    }
  });
});

describe('MacVmHelper with the fake helper', () => {
  let data: string;
  let record: string;
  const helpers: MacVmHelper[] = [];

  beforeEach(() => {
    data = macVmDataDir();
    record = path.join(data, 'record.jsonl');
    fs.mkdirSync(path.join(data, 'macos-vm', 'images', 'a1b2c3d4e5f6', 'slot1'), { recursive: true });
  });

  afterEach(async () => {
    for (const h of helpers.splice(0)) {
      h.kill();
      await h.exited();
    }
    fs.rmSync(data, { recursive: true, force: true });
  });

  const helper = (invocation: HelperInvocation, script: Record<string, unknown> = {}, expectAgentSocket?: string) => {
    const logs: string[] = [];
    const h = new MacVmHelper({
      helper: '/unused/localmost-macvm',
      invocation,
      spawn: fakeMacVmSpawn(script, record),
      env: { PATH: '/usr/bin:/bin', TMPDIR: data },
      log: (level, message) => logs.push(`${level} ${message}`),
      ...(expectAgentSocket ? { expectAgentSocket } : {}),
    });
    helpers.push(h);
    return { h, logs };
  };

  it('returns the catalog, with only PATH and TMPDIR in its environment', async () => {
    const { h } = helper({ command: 'catalog' });
    const result = await h.result();
    expect(result).toMatchObject({ build: '25G83', os: '26.6.2', supported: true });
    expect(isAllowedRestoreImageUrl(result.url)).toBe(true);
    expect(readRecord(record).find((r) => r.env)?.env).toEqual(['PATH', 'TMPDIR']);
  });

  it('kills a helper whose catalog names a URL off the allowlist', async () => {
    const { h } = helper({ command: 'catalog' }, { catalog: { end: { url: 'https://evil.example/x.ipsw' } } });
    await expect(h.result()).rejects.toMatchObject({ code: 'E_HELPER_PROTOCOL' });
  });

  it('reports an install as it goes, and its end', async () => {
    const ipsw = path.join(data, 'macos-vm', 'ipsw', '25G83.ipsw');
    fs.writeFileSync(ipsw, 'ipsw');
    const { h } = helper({ command: 'install', dataDir: data, imageId: 'a1b2c3d4e5f6', ipsw, diskGiB: 64, slot: 1 });
    const progress: unknown[] = [];
    h.on('progress', (p) => progress.push(p));
    const result = await h.result();
    expect(result).toEqual({ build: '25G83', os: '26.6.2', diskBytes: 64 * 2 ** 30 });
    expect(progress).toEqual([
      { phase: 'load', percent: 0 },
      ...[0, 25, 50, 75, 100].map((percent) => ({ phase: 'install', percent })),
    ]);
  });

  it('rejects with the code and message the helper ended with', async () => {
    const { h } = helper({ command: 'save-state', dataDir: data, imageId: 'a1b2c3d4e5f6', slot: 1, cpus: 4, memoryMiB: 6144 }, { 'save-state': { fail: 'E_STATE' } });
    await expect(h.result()).rejects.toMatchObject({ code: 'E_STATE', message: 'save-state failed as scripted' });
    expect((await h.exited()).code).toBe(74);
  });

  it('treats a clean exit with no end as a broken helper', async () => {
    const { h } = helper({ command: 'catalog' }, { catalog: { exitWithoutEnd: 0 } });
    await expect(h.result()).rejects.toMatchObject({ code: 'E_HELPER_PROTOCOL' });
  });

  it('kills a helper that sends an event its command does not, or a malformed line', async () => {
    for (const line of ['{"v":1,"event":"listening","agentSocket":"/x"}', 'not json', '{"v":2,"event":"end","ok":true,"reason":"done"}', '{"v":1,"id":7,"ok":true}']) {
      const { h, logs } = helper({ command: 'catalog' }, { catalog: { lines: [line], hang: true } });
      await expect(h.result()).rejects.toMatchObject({ code: 'E_HELPER_PROTOCOL' });
      expect((await h.exited()).signal).toBe('SIGKILL');
      expect(logs.some((l) => l.includes('broke its protocol'))).toBe(true);
    }
  });

  it('kills a run that listens on a socket other than its own', async () => {
    const vmId = '1-0123456789ab';
    fs.writeFileSync(path.join(data, 'macos-vm', 'images', 'a1b2c3d4e5f6', 'config.json'), '{}');
    fs.mkdirSync(path.join(data, 'macos-vm', 'vms', vmId));
    const { h } = helper(
      { command: 'run', dataDir: data, imageId: 'a1b2c3d4e5f6', vmId, proxyPort: 5000, brokerPort: 8787, cpus: 4, memoryMiB: 6144, boot: 'restore' },
      {},
      path.join(data, 'elsewhere.sock')
    );
    await expect(h.result()).rejects.toMatchObject({ code: 'E_HELPER_PROTOCOL' });
  });

  it('runs a job VM until it is stopped, reporting its boot', async () => {
    const vmId = '1-0123456789ab';
    fs.writeFileSync(path.join(data, 'macos-vm', 'images', 'a1b2c3d4e5f6', 'config.json'), '{}');
    fs.mkdirSync(path.join(data, 'macos-vm', 'vms', vmId));
    const socket = path.join(data, 'macos-vm', 'vms', vmId, 'agent.sock');
    const { h } = helper(
      { command: 'run', dataDir: data, imageId: 'a1b2c3d4e5f6', vmId, proxyPort: 5000, brokerPort: 8787, cpus: 4, memoryMiB: 6144, boot: 'restore' },
      { run: { noState: true } },
      socket
    );
    h.start();
    await new Promise((resolve) => h.once('started', resolve));
    expect(h.started()).toMatchObject({ boot: 'cold', restoreSkipped: 'slot 1 has no saved state' });
    expect(await h.ping()).toBe('running');
    const exit = await h.stop(0);
    expect(exit).toMatchObject({ code: 0, end: { ok: true, reason: 'requested' } });
    expect(exit.errorCode).toBeUndefined();
  });

  it('starts headless provisioning only once it is sent the account, on stdin', async () => {
    fs.writeFileSync(path.join(data, 'macos-vm', 'images', 'a1b2c3d4e5f6', 'config.json'), '{}');
    const { h } = helper({ command: 'provision', dataDir: data, imageId: 'a1b2c3d4e5f6', slot: 1, display: 'none' }, { provision: { guestStopsAfterMs: 50 } });
    h.start();
    await new Promise((resolve) => h.once('ready', resolve));
    expect(h.started()).toBeUndefined();
    h.send({ op: 'provision', username: 'localmost-admin', fullName: 'localmost setup', password: 'abcd-efgh-jkmn-pqrs-tuvw' });
    await new Promise((resolve) => h.once('started', resolve));
    expect(h.started()?.mac).toBe('02:11:22:33:44:55');
    expect(await h.exited()).toMatchObject({ code: 0, end: { ok: true, reason: 'guest' } });
    // The password went on stdin, never on the command line.
    const argv = readRecord(record).find((r) => r.argv)?.argv as string[];
    expect(argv.join(' ')).not.toContain('abcd-efgh');
    expect(readRecord(record).some((r) => (r.stdin as { password?: string } | undefined)?.password === 'abcd-efgh-jkmn-pqrs-tuvw')).toBe(true);
  });
});
