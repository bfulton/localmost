/**
 * Registry credentials, resolved in the app and attached by the filtering
 * socket.
 *
 * The point of this module is what the job never sees. Under the old `docker:
 * credentials` level a job read `~/.docker/config.json` itself, so using a
 * private registry meant handing the repository the operator's secrets. Here
 * the app reads them - outside the sandbox, where `~/.docker` stays denied -
 * and the proxy attaches an X-Registry-Auth header to a pull the policy already
 * permits. Naming a registry in `pull.registries` is the whole grant.
 *
 * The resolution order follows the docker CLI: a per-registry credential
 * helper, then the configured credential store, then an inline `auths` entry.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
