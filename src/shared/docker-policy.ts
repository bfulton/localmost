/**
 * The docker policy grammar, declared per repository in .localmostrc.
 *
 * Actions are CLI-shaped (`pull`, `run`, `build`) because that is how a
 * workflow author thinks and how an approval diff reads. Each action carries
 * the conditions the filtering socket checks against the request. Anything a
 * policy does not name is denied. See
 * docs/superpowers/specs/2026-09-05-docker-isolation-design.md.
 *
 * Pure and shared between the main process and the CLI.
 */

export type MountMode = 'ro' | 'rw';

/** A workspace path the container may bind, and whether it may write to it. */
export interface DockerMount {
  path: string;
  mode: MountMode;
}

/** Container create, start, attach, wait and remove. */
export interface DockerRunPolicy {
  images?: string[];
  mounts?: DockerMount[];
  network?: string;
}

/** Image pulls, gated by the registry the image comes from. */
export interface DockerPullPolicy {
  registries: string[];
}

/** Image builds, gated by where the build context resolves. */
export interface DockerBuildPolicy {
  context?: string;
}

export interface DockerPolicy {
  pull?: DockerPullPolicy;
  run?: DockerRunPolicy;
  build?: DockerBuildPolicy;
  /** Grammar-present but rejected at approval unless the backend is a managed VM. */
  privileged?: boolean;
}

/** True when the policy grants nothing (used to keep `off` == `{}`/absent). */
export const isEmptyDockerPolicy = (p?: DockerPolicy): boolean =>
  !p || (!p.pull && !p.run && !p.build && !p.privileged);
