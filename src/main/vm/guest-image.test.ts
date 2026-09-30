import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GuestImage } from './guest-image';
import { writeGuest } from '../test-utils/vm-fixtures';

describe('GuestImage', () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-guest-')), 'guest');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it('reads the manifest the filter answers the baseline from', () => {
    writeGuest(dir);
    const manifest = new GuestImage(dir).manifest();
    expect(manifest.guestVersion).toBe('2026.10.0');
    expect(manifest.dataFormat).toBe(1);
    expect(manifest.docker).toEqual({ engine: '29.5.3', apiVersion: '1.54', minApiVersion: '1.24' });
    expect(manifest.kernelRelease).toBe('6.18.54-0-virt');
    expect(manifest.baseline.KernelVersion).toBe('6.18.54-0-virt');
    expect(manifest.baseline.SecurityOptions).toEqual(['name=seccomp,profile=builtin', 'name=cgroupns']);
  });

  it('keeps only the /info fields a job may be shown in the baseline', () => {
    writeGuest(dir, {
      baseline: { ServerVersion: '29.5.3', OSType: 'linux', Name: 'the-build-host', HttpProxy: 'http://u:p@proxy' },
    });
    expect(new GuestImage(dir).manifest().baseline).toEqual({ ServerVersion: '29.5.3', OSType: 'linux' });
  });

  it.each([
    ['a missing manifest', null],
    ['another schema', { schema: 2 }],
    ['another agent protocol', { agentProtocol: 2 }],
    ['an API version that is not one', { docker: { engine: '29.5.3', apiVersion: 'latest', minApiVersion: '1.24' } }],
    ['a missing artifact entry', { artifacts: {} }],
    ['a digest that is not sha256 hex', { artifacts: { vmlinux: { sha256: '../x', size: 1 } } }],
    ['an oversized string', { guestVersion: 'x'.repeat(10_000) }],
    ['a baseline field of the wrong type', { baseline: { SecurityOptions: 'all' } }],
  ])('refuses %s with E_GUEST_IMAGE', (_what, overrides) => {
    if (overrides === null) fs.mkdirSync(dir, { recursive: true });
    else writeGuest(dir, overrides as Record<string, unknown>);
    expect(() => new GuestImage(dir).manifest()).toThrow(expect.objectContaining({ code: 'E_GUEST_IMAGE' }));
  });

  it('verifies each artifact against the manifest, and does it once per launch', async () => {
    writeGuest(dir);
    const guest = new GuestImage(dir);
    await expect(guest.verify()).resolves.toBeUndefined();
    // Checked already, so a later boot does not hash 100 MB again: the answer
    // is kept for the launch. A new launch reads the files afresh.
    fs.appendFileSync(path.join(dir, 'rootfs.erofs'), 'changed');
    await expect(guest.verify()).resolves.toBeUndefined();
    await expect(new GuestImage(dir).verify()).rejects.toMatchObject({ code: 'E_GUEST_IMAGE' });
  });

  it('refuses an artifact whose contents or size differ from the manifest', async () => {
    writeGuest(dir);
    fs.writeFileSync(path.join(dir, 'rootfs.erofs'), Buffer.from('rootfs.erofs CONTENTS'));
    await expect(new GuestImage(dir).verify()).rejects.toMatchObject({ code: 'E_GUEST_IMAGE', message: expect.stringMatching(/rootfs\.erofs/) });

    writeGuest(dir);
    fs.appendFileSync(path.join(dir, 'vmlinux'), 'more');
    await expect(new GuestImage(dir).verify()).rejects.toMatchObject({ code: 'E_GUEST_IMAGE', message: expect.stringMatching(/vmlinux/) });
  });

  it('refuses a missing artifact, and an artifact that is a link', async () => {
    writeGuest(dir);
    fs.rmSync(path.join(dir, 'initramfs.cpio.gz'));
    await expect(new GuestImage(dir).verify()).rejects.toMatchObject({ code: 'E_GUEST_IMAGE' });

    writeGuest(dir);
    const elsewhere = path.join(path.dirname(dir), 'elsewhere');
    fs.renameSync(path.join(dir, 'vmlinux'), elsewhere);
    fs.symlinkSync(elsewhere, path.join(dir, 'vmlinux'));
    await expect(new GuestImage(dir).verify()).rejects.toMatchObject({ code: 'E_GUEST_IMAGE' });
  });
});
