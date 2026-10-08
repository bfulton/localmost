/**
 * The macOS VM mode's ids and paths: every path from an id checked first,
 * and every removal held to the exact form of what it removes.
 */

import { describe, it, expect } from '@jest/globals';
import {
  IMAGE_ID_RE,
  MAC_VM_ID_RE,
  assertRemovable,
  imageDir,
  ipswPath,
  macVmIdSlot,
  macVmLayout,
  newImageId,
  newMacVmId,
  slotDir,
  vmDir,
} from './paths';

describe('macOS VM paths', () => {
  it('lays out <data>/macos-vm as the helper derives it', () => {
    expect(macVmLayout('/d')).toEqual({
      root: '/d/macos-vm',
      ipswDir: '/d/macos-vm/ipsw',
      imagesDir: '/d/macos-vm/images',
      currentFile: '/d/macos-vm/images/current.json',
      vmsDir: '/d/macos-vm/vms',
      slotsDir: '/d/macos-vm/slots',
      bootstrapDir: '/d/macos-vm/bootstrap',
    });
    expect(imageDir('/d', 'a1b2c3d4e5f6')).toBe('/d/macos-vm/images/a1b2c3d4e5f6');
    expect(slotDir('/d', 'a1b2c3d4e5f6', 2)).toBe('/d/macos-vm/images/a1b2c3d4e5f6/slot2');
    expect(vmDir('/d', '1-0123456789ab')).toBe('/d/macos-vm/vms/1-0123456789ab');
    expect(ipswPath('/d', '25G83.ipsw')).toBe('/d/macos-vm/ipsw/25G83.ipsw');
  });

  it('builds no path from an id out of its form', () => {
    for (const bad of ['../x', 'A1B2C3D4E5F6', 'a1b2c3d4e5f', 'a1b2c3d4e5f6\n']) expect(() => imageDir('/d', bad)).toThrow();
    for (const bad of ['3-0123456789ab', '1-0123456789ab/..', '01-0123456789ab']) expect(() => vmDir('/d', bad)).toThrow();
    for (const bad of ['../25G83.ipsw', '25G83.zip', '.ipsw', 'a b.ipsw']) expect(() => ipswPath('/d', bad)).toThrow();
    expect(() => slotDir('/d', 'a1b2c3d4e5f6', 3)).toThrow();
    for (const bad of ['relative', '/d/', '/d/../e']) expect(() => macVmLayout(bad)).toThrow();
  });

  it('makes fresh ids of their form, each VM id carrying its slot', () => {
    expect(newImageId()).toMatch(IMAGE_ID_RE);
    expect(newMacVmId(2)).toMatch(MAC_VM_ID_RE);
    expect(macVmIdSlot(newMacVmId(2))).toBe(2);
    expect(newMacVmId(1)).not.toBe(newMacVmId(1));
    expect(() => newMacVmId(3)).toThrow();
  });

  it('removes only exactly <root>/<dir>/<a name of its form>', () => {
    expect(() => assertRemovable('/d', '/d/macos-vm/vms/1-0123456789ab', 'vms', MAC_VM_ID_RE)).not.toThrow();
    expect(() => assertRemovable('/d', '/d/macos-vm/images/a1b2c3d4e5f6', 'images', IMAGE_ID_RE)).not.toThrow();
    for (const bad of [
      '/d/macos-vm/vms',
      '/d/macos-vm/vms/1-0123456789ab/disk.img',
      '/d/macos-vm/images/1-0123456789ab',
      '/d/macos-vm/vms/../images/a1b2c3d4e5f6',
      '/e/macos-vm/vms/1-0123456789ab',
      '/',
    ]) {
      expect(() => assertRemovable('/d', bad, 'vms', MAC_VM_ID_RE)).toThrow(/refusing to remove/);
    }
  });
});
