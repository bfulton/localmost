/**
 * The guest the app ships: `<resources>/guest`, its manifest, and a check of
 * its artifacts' hashes once per launch (contract §4.1, §5.1).
 *
 * The manifest is what the filter answers a VM-less /_ping, /version and
 * /info from, so it is validated like any other input before it is used: a
 * known schema, bounded strings, and a baseline cut to the /info fields a job
 * may be shown. The helper checks each artifact's size before VZ reads it;
 * Electron checks the hashes, so a guest that was changed on disk after it
 * was built never boots.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** The artifacts the helper boots, each named in the manifest with its sha256 and size. */
export const GUEST_ARTIFACTS = ['vmlinux', 'initramfs.cpio.gz', 'rootfs.erofs'] as const;
export type GuestArtifact = (typeof GUEST_ARTIFACTS)[number];

/**
 * The /info fields the filter shows a job (its INFO_FIELDS, less NCPU and
 * MemTotal, which come from the configured VM size).
 */
export const BASELINE_FIELDS = [
  'ServerVersion',
  'OSType',
  'Architecture',
  'OperatingSystem',
  'KernelVersion',
  'Driver',
  'CgroupVersion',
  'SecurityOptions',
] as const;

export interface GuestManifest {
  guestVersion: string;
  /** The data disk's format: a golden disk with another is discarded, not migrated. */
  dataFormat: number;
  agentProtocol: 1;
  kernelRelease: string;
  docker: { engine: string; apiVersion: string; minApiVersion: string };
  artifacts: Record<GuestArtifact, { sha256: string; size: number }>;
  /** The daemon's own /info, recorded at build, cut to BASELINE_FIELDS. */
  baseline: Partial<Record<(typeof BASELINE_FIELDS)[number], string | string[]>>;
}

/** A guest that cannot be used: VmError's code for it is the helper's own, E_GUEST_IMAGE. */
export class GuestImageError extends Error {
  readonly code = 'E_GUEST_IMAGE';
}

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_STRING = 256;
const API_VERSION_RE = /^[0-9]{1,3}\.[0-9]{1,3}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function boundedString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STRING) {
    throw new GuestImageError(`the guest manifest's ${what} is not a string of at most ${MAX_STRING} characters`);
  }
  return value;
}

function parseManifest(raw: unknown): GuestManifest {
  if (!isRecord(raw)) throw new GuestImageError('the guest manifest is not a JSON object');
  if (raw.schema !== 1) throw new GuestImageError(`the guest manifest has schema ${String(raw.schema)}, not 1`);
  if (raw.agentProtocol !== 1) {
    throw new GuestImageError(`the guest speaks agent protocol ${String(raw.agentProtocol)}, not 1`);
  }
  if (!Number.isInteger(raw.dataFormat) || (raw.dataFormat as number) < 1) {
    throw new GuestImageError("the guest manifest's dataFormat is not a positive integer");
  }
  const kernel = isRecord(raw.kernel) ? raw.kernel : {};
  const docker = isRecord(raw.docker) ? raw.docker : {};
  const apiVersion = boundedString(docker.apiVersion, 'docker.apiVersion');
  const minApiVersion = boundedString(docker.minApiVersion, 'docker.minApiVersion');
  for (const [what, version] of [['docker.apiVersion', apiVersion], ['docker.minApiVersion', minApiVersion]]) {
    if (!API_VERSION_RE.test(version)) throw new GuestImageError(`the guest manifest's ${what} is not an API version`);
  }

  const artifactsRaw = isRecord(raw.artifacts) ? raw.artifacts : {};
  const artifacts = {} as GuestManifest['artifacts'];
  for (const name of GUEST_ARTIFACTS) {
    const entry = artifactsRaw[name];
    if (!isRecord(entry) || typeof entry.sha256 !== 'string' || !HEX64_RE.test(entry.sha256)) {
      throw new GuestImageError(`the guest manifest names no sha256 for ${name}`);
    }
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) <= 0) {
      throw new GuestImageError(`the guest manifest names no size for ${name}`);
    }
    artifacts[name] = { sha256: entry.sha256, size: entry.size as number };
  }

  const baselineRaw = isRecord(raw.baseline) ? raw.baseline : {};
  const baseline: GuestManifest['baseline'] = {};
  for (const field of BASELINE_FIELDS) {
    const value = baselineRaw[field];
    if (value === undefined) continue;
    if (field === 'SecurityOptions') {
      if (!Array.isArray(value) || value.length > 32) {
        throw new GuestImageError('the guest manifest\'s baseline.SecurityOptions is not a list');
      }
      baseline[field] = value.map((option) => boundedString(option, 'baseline.SecurityOptions entry'));
    } else {
      baseline[field] = boundedString(value, `baseline.${field}`);
    }
  }

  return {
    guestVersion: boundedString(raw.guestVersion, 'guestVersion'),
    dataFormat: raw.dataFormat as number,
    agentProtocol: 1,
    kernelRelease: boundedString(kernel.release, 'kernel.release'),
    docker: { engine: boundedString(docker.engine, 'docker.engine'), apiVersion, minApiVersion },
    artifacts,
    baseline,
  };
}

/** Hash a regular file, never through a link; resolves with its sha256 and size. */
function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    let fd: number;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (err) {
      reject(err);
      return;
    }
    const hash = crypto.createHash('sha256');
    let size = 0;
    const stream = fs.createReadStream('', { fd });
    stream.on('data', (chunk: string | Buffer) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      hash.update(bytes);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), size }));
  });
}

export class GuestImage {
  private parsed: GuestManifest | null = null;
  private verified: Promise<void> | null = null;

  constructor(private readonly dir: string) {}

  directory(): string {
    return this.dir;
  }

  /** The validated manifest, read once. Throws GuestImageError. */
  manifest(): GuestManifest {
    if (this.parsed) return this.parsed;
    const file = path.join(this.dir, 'manifest.json');
    let text: string;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error('not a manifest-sized file');
      text = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      throw new GuestImageError(`cannot read the guest manifest ${file}: ${(err as Error).message}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new GuestImageError(`the guest manifest ${file} is not JSON`);
    }
    this.parsed = parseManifest(raw);
    return this.parsed;
  }

  /**
   * Check every artifact's sha256 and size against the manifest, once per
   * launch; later calls share the answer, a failure included. Rejects with a
   * GuestImageError naming the artifact.
   */
  verify(): Promise<void> {
    this.verified ??= (async () => {
      const manifest = this.manifest();
      for (const name of GUEST_ARTIFACTS) {
        const expected = manifest.artifacts[name];
        let actual: { sha256: string; size: number };
        try {
          actual = await hashFile(path.join(this.dir, name));
        } catch (err) {
          throw new GuestImageError(`cannot read the guest's ${name}: ${(err as Error).message}`);
        }
        if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
          throw new GuestImageError(
            `the guest's ${name} is not the one its manifest names (sha256 ${actual.sha256}, ${actual.size} bytes; ` +
              `expected ${expected.sha256}, ${expected.size} bytes)`
          );
        }
      }
    })();
    return this.verified;
  }
}
