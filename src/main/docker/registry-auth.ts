/**
 * Registry credentials, resolved in the app.
 *
 * The point of this module is what the job never sees. Under the old `docker:
 * credentials` level a job read `~/.docker/config.json` itself, so using a
 * private registry meant handing the repository the operator's secrets. Here
 * the app reads them - outside the sandbox, where `~/.docker` stays denied -
 * and uses them for a pull the policy already permits. Naming a registry in
 * `pull.registries` is the whole grant.
 *
 * The resolution order follows the docker CLI: a per-registry credential
 * helper, then the configured credential store, then an inline `auths` entry.
 *
 * resolveRegistryCredentials is what the VM backend's puller uses: it runs on
 * the Mac and never forwards what it resolves (contract §6.1). A helper is
 * looked up only in fixed directories, runs asynchronously, and a helper that
 * is missing or fails is an error, never a quiet anonymous pull.
 *
 * resolveRegistryAuth is the Docker Desktop backend's: an X-Registry-Auth
 * header the filter attaches to a forwarded pull. It keeps that backend's
 * behaviour unchanged and goes when the backend does.
 */

import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanText } from './puller/clean-text';

/** Docker's own name for the default registry, as it appears in config.json. */
const DEFAULT_REGISTRY = 'docker.io';
const DEFAULT_REGISTRY_KEY = 'https://index.docker.io/v1/';

interface DockerConfig {
  auths?: Record<string, { auth?: string; identitytoken?: string }>;
  credsStore?: string;
  credHelpers?: Record<string, string>;
}

/** What a credential helper prints on stdout. */
interface HelperCredentials {
  ServerURL?: string;
  Username?: string;
  Secret?: string;
}

export interface RegistryAuthDeps {
  readConfig: () => DockerConfig | null;
  /** Run `docker-credential-<helper> get` with `serverUrl` on stdin. */
  runHelper: (helper: string, serverUrl: string) => HelperCredentials | null;
}

const configPath = (): string => path.join(os.homedir(), '.docker', 'config.json');

const nodeDeps: RegistryAuthDeps = {
  readConfig: () => {
    try {
      return JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as DockerConfig;
    } catch {
      // No config, or one we cannot read: the job simply pulls unauthenticated.
      return null;
    }
  },
  runHelper: (helper, serverUrl) => {
    try {
      const stdout = execFileSync(`docker-credential-${helper}`, ['get'], {
        input: serverUrl,
        encoding: 'utf-8',
        timeout: 10_000,
      });
      return JSON.parse(stdout) as HelperCredentials;
    } catch {
      // A helper that errors means no stored credential for this registry,
      // which is the same as having none.
      return null;
    }
  },
};

/** Every key a registry may be stored under, most specific first. */
function configKeys(registry: string): string[] {
  if (registry === DEFAULT_REGISTRY || registry === 'index.docker.io') {
    return [DEFAULT_REGISTRY_KEY, 'index.docker.io', DEFAULT_REGISTRY];
  }
  return [registry, `https://${registry}`, `${registry}/v1/`, `https://${registry}/v1/`];
}

/** The value of an X-Registry-Auth header: base64 of the AuthConfig JSON. */
function encode(auth: Record<string, string>): string {
  return Buffer.from(JSON.stringify(auth)).toString('base64');
}

/**
 * The X-Registry-Auth value for a registry, or undefined when the operator has
 * no credential for it. Never throws: a pull that cannot be authenticated is
 * still a pull, and an anonymous one may well succeed.
 */
export function resolveRegistryAuth(registry: string, deps: RegistryAuthDeps = nodeDeps): string | undefined {
  const config = deps.readConfig();
  if (!config) return undefined;

  const keys = configKeys(registry);
  const serveraddress = keys[0];

  const helper = keys.map((key) => config.credHelpers?.[key]).find((h) => h !== undefined) ?? config.credsStore;
  if (helper) {
    const credentials = deps.runHelper(helper, serveraddress);
    if (credentials?.Secret) {
      // A helper answers with the literal username <token> when the secret is
      // an identity token rather than a password.
      return credentials.Username === '<token>'
        ? encode({ identitytoken: credentials.Secret, serveraddress })
        : encode({ username: credentials.Username ?? '', password: credentials.Secret, serveraddress });
    }
  }

  for (const key of keys) {
    const entry = config.auths?.[key];
    if (!entry) continue;
    if (entry.identitytoken) return encode({ identitytoken: entry.identitytoken, serveraddress });
    if (!entry.auth) continue;
    const decoded = Buffer.from(entry.auth, 'base64').toString('utf-8');
    const separator = decoded.indexOf(':');
    if (separator === -1) continue;
    return encode({
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
      serveraddress,
    });
  }

  return undefined;
}

/** Where a credential helper may be. Never PATH: an app launched from Finder has PATH=/usr/bin:/bin:/usr/sbin:/sbin. */
export const CREDENTIAL_HELPER_DIRS: readonly string[] = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/Applications/Docker.app/Contents/Resources/bin',
];

/** What the puller authenticates with: a password, or an identity (refresh) token. */
export type RegistryCredentials =
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'identity-token'; token: string };

/**
 * The operator's Docker config names a credential source that localmost
 * cannot use. The message names the config key to change; the pull fails.
 */
export class RegistryAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryAuthError';
  }
}

export interface CredentialDeps {
  /** The operator's ~/.docker/config.json, or null when there is none. Throws on one that cannot be read. */
  readConfig: () => Promise<DockerConfig | null>;
  /** The file the default readConfig reads: ~/.docker/config.json. */
  configFile: string;
  /** Searched in order; the first that has the helper wins. */
  helperDirs: readonly string[];
  timeoutMs: number;
  /**
   * The app log, for what a failing helper printed. That output is the
   * operator's, so it goes here, cleaned, and never into the error, which
   * reaches the job's log.
   */
  log: (message: string) => void;
}

const CONFIG_FILE = '~/.docker/config.json';
/** A helper name is a file-name suffix, never a path. */
const HELPER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HELPER_OUTPUT_MAX = 64 * 1024;
/** What docker-credential-helpers print, with exit 1, when they hold nothing for a server. */
const NOT_FOUND = /credentials not found/i;

async function readConfigFile(file: string): Promise<DockerConfig | null> {
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new RegistryAuthError(`${CONFIG_FILE} could not be read: ${cleanText((error as Error).message, 200)}`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as DockerConfig) : null;
  } catch {
    throw new RegistryAuthError(`${CONFIG_FILE} is not valid JSON; fix it, or remove it`);
  }
}

function withDefaults(overrides: Partial<CredentialDeps>): CredentialDeps {
  const configFile = overrides.configFile ?? configPath();
  return {
    readConfig: () => readConfigFile(configFile),
    configFile,
    helperDirs: CREDENTIAL_HELPER_DIRS,
    timeoutMs: 10_000,
    log: () => undefined,
    ...overrides,
  };
}

function describeHelper(file: string, key: string): string {
  return `the Docker credential helper \`${file}\` (from \`${key}\` in ${CONFIG_FILE})`;
}

async function findHelper(file: string, dirs: readonly string[]): Promise<string | null> {
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    try {
      const stat = await fs.promises.stat(candidate);
      if (stat.isFile()) {
        await fs.promises.access(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Not here, or not executable here: try the next directory.
    }
  }
  return null;
}

type HelperRun =
  | { ok: true; stdout: string }
  | { ok: false; code: number | null; signal: string | null; output: string; timedOut: boolean; tooLarge: boolean };

/** Run `<helper> get` with the server on stdin, asynchronously, bounded in time and output. */
function runHelperGet(file: string, serverUrl: string, timeoutMs: number): Promise<HelperRun> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      ['get'],
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: HELPER_OUTPUT_MAX, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout });
          return;
        }
        const failure = error as Error & { code?: number | string; killed?: boolean; signal?: string | null };
        const tooLarge = failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        resolve({
          ok: false,
          code: typeof failure.code === 'number' ? failure.code : null,
          signal: failure.signal ?? null,
          output: `${stdout ?? ''} ${stderr ?? ''}`.trim() || failure.message,
          timedOut: failure.killed === true && !tooLarge,
          tooLarge,
        });
      }
    );
    child.stdin?.on('error', () => {
      // A helper that exits without reading stdin: its exit status tells the story.
    });
    child.stdin?.end(serverUrl);
  });
}

function fromAuths(config: DockerConfig, keys: string[]): RegistryCredentials | undefined {
  for (const key of keys) {
    const entry = config.auths?.[key];
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.identitytoken === 'string' && entry.identitytoken) {
      return { kind: 'identity-token', token: entry.identitytoken };
    }
    if (typeof entry.auth !== 'string' || !entry.auth) continue;
    const decoded = Buffer.from(entry.auth, 'base64').toString('utf-8');
    const separator = decoded.indexOf(':');
    if (separator === -1) continue;
    return { kind: 'basic', username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  }
  return undefined;
}

/**
 * The operator's credentials for a registry, or undefined for an anonymous
 * pull. Throws RegistryAuthError when the config names a helper that is not in
 * one of CREDENTIAL_HELPER_DIRS, or that fails for any reason other than
 * holding nothing for this registry. The error names the helper and the
 * config key to change; a quietly anonymous pull would fail later, on a
 * private image, with nothing pointing at the cause.
 */
export async function resolveRegistryCredentials(
  registry: string,
  overrides: Partial<CredentialDeps> = {}
): Promise<RegistryCredentials | undefined> {
  const deps = withDefaults(overrides);
  const config = await deps.readConfig();
  if (!config) return undefined;

  const keys = configKeys(registry);
  const serverUrl = keys[0];
  const helperKey = keys.find((key) => typeof config.credHelpers?.[key] === 'string');
  const helper = helperKey !== undefined ? config.credHelpers?.[helperKey] : config.credsStore;
  const key = helperKey !== undefined ? `credHelpers.${helperKey}` : 'credsStore';

  if (typeof helper === 'string' && helper !== '') {
    if (!HELPER_NAME.test(helper)) {
      throw new RegistryAuthError(
        `\`${key}\` in ${CONFIG_FILE} does not name a credential helper localmost can run; ` +
          `fix it, or remove \`${key}\` from ${CONFIG_FILE}`
      );
    }
    const file = `docker-credential-${helper}`;
    const found = await findHelper(file, deps.helperDirs);
    if (!found) {
      const dirs = deps.helperDirs;
      const where = dirs.length > 1 ? `${dirs.slice(0, -1).join(', ')} or ${dirs[dirs.length - 1]}` : dirs.join('');
      throw new RegistryAuthError(
        `${describeHelper(file, key)} was not found in ${where}; install it, or remove \`${key}\` from ${CONFIG_FILE}`
      );
    }
    const result = await runHelperGet(found, serverUrl, deps.timeoutMs);
    if (!result.ok) {
      if (result.code === 1 && NOT_FOUND.test(result.output)) return fromAuths(config, keys);
      // What the helper printed is the operator's: the app log has it, the
      // job's log (where this error goes) only the helper, the key and how
      // it ended.
      deps.log(`${file} (from \`${key}\`) failed: ${cleanText(result.output, 2000)}`);
      const why = result.timedOut
        ? `it did not answer within ${Math.max(1, Math.round(deps.timeoutMs / 1000))} s`
        : result.tooLarge
          ? `its answer was larger than ${HELPER_OUTPUT_MAX / 1024} KiB`
          : result.code !== null
            ? `it exited with status ${result.code}`
            : `it was stopped by ${result.signal ?? 'a signal'}`;
      throw new RegistryAuthError(
        `${describeHelper(file, key)} failed: ${why} (localmost's log has its output); fix it, or remove \`${key}\` from ${CONFIG_FILE}`
      );
    }
    let answer: HelperCredentials;
    try {
      answer = JSON.parse(result.stdout) as HelperCredentials;
      if (!answer || typeof answer !== 'object') throw new Error('not an object');
    } catch {
      throw new RegistryAuthError(
        `${describeHelper(file, key)} failed: its answer was not credential JSON; fix it, or remove \`${key}\` from ${CONFIG_FILE}`
      );
    }
    if (typeof answer.Secret === 'string' && answer.Secret) {
      // A helper answers with the literal username <token> when the secret is
      // an identity token rather than a password.
      return answer.Username === '<token>'
        ? { kind: 'identity-token', token: answer.Secret }
        : { kind: 'basic', username: typeof answer.Username === 'string' ? answer.Username : '', password: answer.Secret };
    }
  }

  return fromAuths(config, keys);
}
