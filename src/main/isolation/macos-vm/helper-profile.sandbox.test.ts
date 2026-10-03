/**
 * The macOS VM helper's profiles through seatbelt itself.
 *
 * helper-profile.test.ts asserts the rules; this shows what seatbelt makes
 * of them. What VZ does under them - the installer's display coming up, a
 * VM restored, the vsock relays - needs a golden image and runs in the live
 * stage (docs/roadmap/macos-vm-jobs.md, "Live validation"). The file half
 * runs here, in the repo's three modes:
 *
 *   off macOS    seatbelt does not exist, and the test says so.
 *   constructed  On an unsandboxed Mac, build each profile and apply it with
 *                sandbox-exec, with a copy of bash standing in for the helper
 *                (the one binary the profile lets it exec), and try what the
 *                helper may and may not reach.
 *   ambient      Inside a localmost job, seatbelt refuses a nested profile,
 *                so assert the job's side: it cannot reach the macos-vm
 *                directories the helper's profiles grant, nor run the helper.
 *
 * Neither mode skips.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { buildMacVmProfile, MacVmProfileOptions } from './helper-profile';
import { MACVM_HELPER_NAME } from './paths';
import { JOB_BIN_DIR } from '../../job-shims';
import { dockerOnPath } from '../../test-utils/vm-fixtures';

const isMacOS = process.platform === 'darwin';
const sq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const canConstruct = (): boolean => {
  if (!isMacOS) return false;
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

if (!isMacOS) {
  describe("the macOS VM helper's profiles through seatbelt", () => {
    it('has nothing to assert off macOS, where seatbelt does not exist', () => {
      expect(process.platform).not.toBe('darwin');
    });
  });
} else if (canConstruct()) {
  describe("the macOS VM helper's profiles through a constructed seatbelt profile", () => {
    let data: string;
    let resources: string;
    let outside: string;
    let helper: string;
    const imageId = 'a1b2c3d4e5f6';
    const vmId = '2-0123456789ab';
    const at = {
      image: () => path.join(data, 'macos-vm', 'images', imageId),
      otherImage: () => path.join(data, 'macos-vm', 'images', 'ffffffffffff'),
      vm: () => path.join(data, 'macos-vm', 'vms', vmId),
      otherVm: () => path.join(data, 'macos-vm', 'vms', '1-0123456789ab'),
      ipsw: () => path.join(data, 'macos-vm', 'ipsw', '25G83.ipsw'),
      bootstrap: () => path.join(data, 'macos-vm', 'bootstrap', imageId),
    };

    beforeAll(() => {
      data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-macvm-data-')));
      resources = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-macvm-res-')));
      outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-macvm-out-')));
      // A copy of bash where the bundle keeps the helper, re-signed ad hoc,
      // because a copy of a system binary is held to the system volume by
      // its launch constraint. Its builtins do the probing - read, printf,
      // globbing and /dev/tcp - since the profile lets it exec nothing else.
      helper = path.join(resources, MACVM_HELPER_NAME);
      fs.copyFileSync('/bin/bash', helper);
      execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', helper], { stdio: 'ignore' });
      const write = (file: string, content: string) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      };
      write(path.join(resources, 'beside-the-helper'), 'another binary');
      write(path.join(at.image(), 'config.json'), 'golden');
      write(path.join(at.image(), 'slot2', 'state.json'), 'slot two');
      write(path.join(at.otherImage(), 'config.json'), 'another image');
      write(path.join(at.vm(), 'helper.pid'), 'pid');
      write(path.join(at.otherVm(), 'helper.pid'), 'another VM');
      write(at.ipsw(), 'restore image');
      write(path.join(at.bootstrap(), 'password'), 'the setup password');
      write(path.join(data, 'macos-vm', 'slots', '1.lock'), '');
      write(path.join(data, 'macos-vm', 'slots', '2.lock'), '');
      write(path.join(data, 'runner', 'sandbox', '1-abcdefabcdef', '.credentials'), 'runner credentials');
      write(path.join(outside, 'home', 'secret'), 'the user');
    });

    afterAll(() => {
      for (const dir of [data, resources, outside]) fs.rmSync(dir, { recursive: true, force: true });
    });

    const userCacheDir = (): string =>
      fs.realpathSync(execFileSync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf-8' }).trim());

    const under = (opts: Partial<MacVmProfileOptions> & Pick<MacVmProfileOptions, 'command'>) => {
      const file = path.join(outside, `${opts.command}-${Math.random().toString(16).slice(2)}.sb`);
      fs.writeFileSync(file, buildMacVmProfile({ helper, dataDir: data, userCacheDir: userCacheDir(), ...opts } as MacVmProfileOptions));
      return (command: string) => {
        const result = spawnSync('/usr/bin/sandbox-exec', ['-f', file, helper, '-c', command], {
          cwd: outside,
          encoding: 'utf-8',
          timeout: 15000,
          env: { PATH: '/usr/bin:/bin', TMPDIR: outside },
        });
        return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr };
      };
    };
    type Run = ReturnType<typeof under>;
    const reads = (run: Run, file: string) => run(`{ read -r l || [ -n "$l" ]; } < ${sq(file)} && printf %s "$l"`);
    const writes = (run: Run, file: string) => run(`printf x > ${sq(file)}`).ok;
    const denied = (run: Run, file: string) => {
      const result = reads(run, file);
      return !result.ok && result.stderr.includes('Operation not permitted');
    };

    it('lets a job VM read its golden image and slot, write only its own directory, and reach nothing else', () => {
      const run = under({ command: 'run', imageId, vmId, proxyPort: 1, brokerPort: 2 });
      expect(reads(run, path.join(at.image(), 'config.json')).stdout).toBe('golden');
      expect(reads(run, path.join(at.image(), 'slot2', 'state.json')).stdout).toBe('slot two');
      expect(writes(run, path.join(at.image(), 'config.json'))).toBe(false);
      expect(writes(run, path.join(at.vm(), 'agent.log'))).toBe(true);
      for (const file of [
        path.join(at.otherImage(), 'config.json'),
        path.join(at.otherVm(), 'helper.pid'),
        at.ipsw(),
        path.join(at.bootstrap(), 'password'),
        path.join(data, 'runner', 'sandbox', '1-abcdefabcdef', '.credentials'),
        path.join(resources, 'beside-the-helper'),
        path.join(outside, 'home', 'secret'),
      ]) {
        expect([file, denied(run, file)]).toEqual([file, true]);
      }
      // The helper's directory may be listed (IOSurface's first connect reads
      // the main bundle), but nothing in it read.
      expect(run(`for f in ${sq(resources)}/*; do printf '%s\\n' "\${f##*/}"; done`).stdout.split('\n')).toEqual(
        expect.arrayContaining([MACVM_HELPER_NAME, 'beside-the-helper'])
      );
    });

    it("lets a job VM connect to the job's proxy and the broker on loopback, and to no other port", async () => {
      const listen = () =>
        new Promise<net.Server>((resolve) => {
          const server = net.createServer((socket) => socket.end());
          server.listen(0, '127.0.0.1', () => resolve(server));
        });
      const [proxy, broker, other] = await Promise.all([listen(), listen(), listen()]);
      try {
        const portOf = (server: net.Server) => (server.address() as net.AddressInfo).port;
        const run = under({ command: 'run', imageId, vmId, proxyPort: portOf(proxy), brokerPort: portOf(broker) });
        const connect = (port: number) => run(`exec 3<>/dev/tcp/127.0.0.1/${port}`);
        expect(connect(portOf(proxy)).ok).toBe(true);
        expect(connect(portOf(broker)).ok).toBe(true);
        const refused = connect(portOf(other));
        expect(refused.ok).toBe(false);
        expect(refused.stderr).toContain('Operation not permitted');
      } finally {
        await Promise.all([proxy, broker, other].map((server) => new Promise((resolve) => server.close(resolve))));
      }
    });

    it('lets install write its own image and read its restore image, and no other', () => {
      const run = under({ command: 'install', imageId, ipswName: '25G83.ipsw', slot: 1 });
      expect(reads(run, at.ipsw()).stdout).toBe('restore image');
      expect(writes(run, path.join(at.image(), 'disk.img'))).toBe(true);
      expect(writes(run, path.join(at.otherImage(), 'disk.img'))).toBe(false);
      expect(denied(run, path.join(at.bootstrap(), 'password'))).toBe(true);
      expect(denied(run, path.join(at.vm(), 'helper.pid'))).toBe(true);
    });

    it('lets check read its image and write nothing', () => {
      const run = under({ command: 'check', imageId });
      expect(reads(run, path.join(at.image(), 'config.json')).stdout).toBe('golden');
      expect(writes(run, path.join(at.image(), 'config.json'))).toBe(false);
      expect(denied(run, path.join(at.otherImage(), 'config.json'))).toBe(true);
    });
  });
} else {
  describe("the macOS VM helper's profiles, from inside a localmost job", () => {
    // The job's TMPDIR is <data>/runner/sandbox/<id>/_temp.
    const sandbox = path.dirname(fs.realpathSync(os.tmpdir()));
    const data = path.dirname(path.dirname(path.dirname(sandbox)));
    const shell = (command: string) => {
      const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf-8', timeout: 15000 });
      return { ok: result.status === 0, stderr: result.stderr };
    };

    it('runs where the app lays a job out', () => {
      expect(path.basename(path.dirname(sandbox))).toBe('sandbox');
      expect(path.basename(path.dirname(path.dirname(sandbox)))).toBe('runner');
    });

    it("cannot list <data>/macos-vm, where the helper's profiles grant the images and VMs", () => {
      // Made with the first image; a denied path whose parent is missing
      // fails with ENOENT, not EPERM, so either is a refusal here.
      const root = path.join(data, 'macos-vm');
      const listing = shell(`/bin/ls ${sq(root)}`);
      expect(listing.ok).toBe(false);
      expect(listing.stderr.includes('Operation not permitted') || !fs.existsSync(root)).toBe(true);
    });

    it('cannot run the macOS VM helper, which carries the virtualization entitlement', () => {
      // Beside the bundled docker CLI's directory, in the bundle's
      // Resources; the job profile denies its exec by path.
      const { resolved, bundled } = dockerOnPath(process.env.PATH ?? '');
      expect(resolved).toBeDefined();
      expect(fs.realpathSync(path.dirname(resolved!))).toBe(path.join(sandbox, JOB_BIN_DIR));
      expect(bundled).toBeDefined();
      const helper = path.join(path.dirname(path.dirname(bundled!)), MACVM_HELPER_NAME);
      const result = shell(`${sq(helper)} version`);
      expect(result.ok).toBe(false);
      expect(result.stderr.includes('Operation not permitted') || !fs.existsSync(helper)).toBe(true);
    });
  });
}
