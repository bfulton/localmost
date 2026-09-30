/**
 * The helper's profile through seatbelt itself.
 *
 * helper-profile.test.ts asserts the rules; this shows what seatbelt makes of
 * them. The VM half - a share outside the grant, or a granted path that is a
 * link, failing VZ's Start(), and a granted real directory readable in the
 * guest - needs the helper and a guest, so it runs in the live stage and the
 * owner's local run. The profile half runs here, in the repo's three modes:
 *
 *   off macOS    seatbelt does not exist, and the test says so.
 *   constructed  On an unsandboxed Mac, build the profile and apply it with
 *                sandbox-exec, with /bin/bash standing in for the helper (the
 *                one binary the profile lets it exec), and try what the
 *                helper may and may not reach.
 *   ambient      Inside a localmost job, seatbelt refuses a nested profile,
 *                so assert the job's side: it cannot reach the VM directories
 *                the helper's profile grants, nor run the helper.
 *
 * Neither mode skips.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { buildHelperProfile, HelperProfileOptions } from './helper-profile';

const isMacOS = process.platform === 'darwin';

/** A word for a shell command line, quoted so nothing in it is special. */
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
  describe("the helper's profile through seatbelt", () => {
    it('has nothing to assert off macOS, where seatbelt does not exist', () => {
      expect(process.platform).not.toBe('darwin');
    });
  });
} else if (canConstruct()) {
  describe("the helper's profile through a constructed seatbelt profile", () => {
    // bash stands in for the helper: the profile execs and reads exactly the
    // helper it is built for. Its builtins do the probing - read, printf and
    // /dev/tcp - since the profile lets it exec nothing else.
    const helper = '/bin/bash';
    let data: string;
    let resources: string;
    let outside: string;
    const vmId = '3-0123456789ab';
    const sandboxId = '3-abcdefabcdef';
    const repoKey = '0123456789abcdef';
    const at = {
      vm: () => path.join(data, 'vm', 'jobs', vmId),
      otherVm: () => path.join(data, 'vm', 'jobs', '4-0123456789ab'),
      sandbox: () => path.join(data, 'runner', 'sandbox', sandboxId),
      share: () => path.join(data, 'runner', 'sandbox', sandboxId, '_work'),
      cache: () => path.join(data, 'vm', 'cache', repoKey),
    };

    beforeAll(() => {
      data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-helper-data-')));
      resources = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-helper-res-')));
      outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-helper-out-')));
      const write = (file: string, content: string) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      };
      write(path.join(resources, 'guest', 'vmlinux'), 'kernel');
      write(path.join(resources, 'localmost-vm-sibling'), 'not the guest');
      write(path.join(at.vm(), 'console.log'), 'console');
      write(path.join(at.otherVm(), 'console.log'), 'another VM');
      write(path.join(at.share(), 'repo', 'f'), 'shared');
      write(path.join(at.sandbox(), '.credentials'), 'runner credentials');
      write(path.join(data, 'runner', 'config', '1', '.runner'), 'registration');
      write(path.join(at.cache(), 'data.img'), 'golden');
      write(path.join(at.cache(), 'data.img.new'), 'refreshing');
      write(path.join(outside, 'home', 'secret'), 'the user');
    });

    afterAll(() => {
      for (const dir of [data, resources, outside]) fs.rmSync(dir, { recursive: true, force: true });
    });

    const profileFor = (options: Partial<HelperProfileOptions> & Pick<HelperProfileOptions, 'mode'>): string => {
      const file = path.join(outside, `${options.mode}-${Math.random().toString(16).slice(2)}.sb`);
      fs.writeFileSync(file, buildHelperProfile({ helper, resources, dataDir: data, vmId, ...options } as HelperProfileOptions));
      return file;
    };

    /** A bash command line under a helper profile, from the VM's directory. */
    const under = (profile: string) => (command: string) => {
      const result = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, helper, '-c', command], {
        cwd: at.vm(),
        encoding: 'utf-8',
        timeout: 15000,
        env: { PATH: '/usr/bin:/bin', TMPDIR: at.vm() },
      });
      return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr };
    };
    /** The file's one line; read fails at an end with no newline, which these files have. */
    const reads = (run: ReturnType<typeof under>, file: string) =>
      run(`{ read -r l || [ -n "$l" ]; } < ${sq(file)} && printf %s "$l"`);
    const writes = (run: ReturnType<typeof under>, file: string) => run(`printf x > ${sq(file)}`).ok;

    describe('in job mode', () => {
      let run: ReturnType<typeof under>;
      beforeAll(() => {
        run = under(profileFor({ mode: 'job', vmId, sandboxId, proxyPort: 1 }));
      });

      it('reads the guest, and reads and writes its own directory and the share', () => {
        expect(reads(run, path.join(resources, 'guest', 'vmlinux')).stdout).toBe('kernel');
        expect(reads(run, path.join(at.vm(), 'console.log')).stdout).toBe('console');
        expect(writes(run, path.join(at.vm(), 'helper.pid'))).toBe(true);
        expect(reads(run, path.join(at.share(), 'repo', 'f')).stdout).toBe('shared');
        expect(writes(run, path.join(at.share(), 'repo', 'written'))).toBe(true);
      });

      it('reaches nothing else: the sandbox around the share, other VMs, the runner, the cache, the home', () => {
        for (const file of [
          path.join(at.sandbox(), '.credentials'),
          path.join(at.otherVm(), 'console.log'),
          path.join(data, 'runner', 'config', '1', '.runner'),
          path.join(at.cache(), 'data.img'),
          path.join(resources, 'localmost-vm-sibling'),
          path.join(outside, 'home', 'secret'),
        ]) {
          const result = reads(run, file);
          expect([file, result.ok, result.stderr.includes('Operation not permitted')]).toEqual([file, false, true]);
        }
        expect(writes(run, path.join(resources, 'guest', 'vmlinux'))).toBe(false);
        expect(writes(run, path.join(at.sandbox(), 'planted'))).toBe(false);
      });

      it('reaches nothing through a link, whether in the share or at the share itself', () => {
        fs.symlinkSync(path.join(outside, 'home'), path.join(at.share(), 'escape'));
        expect(reads(run, path.join(at.share(), 'escape', 'secret')).ok).toBe(false);
        // The share swapped for a link elsewhere: seatbelt matches where it
        // leads, which the profile does not grant.
        const real = `${at.share()}-real`;
        fs.renameSync(at.share(), real);
        fs.symlinkSync(path.join(outside, 'home'), at.share());
        try {
          const result = reads(run, path.join(at.share(), 'secret'));
          expect(result.ok).toBe(false);
          expect(result.stderr).toContain('Operation not permitted');
        } finally {
          fs.unlinkSync(at.share());
          fs.renameSync(real, at.share());
          fs.unlinkSync(path.join(at.share(), 'escape'));
        }
      });

      it("connects to the worker's proxy port on loopback, and to no other", async () => {
        const listen = () =>
          new Promise<net.Server>((resolve) => {
            const server = net.createServer((socket) => socket.end());
            server.listen(0, '127.0.0.1', () => resolve(server));
          });
        const [proxy, other] = await Promise.all([listen(), listen()]);
        try {
          const portOf = (server: net.Server) => (server.address() as net.AddressInfo).port;
          const withProxy = under(profileFor({ mode: 'job', vmId, sandboxId, proxyPort: portOf(proxy) }));
          const connect = (port: number) => withProxy(`exec 3<>/dev/tcp/127.0.0.1/${port}`);
          expect(connect(portOf(proxy)).ok).toBe(true);
          const refused = connect(portOf(other));
          expect(refused.ok).toBe(false);
          expect(refused.stderr).toContain('Operation not permitted');
        } finally {
          await Promise.all([proxy, other].map((server) => new Promise((resolve) => server.close(resolve))));
        }
      });
    });

    describe('in refresh mode', () => {
      let run: ReturnType<typeof under>;
      beforeAll(() => {
        run = under(profileFor({ mode: 'refresh', vmId: '0-0123456789ab', repoKey }));
      });

      it('reads and writes the one disk it refreshes, and not the golden disk every job clones', () => {
        expect(reads(run, path.join(at.cache(), 'data.img.new')).stdout).toBe('refreshing');
        expect(writes(run, path.join(at.cache(), 'data.img.new'))).toBe(true);
        expect(reads(run, path.join(at.cache(), 'data.img')).ok).toBe(false);
        expect(writes(run, path.join(at.cache(), 'meta.json'))).toBe(false);
      });

      it('reaches no share and no loopback port', async () => {
        expect(reads(run, path.join(at.share(), 'repo', 'f')).ok).toBe(false);
        const server = net.createServer((socket) => socket.end());
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
          const port = (server.address() as net.AddressInfo).port;
          expect(run(`exec 3<>/dev/tcp/127.0.0.1/${port}`).ok).toBe(false);
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      });
    });
  });
} else {
  describe("the helper's profile, from inside a localmost job", () => {
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

    it("cannot list or write the app's data directory, where the helper's profile grants the VM directories", () => {
      // <data>/vm is made at the first VM boot, and a denied path whose parent
      // is missing fails with ENOENT, not EPERM. So the refusals that count
      // are on what is certainly there while a job runs: <data> itself and
      // runner/sandbox. <data>/vm is under the same deny, when it exists.
      const probe = path.join(data, `localmost-probe-${process.pid}`);
      const write = shell(`/usr/bin/touch ${sq(probe)}`);
      fs.rmSync(probe, { force: true });
      expect(write.ok).toBe(false);
      expect(write.stderr).toContain('Operation not permitted');
      const listing = shell(`/bin/ls ${sq(path.join(data, 'runner', 'sandbox'))}`);
      expect(listing.ok).toBe(false);
      expect(listing.stderr).toContain('Operation not permitted');
      const vm = path.join(data, 'vm');
      const vmListing = shell(`/bin/ls ${sq(vm)}`);
      expect(vmListing.ok).toBe(false);
      expect(vmListing.stderr.includes('Operation not permitted') || !fs.existsSync(vm)).toBe(true);
    });

    it('cannot run the helper, which carries the virtualization entitlement', () => {
      // Found beside the bundled CLI, which the job's PATH starts with. The
      // job profile denies its exec by path; the constructed form of this is
      // in process-sandbox.sandbox.test.ts, with a compiled stand-in. Until
      // packaging ships the helper there is nothing at the path to refuse.
      const cliDir = (process.env.PATH ?? '').split(':')[0];
      expect(path.basename(cliDir)).toBe('docker-cli');
      const helper = path.join(path.dirname(cliDir), 'localmost-vm');
      const result = shell(`${sq(helper)} version`);
      expect(result.ok).toBe(false);
      expect(result.stderr.includes('Operation not permitted') || !fs.existsSync(helper)).toBe(true);
    });

    it('cannot put itself under a profile of its own', () => {
      expect(shell("/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true").ok).toBe(false);
    });
  });
}
