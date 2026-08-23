/**
 * PID Tree Watch
 *
 * Watches a process and all its descendants using macOS kqueue (via Python).
 * Used in discovery mode to track which PIDs belong to our sandbox process tree.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';

// Python script for pid_tree_watch (uses kqueue + libproc)
const PID_TREE_WATCH_SCRIPT = `#!/usr/bin/env python3
"""
pid_tree_watch - Watch a process and all its descendants using kqueue

NOTE: There is an inherent race condition for short-lived grandchild processes.
When a child forks, we receive NOTE_FORK but must call proc_listchildpids() to
discover the new child's PID. If that child forks and exits before we query it,
we may miss its grandchildren.

Potential mitigations:
- eslogger (EndpointSecurity) as root provides synchronous process notifications
- DYLD_INSERT_LIBRARIES could inject a delay into fork/exec (won't work on
  SIP-protected binaries, but would help for homebrew/user tools)

For our use case (filtering sandbox logs in discovery mode), occasional misses
of very short-lived processes are acceptable.
"""

import sys
import os
import select
import ctypes
import ctypes.util

# Load libproc for proc_listchildpids
libproc = ctypes.CDLL(ctypes.util.find_library('proc'))
libproc.proc_listchildpids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
libproc.proc_listchildpids.restype = ctypes.c_int

def get_child_pids(pid):
    buf_size = 256
    buf = (ctypes.c_int * buf_size)()
    count = libproc.proc_listchildpids(pid, buf, ctypes.sizeof(buf))
    if count <= 0:
        return []
    return [buf[i] for i in range(count)]


class PidTreeWatcher:
    def __init__(self):
        self.kq = select.kqueue()
        self.watched_pids = set()

    def add_watch(self, pid):
        if pid in self.watched_pids:
            return True
        try:
            ev = select.kevent(
                pid,
                filter=select.KQ_FILTER_PROC,
                flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE,
                fflags=select.KQ_NOTE_FORK | select.KQ_NOTE_EXEC | select.KQ_NOTE_EXIT
            )
            self.kq.control([ev], 0, 0)
            self.watched_pids.add(pid)
            return True
        except OSError as e:
            if e.errno != 3:  # ESRCH
                print(f"error: kevent add failed for pid {pid}: {e}", file=sys.stderr)
            return False

    def remove_watch(self, pid):
        self.watched_pids.discard(pid)

    def watch_children(self, parent_pid):
        children = get_child_pids(parent_pid)
        for child in children:
            if child not in self.watched_pids:
                if self.add_watch(child):
                    print(f"fork {parent_pid} {child}", flush=True)
                    self.watch_children(child)

    def run(self, root_pid):
        if not self.add_watch(root_pid):
            print(f"error: could not watch pid {root_pid}", file=sys.stderr)
            return 1

        print(f"watching {root_pid}", flush=True)
        self.watch_children(root_pid)

        while self.watched_pids:
            try:
                events = self.kq.control(None, 16, None)
            except InterruptedError:
                continue
            except OSError as e:
                print(f"error: kevent wait failed: {e}", file=sys.stderr)
                break

            for ev in events:
                pid = ev.ident
                fflags = ev.fflags

                if fflags & select.KQ_NOTE_FORK:
                    self.watch_children(pid)

                if fflags & select.KQ_NOTE_EXEC:
                    print(f"exec {pid}", flush=True)

                if fflags & select.KQ_NOTE_EXIT:
                    print(f"exit {pid}", flush=True)
                    self.remove_watch(pid)

        return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print("usage: pid_tree_watch.py <pid>", file=sys.stderr)
        sys.exit(1)
    try:
        root_pid = int(sys.argv[1])
    except ValueError:
        print("error: invalid pid", file=sys.stderr)
        sys.exit(1)
    if root_pid <= 0:
        print("error: invalid pid", file=sys.stderr)
        sys.exit(1)
    watcher = PidTreeWatcher()
    sys.exit(watcher.run(root_pid))
`;

/**
 * Get the path to the pid_tree_watch Python script.
 * Creates it if it doesn't exist.
 */
export function getPidTreeWatchScript(): string | null {
  if (process.platform !== 'darwin') {
    return null;
  }

  const binDir = path.join(os.homedir(), '.localmost', 'bin');
  const scriptPath = path.join(binDir, 'pid_tree_watch.py');

  // Ensure bin directory exists
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  // Write script if it doesn't exist or is outdated
  const currentContent = fs.existsSync(scriptPath)
    ? fs.readFileSync(scriptPath, 'utf-8')
    : '';

  if (currentContent !== PID_TREE_WATCH_SCRIPT) {
    fs.writeFileSync(scriptPath, PID_TREE_WATCH_SCRIPT, { mode: 0o755 });
  }

  return scriptPath;
}

/**
 * PID tree watcher instance.
 * Spawns the pid_tree_watch helper and collects PIDs in real-time.
 */
export class PidTreeWatcher {
  private process: ChildProcess | null = null;
  private collectedPids: Set<number> = new Set();
  private rootPid: number | null = null;

  /**
   * Start watching a process tree.
   * @param pid The root PID to watch
   * @returns true if watching started successfully
   */
  start(pid: number): boolean {
    const script = getPidTreeWatchScript();
    if (!script) {
      return false;
    }

    this.rootPid = pid;
    this.collectedPids.add(pid);

    this.process = spawn(script, [String(pid)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        this.parseLine(line.trim());
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      // Log errors but don't fail
      const msg = data.toString().trim();
      if (msg) {
        console.error('[pid_tree_watch]', msg);
      }
    });

    return true;
  }

  /**
   * Parse a line of output from pid_tree_watch.
   */
  private parseLine(line: string): void {
    if (!line) return;

    // "watching <pid>" - initial watch confirmation
    const watchMatch = line.match(/^watching (\d+)$/);
    if (watchMatch) {
      this.collectedPids.add(parseInt(watchMatch[1], 10));
      return;
    }

    // "fork <parent> <child>" - new child process
    const forkMatch = line.match(/^fork (\d+) (\d+)$/);
    if (forkMatch) {
      this.collectedPids.add(parseInt(forkMatch[1], 10));
      this.collectedPids.add(parseInt(forkMatch[2], 10));
      return;
    }

    // "exec <pid>" - process executed new binary
    const execMatch = line.match(/^exec (\d+)$/);
    if (execMatch) {
      this.collectedPids.add(parseInt(execMatch[1], 10));
      return;
    }

    // "exit <pid>" - process exited (still counts as part of our tree)
    const exitMatch = line.match(/^exit (\d+)$/);
    if (exitMatch) {
      this.collectedPids.add(parseInt(exitMatch[1], 10));
      return;
    }
  }

  /**
   * Stop watching and return all collected PIDs.
   */
  stop(): Set<number> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    return this.collectedPids;
  }

  /**
   * Get the current set of collected PIDs.
   */
  getPids(): Set<number> {
    return this.collectedPids;
  }
}
