/**
 * A backend for the e2e docker spec's Linux leg only (owner decision 3).
 *
 * The app has one backend, the per-job VM, and no VM runs on a Linux CI
 * runner. So that the filter keeps its real-CLI, real-daemon coverage there,
 * test/e2e/docker.spec.ts builds the filter off macOS over this: a worker
 * that forwards to the runner's native dockerd, and pulls through it rather
 * than on the Mac. It lives under test/, the spec is its only importer, and a
 * jest test (src/main/docker/docker-backend.test.ts) keeps every module
 * under src/ from importing it, so the app can never choose it.
 *
 * Nothing contains a container on this daemon, and nothing here attaches a
 * credential: a pull is anonymous, as the job's own would be.
 */

import * as fs from 'fs';
import * as http from 'http';
import {
  DockerBackend,
  DockerProgress,
  NO_DAEMON_MESSAGE,
  PullRequest,
  runnerWorkspaceRoot,
  WorkerDocker,
} from '../../../src/main/docker/docker-backend';

/** Where a Linux runner's dockerd listens. */
export const NATIVE_DAEMON_SOCKET = '/var/run/docker.sock';

/** The longest pull progress line read before the stream is refused. */
const MAX_PROGRESS_LINE_BYTES = 64 * 1024;

export class NativeDockerBackend implements DockerBackend {
  readonly name = 'native dockerd (e2e only)';
  readonly supportsPrivileged = false;
  /** One daemon for the whole runner, so a stopped socket removes what its job made. */
  readonly disposable = false;

  constructor(private readonly socketPath: string = NATIVE_DAEMON_SOCKET) {}

  workspaceMountRoot(sandboxDir: string, repository?: string): string {
    return runnerWorkspaceRoot(sandboxDir, repository);
  }

  /** Every request to the one daemon: there is no VM to boot, no binds to approve and no proxy to inject. */
  forWorker(): WorkerDocker {
    const socketPath = this.socketPath;
    const present = (): boolean => fs.existsSync(socketPath);
    return {
      bind: () => {},
      prewarm: () => {},
      dropSpare: () => {},
      endpoint: async () => (present() ? { kind: 'ready', socketPath } : { kind: 'none', reason: NO_DAEMON_MESSAGE }),
      running: present,
      baseline: () => ({
        status: 503,
        headers: { 'Content-Type': 'application/json' },
        body: { message: NO_DAEMON_MESSAGE },
      }),
      pull: (req, onProgress, signal) =>
        present() ? pullThroughDaemon(socketPath, req, onProgress, signal) : Promise.reject(new Error(NO_DAEMON_MESSAGE)),
      // The daemon pulled from the registry itself, so it records the
      // repo digest and finds the image by it.
      imageForDigest: () => undefined,
      approveBinds: async () => {},
      containerProxyEnv: () => ({}),
      release: async () => {},
    };
  }
}

/**
 * A pull the daemon makes itself: POST /images/create, whose progress lines
 * are handed on one by one as the daemon sends them. Rejects when the daemon
 * refuses the pull; a failure it reports inside the stream is a progress line
 * like any other, as the CLI reads it.
 */
function pullThroughDaemon(
  socketPath: string,
  req: PullRequest,
  onProgress: (p: DockerProgress) => void,
  signal: AbortSignal
): Promise<void> {
  const query = new URLSearchParams({ fromImage: `${req.registry}/${req.repositoryPath}` });
  if (req.digest) query.set('tag', req.digest);
  else if (req.tag) query.set('tag', req.tag);
  if (req.platform) query.set('platform', req.platform);
  return new Promise((resolve, reject) => {
    const upstream = http.request(
      { socketPath, method: 'POST', path: `/images/create?${query.toString()}`, agent: false, signal },
      (res) => {
        const status = res.statusCode ?? 502;
        let pending = '';
        let refused = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (status !== 200) {
            if (refused.length < MAX_PROGRESS_LINE_BYTES) refused += chunk;
            return;
          }
          pending += chunk;
          for (let nl = pending.indexOf('\n'); nl !== -1; nl = pending.indexOf('\n')) {
            const line = pending.slice(0, nl).trim();
            pending = pending.slice(nl + 1);
            if (line === '') continue;
            try {
              onProgress(JSON.parse(line) as DockerProgress);
            } catch {
              // A line the daemon did not send as JSON is not progress.
            }
          }
          if (pending.length > MAX_PROGRESS_LINE_BYTES) res.destroy(new Error('the daemon sent a progress line over 64 KiB'));
        });
        res.on('error', reject);
        res.on('end', () => {
          if (status === 200) {
            resolve();
            return;
          }
          let message = `the daemon answered ${status}`;
          try {
            const parsed = JSON.parse(refused) as { message?: unknown };
            if (typeof parsed.message === 'string') message = parsed.message;
          } catch {
            // Not JSON: the status is all there is to say.
          }
          reject(new Error(message));
        });
      }
    );
    upstream.on('error', reject);
    upstream.end();
  });
}
