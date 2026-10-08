/**
 * Whether the app is actually reachable on its CLI socket.
 *
 * The file existing is not the question. A force quit or a crash leaves the
 * socket behind, and treating that as "running" meant `localmost start`
 * answered "localmost is already running" forever afterwards, with nothing
 * running and no way out except knowing to delete a file.
 */
import * as fs from 'fs';
import * as net from 'net';

/** How long to wait for a connection before calling the socket dead. */
const CONNECT_TIMEOUT_MS = 1000;

export async function isSocketLive(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return false;

  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (live: boolean, stale = false) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (stale) {
        // Nobody is on the other end, so the file is debris from a hard exit.
        // Removing it here is what makes the next start work without anyone
        // having to know this file exists.
        try {
          fs.unlinkSync(socketPath);
        } catch {
          // Raced with another process doing the same thing, which is fine.
        }
      }
      resolve(live);
    };

    socket.once('connect', () => finish(true));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      // Refused, absent, or not a socket at all: debris at a path that is ours
      // to manage, and leaving it there is what blocks every later start.
      // Anything else - a permissions problem, say - is not evidence the app is
      // gone, so the file stays.
      const stale = err.code === 'ECONNREFUSED' || err.code === 'ENOENT' || err.code === 'ENOTSOCK';
      finish(false, stale);
    });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(false));
  });
}
