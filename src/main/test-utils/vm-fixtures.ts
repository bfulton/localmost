/**
 * Fixtures for the VM backend's tests: a guest directory as build:guest
 * leaves one, with small stand-in artifacts, and the fake helper's path.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { GUEST_ARTIFACTS } from '../vm/guest-image';

/** test/fakes/fake-localmost-vm.mjs, the helper's stand-in (contract §8). */
export const FAKE_HELPER = path.resolve(__dirname, '..', '..', '..', 'test', 'fakes', 'fake-localmost-vm.mjs');

/** Write `<dir>/manifest.json` and the three artifacts it names; returns the manifest. */
export function writeGuest(dir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  fs.mkdirSync(dir, { recursive: true });
  const artifacts: Record<string, { sha256: string; size: number }> = {};
  for (const name of GUEST_ARTIFACTS) {
    const content = Buffer.from(`${name} contents`);
    fs.writeFileSync(path.join(dir, name), content);
    artifacts[name] = { sha256: crypto.createHash('sha256').update(content).digest('hex'), size: content.length };
  }
  const manifest = {
    schema: 1,
    guestVersion: '2026.10.0',
    dataFormat: 1,
    agentProtocol: 1,
    alpine: { branch: 'v3.24', release: '3.24.2' },
    kernel: { package: 'linux-virt-6.18.54-r0', release: '6.18.54-0-virt' },
    docker: { engine: '29.5.3', apiVersion: '1.54', minApiVersion: '1.24', containerd: '2.3.6', runc: '1.4.3' },
    artifacts,
    modules: ['virtiofs'],
    packages: [],
    baseline: {
      ServerVersion: '29.5.3',
      OSType: 'linux',
      Architecture: 'aarch64',
      OperatingSystem: 'localmost guest (Alpine Linux v3.24)',
      KernelVersion: '6.18.54-0-virt',
      Driver: 'overlay2',
      CgroupVersion: '2',
      SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'],
    },
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}
