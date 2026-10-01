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
 * For `localmost test`, run from a terminal or inside a job.
 *
 * With the developer tools' python3 by its own path, as the app's sweep
 * runs, not /usr/bin/python3. That shim first asks xcrun where the tools
 * are, through a cache in the per-user temp directory, and the sweep runs
 * with none of the caller's environment - not the xcrun_db a job points
 * that cache into its own temp with. A job's profile denies the per-user
 * temp directory, so inside a localmost job every sweep had xcrun look the
 * tools up from nothing: two seconds on an idle machine, past the sweep's
 * own timeout on a loaded one, and a sweep that timed out found nothing.
 */
export function reapMarkedProcesses(marker: ProcessMarker): boolean {
  const python = developerPythonSync();
  if (!python) return false;
  try {
    execFileSync(python, reapArgs(marker), {
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: REAP_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/** The python3 under the developer directory xcode-select printed, if it is there. */
function pythonIn(developerDir: string): string | null {
  const python = path.join(developerDir.trim(), 'usr', 'bin', 'python3');
  return path.isAbsolute(python) && fs.existsSync(python) ? python : null;
}

/**
 * developerPython, for the blocking sweep: looked up once per process, as
 * `localmost test` sweeps at the end of every job it runs.
 */
function developerPythonSync(): string | null {
  if (developerPythonFound === undefined) {
    try {
      developerPythonFound = pythonIn(
        execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
      );
    } catch {
      developerPythonFound = null;
    }
  }
  return developerPythonFound;
}

let developerPythonFound: string | null | undefined;

/**
 * The developer tools' python3, by its own path, or null without them.
 *
 * Not /usr/bin/python3: on a Mac without the developer tools that is a stub
 * that offers to install them, in a dialog the app would raise at the end of
 * every job. xcode-select -p only prints where they are, or fails.
 *
 * Looked up once per app run: every finished job is swept, and a startup
 * sweeps every mark an earlier run left, which without the developer tools
 * can be thousands. Tools installed while the app runs are found at its
 * next start.
 */
export function developerPython(): Promise<string | null> {
  developerPythonLookup ??= lookUpDeveloperPython();
  return developerPythonLookup;
}

let developerPythonLookup: Promise<string | null> | undefined;

function lookUpDeveloperPython(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/xcode-select', ['-p'], { encoding: 'utf-8', timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(pythonIn(String(stdout)));
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
