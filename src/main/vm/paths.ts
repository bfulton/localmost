/**
 * The VM backend's identifiers and host paths (contract §1).
 *
 * Every path the VM backend uses is built here, and only from ids checked
 * against their form first. Registry digests, guest answers and anything a
 * job controls reach Electron main, which runs with the user's full rights; a
 * digest like `sha256:../../..` turned into a store path would be a traversal
 * read and delete. So a malformed id throws here rather than becoming a path,
 * and blob paths are built by one function that re-checks what it joins.
 *
 * The data paths take `<data>` as an argument rather than reading
 * getAppDataDir() themselves: the helper profile interpolates real paths, so
 * the caller realpaths `<data>` once and passes that everywhere.
 *
 * See docs/roadmap/vm-docker-backend-contract.md.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import { app } from 'electron';

/**
 * A worker's sandbox directory name, as buildSandbox makes it: `<slot>-<12 hex>`.
 * The slot is written as a number is, with no leading zero.
 */
export const SANDBOX_ID_RE = /^(?:0|[1-9][0-9]?)-[0-9a-f]{12}$/;

/**
 * One VM, never reused: `<slot>-<12 hex>`, slot 0 for a refresh VM. No
 * leading zero, so nothing but `0-` reads as the refresh slot.
 */
export const VM_ID_RE = /^(?:0|[1-9][0-9]?)-[0-9a-f]{12}$/;

/** The only digest form accepted from a registry, the VM or refs.json. */
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** The per-repository store and cache key: see repoKeyOf. */
export const REPO_KEY_RE = /^[0-9a-f]{16}$/;

const HEX64_RE = /^[0-9a-f]{64}$/;

/** A refresh VM has no worker; job slots are 1-99. */
export const REFRESH_SLOT = 0;
const MAX_SLOT = 99;

/** The share: the runner's work folder, the one directory a VM sees. */
export const SHARE_DIR_NAME = '_work';

/** The share's tripwire nonce, inside the share, which the job can neither read nor write. */
export const SHARE_NONCE_FILE = '.localmost-share';

/** The helper's file name, in Resources when packaged and in build/ otherwise. */
export const HELPER_NAME = 'localmost-vm';

/**
 * Replaces helperPath() in a development or test run, so that the fake
 * helper can stand in. A packaged app ignores it: it is checked against
 * app.isPackaged, not NODE_ENV, which a packaged app's environment can set.
 */
export const HELPER_OVERRIDE_ENV = 'LOCALMOST_VM_HELPER';

/**
 * The per-repository key: the first 16 hex of the SHA-256 of the lower-cased
 * `owner/name`. GitHub names are case-insensitive, so one repository has one
 * store however a workflow spells it.
 */
export function repoKeyOf(repository: string): string {
  return crypto.createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * The 64-hex part of a valid `sha256:` digest, or null for anything else
 * (another algorithm, the wrong length, upper case, or not a string at all).
 */
export function digestHex(digest: string): string | null {
  return typeof digest === 'string' && DIGEST_RE.test(digest) ? digest.slice('sha256:'.length) : null;
}

/** A fresh VM id for a slot: 1-99 for a job, REFRESH_SLOT for a refresh. */
export function newVmId(slot: number): string {
  if (!Number.isInteger(slot) || slot < REFRESH_SLOT || slot > MAX_SLOT) {
    throw new Error(`VM slot ${slot} is not an integer from ${REFRESH_SLOT} to ${MAX_SLOT}`);
  }
  return `${slot}-${crypto.randomBytes(6).toString('hex')}`;
}

/** The slot a VM id was made for, or null when it is not a VM id. */
export function vmIdSlot(vmId: string): number | null {
  return VM_ID_RE.test(vmId) ? Number(vmId.slice(0, vmId.indexOf('-'))) : null;
}

function requireAbsolute(dir: string, what: string): string {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw new Error(`${what} must be an absolute path: ${JSON.stringify(dir)}`);
  }
  return dir;
}

function requireForm(value: string, form: RegExp, what: string): string {
  if (typeof value !== 'string' || !form.test(value)) {
    throw new Error(`not a ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Where a blob lives in a store: `<storeRoot>/blobs/sha256/<hex>`. The one
 * way a blob path is built. It re-checks the hex, whatever the caller already
 * checked, and then places it with placeBlob.
 *
 * The store root is `<data>/vm/images/<repoKey>` for public images and the
 * VM's own directory for images that needed credentials (contract §6.3).
 */
export function blobPath(storeRoot: string, hex: string): string {
  if (typeof hex !== 'string' || !HEX64_RE.test(hex)) {
    throw new Error(`not the hex of a sha256 digest: ${JSON.stringify(hex)}`);
  }
  return placeBlob(storeRoot, hex);
}

/**
 * blobPath's second layer: the name must land as a direct child of
 * `<storeRoot>/blobs/sha256`, under exactly its own name. "Somewhere under the
 * root" is not enough, because a per-job store's root is the VM's directory,
 * which also holds helper.sb and data.img. Exported so a test can show that
 * this layer holds without the hex check; build blob paths with blobPath.
 */
export function placeBlob(storeRoot: string, hex: string): string {
  const blobs = path.join(path.resolve(requireAbsolute(storeRoot, 'a blob store root')), 'blobs', 'sha256');
  const blob = path.join(blobs, hex);
  if (path.dirname(blob) !== blobs || path.basename(blob) !== hex) {
    throw new Error(`blob path ${blob} is outside its store ${blobs}`);
  }
  return blob;
}

/** `<data>/vm`: mode 0700, excluded from Time Machine when made. */
export function vmDir(dataDir: string): string {
  return path.join(requireAbsolute(dataDir, 'the data directory'), 'vm');
}

/** The files of one VM's own directory, `<data>/vm/jobs/<vmId>` (mode 0700, made by VmManager). */
export interface VmJobFiles {
  dir: string;
  /** The helper's seatbelt profile. */
  profile: string;
  /** The VM's data disk, a clone of the golden disk or a new sparse file. */
  dataDisk: string;
  pidFile: string;
  consoleLog: string;
  /** Unfiltered dockerd, relayed by the helper. Only the filter connects to it. */
  dockerSocket: string;
  agentSocket: string;
  /** The blob store root for images that needed credentials: this job only, deleted with the VM. */
  blobStore: string;
}

export function vmJobFiles(dataDir: string, vmId: string): VmJobFiles {
  const dir = path.join(vmDir(dataDir), 'jobs', requireForm(vmId, VM_ID_RE, 'vm id'));
  return {
    dir,
    profile: path.join(dir, 'helper.sb'),
    dataDisk: path.join(dir, 'data.img'),
    pidFile: path.join(dir, 'helper.pid'),
    consoleLog: path.join(dir, 'console.log'),
    dockerSocket: path.join(dir, 'docker.sock'),
    agentSocket: path.join(dir, 'agent.sock'),
    blobStore: dir,
  };
}

/** A repository's public image store, `<data>/vm/images/<repoKey>`: the root for blobPath. */
export function imageStoreDir(dataDir: string, repoKey: string): string {
  return path.join(vmDir(dataDir), 'images', requireForm(repoKey, REPO_KEY_RE, 'repository key'));
}

/** The store's references: `<registry>/<path>:<tag>` and `@<digest>` to what was pulled. */
export function refsJsonPath(dataDir: string, repoKey: string): string {
  return path.join(imageStoreDir(dataDir, repoKey), 'refs.json');
}

/** A repository's cache disks, `<data>/vm/cache/<repoKey>`. */
export interface CacheFiles {
  dir: string;
  /** The golden data disk each job VM clones. */
  golden: string;
  /** A refresh in progress, swept at startup. */
  refresh: string;
  meta: string;
}

export function cacheFiles(dataDir: string, repoKey: string): CacheFiles {
  const dir = path.join(vmDir(dataDir), 'cache', requireForm(repoKey, REPO_KEY_RE, 'repository key'));
  return {
    dir,
    golden: path.join(dir, 'data.img'),
    refresh: path.join(dir, 'data.img.new'),
    meta: path.join(dir, 'meta.json'),
  };
}

/** A worker's sandbox, `<data>/runner/sandbox/<sandboxId>`, as buildSandbox makes it. */
export function sandboxDirOf(dataDir: string, sandboxId: string): string {
  return path.join(
    requireAbsolute(dataDir, 'the data directory'),
    'runner',
    'sandbox',
    requireForm(sandboxId, SANDBOX_ID_RE, 'sandbox id')
  );
}

/** What the VM backend uses inside a worker's sandbox. */
export interface SandboxFiles {
  /** The share: made by buildSandbox before any process runs there. */
  share: string;
  /** 32 hex, written O_CREAT|O_EXCL before the worker starts. */
  shareNonce: string;
  /** The filter's socket. */
  dockerSocket: string;
  /** An empty DOCKER_CONFIG for the job's CLI, so it reads no operator config. Not shared. */
  dockerConfig: string;
}

/**
 * Built on sandboxDirOf, from a checked id, not from a directory the caller
 * hands over: the share is the path the helper profile grants and issues its
 * extension for, so it must be a worker's sandbox and nothing else.
 */
export function sandboxFiles(dataDir: string, sandboxId: string): SandboxFiles {
  const dir = sandboxDirOf(dataDir, sandboxId);
  const share = path.join(dir, SHARE_DIR_NAME);
  return {
    share,
    shareNonce: path.join(share, SHARE_NONCE_FILE),
    dockerSocket: path.join(dir, 'docker.sock'),
    dockerConfig: path.join(dir, '.docker'),
  };
}

/**
 * `<resources>`: the app's Resources when packaged, else the checkout's
 * build/, where build:helper, build:guest and fetch:docker-cli put what
 * packaging copies into Resources.
 */
export function getVmResourcesDir(): string {
  if (app.isPackaged) {
    if (!process.resourcesPath) {
      throw new Error('the packaged app has no resources path');
    }
    return process.resourcesPath;
  }
  return path.join(app.getAppPath(), 'build');
}

/** `<resources>/guest`: the kernel, initramfs, root disk and their manifest. */
export function guestDir(): string {
  return path.join(getVmResourcesDir(), 'guest');
}

/**
 * The helper: the one path the spawn, the helper profile and the sweep use.
 * LOCALMOST_VM_HELPER replaces it only in an unpackaged run.
 */
export function helperPath(): string {
  const override = process.env[HELPER_OVERRIDE_ENV];
  if (!app.isPackaged && override) {
    return requireAbsolute(override, HELPER_OVERRIDE_ENV);
  }
  return path.join(getVmResourcesDir(), HELPER_NAME);
}

/** The bundled docker CLI the job runs, `<resources>/docker-cli/docker`. */
export function dockerCliPath(): string {
  return path.join(getVmResourcesDir(), 'docker-cli', 'docker');
}
