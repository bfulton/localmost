/**
 * Removing a finished job's sandbox while something of the job still runs in
 * it, through seatbelt.
 *
 * A process that left its worker's process group with setsid() can outlive
 * every sweep - the profile-mark sweep needs the developer tools - and keeps
 * its job's profile, which grants write on the sandbox's path. Were the tree
 * removed where it is, such a process could swap a directory in it for a link
 * while the removal walked it, and the removal would delete what the link
 * points to. As in the other sandbox tests, a profile can only be constructed
 * outside a localmost job; inside one, the assertion is that the job cannot
 * write where its sandbox is moved to be removed. macOS only, because seatbelt
 * is.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ChildProcess, execFileSync, spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateSandboxProfile } from './process-sandbox';
import { RunnerDownloader } from './runner-downloader';

const isMacOS = process.platform === 'darwin';

/** Whether a profile can be constructed and applied here; see process-sandbox.sandbox.test.ts. */
const canConstruct = (): boolean => {
  if (!isMacOS) return false;
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], {
      timeout: 5000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

if (!isMacOS) {
  describe('removing a sandbox something of its job still runs in', () => {
    it('has nothing to assert off macOS, where seatbelt does not exist', () => {
      expect(process.platform).not.toBe('darwin');
    });
  });
} else if (canConstruct()) {
  describe('removing a sandbox something of its job still runs in', () => {
    const version = '9.9.9';
    // Resolved, as seatbelt matches canonical paths: the profile grants the
    // sandbox by the path buildSandbox returns.
    let root: string;
    let victim: string;
    let downloader: RunnerDownloader;
    const started: ChildProcess[] = [];
    const savedConfigDir = process.env.LOCALMOST_CONFIG_DIR;

    const write = (file: string, content: string, mode = 0o644) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { mode });
    };

    beforeEach(async () => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-removal-')));
      process.env.LOCALMOST_CONFIG_DIR = path.join(root, 'app');
      const runnerDir = path.join(root, 'app', 'runner');
      const arc = path.join(runnerDir, 'arc', `v${version}`);
      write(path.join(arc, 'run.sh'), '#!/bin/bash\n', 0o755);
      write(path.join(arc, 'bin', 'Runner.Listener'), 'listener', 0o755);
      // A registration, as copyProxyCredentials requires one.
      for (const file of ['.runner', '.credentials', '.credentials_rsaparams']) {
        write(path.join(runnerDir, 'proxies', 'target-a', '1', file), '{}');
      }
      // Files of the user's, outside every directory the app keeps.
      victim = path.join(root, 'victim');
      write(path.join(victim, 'keep'), 'kept');

      downloader = new RunnerDownloader();
      await downloader.recordArcManifest(version);
      await downloader.copyProxyCredentials(1, path.join(runnerDir, 'proxies', 'target-a'));
    });

    afterEach(() => {
      for (const child of started.splice(0)) child.kill('SIGKILL');
      if (savedConfigDir === undefined) delete process.env.LOCALMOST_CONFIG_DIR;
      else process.env.LOCALMOST_CONFIG_DIR = savedConfigDir;
      fs.rmSync(root, { recursive: true, force: true });
    });

    /**
     * A process of the finished job, under its profile, working in its
     * sandbox. On cue it swaps a directory there for a link to the user's
     * files, and exits 0 if it could.
     */
    const leftover = async (sandbox: string): Promise<{ swap: () => Promise<boolean> }> => {
      const profile = path.join(root, `${crypto.randomBytes(4).toString('hex')}.sb`);
      fs.writeFileSync(profile, generateSandboxProfile({ instanceDir: sandbox }));
      const child = spawn(
        '/usr/bin/sandbox-exec',
        [
          '-f', profile,
          '/bin/sh', '-c',
          `cd '${path.join(sandbox, '_work')}' && echo ready && read cue && /bin/mv d0 d0.moved && /bin/ln -s '${victim}' d0`,
        ],
        { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', HOME: os.homedir() } }
      );
      started.push(child);
      const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on('data', (chunk) => {
          if (String(chunk).includes('ready')) resolve();
        });
        exited.then((code) => reject(new Error(`the leftover exited (${code}) before it was in place`)));
      });
      return {
        swap: async () => {
          child.stdin!.end('go\n');
          return (await exited) === 0;
        },
      };
    };

    it('keeps a process left running in the sandbox from changing the tree while it is removed', async () => {
      const sandbox = await downloader.buildSandbox(1, version);
      write(path.join(sandbox, '_work', 'd0', 'output'), 'job');
      const job = await leftover(sandbox);
      // The process makes its move once the removal has begun listing the
      // tree, which a real one would have to win a race to do; here it
      // always does.
      const realReaddir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
      let swapped: boolean | undefined;
      const readdir = jest.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: unknown[]) => {
        if (swapped === undefined) swapped = await job.swap();
        return realReaddir(...args);
      }) as never);
      try {
        await downloader.removeSandbox(sandbox);
      } finally {
        readdir.mockRestore();
      }

      // What this pins is that the process cannot change the tree at all
      // once its removal has begun: its swap is refused. The victim would
      // be safe here even had the swap gone through, as the removal never
      // follows a link; that half, against a writer seatbelt does not
      // confine, is the racing writer in runner-cleanup.test.ts.
      expect(swapped).toBe(false);
      expect(fs.readFileSync(path.join(victim, 'keep'), 'utf-8')).toBe('kept');
      expect(fs.readdirSync(downloader.getSandboxBase())).toEqual([]);
    });
  });
} else {
  describe('removing a sandbox something of its job still runs in', () => {
    // Already inside a localmost job, whose TMPDIR is in its own sandbox:
    // <app dir>/runner/sandbox/<n>-<id>/_temp.
    const sandboxDir = path.dirname(fs.realpathSync(os.tmpdir()));
    const sandboxBase = path.dirname(sandboxDir);

    it('cannot write beside its own sandbox, where the sandbox is moved to be removed', () => {
      expect(path.basename(sandboxBase)).toBe('sandbox');
      const aside = path.join(sandboxBase, `.removing-${path.basename(sandboxDir)}.probe-${process.pid}`);
      const result = spawnSync('/bin/mkdir', [aside], { encoding: 'utf-8', timeout: 15000 });
      fs.rmSync(aside, { recursive: true, force: true });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Operation not permitted');
    });
  });
}
