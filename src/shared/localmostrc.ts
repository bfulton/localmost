/**
 * .localmostrc Parser and Validator
 *
 * Handles parsing, validation, and merging of declarative sandbox policies.
 */
import * as yaml from 'js-yaml';
import {
  LOCALMOSTRC_KEYS,
  POLICY_SECTION_KEYS,
  POLICY_SECTION_SUBKEYS,
  PolicyScope,
  WORKFLOW_POLICY_KEYS,
  loopbackValues,
} from './policy-describe';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { canonicalHost, parseHostPattern } from './egress-screen';
import { SandboxPolicy, NetworkPolicy, FilesystemPolicy, EnvPolicy } from './sandbox-profile';
import { SandboxPolicyLevel } from './types';
import {
  validateDockerPolicy,
  mergeDockerPolicy,
  diffDockerPolicy,
  serializeDockerPolicy,
} from './docker-policy';

// =============================================================================
// Types
// =============================================================================

export const LOCALMOSTRC_VERSION = 1;

export interface SecretsPolicy {
  /** Secrets that must be provided for this workflow */
  require?: string[];
}

export interface WorkflowPolicy extends SandboxPolicy {
  secrets?: SecretsPolicy;
}

/** The network section as `shared:` may declare it. */
export interface SharedNetworkPolicy extends NetworkPolicy {
  /**
   * Loopback ports a job may connect to directly, not through its proxy:
   * `true` for every port, or a list (seatbelt has no port ranges). Without
   * it a job reaches only its own proxy on loopback. Shared only: it is part
   * of the sandbox profile, fixed when the worker starts, before the
   * workflow is known.
   */
  loopback?: true | number[];
}

/** What `shared:` may declare: a section, plus what only a whole worker can be given. */
export interface SharedPolicy extends SandboxPolicy {
  network?: SharedNetworkPolicy;
}

/**
 * Keys a policy section once accepted that no longer decide anything. A
 * file that still has one parses, with a warning naming it, and the key is
 * dropped from the policy, so it is neither approved nor shown as a grant.
 * `isolation:` chose among isolation types; every job now runs in a macOS VM.
 */
const IGNORED_POLICY_KEYS: Readonly<Record<string, string>> = Object.freeze({
  isolation: 'every job runs in a macOS VM, so there is no isolation type to choose',
});

export interface LocalmostrcConfig {
  /** Config file version */
  version: number;
  /**
   * How much the sandbox grants before this policy adds to it.
   * Absent means strict - see effectivePolicyLevel.
   */
  level?: SandboxPolicyLevel;
  /** Shared policy applied to all workflows */
  shared?: SharedPolicy;
  /** Per-workflow policy overrides */
  workflows?: Record<string, WorkflowPolicy>;
}

export interface ParseError {
  message: string;
  line?: number;
  column?: number;
}

export interface ParseResult {
  success: boolean;
  config?: LocalmostrcConfig;
  errors: ParseError[];
  warnings: string[];
}

// =============================================================================
// Parsing
// =============================================================================

/**
 * The name of a repository's policy file, at its root, and the only one. The
 * runner fetches the file by this name at a job's commit, and the CLI reads
 * and writes it by this name in a checkout, so both apply the same policy:
 * `localmost test` under grants a real job never gets would pass a workflow
 * the runner then fails.
 */
export const LOCALMOSTRC_FILENAME = '.localmostrc';

/**
 * Names the CLI once read as well. They are not policies: they are looked
 * for only to tell a checkout holding one why its file is not in effect.
 */
const UNREAD_LOCALMOSTRC_NAMES = ['.localmostrc.yml', '.localmostrc.yaml'];

/**
 * Why what is at a .localmostrc path is refused, or null when it is a regular
 * file or nothing.
 *
 * The file comes with the checkout, so whoever controls the repository
 * decides what is at that name, and the CLI that reads and writes it runs as
 * the user, outside any sandbox. A link there - dangling, which reads as no
 * file at all - would have a write land wherever it points, outside the
 * checkout; a device or FIFO would have a read never return. Only a regular
 * file is a policy.
 */
function notRegularFile(filePath: string, stat: fs.Stats | null): string | null {
  if (stat === null || stat.isFile()) return null;
  return refusal(
    filePath,
    stat.isSymbolicLink() ? 'a link' : stat.isDirectory() ? 'a directory' : 'a device, FIFO or socket'
  );
}

function refusal(filePath: string, kind: string): string {
  return (
    `${filePath} is not a regular file (it is ${kind}), so localmost will not read or write it. ` +
    'Replace it with a regular file, or remove it.'
  );
}

/** lstat, with null for nothing there. */
function lstatOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Find the .localmostrc file in a repository.
 *
 * Throws when anything but a regular file is at the name, rather than
 * skipping it: a link or device where the policy belongs is refused
 * outright, not read past or written through.
 */
export function findLocalmostrc(repoRoot: string): string | null {
  const filePath = path.join(repoRoot, LOCALMOSTRC_FILENAME);
  const stat = lstatOrNull(filePath);
  if (stat === null) return null;
  const problem = notRegularFile(filePath, stat);
  if (problem) throw new Error(problem);
  return filePath;
}

/**
 * Why a repository with no .localmostrc may have been expected to have a
 * policy: a file under a name localmost does not read, such as
 * .localmostrc.yml. Null when there is none. The name is only looked at,
 * never followed or read.
 */
export function unreadLocalmostrcNote(repoRoot: string): string | null {
  for (const name of UNREAD_LOCALMOSTRC_NAMES) {
    if (lstatOrNull(path.join(repoRoot, name)) === null) continue;
    return (
      `${name} is not read: localmost takes a repository's policy only from ${LOCALMOSTRC_FILENAME}, ` +
      `for jobs and for localmost test alike. Rename it to ${LOCALMOSTRC_FILENAME} to use it. ` +
      `A ${LOCALMOSTRC_FILENAME} that localmost writes does not start from it: rename it first to keep its grants.`
    );
  }
  return null;
}

/**
 * Write a .localmostrc, replacing a regular file or creating one, and never
 * following a link.
 *
 * The content goes to a new file created beside the destination - O_EXCL, so
 * not through anything already at that name - which is then renamed over it.
 * A rename replaces a link rather than writing through it, so even a link
 * swapped in after the check below cannot carry the write out of the
 * checkout. A replaced file keeps its mode; a new one is 0644, as a file to
 * be checked in is, rather than the CLI's private umask.
 */
export function writeLocalmostrc(filePath: string, content: string): void {
  const check = (): fs.Stats | null => {
    const stat = lstatOrNull(filePath);
    const problem = notRegularFile(filePath, stat);
    if (problem) throw new Error(problem);
    return stat;
  };
  const existing = check();
  const mode = existing ? existing.mode & 0o777 : 0o644;

  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  const fd = fs.openSync(temp, 'wx', mode);
  try {
    try {
      fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
    check();
    fs.renameSync(temp, filePath);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * Parse a .localmostrc file.
 *
 * Opened without following a link and without blocking, and read only once
 * the open file is known to be a regular one: a link swapped in after
 * findLocalmostrc looked is refused rather than followed, and a FIFO or
 * device is refused rather than waited on or read forever.
 */
export function parseLocalmostrc(filePath: string): ParseResult {
  const failed = (message: string): ParseResult => ({ success: false, errors: [{ message }], warnings: [] });

  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return failed(`File not found: ${filePath}`);
    // O_NOFOLLOW refuses a link as ELOOP.
    if (code === 'ELOOP') return failed(refusal(filePath, 'a link'));
    return failed(`Failed to read file: ${(err as Error).message}`);
  }

  let content: string;
  try {
    const problem = notRegularFile(filePath, fs.fstatSync(fd));
    if (problem) return failed(problem);
    content = fs.readFileSync(fd, 'utf-8');
  } catch (err) {
    return failed(`Failed to read file: ${(err as Error).message}`);
  } finally {
    fs.closeSync(fd);
  }

  return parseLocalmostrcContent(content);
}

/**
 * Parse .localmostrc content string.
 */
const POLICY_LEVELS: SandboxPolicyLevel[] = ['strict', 'moderate', 'permissive'];

/**
 * The level a policy asks for, which is strict unless it says otherwise.
 *
 * Silence has to mean the tightest setting: a policy that declares nothing
 * should not inherit whatever the machine was last left on.
 */
export function effectivePolicyLevel(config?: LocalmostrcConfig | null): SandboxPolicyLevel {
  return config?.level ?? 'strict';
}

export function parseLocalmostrcContent(content: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    const yamlError = err as yaml.YAMLException;
    return {
      success: false,
      errors: [
        {
          message: yamlError.message,
          line: yamlError.mark?.line,
          column: yamlError.mark?.column,
        },
      ],
      warnings: [],
    };
  }

  return validateLocalmostrc(parsed);
}

/**
 * Validate an already-parsed policy against the grammar.
 *
 * Separate from parsing so a policy read back from anywhere else - the
 * approval cache, which is JSON - is held to exactly the grammar the
 * repository's file was, rather than trusted for having been written by us.
 */
export function validateLocalmostrc(parsed: unknown): ParseResult {
  const errors: ParseError[] = [];
  const warnings: string[] = [];

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      success: false,
      errors: [{ message: 'Invalid .localmostrc: must be a YAML object' }],
      warnings: [],
    };
  }

  const config = parsed as Record<string, unknown>;

  // Closed at the top as each section is: a key nobody parses grants nothing
  // while reading as though it decides something, and a key a later version
  // adds would otherwise be approved here without being shown. The list is
  // shared with what describes a policy, whose guard test covers it.
  for (const key of Object.keys(config)) {
    if ((LOCALMOSTRC_KEYS as readonly string[]).includes(key)) continue;
    errors.push({
      message: `"${key}" is not a .localmostrc key. Accepted keys: ${LOCALMOSTRC_KEYS.join(', ')}.`,
    });
  }

  // Validate version
  if (config.version === undefined) {
    warnings.push('Missing "version" field. Assuming version 1.');
  } else if (typeof config.version !== 'number') {
    errors.push({ message: '"version" must be a number' });
  } else if (config.version !== LOCALMOSTRC_VERSION) {
    errors.push({
      message: `Unsupported version: ${config.version}. This tool supports version ${LOCALMOSTRC_VERSION}.`,
    });
  }

  // Validate level
  if (config.level !== undefined && !POLICY_LEVELS.includes(config.level as SandboxPolicyLevel)) {
    errors.push({
      message: `"level" must be one of: ${POLICY_LEVELS.join(', ')}`,
    });
  }

  // Validate shared policy
  if (config.shared !== undefined) {
    validatePolicy(config.shared, 'shared', errors, 'shared', warnings);
  }

  // Validate per-workflow policies
  if (config.workflows !== undefined) {
    if (typeof config.workflows !== 'object' || config.workflows === null) {
      errors.push({ message: '"workflows" must be an object' });
    } else {
      for (const [workflowName, policy] of Object.entries(config.workflows as Record<string, unknown>)) {
        // A workflow may also require secrets; the shared scope may not.
        validatePolicy(policy, `workflows.${workflowName}`, errors, 'workflow', warnings);
        validateSecretsPolicy(policy, `workflows.${workflowName}`, errors);
      }
    }
  }

  if (errors.length > 0) {
    return { success: false, errors, warnings };
  }

  // Build a properly typed config object
  const workflows = config.workflows as Record<string, unknown> | undefined;
  const typedConfig: LocalmostrcConfig = {
    version: typeof config.version === 'number' ? config.version : LOCALMOSTRC_VERSION,
    level: config.level as SandboxPolicyLevel | undefined,
    shared: withoutIgnoredKeys(config.shared) as SharedPolicy | undefined,
    workflows: workflows
      ? (Object.fromEntries(Object.entries(workflows).map(([name, policy]) => [name, withoutIgnoredKeys(policy)])) as Record<string, WorkflowPolicy>)
      : undefined,
  };

  return {
    success: true,
    config: typedConfig,
    errors: [],
    warnings,
  };
}

/** A policy section without the keys that are ignored; anything else as it was. */
function withoutIgnoredKeys(policy: unknown): unknown {
  if (typeof policy !== 'object' || policy === null) return policy;
  const kept = { ...(policy as Record<string, unknown>) };
  for (const key of Object.keys(IGNORED_POLICY_KEYS)) delete kept[key];
  return kept;
}

/**
 * Validate a sandbox policy object.
 */
function validatePolicy(policy: unknown, path: string, errors: ParseError[], scope: PolicyScope, warnings: string[]): void {
  const accepted: readonly string[] = scope === 'workflow' ? WORKFLOW_POLICY_KEYS : POLICY_SECTION_KEYS;
  if (policy === null || policy === undefined) {
    return; // Empty policy is valid
  }

  if (typeof policy !== 'object') {
    errors.push({ message: `${path} must be an object` });
    return;
  }

  const p = policy as Record<string, unknown>;

  // A key nobody parses grants nothing while reading as though it grants
  // something, and shows up in no approval diff because no parser produced it.
  // The keys are listed in one place, shared with what describes a policy, so
  // a new one cannot be accepted without also being shown.
  for (const key of Object.keys(p)) {
    if (accepted.includes(key)) continue;
    if (key === 'sockets') continue; // Has its own message, below.
    if (Object.hasOwn(IGNORED_POLICY_KEYS, key)) {
      warnings.push(`${path}.${key} is ignored: ${IGNORED_POLICY_KEYS[key]}.`);
      continue;
    }
    errors.push({
      message: `${path}.${key} is not a policy key. Accepted keys: ${accepted.join(', ')}.`,
    });
  }

  // Validate network policy
  if (p.network !== undefined) {
    validateNetworkPolicy(p.network, `${path}.network`, errors, scope);
  }

  // Validate filesystem policy
  if (p.filesystem !== undefined) {
    validateFilesystemPolicy(p.filesystem, `${path}.filesystem`, errors);
  }

  // Removed in favour of docker:, which the runner applies as well as
  // localmost test, and which cannot name an arbitrary socket.
  if (p.sockets !== undefined) {
    errors.push({
      message:
        `${path}.sockets is no longer supported. Use \`docker:\` to declare ` +
        'container work (pull, run, build).',
    });
  }

  // Validate env policy
  if (p.env !== undefined) {
    validateEnvPolicy(p.env, `${path}.env`, errors);
  }

  // Validate the docker action block. The filtering socket is bound to the
  // merged policy when the job is claimed, so docker is valid at both scopes
  // and validates the same way in each.
  if (p.docker !== undefined) {
    validateDockerPolicy(p.docker, `${path}.docker`, (m) => errors.push({ message: m }));
  }
}

function validateNetworkPolicy(policy: unknown, path: string, errors: ParseError[], scope: PolicyScope): void {
  if (typeof policy !== 'object' || policy === null) {
    errors.push({ message: `${path} must be an object` });
    return;
  }

  const p = policy as Record<string, unknown>;
  refuseUnknownKeys(p, path, POLICY_SECTION_SUBKEYS.network, errors);

  if (p.allow !== undefined) {
    validateHostPatternArray(p.allow, `${path}.allow`, errors);
  }
  if (p.deny !== undefined) {
    validateHostPatternArray(p.deny, `${path}.deny`, errors);
  }
  if (p.loopback !== undefined) {
    validateLoopback(p.loopback, `${path}.loopback`, errors, scope);
  }
}

/**
 * Why a network entry is not one the proxies can match, or null when it is.
 * The proxies read an entry with parseHostPattern: a host name, an IP address
 * or a *.domain wildcard, optionally followed by :port (an IPv6 address takes
 * one only in brackets), and nothing else. Read that way, "https://evil.com"
 * is a host "https" with a port that is not one and " evil.com" a name no
 * connection has, so each allowed or denied nothing while reading as though
 * it did. Case is ignored.
 *
 * A host must also be in the spelling a request's host arrives in - ASCII
 * (punycode for an international name), an address written out, no trailing
 * dot - since an allow entry spelled otherwise never matches one. A deny
 * entry is compared in that spelling whatever it is written in (see
 * denyForm), and is held to it all the same, so the two lists read alike.
 * The message gives the entry to write, wildcard and port kept.
 */
export function hostPatternProblem(entry: string): string | null {
  const pattern = parseHostPattern(entry);
  const host = pattern.wildcard ? pattern.host.slice(1) : pattern.host;
  const canonical = pattern.port === null ? null : canonicalHost(host)?.replace(/\.+$/, '') ?? null;
  const isAddress = canonical !== null && net.isIP(canonical) !== 0;
  const isName = canonical !== null && canonical.split('.').every((label) => /^[a-z0-9_-]{1,63}$/.test(label));
  // canonicalHost reads a host the way a URL does, ending it at the first of
  // these and dropping a tab or line break, so the spelling offered below for
  // "10.0.0.0/8" would be one address rather than the range, for
  // "evil.com/path" a whole host, and for "evil.com\tx" another host.
  const urlSyntax = /[/?#\\\t\n\r]/.test(host);
  if (canonical === null || urlSyntax || (pattern.wildcard ? !isName || isAddress : !isName && !isAddress)) {
    return 'must be a host, an IP address or *.domain, optionally with :port, and nothing else';
  }
  if (canonical === host) return null;
  const port = pattern.port === undefined ? '' : `:${pattern.port}`;
  const spelled = net.isIP(canonical) === 6 && port ? `[${canonical}]` : canonical;
  return `is not in the spelling a request's host arrives in: write ${JSON.stringify(`${pattern.wildcard ? '*.' : ''}${spelled}${port}`)} instead`;
}

function validateHostPatternArray(value: unknown, path: string, errors: ParseError[]): void {
  validateStringArray(value, path, errors);
  if (!Array.isArray(value)) return;
  value.forEach((entry, i) => {
    if (typeof entry !== 'string') return;
    const problem = hostPatternProblem(entry);
    if (problem) errors.push({ message: `${path}[${i}] ${problem}` });
  });
}

/**
 * Loopback is written into the sandbox profile, which a worker is spawned
 * with before anyone knows which workflow it will run - so, like the
 * filesystem, it can only come from `shared:`. A per-workflow one is refused
 * rather than shown and not applied. Ports are listed one by one because
 * seatbelt matches a single port or all of them, never a range.
 */
function validateLoopback(value: unknown, path: string, errors: ParseError[], scope: PolicyScope): void {
  if (scope === 'workflow') {
    errors.push({
      message:
        `${path} is only accepted under shared.network: the sandbox profile is fixed when the worker starts, ` +
        'before the workflow is known.',
    });
    return;
  }
  if (value === true) return;
  if (!Array.isArray(value)) {
    errors.push({ message: `${path} must be true (every port) or a list of port numbers` });
    return;
  }
  const seen = new Set<number>();
  value.forEach((port, i) => {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push({ message: `${path}[${i}] must be a port number from 1 to 65535` });
    } else if (seen.has(port)) {
      errors.push({ message: `${path} lists port ${port} twice` });
    } else {
      seen.add(port);
    }
  });
}

function validateFilesystemPolicy(policy: unknown, path: string, errors: ParseError[]): void {
  if (typeof policy !== 'object' || policy === null) {
    errors.push({ message: `${path} must be an object` });
    return;
  }

  const p = policy as Record<string, unknown>;
  refuseUnknownKeys(p, path, POLICY_SECTION_SUBKEYS.filesystem, errors);

  if (p.read !== undefined) {
    validatePathArray(p.read, `${path}.read`, errors);
  }
  if (p.write !== undefined) {
    validatePathArray(p.write, `${path}.write`, errors);
  }
  if (p.deny !== undefined) {
    validatePathArray(p.deny, `${path}.deny`, errors);
    // seatbelt never matches a relative path against a real one, so a
    // relative deny would be shown as denying something and deny nothing.
    // Unlike a grant, which is no worse for granting nothing.
    if (Array.isArray(p.deny)) {
      p.deny.forEach((entry, i) => {
        if (typeof entry !== 'string' || entry === '~' || entry.startsWith('~/') || entry.startsWith('/')) return;
        errors.push({ message: `${path}.deny[${i}] must be an absolute path or start with ~/: a relative deny is never applied` });
      });
    }
  }
}

function validateEnvPolicy(policy: unknown, path: string, errors: ParseError[]): void {
  if (typeof policy !== 'object' || policy === null) {
    errors.push({ message: `${path} must be an object` });
    return;
  }

  const p = policy as Record<string, unknown>;
  refuseUnknownKeys(p, path, POLICY_SECTION_SUBKEYS.env, errors);

  if (p.allow !== undefined) {
    validateStringArray(p.allow, `${path}.allow`, errors);
  }
  if (p.deny !== undefined) {
    validateStringArray(p.deny, `${path}.deny`, errors);
  }
}

/**
 * Refuse a key inside a section that the grammar does not define, for the
 * same reason validatePolicy refuses one at the section level: nothing
 * parses it, so it grants or protects nothing while reading as though it did.
 */
function refuseUnknownKeys(
  section: Record<string, unknown>,
  path: string,
  accepted: readonly string[],
  errors: ParseError[]
): void {
  for (const key of Object.keys(section)) {
    if (accepted.includes(key)) continue;
    errors.push({ message: `${path}.${key} is not a policy key. Accepted keys: ${accepted.join(', ')}.` });
  }
}

function validateSecretsPolicy(policy: unknown, path: string, errors: ParseError[]): void {
  if (typeof policy !== 'object' || policy === null) {
    return;
  }

  const p = policy as Record<string, unknown>;
  if (p.secrets === undefined) {
    return;
  }

  if (typeof p.secrets !== 'object' || p.secrets === null) {
    errors.push({ message: `${path}.secrets must be an object` });
    return;
  }

  const s = p.secrets as Record<string, unknown>;
  refuseUnknownKeys(s, `${path}.secrets`, POLICY_SECTION_SUBKEYS.secrets, errors);
  if (s.require !== undefined) {
    validateStringArray(s.require, `${path}.secrets.require`, errors);
  }
}

function validateStringArray(value: unknown, path: string, errors: ParseError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ message: `${path} must be an array` });
    return;
  }

  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      errors.push({ message: `${path}[${i}] must be a string` });
    }
  }
}

/**
 * A filesystem path from a policy, which is written verbatim into the
 * sandbox-exec profile - a quoted DSL. A quote or backslash could close or
 * escape the string, and a control character (a newline especially) could add
 * a rule of its own. None occurs in a real macOS path, so they are refused
 * rather than escaped-and-hoped: the user approves what a policy says, and it
 * must not be able to enforce something else.
 */
function validatePathArray(value: unknown, path: string, errors: ParseError[]): void {
  validateStringArray(value, path, errors);
  if (!Array.isArray(value)) return;
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (typeof entry !== 'string') continue;
    if (/["\\\x00-\x1f\x7f]/.test(entry)) {
      errors.push({ message: `${path}[${i}] must not contain quotes, backslashes or control characters` });
    }
    // No ".." traversal. A relative path is a legitimate workspace path
    // (./build, ./Pods), emitted into the profile and resolved from the
    // worker's own directory - but a ".." segment could climb out of the
    // workspace into the app's runner directory (proxy credentials, pids,
    // other sandboxes), which the resolved-against-main-cwd filter would miss.
    if (entry.split('/').includes('..')) {
      errors.push({ message: `${path}[${i}] must not contain ".." path segments` });
    }
  }
}

// =============================================================================
// Policy Merging
// =============================================================================

/**
 * Merge two string arrays, deduplicating.
 */
function mergeArrays(base?: string[], override?: string[]): string[] | undefined {
  if (!base && !override) {
    return undefined;
  }
  const result = new Set<string>(base || []);
  for (const item of override || []) {
    result.add(item);
  }
  return Array.from(result);
}

/**
 * Merge network policies.
 */
function mergeNetworkPolicy(
  base?: SharedNetworkPolicy,
  override?: NetworkPolicy
): SharedNetworkPolicy | undefined {
  if (!base && !override) {
    return undefined;
  }

  return {
    allow: mergeArrays(base?.allow, override?.allow),
    deny: mergeArrays(base?.deny, override?.deny),
    // Only the shared section can declare it, and it holds for every workflow.
    ...(base?.loopback !== undefined ? { loopback: base.loopback } : {}),
  };
}

/**
 * Merge filesystem policies.
 */
function mergeFilesystemPolicy(
  base?: FilesystemPolicy,
  override?: FilesystemPolicy
): FilesystemPolicy | undefined {
  if (!base && !override) {
    return undefined;
  }

  return {
    read: mergeArrays(base?.read, override?.read),
    write: mergeArrays(base?.write, override?.write),
    deny: mergeArrays(base?.deny, override?.deny),
  };
}

/**
 * Merge sockets policies.
 */
/**
 * Merge env policies.
 */
function mergeEnvPolicy(base?: EnvPolicy, override?: EnvPolicy): EnvPolicy | undefined {
  if (!base && !override) {
    return undefined;
  }

  return {
    allow: mergeArrays(base?.allow, override?.allow),
    deny: mergeArrays(base?.deny, override?.deny),
  };
}

/**
 * Merge two sandbox policies.
 * Override takes precedence, arrays are merged.
 */
export function mergePolicies(base: SharedPolicy, override: SandboxPolicy): SharedPolicy {
  return {
    network: mergeNetworkPolicy(base.network, override.network),
    filesystem: mergeFilesystemPolicy(base.filesystem, override.filesystem),
    env: mergeEnvPolicy(base.env, override.env),
    docker: mergeDockerPolicy(base.docker, override.docker),
  };
}

/**
 * Get the effective policy for a specific workflow.
 * Merges shared policy with workflow-specific overrides.
 */
export function getEffectivePolicy(config: LocalmostrcConfig, workflowName: string): SharedPolicy {
  const shared = config.shared || {};
  const workflowPolicy = config.workflows?.[workflowName] || {};

  return mergePolicies(shared, workflowPolicy);
}

/**
 * Get required secrets for a workflow.
 */
export function getRequiredSecrets(config: LocalmostrcConfig, workflowName: string): string[] {
  return config.workflows?.[workflowName]?.secrets?.require || [];
}

// =============================================================================
// Serialization
// =============================================================================

/**
 * Generate a .localmostrc file from a config object.
 *
 * `localmost test --updaterc` writes a repository's whole policy back
 * through this, so it must reproduce every key the parser accepts, each
 * value exactly. Strings are always quoted - an env pattern such as
 * `*_TOKEN` would otherwise open a YAML alias - and a section with nothing
 * in it is left out rather than written as a bare key, which YAML reads as
 * null and the parser refuses. It writes the parsed config, so comments in
 * a hand-written file are not kept.
 */
export function serializeLocalmostrc(config: LocalmostrcConfig): string {
  const lines: string[] = [];

  lines.push(`version: ${config.version}`);
  if (config.level) {
    lines.push(`level: ${config.level}`);
  }
  lines.push('');

  if (config.shared) {
    lines.push(...serializeBlock('shared', serializePolicy(config.shared, '  ')));
  }

  if (config.workflows && Object.keys(config.workflows).length > 0) {
    lines.push('');
    lines.push('workflows:');

    for (const [name, policy] of Object.entries(config.workflows)) {
      const body = serializePolicy(policy, '    ');
      body.push(...serializeSection('secrets', serializeList('require', policy.secrets?.require, '      '), '    '));
      lines.push(...serializeBlock(yamlKey(name), body, '  '));
    }
  }

  return lines.join('\n') + '\n';
}

/** Quote a string for YAML, as serializeDockerPolicy does. */
const quote = (value: string): string => JSON.stringify(value);

/**
 * A workflow name as a mapping key: bare only when it is plain characters
 * and YAML reads it back as the same string, quoted otherwise - a `: ` or
 * ` #` in a name would end the key early, and a name such as `1.0`, `True`
 * or `null` would come back as a different key.
 */
function yamlKey(name: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) && yaml.load(name) === name ? name : quote(name);
}

/** A policy block: `key:` over its body, or `key: {}` when it has none. */
function serializeBlock(key: string, body: string[], indent = ''): string[] {
  return body.length > 0 ? [`${indent}${key}:`, ...body] : [`${indent}${key}: {}`];
}

/** A section inside a policy: `key:` over its body, or nothing when it has none. */
function serializeSection(key: string, body: string[], indent: string): string[] {
  return body.length > 0 ? [`${indent}${key}:`, ...body] : [];
}

/** A list of strings under `key:`, or nothing when it is empty. */
function serializeList(key: string, items: readonly string[] | undefined, indent: string): string[] {
  if (!items?.length) return [];
  return [`${indent}${key}:`, ...items.map((item) => `${indent}  - ${quote(item)}`)];
}

function serializePolicy(policy: SharedPolicy, indent: string): string[] {
  const lines: string[] = [];
  const inner = `${indent}  `;

  if (policy.docker) {
    lines.push(...serializeDockerPolicy(policy.docker, indent));
  }

  if (policy.network) {
    const { allow, deny, loopback } = policy.network;
    const body = [...serializeList('allow', allow, inner), ...serializeList('deny', deny, inner)];
    if (loopback !== undefined) {
      body.push(`${inner}loopback: ${loopback === true ? 'true' : `[${loopback.join(', ')}]`}`);
    }
    lines.push(...serializeSection('network', body, indent));
  }

  if (policy.filesystem) {
    const { read, write, deny } = policy.filesystem;
    lines.push(...serializeSection('filesystem', [
      ...serializeList('read', read, inner),
      ...serializeList('write', write, inner),
      ...serializeList('deny', deny, inner),
    ], indent));
  }

  if (policy.env) {
    const { allow, deny } = policy.env;
    lines.push(...serializeSection('env', [
      ...serializeList('allow', allow, inner),
      ...serializeList('deny', deny, inner),
    ], indent));
  }

  return lines;
}

// =============================================================================
// Diffing
// =============================================================================

export interface PolicyDiff {
  path: string;
  type: 'added' | 'removed' | 'changed';
  oldValue?: string;
  newValue?: string;
}

/**
 * Compute diff between two configs.
 */
export function diffConfigs(oldConfig: LocalmostrcConfig, newConfig: LocalmostrcConfig): PolicyDiff[] {
  const diffs: PolicyDiff[] = [];

  // The level decides how much the sandbox grants before anything below is
  // read, so a change to it is the largest change a policy can make.
  const oldLevel = effectivePolicyLevel(oldConfig);
  const newLevel = effectivePolicyLevel(newConfig);
  if (oldLevel !== newLevel) {
    diffs.push({ path: 'level', type: 'changed', oldValue: oldLevel, newValue: newLevel });
  }

  // Compare shared policies
  diffPolicies(oldConfig.shared || {}, newConfig.shared || {}, 'shared', diffs);

  // Compare workflow policies
  const allWorkflows = new Set([
    ...Object.keys(oldConfig.workflows || {}),
    ...Object.keys(newConfig.workflows || {}),
  ]);

  for (const workflow of allWorkflows) {
    const oldPolicy = oldConfig.workflows?.[workflow] || {};
    const newPolicy = newConfig.workflows?.[workflow] || {};
    diffPolicies(oldPolicy, newPolicy, `workflows.${workflow}`, diffs);
  }

  return diffs;
}

function diffPolicies(
  oldPolicy: SharedPolicy,
  newPolicy: SharedPolicy,
  prefix: string,
  diffs: PolicyDiff[]
): void {
  // Network
  diffArrays(oldPolicy.network?.allow, newPolicy.network?.allow, `${prefix}.network.allow`, diffs);
  diffArrays(oldPolicy.network?.deny, newPolicy.network?.deny, `${prefix}.network.deny`, diffs);
  // Each port its own entry, and "every port" one of its own, so widening a
  // list to all of them reads as exactly that.
  diffArrays(
    loopbackValues(oldPolicy.network?.loopback),
    loopbackValues(newPolicy.network?.loopback),
    `${prefix}.network.loopback`,
    diffs
  );

  // Filesystem
  diffArrays(oldPolicy.filesystem?.read, newPolicy.filesystem?.read, `${prefix}.filesystem.read`, diffs);
  diffArrays(oldPolicy.filesystem?.write, newPolicy.filesystem?.write, `${prefix}.filesystem.write`, diffs);
  diffArrays(oldPolicy.filesystem?.deny, newPolicy.filesystem?.deny, `${prefix}.filesystem.deny`, diffs);

  // Docker. One entry per grant: what a container may pull, run and mount is
  // decided by this diff alone, so nothing under docker: collapses into a line.
  diffs.push(...diffDockerPolicy(oldPolicy.docker, newPolicy.docker, `${prefix}.docker`));

  // Env
  diffArrays(oldPolicy.env?.allow, newPolicy.env?.allow, `${prefix}.env.allow`, diffs);
  diffArrays(oldPolicy.env?.deny, newPolicy.env?.deny, `${prefix}.env.deny`, diffs);
}

function diffArrays(
  oldArr: string[] | undefined,
  newArr: string[] | undefined,
  path: string,
  diffs: PolicyDiff[]
): void {
  const oldSet = new Set(oldArr || []);
  const newSet = new Set(newArr || []);

  for (const item of newSet) {
    if (!oldSet.has(item)) {
      diffs.push({ path, type: 'added', newValue: item });
    }
  }

  for (const item of oldSet) {
    if (!newSet.has(item)) {
      diffs.push({ path, type: 'removed', oldValue: item });
    }
  }
}

/**
 * Format policy diff for display.
 */
export function formatPolicyDiff(diffs: PolicyDiff[]): string {
  if (diffs.length === 0) {
    return 'No changes';
  }

  const lines: string[] = [];
  for (const diff of diffs) {
    switch (diff.type) {
      case 'added':
        lines.push(`+ ${diff.path}: ${diff.newValue}`);
        break;
      case 'removed':
        lines.push(`- ${diff.path}: ${diff.oldValue}`);
        break;
      case 'changed':
        lines.push(`~ ${diff.path}: ${diff.oldValue} -> ${diff.newValue}`);
        break;
    }
  }
  return lines.join('\n');
}
