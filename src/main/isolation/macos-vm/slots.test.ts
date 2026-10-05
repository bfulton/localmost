/**
 * The macOS VM slots: never more VMs than the limit, in order of asking,
 * and a slot asked for by number when its identity matters.
 */

import { describe, it, expect } from '@jest/globals';
import { MacVmSlots } from './slots';
import { concurrentVmLimit, hostRefusal, macosMajorOf, provisioningMode } from './host';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('MacVmSlots', () => {
  it('hands out two slots and makes a third VM wait for one to be released', async () => {
    const slots = new MacVmSlots(() => 2);
    expect(await slots.acquire('job a')).toBe(1);
    expect(await slots.acquire('job b')).toBe(2);
    let third: number | undefined;
    void slots.acquire('job c').then((s) => (third = s));
    await tick();
    expect(third).toBeUndefined();
    expect(slots.queued()).toBe(1);
    slots.release(1);
    await tick();
    expect(third).toBe(1);
    expect(slots.holders()).toEqual([{ slot: 2, owner: 'job b' }, { slot: 1, owner: 'job c' }]);
  });

  it('holds to a limit of one on a Mac with memory for one VM', async () => {
    const slots = new MacVmSlots(() => 1);
    await slots.acquire('job a');
    let second: number | undefined;
    void slots.acquire('job b').then((s) => (second = s));
    await tick();
    expect(second).toBeUndefined();
    slots.release(1);
    await tick();
    expect(second).toBe(1);
  });

  it('serves a caller that can take a free slot ahead of one waiting for a held slot', async () => {
    const slots = new MacVmSlots(() => 2);
    await slots.acquire('job in slot 2', [2]);
    const order: string[] = [];
    void slots.acquire('save-state of slot 2', [2]).then(() => order.push('save-state'));
    void slots.acquire('job', [1, 2]).then((s) => order.push(`job in ${s}`));
    await tick();
    expect(order).toEqual(['job in 1']);
    slots.release(2);
    await tick();
    expect(order).toEqual(['job in 1', 'save-state']);
  });

  it('gives up waiting when aborted, and refuses a caller that can use no slot', async () => {
    const slots = new MacVmSlots(() => 2);
    await slots.acquire('a');
    await slots.acquire('b');
    const abort = new AbortController();
    const waiting = slots.acquire('c', [1, 2], abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow(/cancelled/);
    expect(slots.queued()).toBe(0);
    await expect(slots.acquire('d', [])).rejects.toThrow(/no macOS VM slot/);
  });
});

describe('what this Mac can run', () => {
  const host = { platform: 'darwin', arch: 'arm64', darwin: '25.6.0', build: '25G83', totalMemoryBytes: 16 * 2 ** 30 };

  it('reads the macOS release from the Darwin version', () => {
    expect(macosMajorOf('23.6.0')).toBe(14);
    expect(macosMajorOf('24.0.0')).toBe(15);
    expect(macosMajorOf('25.6.0')).toBe(26);
    expect(macosMajorOf('26.0.0')).toBe(27);
    expect(macosMajorOf('19.0.0')).toBeNull();
    expect(macosMajorOf('x')).toBeNull();
  });

  it('runs two VMs on 16 GB, one on 12 GB, none on 8 GB', () => {
    expect(concurrentVmLimit(16 * 2 ** 30)).toBe(2);
    expect(concurrentVmLimit(64 * 2 ** 30)).toBe(2);
    expect(concurrentVmLimit(12 * 2 ** 30)).toBe(1);
    expect(concurrentVmLimit(8 * 2 ** 30)).toBe(0);
  });

  it('refuses an Intel Mac, macOS before 14, and a Mac without memory for a VM', () => {
    expect(hostRefusal(host)).toBeNull();
    expect(hostRefusal({ ...host, arch: 'x64' })).toMatch(/Apple silicon/);
    expect(hostRefusal({ ...host, darwin: '22.6.0' })).toMatch(/macOS 14/);
    expect(hostRefusal({ ...host, totalMemoryBytes: 8 * 2 ** 30 })).toMatch(/memory/);
  });

  it('provisions headless only on macOS 27 with a helper built with the macOS 27 SDK', () => {
    expect(provisioningMode(host, true)).toBe('guided');
    expect(provisioningMode({ ...host, darwin: '26.0.0' }, true)).toBe('headless');
    expect(provisioningMode({ ...host, darwin: '26.0.0' }, false)).toBe('guided');
  });
});
