/**
 * The real launch's pieces that need no VM: which paths each command's
 * profile is built from, and the runner archive the guest is sent.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as tar from 'tar';
import { packRunner, profileOptions, runnerArchive, type RunnerPacking } from './launch';
import { buildMacVmProfile } from './helper-profile';
import { shortTempDir } from '../../test-utils/vm-fixtures';

const helper = '/Applications/localmost.app/Contents/Resources/localmost-macvm';

describe('profileOptions', () => {
  it("builds each command's profile from the invocation's own ids, and a profile builds from each", () => {
    const cases = [
      { command: 'catalog' as const },
      { command: 'inspect' as const, ipsw: '/d/macos-vm/ipsw/25G83.ipsw' },
      { command: 'install' as const, dataDir: '/d', imageId: 'a1b2c3d4e5f6', ipsw: '/d/macos-vm/ipsw/25G83.ipsw', diskGiB: 100, slot: 1 as const },
      { command: 'provision' as const, dataDir: '/d', imageId: 'a1b2c3d4e5f6', slot: 1 as const, display: 'window' as const },
      { command: 'save-state' as const, dataDir: '/d', imageId: 'a1b2c3d4e5f6', slot: 2 as const, cpus: 4, memoryMiB: 6144 },
      { command: 'run' as const, dataDir: '/d', imageId: 'a1b2c3d4e5f6', vmId: '2-0123456789ab', proxyPort: 5000, brokerPort: 8787, cpus: 4, memoryMiB: 6144, boot: 'restore' as const },
      { command: 'check' as const, dataDir: '/d', imageId: 'a1b2c3d4e5f6' },
    ];
    for (const inv of cases) {
      const opts = profileOptions(inv, helper, '/d', '/private/var/folders/x/C', inv.command === 'provision');
      expect(opts.command).toBe(inv.command);
      expect(() => buildMacVmProfile(opts)).not.toThrow();
    }
    expect(profileOptions(cases[2], helper, '/d', '/c')).toMatchObject({ ipswName: '25G83.ipsw', imageId: 'a1b2c3d4e5f6', slot: 1 });
    expect(profileOptions(cases[5], helper, '/d', '/c')).toMatchObject({ vmId: '2-0123456789ab', proxyPort: 5000, brokerPort: 8787 });
    expect(profileOptions(cases[3], helper, '/d', '/c', true)).toMatchObject({ window: true });
  });
});

describe('runnerArchive', () => {
  let data: string;
  let arc: string;

  beforeEach(() => {
    data = shortTempDir();
    arc = path.join(data, 'arc');
    fs.mkdirSync(path.join(arc, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(arc, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(arc, 'bin', 'Runner.Listener'), 'listener');
  });

  afterEach(() => fs.rmSync(data, { recursive: true, force: true }));

  /** Packs `arc` as it is, and counts; verify refuses whatever `bad` says. */
  const packing = (bad: (bytes: Buffer) => boolean = () => false) => {
    const calls = { pack: 0, verify: 0 };
    const p: RunnerPacking = {
      pack: async (_version, dest) => {
        calls.pack++;
        await packRunner(arc, dest);
      },
      verify: async (_version, bytes) => {
        calls.verify++;
        if (bad(bytes)) throw new Error('does not match its integrity record');
      },
    };
    return { p, calls };
  };

  it('packs the arc once per version, with relative entries, and hashes what it sends', async () => {
    const { p, calls } = packing();
    const first = await runnerArchive(data, '2.330.0', p);
    expect(first.sha256).toBe(crypto.createHash('sha256').update(first.bytes).digest('hex'));
    const archive = path.join(data, 'macos-vm', 'runner', '2.330.0.tar.gz');
    expect(fs.existsSync(archive)).toBe(true);
    const entries: string[] = [];
    await tar.t({ file: archive, onReadEntry: (e) => void entries.push(e.path) });
    expect(entries.sort()).toEqual(['./', './bin/', './bin/Runner.Listener', './run.sh']);
    // Packed once: a later call reads the same archive back, checked again.
    fs.writeFileSync(path.join(arc, 'run.sh'), 'changed');
    expect((await runnerArchive(data, '2.330.0', p)).sha256).toBe(first.sha256);
    expect(calls).toEqual({ pack: 1, verify: 2 });
    await expect(runnerArchive(data, '../2.330.0', p)).rejects.toThrow(/runner version/);
  });

  it('packs again, rather than send, a kept archive that no longer checks', async () => {
    const archive = path.join(data, 'macos-vm', 'runner', '2.330.0.tar.gz');
    await runnerArchive(data, '2.330.0', packing().p);
    fs.writeFileSync(archive, 'tampered');
    const { p, calls } = packing((bytes) => bytes.toString() === 'tampered');
    const sent = await runnerArchive(data, '2.330.0', p);
    expect(sent.bytes.toString()).not.toBe('tampered');
    expect(calls).toEqual({ pack: 1, verify: 2 });

    // One that does not check even freshly packed is not sent at all.
    await expect(runnerArchive(data, '2.330.0', packing(() => true).p)).rejects.toThrow(/integrity record/);
  });
});
