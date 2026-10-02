/**
 * A job's own home directory.
 *
 * A job runs with HOME set to an empty directory of its own - `<sandbox>/home`
 * for a runner job, the workspace's `.home` under `localmost test` - which it
 * can write and which goes with it. Tools find their configuration, caches
 * and dotfiles there instead of in the user's home, where the sandbox denies
 * most of what they would look for: a dotfile the floor denies (a regular
 * ~/.gitconfig, ~/.yarnrc.yml) is not there to be found and fail on, and
 * nothing a job writes under HOME outlives it.
 *
 * What the job's approved policy grants under the real home is linked into
 * the job's home at the same relative path, so a tool that looks for it
 * through HOME finds it. The link only names the real path: the sandbox
 * judges the path a link resolves to, so a link reaches exactly what the
 * grant already reached, and the floor's denies still hold. See
 * docs/roadmap/job-environment.md.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The job's home inside a runner sandbox. */
export const JOB_HOME_DIR_NAME = 'home';

/**
 * The global git config every job gets, as `$HOME/.gitconfig`: nothing of the
 * user's. proxyAuthMethod=basic makes git send the proxy token up front;
 * without it git waits for a 407 challenge the proxy answers by closing the
 * connection, and the fetch aborts. Should keys of the user's ever be merged
 * in, an allowlist of them only, and never credential.*, url.*.insteadOf,
 * core.sshCommand or include.path.
 */
export const JOB_GIT_CONFIG = '[http]\n\tproxyAuthMethod = basic\n';

/** Log sink for what preparing a home skips or cannot do. */
export type JobHomeLog = (level: 'debug' | 'warn', message: string) => void;

/** A path quoted for a POSIX shell, as git runs GIT_SSH_COMMAND through one. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * GIT_SSH_COMMAND for a job: ssh reading its config and known hosts from the
 * job's home. ssh finds its own directory through the user database, not
 * HOME, so without this it would look in the user's ~/.ssh, which the
 * sandbox denies.
 */
export function gitSshCommand(home: string): string {
  return `ssh -F ${shellQuote(path.join(home, '.ssh', 'config'))} -o UserKnownHostsFile=${shellQuote(path.join(home, '.ssh', 'known_hosts'))}`;
}

/** Whether `inner` is `outer` or lies beneath it. */
const within = (inner: string, outer: string): boolean =>
  inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);

/** One name component of a policy path with `*` in it, as a regex: `*` stays within the name. */
const componentPattern = (component: string): RegExp =>
  new RegExp(`^${component.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

/**
 * The paths a grant names under `realHome`, relative to it. A leading ~ is
 * the real home. A trailing `/**` grants the directory, as it does in the
 * profiles. A component with `*` in it is matched, within that one name,
 * against what is there now, so each existing match is a path of its own;
 * one with `**` in the middle stops the walk at the directory before it.
 * The home itself is no path: it cannot be linked into itself.
 */
export function homeRelativeGrants(grant: string, realHome: string = os.homedir()): string[] {
  let expanded = grant === '~' || grant.startsWith('~/') ? path.join(realHome, grant.slice(1)) : grant;
  if (!path.isAbsolute(expanded) || expanded.split('/').includes('..')) return [];
  expanded = path.normalize(expanded).replace(/\/\*\*$/, '');
  if (!within(expanded, realHome) || expanded === realHome) return [];
  const components = path.relative(realHome, expanded).split(path.sep);
  let found: string[] = [''];
  for (const component of components) {
    if (component.includes('**')) break;
    if (!component.includes('*')) {
      found = found.map((rel) => path.join(rel, component));
      continue;
    }
    const pattern = componentPattern(component);
    found = found.flatMap((rel) => {
      let names: string[];
      try {
        names = fs.readdirSync(path.join(realHome, rel));
      } catch {
        return [];
      }
      return names.filter((name) => pattern.test(name)).map((name) => path.join(rel, name));
    });
  }
  return found.filter((rel) => rel !== '');
}

/**
 * Link each path the grants name under the real home into the job's home,
 * at the same relative path, and return the relative paths linked.
 *
 * The directories on the way are made in the job's home as real
 * directories. Nothing that is already there is followed or replaced: an
 * entry on the way that is not a directory, or a link a shorter grant
 * already made above this one, stops that path - the link above already
 * leads into the real tree. Shorter paths go first for that reason, so a
 * grant of ~/.cache and one of ~/.cache/pip give one link, ~/.cache, not a
 * directory that hides the rest of it.
 */
export function linkHomeGrants(
  jobHome: string,
  grants: string[],
  options: { realHome?: string; log?: JobHomeLog } = {}
): string[] {
  const realHome = options.realHome ?? os.homedir();
  const log = options.log ?? (() => {});
  const relatives = [...new Set(grants.flatMap((grant) => homeRelativeGrants(grant, realHome)))]
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || (a < b ? -1 : 1));
  const linked: string[] = [];
  for (const rel of relatives) {
    const parts = rel.split(path.sep);
    let blocked = false;
    for (let i = 1; i < parts.length && !blocked; i++) {
      const dir = path.join(jobHome, ...parts.slice(0, i));
      const stat = lstatOrUndefined(dir);
      if (!stat) {
        fs.mkdirSync(dir, { mode: 0o700 });
      } else if (!stat.isDirectory() || stat.isSymbolicLink()) {
        blocked = true;
      }
    }
    if (blocked) {
      log('debug', `Not linking ~/${rel} into the job's home: a link above it already leads there`);
      continue;
    }
    const target = path.join(jobHome, rel);
    if (lstatOrUndefined(target)) {
      log('debug', `Not linking ~/${rel} into the job's home: something is already there`);
      continue;
    }
    fs.symlinkSync(path.join(realHome, rel), target);
    linked.push(rel);
  }
  return linked;
}

/** lstat, or undefined where nothing is there. */
function lstatOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Create each directory a write grant names under the real home that does
 * not exist yet, and return the directories created.
 *
 * One level at a time from the home down: each existing level is lstat'd
 * and must be a directory, not a link, or the grant is left alone - a link
 * there could lead the creation anywhere. Each missing level is made empty,
 * with a plain mkdir that refuses a name someone else created first, mode
 * 0755 less the umask, owned by the user. A grant with `*` in it names no
 * single directory to create, and is skipped, and so is one in, or above,
 * any of `excludeRoots`: the app's own directories, where a policy may name
 * a path the job is denied anyway, and where a directory made at a name the
 * app uses - config.yaml, say - would break the app. Nor is one in any of
 * `deniedRoots`, the credential locations the job is denied whatever it is
 * granted: a ~/.ssh or ~/.aws made because a policy named a path in it
 * would serve the job nothing, and is the user's to make.
 */
export function createMissingGrantedDirs(
  writeGrants: string[],
  options: { realHome?: string; excludeRoots?: string[]; deniedRoots?: string[]; log?: JobHomeLog } = {}
): string[] {
  const realHome = options.realHome ?? os.homedir();
  const log = options.log ?? (() => {});
  const excluded = (options.excludeRoots ?? []).map((root) => path.resolve(root));
  const denied = (options.deniedRoots ?? []).map((root) => path.resolve(root));
  const created: string[] = [];
  for (const grant of writeGrants) {
    let expanded = grant === '~' || grant.startsWith('~/') ? path.join(realHome, grant.slice(1)) : grant;
    if (!path.isAbsolute(expanded) || expanded.split('/').includes('..')) continue;
    expanded = path.normalize(expanded).replace(/\/\*\*$/, '');
    if (expanded.includes('*') || !within(expanded, realHome) || expanded === realHome) continue;
    if (excluded.some((root) => within(expanded, root) || within(root, expanded))) {
      log('debug', `Not creating ${expanded} for the job: it is in the app's own directories`);
      continue;
    }
    if (denied.some((root) => within(expanded, root))) {
      log('debug', `Not creating ${expanded} for the job: the job is denied it whatever it is granted`);
      continue;
    }
    let node = realHome;
    for (const part of path.relative(realHome, expanded).split(path.sep)) {
      node = path.join(node, part);
      const stat = lstatOrUndefined(node);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) continue;
      if (stat) {
        log('warn', `Not creating ${expanded} for the job: ${node} is not a directory`);
        break;
      }
      try {
        fs.mkdirSync(node, { mode: 0o755 });
        created.push(node);
      } catch (err) {
        log('warn', `Could not create ${node} for the job: ${(err as Error).message}`);
        break;
      }
    }
  }
  return created;
}

/**
 * Fill a job's new, empty home: the hermetic git config as `.gitconfig`, an
 * empty `.ssh/config` for GIT_SSH_COMMAND, and a link for each path the
 * grants name under the real home (linkHomeGrants). Called before anything
 * of the job runs there; every file is created exclusively, so nothing put
 * at a name is written through. Throws on what it cannot do; the caller
 * decides what a job can run without.
 */
export function prepareJobHome(
  jobHome: string,
  options: { grants: string[]; realHome?: string; log?: JobHomeLog }
): { gitConfig: string; linked: string[] } {
  const gitConfig = path.join(jobHome, '.gitconfig');
  fs.writeFileSync(gitConfig, JOB_GIT_CONFIG, { flag: 'wx', mode: 0o644 });
  const ssh = path.join(jobHome, '.ssh');
  fs.mkdirSync(ssh, { mode: 0o700 });
  fs.writeFileSync(path.join(ssh, 'config'), '', { flag: 'wx', mode: 0o600 });
  const linked = linkHomeGrants(jobHome, options.grants, { realHome: options.realHome, log: options.log });
  return { gitConfig, linked };
}
