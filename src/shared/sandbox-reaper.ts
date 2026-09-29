/**
 * Finding the processes that run under a profile carrying a process marker
 * (see processMarkerRules), and killing them.
 *
 * A process can leave its process group with setsid() and close every
 * descriptor it inherited, but it cannot leave its sandbox. Both job
 * profiles - the runner's and `localmost test`'s - can carry a marker, so
 * what a job left running is found by the one thing it cannot shed.
 */

import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ProcessMarker } from './sandbox-profile';

/**
 * Stop, then kill, every process of the user's that runs under a profile
 * carrying the marker named by argv, and print their pids.
 *
 * sandbox_check answers for another process's profile: whether it is
 * sandboxed at all, and whether it may read a path. Only a profile carrying
 * the marker reads one file and not the other. Everything found is stopped
 * before anything is killed, so nothing it forks while the sweep runs is
 * missed, and a process that no longer matches once stopped - a pid reused
 * between the look and the stop - is let go. sandbox_check is variadic after
 * its third argument, so only the first three are declared: ctypes then
 * passes the path the way arm64 expects a variadic argument.
 */
const REAP_SCRIPT = `
import ctypes, os, signal, sys
libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
check = libc.sandbox_check
check.restype = ctypes.c_int
check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
listpids = libc.proc_listallpids
listpids.restype = ctypes.c_int
listpids.argtypes = [ctypes.c_void_p, ctypes.c_int]
granted, withheld = (os.fsencode(p) for p in sys.argv[1:3])
FILTER_PATH = 1

def reads(pid, p):
    return check(pid, b'file-read-data', FILTER_PATH, ctypes.c_char_p(p))

def ours(pid):
    return check(pid, None, 0) == 1 and reads(pid, granted) == 0 and reads(pid, withheld) == 1

def scan():
    n = listpids(None, 0)
    buf = (ctypes.c_int * (max(n, 0) + 1024))()
    n = listpids(buf, ctypes.sizeof(buf))
    me = os.getpid()
    return {buf[i] for i in range(max(n, 0)) if buf[i] > 1 and buf[i] != me and ours(buf[i])}

stopped = set()
for _ in range(100):
    found = scan() - stopped
    if not found:
        break
    for pid in found:
        try:
            os.kill(pid, signal.SIGSTOP)
            stopped.add(pid)
        except OSError:
            pass
still = scan()
for pid in stopped:
    try:
        os.kill(pid, signal.SIGKILL if pid in still else signal.SIGCONT)
    except OSError:
        pass
print(' '.join(str(pid) for pid in sorted(stopped & still)))
`;

const REAP_TIMEOUT_MS = 15000;

const reapArgs = (marker: ProcessMarker): string[] => ['-I', '-S', '-c', REAP_SCRIPT, marker.granted, marker.withheld];

/**
 * Kill whatever runs under `marker`, however it got out of its process
 * group, and wait for the sweep. Returns false if the sweep could not run.
 * For `localmost test`, run from a terminal, where python3 is expected.
 */
export function reapMarkedProcesses(marker: ProcessMarker): boolean {
  try {
    execFileSync('/usr/bin/python3', reapArgs(marker), {
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: REAP_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The developer tools' python3, by its own path, or null without them.
 *
 * Not /usr/bin/python3: on a Mac without the developer tools that is a stub
 * that offers to install them, in a dialog the app would raise at the end of
 * every job. xcode-select -p only prints where they are, or fails.
 */
function developerPython(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/xcode-select', ['-p'], { encoding: 'utf-8', timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const python = path.join(String(stdout).trim(), 'usr', 'bin', 'python3');
      resolve(path.isAbsolute(python) && fs.existsSync(python) ? python : null);
    });
  });
}

/**
 * Kill whatever runs under `marker`, however it got out of its process
 * group, without blocking the app. Resolves to the pids killed, or null if
 * the sweep could not run - no developer tools, or a sweep that failed -
 * in which case nothing is known about what is left.
 */
export async function reapMarkedProcessesAsync(
  marker: ProcessMarker,
  findPython: () => Promise<string | null> = developerPython
): Promise<number[] | null> {
  const python = await findPython();
  if (!python) return null;
  return new Promise((resolve) => {
    execFile(
      python,
      reapArgs(marker),
      { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf-8', timeout: REAP_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout).split(/\s+/).filter((token) => /^\d+$/.test(token)).map(Number));
      }
    );
  });
}
