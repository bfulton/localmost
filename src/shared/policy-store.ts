/**
 * The policy approval cache, as both the app and the CLI read and write it.
 *
 * Each repository has one entry holding up to two policies: the approved one,
 * which is what its jobs run under, and a pending one, which a refused job
 * asked for and nobody has decided on. They used to be one slot, so a refused
 * job's policy overwrote the approved one - the approved policy stopped
 * applying, and the next click approved whatever had been written last,
 * which need not be what the reviewer was looking at.
 *
 * Approval is bound to content by a stamp: a sha256 of the repository and the
 * policy - and of the repository id a pending policy would be approved for -
 * which is what a reviewer is shown alongside it. Approving quotes the stamp,
 * and is refused if the pending policy is no longer the one it names.
 *
 * Shared because the CLI approves too, and it runs outside Electron.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { LocalmostrcConfig, validateLocalmostrc } from './localmostrc';

/** One policy and when it reached the slot it is in. */
export interface PolicyVersion {
  config: LocalmostrcConfig;
  at: string;
  /**
   * GitHub's id for the repository the policy came from. A name can be freed
   * and taken by another repository; the id cannot. Absent in an entry
   * written before ids were kept, until a matching job supplies it.
   */
  repositoryId?: number;
}

export interface PolicyEntry {
  repository: string;
  /** In force: what this repository's jobs run under. */
  approved?: PolicyVersion;
  /** Asked for by a job that was refused. Never applied until approved. */
  pending?: PolicyVersion;
}

/** Marks the on-disk shape; an entry without it predates the split. */
const ENTRY_FORMAT = 2;

// GitHub's own grammar, plus the "_" of an Enterprise Managed User's handle
// ("<user>_<shortcode>"). Neither part can contain "/" or be "..", which is
// what keeps the file inside the directory.
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

// The file is "<owner>_<repo>.json", with any "_" in the owner written as
// "%5F", so the first "_" always ends the owner and every name maps to one
// file. Neither part can contain "%", and an owner without "_" - every owner
// before managed users were accepted - keeps the file name it always had.
// Both parts are lowercased, as GitHub treats them: the app sees a target's
// casing and GitHub's, and on a case-sensitive volume those were two files.
const OWNER_UNDERSCORE = '%5F';

export function isValidRepository(repository: unknown): repository is string {
  if (typeof repository !== 'string') return false;
  const parts = repository.split('/');
  if (parts.length !== 2) return false;
  const [owner, repo] = parts;
  return OWNER.test(owner) && REPO.test(repo) && repo !== '.' && repo !== '..';
}

export function policyFilePath(dir: string, repository: string): string {
  if (!isValidRepository(repository)) {
    throw new Error(`Not a repository name: ${JSON.stringify(String(repository).slice(0, 200))}`);
  }
  const [owner, repo] = repository.toLowerCase().split('/');
  return path.join(dir, `${owner.split('_').join(OWNER_UNDERSCORE)}_${repo}.json`);
}

/**
 * Files holding this repository's entry under a name in another casing:
 * written before names were lowercased, and on a case-sensitive volume not
 * found by the lowercased name. On a volume that ignores case the entry's
 * own file can be listed under its old name, so that one is recognised by
 * identity, not name, and never counted.
 */
function otherCasedFiles(dir: string, filePath: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const name = path.basename(filePath);
  const own = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  return fs
    .readdirSync(dir)
    .filter((file) => file !== name && file.toLowerCase() === name.toLowerCase())
    .map((file) => path.join(dir, file))
    .filter((file) => {
      const stat = fs.statSync(file);
      return !own || stat.ino !== own.ino || stat.dev !== own.dev;
    });
}

/** The file an entry is in, if it has one, under whatever casing it was written. */
function existingEntryFile(dir: string, repository: string): string | null {
  const filePath = policyFilePath(dir, repository);
  if (fs.existsSync(filePath)) return filePath;
  return otherCasedFiles(dir, filePath)[0] ?? null;
}

/** GitHub names are case-insensitive, and the app sees both casings. */
function sameRepository(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** JSON with keys sorted at every level, so equal policies hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The stamp a reviewer's approval has to quote. Everything shown for a policy
 * - its grants, its level, its changes - is derived from the config, so a
 * stamp over the config binds the approval to all of it, and to anything the
 * rendering might leave out as well.
 *
 * A pending policy's stamp also covers the repository id approving it would
 * bind the approval to, which the card shows when it changes: otherwise the
 * same file recorded by a job from yet another repository between listing
 * and approving would move the approval to one the reviewer never saw.
 * Without an id the stamp is what it always was, which is also what the
 * CLI, reading a clone that carries none, computes.
 */
export function approvalStamp(repository: string, config: LocalmostrcConfig, repositoryId?: number): string {
  // canonicalJson leaves out an undefined field, so no id hashes as before.
  return crypto
    .createHash('sha256')
    .update(canonicalJson({ repository: repository.toLowerCase(), config, repositoryId }))
    .digest('hex');
}

function parseConfig(raw: unknown, where: string): LocalmostrcConfig {
  const result = validateLocalmostrc(raw);
  if (!result.success || !result.config) {
    throw new Error(`${where}: ${result.errors[0]?.message ?? 'invalid policy'}`);
  }
  return result.config;
}

function parseVersion(raw: unknown, where: string): PolicyVersion | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.at !== 'string') throw new Error(`${where}.at must be a string`);
  const version: PolicyVersion = { config: parseConfig(record.config, `${where}.config`), at: record.at };
  if (record.repositoryId !== undefined) {
    if (!isRepositoryId(record.repositoryId)) throw new Error(`${where}.repositoryId must be a positive integer`);
    version.repositoryId = record.repositoryId;
  }
  return version;
}

export function isRepositoryId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * A policy version, with the repository id only when there is a real one.
 * An id that is not one is dropped here rather than written: the entry would
 * then fail to read back, and the next change would replace it, approval and
 * all. Dropped, the job counts as carrying no id, as before ids were kept.
 */
function versionOf(config: LocalmostrcConfig, repositoryId: number | undefined): PolicyVersion {
  const version: PolicyVersion = { config, at: new Date().toISOString() };
  if (isRepositoryId(repositoryId)) version.repositoryId = repositoryId;
  return version;
}

/**
 * Read an entry as written by this module or by the version before it.
 *
 * Nothing is trusted for being in our directory: the config is held to the
 * .localmostrc grammar and the repository to the file's own name, and an
 * entry that fails either is an error rather than a policy.
 */
function parseEntry(raw: unknown, repository: string): PolicyEntry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('policy cache entry must be an object');
  }
  const record = raw as Record<string, unknown>;
  if (!isValidRepository(record.repository) || !sameRepository(record.repository, repository)) {
    throw new Error(`policy cache entry is for another repository than ${repository}`);
  }

  if (record.format === ENTRY_FORMAT) {
    const entry: PolicyEntry = { repository: record.repository };
    const approved = parseVersion(record.approved, 'approved');
    const pending = parseVersion(record.pending, 'pending');
    if (approved) entry.approved = approved;
    if (pending) entry.pending = pending;
    return entry;
  }

  // One config and an approved flag. An unapproved one was a pending policy
  // that had already overwritten whatever was approved before it, so there
  // is nothing else to recover.
  if (typeof record.approved !== 'boolean') {
    throw new Error('policy cache entry has neither a format nor an approved flag');
  }
  const version: PolicyVersion = {
    config: parseConfig(record.config, 'config'),
    at: typeof record.cachedAt === 'string' ? record.cachedAt : '',
  };
  return record.approved
    ? { repository: record.repository, approved: version }
    : { repository: record.repository, pending: version };
}

/**
 * Read a repository's entry. Null when there is none; throws when there is
 * one that cannot be trusted, so the caller decides how to fail closed.
 */
export function readPolicyEntry(dir: string, repository: string): PolicyEntry | null {
  const filePath = existingEntryFile(dir, repository);
  if (!filePath) return null;
  return parseEntry(JSON.parse(fs.readFileSync(filePath, 'utf-8')), repository);
}

/**
 * Read an entry in order to change it. One that cannot be trusted is replaced
 * rather than refused: it grants nothing already, and refusing meant nothing
 * could ever be recorded or approved over it, so the repository stayed locked
 * out until someone deleted the file by hand. Its approved slot is dropped
 * with it, which fails closed. A name that is not a repository still throws.
 */
function readEntryToChange(dir: string, repository: string): PolicyEntry {
  const filePath = existingEntryFile(dir, repository);
  if (!filePath) return { repository };
  const text = fs.readFileSync(filePath, 'utf-8');
  try {
    return parseEntry(JSON.parse(text), repository);
  } catch {
    return { repository };
  }
}

/**
 * Write an entry, or remove it once it holds nothing. Written to a temporary
 * file and renamed, so a reader never sees half an entry. A copy under an
 * older casing goes with it, having been read into this one.
 */
function writePolicyEntry(dir: string, entry: PolicyEntry): void {
  const filePath = policyFilePath(dir, entry.repository);
  if (!entry.approved && !entry.pending) {
    fs.rmSync(filePath, { force: true });
  } else {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const data = { format: ENTRY_FORMAT, ...entry };
    const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, filePath);
  }
  for (const stale of otherCasedFiles(dir, filePath)) fs.rmSync(stale, { force: true });
}

/** Every entry that reads cleanly. One that does not is left out, not guessed at. */
export function listPolicyEntries(dir: string): PolicyEntry[] {
  if (!fs.existsSync(dir)) return [];
  const entries: PolicyEntry[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    // The first "_" separates the owner from the repository - the inverse
    // of policyFilePath.
    const stem = file.slice(0, -'.json'.length);
    const split = stem.indexOf('_');
    if (split < 0) continue;
    const owner = stem.slice(0, split).split(OWNER_UNDERSCORE).join('_');
    const repository = `${owner}/${stem.slice(split + 1)}`;
    if (!isValidRepository(repository)) continue;
    try {
      entries.push(parseEntry(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')), repository));
    } catch {
      // Unreadable or untrustworthy; it grants nothing by being skipped.
    }
  }
  return entries;
}

/**
 * Record what a refused job asked for. The approved policy, if any, is left
 * exactly as it was: it stays in force until a reviewer approves another.
 */
export function recordPending(
  dir: string,
  repository: string,
  config: LocalmostrcConfig,
  repositoryId?: number
): void {
  const entry = readEntryToChange(dir, repository);
  entry.pending = versionOf(config, repositoryId);
  writePolicyEntry(dir, entry);
}

/**
 * Approve the pending policy, provided it is still the one the reviewer saw.
 */
export function approvePending(dir: string, repository: string, stamp: string): LocalmostrcConfig {
  const entry = readEntryToChange(dir, repository);
  if (!entry.pending) {
    throw new Error(`There is nothing waiting for approval for ${repository}`);
  }
  if (approvalStamp(repository, entry.pending.config, entry.pending.repositoryId) !== stamp) {
    throw new Error(`The policy for ${repository} changed since it was shown. Review it again before approving.`);
  }
  // Approving a job's request approves it for the repository that asked. One
  // that did not say which keeps whatever the approval was bound to before.
  entry.approved = versionOf(entry.pending.config, entry.pending.repositoryId ?? entry.approved?.repositoryId);
  delete entry.pending;
  writePolicyEntry(dir, entry);
  return entry.approved.config;
}

/**
 * Approve a policy the caller read and showed itself - the CLI, from the
 * operator's own clone. A pending policy is cleared only if it is this one,
 * for the repository the approval is bound to; any other is still waiting
 * for its own decision.
 */
export function approveConfig(dir: string, repository: string, config: LocalmostrcConfig): string {
  const stamp = approvalStamp(repository, config);
  const entry = readEntryToChange(dir, repository);
  // The operator's clone carries no repository id, and nothing the CLI
  // shows names one, so an approval bound to a repository stays bound to it.
  // A pending policy from another repository under the name, however
  // identical, is left waiting for the app's card, which shows the id
  // changing: from here an empty binding may be filled, never replaced.
  const pendingIsThis = entry.pending !== undefined && approvalStamp(repository, entry.pending.config) === stamp;
  const boundTo = entry.approved?.repositoryId;
  const pendingId = pendingIsThis ? entry.pending?.repositoryId : undefined;
  const pendingMovesIt = boundTo !== undefined && pendingId !== undefined && pendingId !== boundTo;
  entry.approved = versionOf(config, boundTo ?? pendingId);
  if (pendingIsThis && !pendingMovesIt) {
    delete entry.pending;
  }
  writePolicyEntry(dir, entry);
  return stamp;
}

/**
 * Bind an approved policy to the repository a matching job came from, if it
 * is bound to none yet - an approval written before ids were kept. Once
 * bound, a job from another repository under the same name is asked about.
 */
export function bindRepositoryId(dir: string, repository: string, repositoryId: number): void {
  if (!isRepositoryId(repositoryId)) return;
  const entry = readEntryToChange(dir, repository);
  if (!entry.approved || entry.approved.repositoryId !== undefined) return;
  entry.approved.repositoryId = repositoryId;
  writePolicyEntry(dir, entry);
}

/**
 * Drop the pending policy, leaving the approved one in force. Returns the
 * stamp of what was dropped, for the record.
 */
export function rejectPending(dir: string, repository: string): string | undefined {
  const entry = readEntryToChange(dir, repository);
  if (!entry.pending) return undefined;
  const stamp = approvalStamp(repository, entry.pending.config, entry.pending.repositoryId);
  delete entry.pending;
  writePolicyEntry(dir, entry);
  return stamp;
}

export interface PolicyDecisionRecord {
  repository: string;
  decision: 'approved' | 'rejected';
  /** Which policy was decided on: the stamp the reviewer was shown. */
  stamp?: string;
  /** Where the decision was made. */
  via: 'app' | 'cli';
}

/**
 * Append a decision to the audit log.
 *
 * Approving a policy widens what someone else's code may do on this machine,
 * so the decision is worth a durable record separate from the cache entry,
 * which only ever holds the current state.
 */
export function recordPolicyDecision(dir: string, record: PolicyDecisionRecord): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ at: new Date().toISOString(), ...record });
  fs.appendFileSync(path.join(dir, 'decisions.log'), `${line}\n`, { mode: 0o600 });
}
