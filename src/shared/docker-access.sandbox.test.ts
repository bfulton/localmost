/**
 * Integration coverage for Docker access.
 *
 * The unit tests assert which rules the profile contains. They cannot show
 * that those rules let a process reach the daemon, or that its absence stops
 * one - which is the only thing this feature is for. This runs real seatbelt
 * against the real socket, both ways round.
 *
 * macOS only, and only when a daemon is reachable: seatbelt does not exist
 * elsewhere, and there is nothing to connect to without Docker running.
 */

import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateSandboxProfile } from './sandbox-profile';
import { resolveDockerEndpoint, DockerAccessLevel } from './docker-access';

const endpoint = process.platform === 'darwin' ? resolveDockerEndpoint() : null;

/** A raw HTTP request to the daemon over its unix socket. */
const PING = `printf 'GET /_ping HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' | /usr/bin/nc -U`;

/**
 * Whether a daemon is actually listening, not merely a socket file present.
 *
 * Any HTTP status counts: Docker Desktop answers this raw request with a 500,
 * and a status line is proof the connection was accepted and the daemon spoke.
 * What the sandbox changes is whether there is a reply at all.
 */
const daemonResponds = (): boolean => {
  if (!endpoint) return false;
  try {
    const out = execFileSync('/bin/sh', ['-c', `${PING} ${endpoint.socketPath}`], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return out.includes('HTTP/');
  } catch {
    return false;
  }
};

const runnable = Boolean(endpoint) && daemonResponds();

if (!runnable) {
  // Say why, so a silent skip is not mistaken for coverage.
  const reason =
    process.platform !== 'darwin'
      ? `platform is ${process.platform}, seatbelt is macOS only`
      : endpoint
        ? 'no daemon answered on the socket'
        : 'no Docker socket resolved';
  console.log(`[docker-access.sandbox] skipped: ${reason}`);
}

const describeIfRunnable = runnable ? describe : describe.skip;

describeIfRunnable('docker access through real seatbelt', () => {
  /** Ask the daemon for /_ping from inside a sandbox built for `level`. */
  const pingFromSandbox = (level: DockerAccessLevel): { ok: boolean; output: string } => {
    const socketPath = endpoint!.socketPath;
    const profile = generateSandboxProfile({
      workDir: process.cwd(),
      proxyPort: 8080,
      homeDir: os.homedir(),
      dockerEndpoint: endpoint,
      policy: level === 'off' ? {} : { docker: level },
    });

    const profilePath = path.join(os.tmpdir(), `localmost-docker-test-${process.pid}-${level}.sb`);
    fs.writeFileSync(profilePath, profile);

    try {
      const output: string = execFileSync(
        '/usr/bin/sandbox-exec',
        [
          '-f',
          profilePath,
          '/bin/sh',
          '-c',
          `${PING} ${socketPath}`,
        ],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }
      );
      return { ok: output.includes('HTTP/'), output };
    } catch (error) {
      const err = error as { stderr?: Buffer | string; status?: number };
      return { ok: false, output: String(err.stderr ?? '') };
    } finally {
      fs.unlinkSync(profilePath);
    }
  };

  it('reaches the daemon when the policy declares docker: socket', () => {
    const { ok, output } = pingFromSandbox('socket');

    expect(ok).toBe(true);
    expect(output).toContain('HTTP/');
  });

  it('cannot reach the daemon when the policy declares nothing', () => {
    // The negative case is what makes the positive one meaningful: without it,
    // a profile that granted everything would pass the test above.
    const { ok } = pingFromSandbox('off');

    expect(ok).toBe(false);
  });

  it('reaches the daemon at every level above off', () => {
    for (const level of ['socket', 'contexts', 'credentials'] as const) {
      expect(pingFromSandbox(level).ok).toBe(true);
    }
  });
});
