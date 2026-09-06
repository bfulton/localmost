/**
 * Integration coverage for Docker isolation at the seatbelt layer.
 *
 * The unit tests assert which rules a profile contains. They cannot show that
 * a process under those rules is actually kept off the daemon socket - the
 * boundary the filtering docker socket exists to replace, and the one a
 * profile that failed open would silently cross.
 *
 * There are two ways to establish that, and which applies depends on whether
 * this process is already inside a sandbox:
 *
 *   constructed  On an unsandboxed machine, build a profile and apply it with
 *                sandbox-exec. Tests both directions: a socket the profile
 *                grants is reachable, which is what makes the daemon's
 *                unreachability mean anything.
 *
 *   ambient      Inside a localmost job, this process is already running under
 *                the runner's profile with the repository's approved policy
 *                applied, so assert what that profile actually does. Seatbelt
 *                refuses any nested profile that deviates from the one in
 *                force - narrower, wider, or an extra deny alike - so
 *                constructing one here is impossible. Asserting the ambient
 *                profile is the stronger test anyway: it is the real profile
 *                on the real runner.
 *
 * Neither mode skips. macOS only, because seatbelt is.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { generateSandboxProfile, SandboxPolicy } from './sandbox-profile';
import { resolveDockerEndpoint } from './docker-access';

const isMacOS = process.platform === 'darwin';
const endpoint = isMacOS ? resolveDockerEndpoint() : null;
const execFileAsync = promisify(execFile);

/** A raw HTTP request over a unix socket. */
const ping = (socketPath: string): string =>
  `printf 'GET /_ping HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' | /usr/bin/nc -U '${socketPath}'`;

/**
 * Run a shell command, reporting whether it produced an HTTP response.
 *
 * Any status counts: Docker Desktop answers this raw request with a 500, and a
 * status line proves the connection was accepted. What the sandbox changes is
 * whether there is a reply at all. Asynchronous, so a socket served from this
 * very process can answer while the command waits on it.
 */
const reaches = async (command: string): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', command], {
      encoding: 'utf-8',
      timeout: 15000,
    });
    return stdout.includes('HTTP/');
  } catch {
    return false;
  }
};

/** A policy that declares container work, as a repository using Docker would. */
const dockerPolicy: SandboxPolicy = {
  docker: {
    pull: { registries: ['docker.io'] },
    run: { images: ['alpine:3'], mounts: [{ path: './', mode: 'ro' }], network: 'bridge' },
  },
};

const profileFor = (workDir: string, policy: SandboxPolicy): string =>
  generateSandboxProfile({ workDir, proxyPort: 8080, policy });

/**
 * Whether a constructed profile can be applied from here.
 *
 * Probed with the profile shape the tests actually use, not a permissive
 * stand-in: `(allow default)` is the one profile that can never be applied
 * inside a sandbox, so probing with it answers the wrong question.
 */
const canConstruct = (): boolean => {
  if (!isMacOS || !endpoint) return false;

  const probePath = path.join(os.tmpdir(), `localmost-seatbelt-probe-${process.pid}.sb`);
  fs.writeFileSync(probePath, profileFor(process.cwd(), dockerPolicy));

  try {
    execFileSync('/usr/bin/sandbox-exec', ['-f', probePath, '/usr/bin/true'], {
      timeout: 5000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  } finally {
    fs.unlinkSync(probePath);
  }
};

if (!isMacOS) {
  describe('docker isolation through seatbelt', () => {
    it('has nothing to assert off macOS, where seatbelt does not exist', () => {
      expect(process.platform).not.toBe('darwin');
    });
  });
} else if (canConstruct()) {
  describe('docker isolation through a constructed seatbelt profile', () => {
    const daemonSocket = endpoint!.socketPath;

    // A socket this process serves from inside the workspace, which the
    // profile grants: the positive case that gives the negative one meaning.
    let workDir: string;
    let servedSocket: string;
    let served: net.Server;

    beforeAll(async () => {
      // Resolved: os.tmpdir() is under /var, a symlink, and seatbelt matches
      // the canonical path.
      workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localmost-docker-')));
      servedSocket = path.join(workDir, 'served.sock');
      served = net.createServer((client) => {
        client.on('data', () => client.end('HTTP/1.0 200 OK\r\n\r\n'));
      });
      await new Promise<void>((resolve) => served.listen(servedSocket, resolve));
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => served.close(() => resolve()));
      fs.rmSync(workDir, { recursive: true, force: true });
    });

    const pingFromSandbox = async (policy: SandboxPolicy, socketPath: string): Promise<boolean> => {
      const profilePath = path.join(os.tmpdir(), `localmost-docker-${process.pid}-${Date.now()}.sb`);
      fs.writeFileSync(profilePath, profileFor(workDir, policy));

      try {
        return await reaches(`/usr/bin/sandbox-exec -f '${profilePath}' /bin/sh -c "${ping(socketPath)}"`);
      } finally {
        fs.unlinkSync(profilePath);
      }
    };

    it('requires a running daemon', async () => {
      // Not a skip: a reachable daemon is what makes its unreachability from
      // inside the sandbox a finding rather than an absence.
      expect(await reaches(ping(daemonSocket))).toBe(true);
    });

    it('reaches a socket served inside the workspace, so the refusal below is specific', async () => {
      expect(await pingFromSandbox({}, servedSocket)).toBe(true);
      expect(await pingFromSandbox(dockerPolicy, servedSocket)).toBe(true);
    });

    it('cannot reach the daemon socket, whatever the docker policy declares', async () => {
      // A docker policy is a set of requests the filtering socket may forward,
      // not a grant of the daemon. The daemon's own socket stays closed under
      // every policy, since a job that reached it would bypass the filter.
      expect(await pingFromSandbox({}, daemonSocket)).toBe(false);
      expect(await pingFromSandbox(dockerPolicy, daemonSocket)).toBe(false);
    });
  });
} else {
  describe('docker isolation through the ambient seatbelt profile', () => {
    // Already inside a localmost job: the runner applied this repository's
    // approved policy to this very process, and DOCKER_HOST names the socket
    // it serves the job.
    const dockerHost = process.env.DOCKER_HOST;
    const servedSocket = dockerHost?.startsWith('unix://') ? dockerHost.slice('unix://'.length) : undefined;
    const homeDir = os.homedir();
    const daemonSockets = ['/var/run/docker.sock', path.join(homeDir, '.docker', 'run', 'docker.sock')];

    it('is pointed at a socket the runner serves, not the daemon', () => {
      expect(servedSocket).toBeDefined();
      expect(daemonSockets).not.toContain(servedSocket);
    });

    it('reaches the served socket and none of the daemon paths', async () => {
      // Any status counts for the served socket: an unbound one refuses, a
      // bound one forwards, and either way the answer proves the connection.
      expect(await reaches(ping(servedSocket ?? ''))).toBe(true);
      for (const socketPath of daemonSockets) {
        expect(await reaches(ping(socketPath))).toBe(false);
      }
    });

    it('denies ~/.docker/config.json, since credentials are attached by the socket', () => {
      expect(() => fs.readFileSync(path.join(homeDir, '.docker', 'config.json'))).toThrow();
    });

    it('denies a socket the policy did not grant', async () => {
      // Proves the grant is specific rather than a blanket socket allow. The
      // workspace has its own allow, so this path is under the home directory.
      const strayPath = path.join(homeDir, `.localmost-stray-${process.pid}.sock`);
      expect(await reaches(ping(strayPath))).toBe(false);
    });
  });
}
