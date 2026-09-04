/**
 * Docker daemon access, declared per repository in .localmostrc.
 *
 * A job that can reach the daemon is not sandboxed: containers are not subject
 * to the seatbelt profile, so a bind mount reaches host paths the profile
 * denies. See docs/roadmap/docker-access.md.
 */

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
