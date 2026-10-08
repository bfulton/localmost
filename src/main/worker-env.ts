/**
 * What goes into a runner worker's environment: the runner's own settings,
 * the job's proxy, and what the repository's env policy allows of the app's
 * own environment. The worker runs in a macOS VM, whose guest agent sets the
 * job user's HOME, PATH, shell and temp itself.
 */

import type { EnvPolicy } from '../shared/policy-types';
import type { LocalmostrcConfig } from '../shared/localmostrc';

/**
 * The variables of the app's own environment every worker is given: the
 * locale and the time zone, so a job's log reads as the operator's Mac
 * does. Everything else the app was launched with - a shell's tokens, an
 * agent socket, NODE_OPTIONS, a NO_PROXY that would route around the job's
 * proxy - reaches a job only if its repository's approved policy allows it
 * by name; the guest's own PATH, HOME and user are never the Mac's.
 */
const BASELINE_ENV = ['LANG', 'LC_ALL', 'TZ'];

/** Whether a variable name matches a policy pattern: a name, `*` standing for any run of characters. */
function matchesEnvPattern(name: string, pattern: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(name);
}

/**
 * A worker's environment: the baseline and whatever the repository's env
 * policy allows of the app's environment, less whatever it denies - a deny
 * wins over both - and then the runner's own settings and the job's proxy,
 * which no policy can replace. The guest reaches the proxy through its relay
 * at the same loopback address, so the URL is passed as the Mac's proxy has
 * it. Git is told to send the proxy's credentials up front: otherwise it
 * waits for a 407 challenge the proxy answers by closing the connection, and
 * every fetch aborts. The guest agent takes only the names a job may set
 * (jobEnvNameAllowed in the macOS VM's agent client), so a policy cannot
 * reach the loader, the shell or the runner's own configuration through this.
 */
export function vmWorkerEnv(hostEnv: NodeJS.ProcessEnv, policy: EnvPolicy | undefined, proxyUrl: string): Record<string, string> {
  const allow = [...BASELINE_ENV, ...(policy?.allow ?? [])];
  const deny = policy?.deny ?? [];
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (!allow.some((pattern) => matchesEnvPattern(name, pattern))) continue;
    if (deny.some((pattern) => matchesEnvPattern(name, pattern))) continue;
    env[name] = value;
  }
  return {
    ...env,
    ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT: 'true',
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    GIT_HTTP_PROXY_AUTHMETHOD: 'basic',
  };
}

/**
 * The env policy a worker can be spawned under. The environment is fixed at
 * spawn, before the workflow is known, so allow comes from the shared
 * section only: a per-workflow allow cannot be honoured, and is not applied.
 * A deny can be honoured conservatively, so every workflow's deny applies to
 * every job: a deny that silently did not apply would be the unsafe way to
 * be wrong.
 */
export function spawnEnvPolicy(config: LocalmostrcConfig): { allow: string[]; deny: string[] } {
  const deny = [...(config.shared?.env?.deny ?? [])];
  for (const workflow of Object.values(config.workflows ?? {})) {
    for (const name of workflow?.env?.deny ?? []) {
      if (!deny.includes(name)) deny.push(name);
    }
  }
  return { allow: [...(config.shared?.env?.allow ?? [])], deny };
}
