/**
 * The helper's seatbelt profile: one per VM, written to its helper.sb before
 * the helper is spawned under it (contract §2.5).
 *
 * The helper runs VZ. Its profile grants the helper binary, the guest
 * artifacts, the VM's own directory (its disk, console, pid file and
 * sockets), and in job mode the one shared directory and the worker's proxy
 * port on loopback. VZ's service reaches the share only through a sandbox
 * extension the helper issues for the path it resolved at Start(), so the
 * file-issue-extension rule, scoped to the share's real path, is what makes a
 * share that became a link elsewhere fail with EPERM: the second layer of the
 * share rule. It is never broadened. A refresh VM has no share, so no
 * extension rule at all - neither that one nor virtiofs's own - and its one
 * disk is the repository's data.img.new.
 *
 * Every path is built here from ids, through vm/paths, and escaped as the job
 * profile escapes its paths. The caller passes <data> already realpathed.
 */

import * as path from 'path';
import { cacheFiles, sandboxFiles, vmIdSlot, vmJobFiles, REFRESH_SLOT } from './paths';

export interface HelperProfileOptions {
  mode: 'job' | 'refresh';
  /** helperPath(): the one binary the profile lets it exec. */
  helper: string;
  /** <resources>, whose guest/ the helper reads. */
  resources: string;
  /** <data>, realpathed by the caller. */
  dataDir: string;
  vmId: string;
  /** Job mode only: the worker's sandbox, whose _work is the share. */
  sandboxId?: string;
  /** Job mode only: the worker's ProxyServer port on 127.0.0.1. */
  proxyPort?: number;
  /** Refresh mode only: the repository whose data.img.new the VM writes. */
  repoKey?: string;
}

/** Backslash first, then the quote, so a path cannot close its DSL string. */
const escape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function requireAbsolute(value: string, what: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`the helper profile's ${what} must be an absolute path: ${JSON.stringify(value)}`);
  }
  return value;
}

export function buildHelperProfile(opts: HelperProfileOptions): string {
  const helper = requireAbsolute(opts.helper, 'helper');
  const resources = requireAbsolute(opts.resources, 'resources directory');
  const dataDir = requireAbsolute(opts.dataDir, 'data directory');
  const vmDir = vmJobFiles(dataDir, opts.vmId).dir;
  const slot = vmIdSlot(opts.vmId);
  const refresh = opts.mode === 'refresh';
  if (refresh !== (slot === REFRESH_SLOT)) {
    throw new Error(`VM ${opts.vmId} is in slot ${slot}, but a ${opts.mode} VM ${refresh ? 'is' : 'is never'} in slot ${REFRESH_SLOT}`);
  }

  const lines = [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    `(allow process-exec (literal "${escape(helper)}"))`,
    '(allow file-read*',
    `  (literal "${escape(helper)}")`,
    `  (subpath "${escape(path.join(resources, 'guest'))}"))`,
    ';; The VM\'s own directory: its disk, console, pid file and sockets.',
    `(allow file-read* file-write* (subpath "${escape(vmDir)}"))`,
  ];

  if (refresh) {
    if (opts.sandboxId !== undefined || opts.proxyPort !== undefined) {
      throw new Error('a refresh VM has no share and no proxy; those are for a job VM');
    }
    if (opts.repoKey === undefined) throw new Error('a refresh VM needs the repository key of the disk it refreshes');
    lines.push(
      ';; Its one disk, and no share, so no extension rule at all.',
      `(allow file-read* file-write* (literal "${escape(cacheFiles(dataDir, opts.repoKey).refresh)}"))`
    );
  } else {
    if (opts.repoKey !== undefined) throw new Error('only a refresh VM is given a repository key');
    if (opts.sandboxId === undefined) throw new Error('a job VM needs the sandbox whose work folder it shares');
    const port = opts.proxyPort;
    if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`a job VM needs its worker's proxy port, 1-65535: ${String(port)}`);
    }
    const share = escape(sandboxFiles(dataDir, opts.sandboxId).share);
    lines.push(
      `(allow file-read* file-write* (subpath "${share}"))`,
      ';; The second layer of the share rule. VZ\'s service reaches the share only',
      ';; through an extension the helper issues for the path it resolved at start.',
      ';; Scoped to the share and never broadened: a link planted at the share',
      ';; resolves outside it, so no extension is issued and start fails with EPERM.',
      '(allow file-issue-extension',
      '  (require-all',
      '    (extension-class "com.apple.app-sandbox.read-write" "com.apple.app-sandbox.read")',
      `    (subpath "${share}")))`,
      ';; The virtiofs device\'s own extension, for the share.',
      '(allow generic-issue-extension (extension-class "com.apple.virtualization.extension.fuse"))'
    );
  }

  if (!refresh) {
    lines.push(
      ';; The relay from the guest\'s 198.18.0.1:3128 to this worker\'s proxy.',
      `(allow network-outbound (remote ip "localhost:${opts.proxyPort}"))`
    );
  }
  lines.push(
    ';; The helper\'s own unix sockets, docker.sock and agent.sock.',
    `(allow network-bind network-inbound (subpath "${escape(vmDir)}"))`,
    ''
  );
  return lines.join('\n');
}
