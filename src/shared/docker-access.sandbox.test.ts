/**
 * Integration coverage for Docker access.
 *
 * The unit tests assert which rules a profile contains. They cannot show that
 * those rules let a process reach the daemon, or that their absence stops one -
 * which is the only thing this feature is for.
 *
 * There are two ways to establish that, and which applies depends on whether
 * this process is already inside a sandbox:
 *
 *   constructed  On an unsandboxed machine, build a profile and apply it with
 *                sandbox-exec. Tests both directions, including the negative
 *                case that makes the positive one mean anything.
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

import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateSandboxProfile } from './sandbox-profile';
import { parseLocalmostrcContent } from './localmostrc';
import { resolveDockerEndpoint, DockerAccessLevel } from './docker-access';

const isMacOS = process.platform === 'darwin';
const endpoint = isMacOS ? resolveDockerEndpoint() : null;

/** A raw HTTP request to the daemon over its unix socket. */
const ping = (socketPath: string): string =>
  `printf 'GET /_ping HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' | /usr/bin/nc -U '${socketPath}'`;

/**
 * Run a shell command, reporting whether it produced an HTTP response.
 *
 * Any status counts: Docker Desktop answers this raw request with a 500, and a
 * status line proves the connection was accepted. What the sandbox changes is
 * whether there is a reply at all.
 */
const reaches = (command: string): boolean => {
  try {
    const out = execFileSync('/bin/sh', ['-c', command], {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.includes('HTTP/');
  } catch {
    return false;
  }
};

/** The level this repository declares for itself, which the runner applies. */
const declaredLevel = (): DockerAccessLevel => {
  const rcPath = path.join(__dirname, '..', '..', '.localmostrc');
  const parsed = parseLocalmostrcContent(fs.readFileSync(rcPath, 'utf-8'));
  return parsed.config?.shared?.docker ?? 'off';
};

const profileFor = (level: DockerAccessLevel): string =>
  generateSandboxProfile({
    workDir: process.cwd(),
    proxyPort: 8080,
    homeDir: os.homedir(),
    dockerEndpoint: endpoint,
    policy: level === 'off' ? {} : { docker: level },
  });

/**
 * Whether a constructed profile can be applied from here.
 *
 * Probed with the profile the tests actually use, not a permissive stand-in:
 * `(allow default)` is the one profile that can never be applied inside a
 * sandbox, so probing with it answers the wrong question.
 */
const canConstruct = (): boolean => {
  if (!isMacOS || !endpoint) return false;

  const probePath = path.join(os.tmpdir(), `localmost-seatbelt-probe-${process.pid}.sb`);
  fs.writeFileSync(probePath, profileFor('socket'));

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
  describe('docker access through seatbelt', () => {
    it('has nothing to assert off macOS, where seatbelt does not exist', () => {
      expect(process.platform).not.toBe('darwin');
    });
  });
} else if (canConstruct()) {
  describe('docker access through a constructed seatbelt profile', () => {
    const socketPath = endpoint!.socketPath;

    const pingFromSandbox = (level: DockerAccessLevel): boolean => {
      const profilePath = path.join(os.tmpdir(), `localmost-docker-${process.pid}-${level}.sb`);
      fs.writeFileSync(profilePath, profileFor(level));

      try {
        return reaches(`/usr/bin/sandbox-exec -f '${profilePath}' /bin/sh -c "${ping(socketPath)}"`);
      } finally {
        fs.unlinkSync(profilePath);
      }
    };

    it('requires a running daemon', () => {
      // Not a skip: this repository declares docker: socket, so a reachable
      // daemon is part of its test setup.
      expect(reaches(ping(socketPath))).toBe(true);
    });

    it('reaches the daemon when the policy declares docker: socket', () => {
      expect(pingFromSandbox('socket')).toBe(true);
    });

    it('cannot reach the daemon when the policy declares nothing', () => {
      // The negative case is what makes the positive one meaningful: without
      // it, a profile that granted everything would pass just as well.
      expect(pingFromSandbox('off')).toBe(false);
    });

    it('reaches the daemon at every level above off', () => {
      for (const level of ['socket', 'contexts', 'credentials'] as const) {
        expect(pingFromSandbox(level)).toBe(true);
      }
    });
  });
} else {
  describe('docker access through the ambient seatbelt profile', () => {
    // Already inside a localmost job: the runner applied this repository's
    // approved policy to this very process.
    const level = declaredLevel();
    const configPath = path.join(os.homedir(), '.docker', 'config.json');

    it('reaches the daemon exactly when the declared level grants it', () => {
      const socketPath = endpoint?.socketPath ?? '/var/run/docker.sock';
      expect(reaches(ping(socketPath))).toBe(level !== 'off');
    });

    it('denies ~/.docker/config.json below the credentials level', () => {
      if (level === 'credentials') {
        expect(() => fs.readFileSync(configPath)).not.toThrow();
        return;
      }
      expect(() => fs.readFileSync(configPath)).toThrow();
    });

    it('denies a socket the policy did not grant', () => {
      // Proves the grant is specific rather than a blanket socket allow. The
      // workspace has its own allow, so this path is under the home directory.
      const strayPath = path.join(os.homedir(), `.localmost-stray-${process.pid}.sock`);
      expect(reaches(ping(strayPath))).toBe(false);
    });
  });
}
