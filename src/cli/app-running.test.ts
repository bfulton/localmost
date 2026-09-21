import { describe, it, expect, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as net from 'net';
import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { isSocketLive } from './app-running';

/**
 * A force quit leaves the CLI socket file behind. Deciding the app is running
 * from that file alone meant `localmost start` answered "localmost is already
 * running" forever after a hard kill - with nothing running - and the only way
 * out was knowing to delete a file. Seen for real after the app was force quit
 * for burning a core.
 */
describe('isSocketLive', () => {
  const made: string[] = [];
  const servers: net.Server[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null)));
    for (const p of made.splice(0)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // Already gone, which is what some of these tests assert.
      }
    }
  });

  const tempPath = (name: string): string => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sock-')), name);
    made.push(p);
    return p;
  };

  it('is false, and removes the file, when nothing is listening', async () => {
    const socketPath = tempPath('stale.sock');
    // A leftover file where a socket used to be.
    fs.writeFileSync(socketPath, '');

    expect(await isSocketLive(socketPath)).toBe(false);
    // Removed, so the next start is not refused by a socket nobody is on.
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('is false, and removes it, for a socket whose process was killed', async () => {
    // The real case: a hard kill leaves the socket inode behind, and connecting
    // to it is refused. Built by killing a listener rather than by faking a
    // file, because the two produce different errno and only this one is what
    // a force quit actually leaves.
    const socketPath = tempPath('orphan.sock');
    const child = spawn(process.execPath, [
      '-e',
      `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('up'))`,
    ]);
    await new Promise((r) => child.stdout.once('data', r));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    expect(fs.existsSync(socketPath)).toBe(true);

    expect(await isSocketLive(socketPath)).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('is false when the path does not exist', async () => {
    expect(await isSocketLive(tempPath('absent.sock'))).toBe(false);
  });

  it('is true while something is listening, and leaves it alone', async () => {
    const socketPath = tempPath('live.sock');
    const server = net.createServer();
    servers.push(server);
    await new Promise((r) => server.listen(socketPath, () => r(null)));

    expect(await isSocketLive(socketPath)).toBe(true);
    expect(fs.existsSync(socketPath)).toBe(true);
  });
});
