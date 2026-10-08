/**
 * The provisioning VM's address from its DHCP lease, and the one-time setup
 * over SSH against a scripted ssh: what reaches the guest, and how.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { frame } from '../../vm/ndjson';
import { leaseFor, normalizeMac, isPrivateIPv4, parseLeases } from './dhcp-leases';
import { classifyReachStderr, readablePassword, runBootstrap, sshArgs, sshEnv, SshRunner } from './bootstrap';
import { shortTempDir } from '../../test-utils/vm-fixtures';

const LEASES = `{
\tname=localmost-admins-Virtual-Machine
\tip_address=192.168.64.5
\thw_address=1,2:11:22:33:44:55
\tidentifier=1,2:11:22:33:44:55
\tlease=0x7000000a
}
{
\tip_address=192.168.64.9
\thw_address=1,2:11:22:33:44:55
\tidentifier=1,2:11:22:33:44:55
\tlease=0x70000001
}
{
\tip_address=8.8.8.8
\thw_address=1,2:11:22:33:44:66
\tlease=0x7fffffff
}
{
\tip_address=192.168.64.4
\thw_address=1,5a:94:ef:0:0:11
\tlease=0x6abd1397
}`;

describe('the provisioning VM lease', () => {
  it("reads bootpd's leases, octets without their leading zero", () => {
    expect(normalizeMac('5a:94:ef:0:0:11')).toBe('5a:94:ef:00:00:11');
    expect(normalizeMac('5a:94:ef:0:0')).toBeNull();
    expect(parseLeases(LEASES).map((l) => l.ip)).toEqual(['192.168.64.5', '192.168.64.9', '192.168.64.4']);
  });

  it('finds the newest live lease for the image MAC, and only a private address', () => {
    expect(leaseFor(LEASES, '02:11:22:33:44:55', 0x70000000)).toBe('192.168.64.5');
    expect(leaseFor(LEASES, '02:11:22:33:44:55', 0x7000000b)).toBeNull();
    expect(leaseFor(LEASES, '02:11:22:33:44:66', 0)).toBeNull();
    expect(isPrivateIPv4('192.168.64.5')).toBe(true);
    for (const bad of ['8.8.8.8', '192.168.64.255', '192.168.64.0', '192.168.64', '1.2.3.4.5', '300.1.1.1']) expect(isPrivateIPv4(bad)).toBe(false);
  });
});

describe('the setup over SSH', () => {
  let dir: string;
  let agent: string;
  let runner: string;
  const account = { username: 'localmost-admin', fullName: 'localmost setup', password: 'abcd-efgh-jkmn-pqrs-tuvw' };
  const inputs = { jobPassword: 'j'.repeat(32), discardedAdminPassword: 'd'.repeat(32), runnerVersion: '2.330.0', osVersion: '26.6.2', osBuild: '25G83' };

  beforeEach(() => {
    dir = shortTempDir();
    fs.chmodSync(dir, 0o700);
    agent = path.join(dir, 'agent-binary');
    runner = path.join(dir, 'runner.tar.gz');
    fs.writeFileSync(agent, 'agent bytes');
    fs.writeFileSync(runner, 'runner bytes');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** An ssh that answers as a guest would: refused until `upAfter` tries, then each command as scripted. */
  const fakeSsh = (opts: { upAfter?: number; setup?: string[] } = {}) => {
    const calls: Array<{ command: string; env: Record<string, string>; input: string | null; askpassSays: string }> = [];
    let tries = 0;
    const ssh: SshRunner = async (args, env, input, onLine) => {
      const command = args[args.length - 1];
      // What the askpass prints, as ssh would run it for the password.
      const askpassSays = fs.existsSync(env.SSH_ASKPASS) ? fs.readFileSync(fs.readFileSync(env.SSH_ASKPASS, 'utf8').match(/'(.*)'/)![1], 'utf8') : '';
      calls.push({ command, env, input: input ? input.toString('utf8') : null, askpassSays });
      if (command === '/usr/bin/true') return { code: ++tries > (opts.upAfter ?? 0) ? 0 : 255, stderr: 'Connection refused' };
      if (command.includes(' setup')) {
        for (const line of opts.setup ?? [frame({ event: 'step', index: 1, of: 2, what: 'create the job user runner' }), frame({ event: 'done' })]) {
          onLine(line.trimEnd());
        }
      }
      return { code: 0, stderr: '' };
    };
    return { ssh, calls };
  };

  it('reads no ssh configuration, key or agent of the user, and keeps the host key in the bootstrap directory', () => {
    const args = sshArgs(dir, 'localmost-admin', '192.168.64.5', '/usr/bin/true');
    expect(args.slice(0, 2)).toEqual(['-F', '/dev/null']);
    for (const option of ['PubkeyAuthentication=no', 'IdentityAgent=none', 'StrictHostKeyChecking=accept-new', `UserKnownHostsFile=${dir}/known_hosts`, 'GlobalKnownHostsFile=/dev/null', 'ForwardAgent=no']) {
      expect(args).toContain(option);
    }
    expect(args.slice(-4)).toEqual(['-l', 'localmost-admin', '192.168.64.5', '/usr/bin/true']);
    expect(sshEnv(dir)).toEqual({ PATH: '/usr/bin:/bin', HOME: dir, SSH_ASKPASS: `${dir}/askpass`, SSH_ASKPASS_REQUIRE: 'force' });
    expect(() => sshArgs(dir, 'Admin; rm', '192.168.64.5', 'x')).toThrow();
    expect(() => sshArgs(dir, 'admin', '8.8.8.8', 'x')).toThrow();
  });

  it('waits for Remote Login, copies the agent and runner, and runs the setup with the password on stdin only', async () => {
    const { ssh, calls } = fakeSsh({ upAfter: 2 });
    const steps: string[] = [];
    await runBootstrap({
      ip: '192.168.64.5', account, dir, agentBinary: agent, runnerTarball: runner, inputs, ssh, retryMs: 1,
      onStep: (i, of, what) => steps.push(`${i}/${of} ${what}`), log: () => {},
    });
    expect(calls.map((c) => c.command)).toEqual([
      '/usr/bin/true',
      '/usr/bin/true',
      '/usr/bin/true',
      '/bin/mkdir -p -m 700 localmost-setup && /bin/cat > localmost-setup/localmost-macvm-agent && /bin/chmod 755 localmost-setup/localmost-macvm-agent',
      '/bin/mkdir -p -m 700 localmost-setup && /bin/cat > localmost-setup/runner.tar.gz && /bin/chmod 644 localmost-setup/runner.tar.gz',
      "/usr/bin/sudo -S -p '' /Users/localmost-admin/localmost-setup/localmost-macvm-agent setup",
    ]);
    expect(calls[3].input).toBe('agent bytes');
    expect(calls[4].input).toBe('runner bytes');
    // ssh gets the password from the askpass, and only from there.
    expect(calls.every((c) => c.askpassSays === `${account.password}\n`)).toBe(true);
    expect(calls.every((c) => !c.command.includes(account.password))).toBe(true);
    const [sudoPassword, json] = calls[5].input!.split('\n');
    expect(sudoPassword).toBe(account.password);
    expect(JSON.parse(json)).toEqual({
      adminUser: 'localmost-admin', adminPassword: account.password, jobPassword: inputs.jobPassword,
      discardedAdminPassword: inputs.discardedAdminPassword, runnerVersion: '2.330.0',
      runnerTarball: '/Users/localmost-admin/localmost-setup/runner.tar.gz',
      agentBinary: '/Users/localmost-admin/localmost-setup/localmost-macvm-agent', osVersion: '26.6.2', osBuild: '25G83',
    });
    expect(steps).toEqual(['1/2 create the job user runner']);
    // The password file and the askpass are gone.
    expect(fs.readdirSync(dir).sort()).toEqual(['agent-binary', 'runner.tar.gz']);
  });

  it('fails with the step that failed, or when the setup ends without saying it is done, and still removes the password', async () => {
    const failed = fakeSsh({ setup: [frame({ event: 'step', index: 3, of: 9, what: 'x' }), frame({ event: 'failed', index: 3, message: 'sysadminctl exited 1' })] });
    await expect(runBootstrap({ ip: '192.168.64.5', account, dir, agentBinary: agent, runnerTarball: runner, inputs, ssh: failed.ssh, log: () => {} })).rejects.toThrow(
      /sysadminctl exited 1/
    );
    const silent = fakeSsh({ setup: [] });
    await expect(runBootstrap({ ip: '192.168.64.5', account, dir, agentBinary: agent, runnerTarball: runner, inputs, ssh: silent.ssh, log: () => {} })).rejects.toThrow(
      /without finishing/
    );
    expect(fs.existsSync(path.join(dir, 'password'))).toBe(false);
  });

  it('refuses a bootstrap directory others can reach', async () => {
    fs.chmodSync(dir, 0o755);
    await expect(runBootstrap({ ip: '192.168.64.5', account, dir, agentBinary: agent, runnerTarball: runner, inputs, ssh: fakeSsh().ssh, log: () => {} })).rejects.toThrow(
      /only its owner/
    );
  });

  it('classifies what a probe saw by its ssh stderr', () => {
    expect(classifyReachStderr('ssh: connect to host 192.168.64.9 port 22: No route to host')).toMatch(/no route/);
    expect(classifyReachStderr('ssh: connect to host 192.168.64.9 port 22: Connection refused')).toMatch(/TCP refused/);
    expect(classifyReachStderr('ssh: connect to host 192.168.64.9 port 22: Operation timed out')).toMatch(/timed out/);
    expect(classifyReachStderr('localmost-admin@192.168.64.9: Permission denied (keyboard-interactive).')).toMatch(/auth refused/);
    expect(classifyReachStderr('something else')).toBe('not answering');
  });

  it('reports each wait with the seconds elapsed and what the probe saw, and logs when it changes', async () => {
    let clock = 0;
    const waits: Array<[number, string]> = [];
    const logs: string[] = [];
    let tries = 0;
    const ssh: SshRunner = async (args, _env, _input, onLine) => {
      const command = args[args.length - 1];
      if (command === '/usr/bin/true') {
        tries += 1;
        if (tries > 3) return { code: 0, stderr: '' };
        const stderr = tries <= 2 ? 'ssh: connect to host x port 22: No route to host' : 'ssh: connect to host x port 22: Connection refused';
        return { code: 255, stderr };
      }
      if (command.includes(' setup')) for (const l of [frame({ event: 'step', index: 1, of: 1, what: 'x' }), frame({ event: 'done' })]) onLine(l.trimEnd());
      return { code: 0, stderr: '' };
    };
    await runBootstrap({
      ip: '192.168.64.5', account, dir, agentBinary: agent, runnerTarball: runner, inputs, ssh, retryMs: 1,
      now: () => (clock += 1000), onWaiting: (s, p) => waits.push([s, p]), log: (_l, m) => logs.push(m),
    });
    // Two no-route probes then one refused, so three waits, the class changing once.
    expect(waits.map((w) => w[1])).toEqual([expect.stringMatching(/no route/), expect.stringMatching(/no route/), expect.stringMatching(/TCP refused/)]);
    expect(waits.every(([sec]) => sec > 0)).toBe(true);
    expect(logs.filter((m) => /no route/.test(m))).toHaveLength(1);
    expect(logs.filter((m) => /TCP refused/.test(m))).toHaveLength(1);
    expect(logs.some((m) => /answered on 192\.168\.64\.5 after \d+ s/.test(m))).toBe(true);
  });

  it('follows the guest to a new address when its lease changes', async () => {
    const seenIps: string[] = [];
    let n = 0;
    const ssh: SshRunner = async (args, _env, _input, onLine) => {
      const command = args[args.length - 1];
      const ipArg = args[args.length - 2];
      if (command === '/usr/bin/true') {
        seenIps.push(ipArg);
        return ipArg === '192.168.64.9' ? { code: 0, stderr: '' } : { code: 255, stderr: 'No route to host' };
      }
      if (command.includes(' setup')) for (const l of [frame({ event: 'step', index: 1, of: 1, what: 'x' }), frame({ event: 'done' })]) onLine(l.trimEnd());
      return { code: 0, stderr: '' };
    };
    const logs: string[] = [];
    await runBootstrap({
      ip: '192.168.64.5', account, dir, agentBinary: agent, runnerTarball: runner, inputs, ssh, retryMs: 1,
      resolveIp: () => (++n >= 3 ? '192.168.64.9' : '192.168.64.5'), log: (_l, m) => logs.push(m),
    });
    expect(seenIps).toContain('192.168.64.9');
    expect(logs.some((m) => /address changed from 192\.168\.64\.5 to 192\.168\.64\.9/.test(m))).toBe(true);
  });

  it('gives up after the timeout, saying how long it waited', async () => {
    let clock = 0;
    const ssh: SshRunner = async () => ({ code: 255, stderr: 'No route to host' });
    await expect(
      runBootstrap({
        ip: '192.168.64.5', account, dir, agentBinary: agent, runnerTarball: runner, inputs, ssh, retryMs: 1,
        reachableTimeoutMs: 0, now: () => (clock += 60_000), log: () => {},
      })
    ).rejects.toThrow(/did not answer within \d+ min/);
  });

  it('makes readable passwords the guest accepts', () => {
    const crypto = require('crypto') as typeof import('crypto');
    const p = readablePassword((n) => crypto.randomBytes(n));
    expect(p).toMatch(/^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){4}$/);
    expect(p.length).toBeGreaterThanOrEqual(16);
  });
});
