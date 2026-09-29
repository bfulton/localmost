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
 * policy, which is what a reviewer is shown alongside it. Approving quotes the
 * stamp, and is refused if the pending policy is no longer the one it names.
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

// GitHub's own grammar. An owner cannot contain "_", which is what makes
// "<owner>_<repo>.json" name exactly one repository, and neither part can
// contain "/" or be "..", which is what keeps the file inside the directory.
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

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
  const [owner, repo] = repository.split('/');
  return path.join(dir, `${owner}_${repo}.json`);
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
 */
export function approvalStamp(repository: string, config: LocalmostrcConfig): string {
  return crypto
    .createHash('sha256')
    .update(canonicalJson({ repository: repository.toLowerCase(), config }))
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
  return { config: parseConfig(record.config, `${where}.config`), at: record.at };
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
  const filePath = policyFilePath(dir, repository);
  if (!fs.existsSync(filePath)) return null;
  return parseEntry(JSON.parse(fs.readFileSync(filePath, 'utf-8')), repository);
}

/**
 * Write an entry, or remove it once it holds nothing. Written to a temporary
 * file and renamed, so a reader never sees half an entry.
 */
function writePolicyEntry(dir: string, entry: PolicyEntry): void {
  const filePath = policyFilePath(dir, entry.repository);
  if (!entry.approved && !entry.pending) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const data = { format: ENTRY_FORMAT, ...entry };
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, filePath);
}

/** Every entry that reads cleanly. One that does not is left out, not guessed at. */
export function listPolicyEntries(dir: string): PolicyEntry[] {
  if (!fs.existsSync(dir)) return [];
  const entries: PolicyEntry[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    // The owner cannot contain "_", so the first one separates it from the
    // repository - the inverse of policyFilePath.
    const stem = file.slice(0, -'.json'.length);
    const split = stem.indexOf('_');
    if (split < 0) continue;
    const repository = `${stem.slice(0, split)}/${stem.slice(split + 1)}`;
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
export function recordPending(dir: string, repository: string, config: LocalmostrcConfig): void {
  const entry = readPolicyEntry(dir, repository) ?? { repository };
  entry.pending = { config, at: new Date().toISOString() };
  writePolicyEntry(dir, entry);
}

/**
 * Approve the pending policy, provided it is still the one the reviewer saw.
 */
export function approvePending(dir: string, repository: string, stamp: string): LocalmostrcConfig {
  const entry = readPolicyEntry(dir, repository);
  if (!entry?.pending) {
    throw new Error(`There is nothing waiting for approval for ${repository}`);
  }
  if (approvalStamp(repository, entry.pending.config) !== stamp) {
    throw new Error(`The policy for ${repository} changed since it was shown. Review it again before approving.`);
  }
  entry.approved = { config: entry.pending.config, at: new Date().toISOString() };
  delete entry.pending;
  writePolicyEntry(dir, entry);
  return entry.approved.config;
}

/**
 * Approve a policy the caller read and showed itself - the CLI, from the
 * operator's own clone. A pending policy is cleared only if it is this one;
 * a different one is still waiting for its own decision.
 */
export function approveConfig(dir: string, repository: string, config: LocalmostrcConfig): string {
  const stamp = approvalStamp(repository, config);
  const entry = readPolicyEntry(dir, repository) ?? { repository };
  entry.approved = { config, at: new Date().toISOString() };
  if (entry.pending && approvalStamp(repository, entry.pending.config) === stamp) {
    delete entry.pending;
  }
  writePolicyEntry(dir, entry);
  return stamp;
}

/**
 * Drop the pending policy, leaving the approved one in force. Returns the
 * stamp of what was dropped, for the record.
 */
export function rejectPending(dir: string, repository: string): string | undefined {
  const entry = readPolicyEntry(dir, repository);
  if (!entry?.pending) return undefined;
  const stamp = approvalStamp(repository, entry.pending.config);
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
