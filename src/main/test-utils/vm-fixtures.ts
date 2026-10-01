/**
 * Fixtures for the VM backend's tests: a guest directory as build:guest
 * leaves one, with small stand-in artifacts, and the fake helper's path.
 */

import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GUEST_ARTIFACTS } from '../vm/guest-image';

/** test/fakes/fake-localmost-vm.mjs, the helper's stand-in (contract §8). */
export const FAKE_HELPER = path.resolve(__dirname, '..', '..', '..', 'test', 'fakes', 'fake-localmost-vm.mjs');

/**
 * A new directory with as short a real path as the temp directory allows: a
 * name of one hex digit if one is free, then two, then three. A VM's sockets
 * are `<data>/vm/jobs/<vmId>/docker.sock`, 35 or 36 bytes past `<data>`, and
 * a unix socket's path must fit in 103 bytes and its NUL - which a job's own
 * TMPDIR, deep in its sandbox, leaves little room for.
 */
export function shortTempDir(): string {
  const base = fs.realpathSync(os.tmpdir());
  for (const length of [1, 2, 3]) {
    const names = Array.from({ length: 16 ** length }, (_, i) => i.toString(16).padStart(length, '0'));
    // Shuffled, so parallel test files do not all race for the same name.
    for (let i = names.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [names[i], names[j]] = [names[j], names[i]];
    }
    for (const name of names) {
      const dir = path.join(base, name);
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
        return dir;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  }
  throw new Error(`no free short directory name in ${base}`);
}

/** The most a unix socket's path may have, less its NUL. */
const MAX_SOCKET_PATH_BYTES = 103;

/**
 * Throw, saying why, when a VM's sockets under `data` would not fit in a
 * unix socket's path: a test that connects to one would otherwise fail
 * later with an error that does not say so. The longest VM id, a two-digit
 * slot, is the one measured.
 */
export function assertVmSocketsFit(data: string): void {
  const longest = path.join(data, 'vm', 'jobs', '99-0123456789ab', 'docker.sock');
  const bytes = Buffer.byteLength(longest);
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `a Docker VM socket under ${data} would be ${bytes} bytes, past the ${MAX_SOCKET_PATH_BYTES} a unix socket's path may have: ` +
        'run the tests with a shorter TMPDIR'
    );
  }
}

/** A `<data>` laid out as the app lays one out for a job VM, before its helper starts. */
export interface VmLayout {
  data: string;
  resources: string;
  sandboxId: string;
  sandbox: string;
  share: string;
  nonce: string;
}

/**
 * Make `<data>/runner/sandbox/<sandboxId>/_work` with its nonce, and a
 * resources directory with a guest, under `root`.
 */
export function layOutVmData(root: string, sandboxId = '1-abcdef012345'): VmLayout {
  const data = path.join(root, 'd');
  const resources = path.join(root, 'r');
  assertVmSocketsFit(data);
  const sandbox = path.join(data, 'runner', 'sandbox', sandboxId);
  const share = path.join(sandbox, '_work');
  fs.mkdirSync(share, { recursive: true });
  const nonce = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(share, '.localmost-share'), nonce, { mode: 0o600 });
  writeGuest(path.join(resources, 'guest'));
  return { data, resources, sandboxId, sandbox, share, nonce };
}

/**
 * A HelperSpawn that runs the fake helper with this node, directly (never
 * through sandbox-exec), with the fake's script and mock daemon added to the
 * environment the client gives it.
 */
export function fakeHelperSpawn(script: Record<string, unknown> = {}, dockerd?: string) {
  return (_helper: string, args: string[], env: Record<string, string>): ChildProcess =>
    spawn(process.execPath, [FAKE_HELPER, ...args], {
      env: {
        ...env,
        FAKE_AGENT_SCRIPT: JSON.stringify(script),
        ...(dockerd !== undefined ? { FAKE_DOCKERD_SOCKET: dockerd } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
}

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

/**
 * Where `docker` resolves on a PATH, as a shell's lookup finds it - the first
 * directory holding an executable file of that name - and the bundled CLI's
 * directory, `docker-cli`, on it. The runner puts the bundled directory first
 * on a job's PATH, but what a job runs may put more in front of it (npm and
 * jest put node_modules/.bin first), so what matters is not that it is first
 * but that no other docker comes before it: then `resolved` is its `docker`.
 */
export function dockerOnPath(pathEnv: string): { bundledDir: string | undefined; resolved: string | undefined } {
  const dirs = pathEnv.split(':').filter((dir) => dir !== '');
  const isExecutableFile = (file: string): boolean => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  const resolvedDir = dirs.find((dir) => isExecutableFile(path.join(dir, 'docker')));
  return {
    bundledDir: dirs.find((dir) => path.basename(dir) === 'docker-cli'),
    resolved: resolvedDir === undefined ? undefined : path.join(resolvedDir, 'docker'),
  };
}
