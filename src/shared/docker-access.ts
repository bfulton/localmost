/**
 * Docker daemon access, declared per repository in .localmostrc.
 *
 * A job that can reach the daemon is not sandboxed: containers are not subject
 * to the seatbelt profile, so a bind mount reaches host paths the profile
 * denies. See docs/roadmap/docker-access.md.
 */

import * as fsNode from 'fs';
import * as os from 'os';

/** How much Docker surface a repository's policy opens. Cumulative. */
export type DockerAccessLevel = 'off' | 'socket' | 'contexts' | 'credentials';

/** In increasing order of access. */
export const DOCKER_ACCESS_LEVELS: readonly DockerAccessLevel[] = [
  'off',
  'socket',
  'contexts',
  'credentials',
];

export function isDockerAccessLevel(value: unknown): value is DockerAccessLevel {
  return typeof value === 'string' && (DOCKER_ACCESS_LEVELS as readonly string[]).includes(value);
}

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

/** What a level opens in a sandbox profile. */
export interface DockerGrants {
  /** Socket paths to allow network-outbound, file-read* and file-write* on. */
  socketLiterals: string[];
  /** Single files to allow file-read* on. */
  readLiterals: string[];
  /** Directories to allow file-read* on. */
  readSubpaths: string[];
  /** Environment to inject into the job. */
  env: Record<string, string>;
}

/** Rank a level so cumulative comparisons read as comparisons. */
const rank = (level: DockerAccessLevel): number => DOCKER_ACCESS_LEVELS.indexOf(level);

/**
 * What a declared level opens, given the resolved endpoint. Empty when the
 * level is off or absent, or when no daemon socket was found - the declaration
 * is a permission, not a requirement.
 */
export function dockerSandboxGrants(
  level: DockerAccessLevel | undefined,
  endpoint: DockerEndpoint | null,
  homeDir: string
): DockerGrants {
  if (!level || level === 'off' || !endpoint) {
    return { socketLiterals: [], readLiterals: [], readSubpaths: [], env: {} };
  }

  const grants: DockerGrants = {
    socketLiterals: [endpoint.socketPath],
    readLiterals: [],
    readSubpaths: [],
    // The job never has to discover the endpoint, which is what lets the rest
    // of ~/.docker stay closed at socket level.
    env: { DOCKER_HOST: `unix://${endpoint.socketPath}` },
  };

  if (rank(level) >= rank('contexts')) {
    grants.readSubpaths.push(`${homeDir}/.docker/contexts`);
  }
  if (rank(level) >= rank('credentials')) {
    grants.readLiterals.push(`${homeDir}/.docker/config.json`);
  }

  return grants;
}
