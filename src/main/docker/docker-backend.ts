/**
 * The daemon behind the filtering docker socket.
 *
 * The filter decides whether a request is permitted; the backend is where a
 * permitted request goes. Keeping the two apart is what makes the isolation
 * progression a swap rather than a rewrite: stage 1 forwards to the operator's
 * own daemon, stage 2 to a dockerd inside a VM whose only mount is the job
 * workspace. See docs/superpowers/specs/2026-09-05-docker-isolation-design.md.
 */

import * as path from 'path';
import { resolveDockerEndpoint, DockerEndpoint } from '../../shared/docker-access';

export interface DockerBackend {
  /** Human name for logs. */
  readonly name: string;
  /** Whether `privileged` may be granted on this backend. Stage 1: false. */
  readonly supportsPrivileged: boolean;
  /** The daemon endpoint to forward approved requests to, or null when none. */
  resolveEndpoint(): DockerEndpoint | null;
  /** Absolute host path that job mounts must resolve inside (the job workspace). */
  workspaceMountRoot(sandboxDir: string): string;
}

export interface DesktopBackendOptions {
  /** Endpoint lookup, injected for testing. Defaults to resolveDockerEndpoint. */
  resolve?: () => DockerEndpoint | null;
  /** The sandbox subdir the runner checks out into. Defaults to the runner's `_work`. */
  workspaceSubdir?: string;
}

/**
 * The runner is configured with `--work _work`, so a job's checkout lives
 * under this subdir of its sandbox directory. Keep this aligned with the
 * workFolder in RunnerManager and buildSandbox.
 */
const RUNNER_WORK_FOLDER = '_work';

/**
 * Stage 1: the operator's existing daemon, found exactly as the app finds it
 * today. Nothing contains a container that escapes this daemon, which is why
 * privileged can never be granted here.
 */
export class DesktopBackend implements DockerBackend {
  readonly name = 'docker-desktop';
  readonly supportsPrivileged = false;

  constructor(private readonly opts: DesktopBackendOptions = {}) {}

  resolveEndpoint(): DockerEndpoint | null {
    return this.opts.resolve ? this.opts.resolve() : resolveDockerEndpoint();
  }

  workspaceMountRoot(sandboxDir: string): string {
    return path.join(sandboxDir, this.opts.workspaceSubdir ?? RUNNER_WORK_FOLDER);
  }
}
