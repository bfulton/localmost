/**
 * Finding the operator's Docker daemon.
 *
 * This runs in the app, outside the sandbox. The job never sees the endpoint
 * found here: it talks to the filtering socket the app serves it, and the
 * desktop backend forwards what that socket permits to the daemon resolved
 * here. See docs/superpowers/specs/2026-09-05-docker-isolation-design.md.
 */

import * as fsNode from 'fs';
import * as os from 'os';

/** The daemon socket, as a resolved real path. */
export interface DockerEndpoint {
  socketPath: string;
}

/** The filesystem questions endpoint resolution asks, injected for testing. */
export interface DockerFsProbe {
  exists(p: string): boolean;
  realpath(p: string): string;
}

const nodeProbe: DockerFsProbe = {
  exists: p => fsNode.existsSync(p),
  realpath: p => fsNode.realpathSync(p),
};

/** Docker Desktop's per-user socket, which /var/run/docker.sock links to. */
const perUserSocket = (homeDir: string): string => `${homeDir}/.docker/run/docker.sock`;

const SYSTEM_SOCKET = '/var/run/docker.sock';

/**
 * Find the daemon socket, resolving symlinks. Returns null when no socket is
 * present - including the common case of a dangling /var/run/docker.sock left
 * behind by a stopped Docker Desktop.
 *
 * This runs in the app, outside the sandbox, so the job never has to discover
 * the endpoint itself.
 */
export function resolveDockerEndpoint(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fs?: DockerFsProbe;
}): DockerEndpoint | null {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const fs = options?.fs ?? nodeProbe;

  const candidates: string[] = [];

  const dockerHost = env.DOCKER_HOST;
  if (dockerHost && dockerHost.startsWith('unix://')) {
    candidates.push(dockerHost.slice('unix://'.length));
  }
  candidates.push(SYSTEM_SOCKET, perUserSocket(homeDir));

  for (const candidate of candidates) {
    if (!fs.exists(candidate)) continue;
    try {
      return { socketPath: fs.realpath(candidate) };
    } catch {
      // A dangling symlink: the path exists, its target does not.
      continue;
    }
  }

  return null;
}
