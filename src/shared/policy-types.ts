/**
 * The rules a .localmostrc section declares, as the parser hands them on:
 * which hosts the job's proxy allows and denies, the filesystem grants
 * (waiting for VM shares), the environment the job is given, and the
 * container work the filtering socket permits. Types only; see
 * localmostrc.ts for the grammar.
 */

import type { DockerPolicy } from './docker-policy';

export interface NetworkPolicy {
  allow?: string[];
  deny?: string[];
}

export interface FilesystemPolicy {
  read?: string[];
  write?: string[];
  deny?: string[];
}

export interface EnvPolicy {
  allow?: string[];
  deny?: string[];
}

export interface PolicyRules {
  network?: NetworkPolicy;
  filesystem?: FilesystemPolicy;
  env?: EnvPolicy;
  /** Container work, checked per request by the filtering socket - see docker-policy.ts. */
  docker?: DockerPolicy;
}
