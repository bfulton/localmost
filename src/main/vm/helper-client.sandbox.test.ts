/**
 * HelperClient through the real sandbox-exec wrapping (contract §2.1).
 *
 * The unit tests run the fake helper directly. This runs the spawn the app
 * uses - sandbox-exec, the VM's own profile from buildHelperProfile, an
 * environment of PATH and TMPDIR alone, the VM's directory as the working
 * directory - in the repo's three modes:
 *
 *   off macOS    seatbelt does not exist, and the test says so.
 *   constructed  On an unsandboxed Mac. The profile lets exactly one binary
 *                run, and a script cannot be it (its interpreter would be a
 *                second), so /bin/bash stands in for the helper: given the
 *                helper's argument line, it runs the file `run` in its
 *                working directory, which speaks the §2.4 protocol with
 *                builtins and reports what it could reach.
 *   ambient      Inside a localmost job, seatbelt refuses a nested profile:
 *                the helper never runs, and the client reports a failed exit.
 */

import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildHelperProfile } from './helper-profile';
import { HelperClient, sandboxedHelperSpawn } from './helper-client';

// Each test spawns real processes under sandbox-exec, and these
// suites also run inside a job's sandbox on a loaded CI machine: jest's 5 s
// default is not a bound any test here means to assert.
jest.setTimeout(30_000);

const isMacOS = process.platform === 'darwin';

const canConstruct = (): boolean => {
  if (!isMacOS) return false;
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/**
 * The stand-in helper's protocol, in bash builtins only. It reports what it
 * was given and what it could read as log lines, speaks the events, and
 * stops when its stdin ends, as the helper does.
 */
const standIn = (vmDir: string, outsideFile: string) => `
echo "info env-begin"
compgen -e
echo "info env-end"
echo "info args $*"
if { read -r l || [ -n "$l" ]; } < '${outsideFile}' 2>/dev/null; then echo "info outside: read"; else echo "info outside: denied"; fi
printf '{"v":1,"event":"listening","dockerSocket":"%s","agentSocket":"%s"}\\n' '${vmDir}/docker.sock' '${vmDir}/agent.sock' >&3
printf '{"v":1,"event":"started","pid":%d,"rosetta":"off","startMs":1}\\n' $$ >&3
while read -r line; do :; done
printf '{"v":1,"event":"stopped","reason":"requested"}\\n' >&3
exit 0
`;

if (!isMacOS) {
  describe('the helper spawned through sandbox-exec', () => {
    it('has nothing to assert off macOS, where seatbelt does not exist', () => {
      expect(process.platform).not.toBe('darwin');
    });
  });
} else if (canConstruct()) {
  describe('the helper spawned through sandbox-exec, under a constructed profile', () => {
    let root: string;
    let data: string;
    let vmDir: string;
    let outsideFile: string;
    const vmId = '1-0123456789ab';
    const sandboxId = '1-abcdef012345';

    beforeAll(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-helper-spawn-')));
      data = path.join(root, 'data');
      vmDir = path.join(data, 'vm', 'jobs', vmId);
      fs.mkdirSync(vmDir, { recursive: true });
      fs.mkdirSync(path.join(data, 'runner', 'sandbox', sandboxId, '_work'), { recursive: true });
      fs.mkdirSync(path.join(root, 'resources', 'guest'), { recursive: true });
      outsideFile = path.join(root, 'outside');
      fs.writeFileSync(outsideFile, 'not the helper\'s\n');
      // bash is the one binary; its fd 3 is stdout, so the protocol lines
      // stay apart from what bash itself might print.
      fs.writeFileSync(path.join(vmDir, 'run'), `exec 3>&1 1>&2\n${standIn(vmDir, outsideFile)}`);
      fs.writeFileSync(
        path.join(vmDir, 'helper.sb'),
        buildHelperProfile({ mode: 'job', helper: '/bin/bash', resources: path.join(root, 'resources'), dataDir: data, vmId, sandboxId, proxyPort: 5000 })
      );
    });

    afterAll(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('runs the helper under the VM profile, with only PATH and TMPDIR, and it reaches nothing outside', async () => {
      const logs: string[] = [];
      const client = new HelperClient({
        helper: '/bin/bash',
        args: { vmId, mode: 'job', dataDir: data, resources: path.join(root, 'resources'), sandboxId, proxyPort: 5000, cpus: 1, memoryMiB: 1024, rosetta: 'off' },
        spawn: sandboxedHelperSpawn(path.join(vmDir, 'helper.sb'), vmDir),
        env: { PATH: '/usr/bin:/bin', TMPDIR: vmDir },
        expectSockets: { dockerSocket: path.join(vmDir, 'docker.sock'), agentSocket: path.join(vmDir, 'agent.sock') },
        log: (_level, message) => logs.push(message),
      });
      const started = new Promise<void>((resolve) => client.once('started', () => resolve()));
      client.start();
      await Promise.race([started, client.exited()]);
      expect(client.started()).toBeDefined();
      client.closeStdin();
      const exit = await client.exited();

      expect(exit).toMatchObject({ code: 0, stopped: { reason: 'requested' } });
      expect(logs).toContain('outside: denied');
      // Nothing of the app's environment - bash adds only its own.
      const env = logs.slice(logs.indexOf('env-begin') + 1, logs.indexOf('env-end'));
      expect(env).toEqual(expect.arrayContaining(['PATH', 'TMPDIR']));
      expect(env.filter((name) => !['PATH', 'TMPDIR', 'OLDPWD', 'PWD', 'SHLVL', '_'].includes(name))).toEqual([]);
      expect(logs.find((line) => line.startsWith('args '))).toBe(
        `args --vm-id ${vmId} --mode job --data-dir ${data} --resources ${path.join(root, 'resources')} ` +
          `--sandbox-id ${sandboxId} --proxy-port 5000 --cpus 1 --memory-mib 1024 --rosetta off`
      );
    });

    it('never runs a helper its profile does not name', async () => {
      const client = new HelperClient({
        helper: '/bin/zsh',
        args: { vmId, mode: 'job', dataDir: data, resources: path.join(root, 'resources'), sandboxId, proxyPort: 5000, cpus: 1, memoryMiB: 1024, rosetta: 'off' },
        spawn: sandboxedHelperSpawn(path.join(vmDir, 'helper.sb'), vmDir),
        env: { PATH: '/usr/bin:/bin', TMPDIR: vmDir },
        expectSockets: { dockerSocket: path.join(vmDir, 'docker.sock'), agentSocket: path.join(vmDir, 'agent.sock') },
        log: () => {},
      });
      client.start();
      const exit = await client.exited();
      expect(exit.code).not.toBe(0);
      expect(client.listening()).toBeUndefined();
    });
  });
} else {
  describe('the helper spawned through sandbox-exec, from inside a localmost job', () => {
    it('never runs, since seatbelt refuses a nested profile, and the client reports a failed exit', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-'));
      try {
        fs.writeFileSync(path.join(dir, 'helper.sb'), '(version 1)(allow default)');
        const client = new HelperClient({
          helper: '/usr/bin/true',
          args: { vmId: '1-0123456789ab', mode: 'job', dataDir: dir, resources: dir, sandboxId: '1-abcdef012345', proxyPort: 5000, cpus: 1, memoryMiB: 1024, rosetta: 'off' },
          spawn: sandboxedHelperSpawn(path.join(dir, 'helper.sb'), dir),
          env: { PATH: '/usr/bin:/bin', TMPDIR: dir },
          expectSockets: { dockerSocket: path.join(dir, 'docker.sock'), agentSocket: path.join(dir, 'agent.sock') },
          log: () => {},
        });
        client.start();
        const exit = await client.exited();
        expect(exit.code).not.toBe(0);
        expect(exit.errorCode).toBeDefined();
        expect(client.listening()).toBeUndefined();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
