/**
 * Write grants that reach past the job.
 *
 * A policy may declare any write path but "..", and the approval screen used
 * to list them all alike - `write: ~/.npm` looked no different from
 * `write: ~/Library/LaunchAgents`. Some places are read and acted on later by
 * something outside the sandbox: launchd runs what is left in a LaunchAgents
 * directory at login, the shell runs its rc files, git runs what .gitconfig
 * names, and whatever lands in a PATH directory runs the next time you type
 * its name. A job granted one of them can leave code that runs as you, with
 * no sandbox, long after it ends. Those grants are still allowed - a repository
 * may have a real reason - but the reviewer is told what they mean.
 */

import * as os from 'os';

interface SensitivePlace {
  /** As a policy would write it: `~` for the home directory. */
  path: string;
  /** Anything whose path starts with this string, not only this directory. */
  prefix?: boolean;
  /** What a write there lets a job do, in the reviewer's terms. */
  why: string;
}

const LAUNCHD = 'launchd runs what is written here, outside the sandbox';
const SHELL_RC = 'your shell runs this file as it starts or exits, outside the sandbox';
const ON_PATH = 'on your PATH: what is written here runs as your own commands, outside the sandbox';

const SENSITIVE_WRITE_PLACES: SensitivePlace[] = [
  { path: '~/Library/LaunchAgents', why: LAUNCHD },
  { path: '~/Library/LaunchDaemons', why: LAUNCHD },
  // LaunchAgents, LaunchDaemons, and whatever launchd reads there next.
  { path: '/Library/Launch', prefix: true, why: LAUNCHD },
  // zsh reads .zshenv for every invocation, the `zsh -c` of scripts and
  // editors included - the widest of them all.
  { path: '~/.zshenv', why: SHELL_RC },
  { path: '~/.zshrc', why: SHELL_RC },
  { path: '~/.zprofile', why: SHELL_RC },
  { path: '~/.zlogin', why: SHELL_RC },
  { path: '~/.zlogout', why: SHELL_RC },
  { path: '~/.bashrc', why: SHELL_RC },
  { path: '~/.bash_profile', why: SHELL_RC },
  { path: '~/.bash_login', why: SHELL_RC },
  { path: '~/.profile', why: SHELL_RC },
  { path: '~/.ssh', why: 'your SSH keys, and the commands your SSH config runs' },
  { path: '~/.gitconfig', why: 'git runs the commands this file names, in every repository you work in' },
  { path: '~/.config', why: 'configuration your own tools load and act on, outside the sandbox' },
  {
    path: '~/Library/Application Support',
    why: 'data and configuration your own apps load, outside the sandbox',
  },
  { path: '/usr/local/bin', why: ON_PATH },
  { path: '/opt/homebrew/bin', why: ON_PATH },
  // Where pipx, uv and the like install, and where people keep their own.
  { path: '~/.local/bin', why: ON_PATH },
  { path: '~/bin', why: ON_PATH },
];

// The data volume is firmlinked at the root, so the home directory and
// /Library are also reachable under this name.
const DATA_VOLUME = /^\/system\/volumes\/data(?=\/|$)/i;

/**
 * A path as a set of paths: a directory and everything under it, or - for a
 * glob - every path starting with the part before the first wildcard. The
 * glob reading is deliberately loose: it may warn about a pattern that could
 * not in fact match, never miss one that could.
 */
interface Region {
  literal: string;
  open: boolean;
}

function regionOf(entry: string, home: string, open = false): Region | null {
  let p = entry;
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
  // Relative paths are the workspace's, and ~user is not expanded by the
  // profile either. Neither reaches any place listed here.
  if (!p.startsWith('/')) return null;

  const wildcard = p.search(/[*?[]/);
  if (wildcard >= 0) {
    p = p.slice(0, wildcard);
    open = true;
  }
  p = p.replace(/\/+/g, '/');
  // "/./" is the directory itself, as the kernel reads it.
  while (p.includes('/./')) p = p.replace('/./', '/');
  // Read as the path it mirrors, so a grant through the alias is warned
  // about like one on the place itself. Warning is the safe reading either
  // way, whether or not the sandbox matches the alias to the place.
  if (DATA_VOLUME.test(p)) p = p.replace(DATA_VOLUME, '') || '/';
  if (!open) p = p.replace(/\/\.$/, '').replace(/\/+$/, '');
  // The default macOS volume ignores case, and so does the sandbox on it.
  return { literal: p.toLowerCase(), open };
}

function within(p: string, dir: string): boolean {
  return p === dir || p.startsWith(`${dir}/`);
}

/** Whether some path is in both regions. */
function overlaps(a: Region, b: Region): boolean {
  if (!a.open && !b.open) return within(a.literal, b.literal) || within(b.literal, a.literal);
  if (a.open && b.open) return a.literal.startsWith(b.literal) || b.literal.startsWith(a.literal);
  const [glob, dir] = a.open ? [a, b] : [b, a];
  return dir.literal.startsWith(glob.literal) || glob.literal.startsWith(`${dir.literal}/`);
}

/** Whether a region holds the whole of a directory. */
function contains(region: Region, dir: string): boolean {
  return region.open ? `${dir}/`.startsWith(region.literal) : within(dir, region.literal);
}

/**
 * Why a write grant on this path reaches past the job, or undefined if it
 * does not. `home` is for tests; the profile expands `~` to the real one.
 */
export function sensitiveWriteReason(entry: string, home: string = os.homedir()): string | undefined {
  const region = regionOf(entry, home);
  if (!region) return undefined;

  if (contains(region, '')) {
    return 'the whole disk: a job could leave code that launchd, your shell or your PATH runs outside the sandbox';
  }
  const homeRegion = regionOf(home, home);
  if (homeRegion && contains(region, homeRegion.literal)) {
    return (
      'your whole home directory: a job could leave code that launchd, your shell, git or your apps ' +
      'run outside the sandbox, and change your SSH keys'
    );
  }

  for (const place of SENSITIVE_WRITE_PLACES) {
    const placeRegion = regionOf(place.path, home, place.prefix);
    if (!placeRegion || !overlaps(region, placeRegion)) continue;
    // A grant on a parent says which place it takes in; one on the place
    // itself, or inside it, just says what the place is. A place matched by
    // prefix (/Library/Launch*) has a parent in any directory above it.
    const isParent = placeRegion.open
      ? !region.open && placeRegion.literal.startsWith(`${region.literal}/`)
      : contains(region, placeRegion.literal) && region.literal !== placeRegion.literal;
    return isParent ? `includes ${place.path}${place.prefix ? '*' : ''}: ${place.why}` : place.why;
  }
  return undefined;
}

export function isSensitiveWritePath(entry: string, home: string = os.homedir()): boolean {
  return sensitiveWriteReason(entry, home) !== undefined;
}
