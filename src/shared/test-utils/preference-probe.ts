/**
 * Probes of what a sandbox profile lets a process do with the user's
 * preferences, for the *.sandbox.test.ts files.
 *
 * cfprefsd, not the process, reads and writes the plists, and it asks the
 * sandbox on the process's behalf: a domain is served when the profile allows
 * user-preference-read (or -write) on it, or file-read-data (or
 * file-write-data) on its plist. So the end-to-end probe is `defaults`
 * itself, run under the profile, on a throwaway domain no app owns. A domain
 * the user's own apps load - Xcode's - is never written to find out: for
 * that, sandbox_check is asked about a process running under the profile,
 * which writes nothing whatever the answer.
 */

import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { developerPythonSync } from '../sandbox-reaper';

/**
 * Ask sandbox_check whether a process under `profilePath`, or under this
 * process's own profile when it is omitted, may perform `operation` on the
 * preference domain. The process is a sleep, started for the question and
 * killed after it. sandbox_check is variadic after its third argument, so
 * only the first three are declared (see the reaper's script); 6 is
 * SANDBOX_FILTER_PREFERENCE_DOMAIN, and SANDBOX_CHECK_NO_REPORT keeps the
 * answer out of the log.
 */
const CHECK_SCRIPT = `
import ctypes, subprocess, sys, time
libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
check = libc.sandbox_check
check.restype = ctypes.c_int
check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
profile, operation, domain = sys.argv[1:4]
argv = ['/usr/bin/sandbox-exec', '-f', profile, '/bin/sleep', '30'] if profile else ['/bin/sleep', '30']
child = subprocess.Popen(argv)
try:
    answer = -1
    for _ in range(100):
        # Until sandbox-exec has applied the profile and exec'd the sleep.
        if child.poll() is not None:
            break
        sandboxed = check(child.pid, None, 0)
        if sandboxed == 1:
            answer = check(child.pid, operation.encode(), 6 | 0x40000000, ctypes.c_char_p(domain.encode()))
            break
        time.sleep(0.05)
    print(answer)
finally:
    child.kill()
    child.wait()
`;

/**
 * Whether a process under the profile at `profilePath` (or this process's
 * own) may perform `operation` on `domain`. Throws when the developer tools'
 * python3 is missing or the probe did not get an answer, rather than read
 * either as a refusal.
 */
export function preferenceAllowed(
  operation: 'user-preference-read' | 'user-preference-write',
  domain: string,
  profilePath?: string
): boolean {
  const python = developerPythonSync();
  if (!python) throw new Error('the preference probe needs the developer tools\' python3 (xcode-select -p)');
  const result = spawnSync(python, ['-c', CHECK_SCRIPT, profilePath ?? '', operation, domain], {
    encoding: 'utf-8',
    timeout: 20000,
  });
  const answer = result.stdout.trim();
  if (answer === '0') return true;
  if (answer === '1') return false;
  throw new Error(`sandbox_check gave no answer for ${operation} ${domain}: ${answer} ${result.stderr} ${result.error ?? ''}`);
}

/** A preference domain no app owns, for a probe that writes. */
export const throwawayDomain = (): string =>
  `com.localmost.prefs-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

const THROWAWAY = /^com\.localmost\.prefs-test-\d+-[0-9a-f]{8}$/;

/**
 * Remove a domain throwawayDomain named, and its plist: `defaults delete`
 * empties the domain but leaves an empty plist behind. Only a name of that
 * shape, and only a plain file, so nothing else is ever removed.
 */
export function removeThrowawayDomain(domain: string): void {
  if (!THROWAWAY.test(domain)) throw new Error(`not a throwaway preference domain: ${domain}`);
  defaults(['delete', domain]);
  const plist = path.join(os.userInfo().homedir, 'Library', 'Preferences', `${domain}.plist`);
  if (fs.lstatSync(plist, { throwIfNoEntry: false })?.isFile()) fs.unlinkSync(plist);
}

/** Run /usr/bin/defaults, under the profile at `profilePath` or under this process's own. */
export function defaults(args: string[], profilePath?: string): { ok: boolean; stdout: string; stderr: string } {
  const argv = profilePath ? ['/usr/bin/sandbox-exec', '-f', profilePath, '/usr/bin/defaults', ...args] : ['/usr/bin/defaults', ...args];
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf-8', timeout: 15000 });
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim(), stderr: result.stderr ?? '' };
}
