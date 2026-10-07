import { describe, it, expect, afterEach } from '@jest/globals';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseImageArgs,
  formatImageStatus,
  progressLine,
  runImage,
  runImageBuild,
  type ImageIo,
} from './image';
import type { CliRequest, CliResponse } from '../shared/cli-protocol';
import type { MacVmSetupStatus } from '../shared/macos-vm-setup';

const baseStatus = (over: Partial<MacVmSetupStatus> = {}): MacVmSetupStatus => ({
  state: 'not-built',
  disk: { freeBytes: 200 * 2 ** 30, neededBytes: 60 * 2 ** 30 },
  provisioning: 'headless',
  busy: false,
  ...over,
});

describe('parseImageArgs', () => {
  it('parses the subcommands and their options', () => {
    expect(parseImageArgs(['status'])).toEqual({ subcommand: 'status', options: {} });
    expect(parseImageArgs(['status', '--json'])).toEqual({ subcommand: 'status', options: { json: true } });
    expect(parseImageArgs(['build'])).toEqual({ subcommand: 'build', options: {} });
    expect(parseImageArgs(['build', '--rebuild'])).toEqual({ subcommand: 'build', options: { rebuild: true } });
    expect(parseImageArgs(['cancel'])).toEqual({ subcommand: 'cancel', options: {} });
  });

  it('rejects an unknown subcommand, an unknown option, and --rebuild outside build', () => {
    expect(() => parseImageArgs([])).toThrow(/Unknown image subcommand/);
    expect(() => parseImageArgs(['frobnicate'])).toThrow(/Unknown image subcommand/);
    expect(() => parseImageArgs(['status', '--nope'])).toThrow(/Unknown option/);
    expect(() => parseImageArgs(['status', '--rebuild'])).toThrow(/--rebuild applies only/);
  });
});

describe('formatImageStatus / progressLine', () => {
  it('shows state, disk and readiness, and the error when present', () => {
    const lines = formatImageStatus(baseStatus({ state: 'failed', reason: 'the first boot ended badly' }));
    const text = lines.join('\n');
    expect(text).toMatch(/State:\s+failed/);
    expect(text).toMatch(/Ready:\s+no/);
    expect(text).toMatch(/Disk:\s+200 GB free \/ about 60 GB needed/);
    expect(text).toMatch(/Error:\s+the first boot ended badly/);
  });

  it('shows the image and marks a ready image ready', () => {
    const lines = formatImageStatus(
      baseStatus({ state: 'ready', disk: { freeBytes: 180 * 2 ** 30, neededBytes: 0 }, image: { os: '26', build: '23A1', diskAllocatedBytes: 20 * 2 ** 30, slots: [1, 2], stale: false } })
    );
    const text = lines.join('\n');
    expect(text).toMatch(/Ready:\s+yes/);
    expect(text).toMatch(/Image:\s+macOS 26 \(23A1\).*slot\(s\) 1, 2/);
  });

  it('renders a one-line progress view while building', () => {
    expect(progressLine(baseStatus({ state: 'building', phase: 'download', step: 'Downloading macOS 26', percent: 42 }))).toBe('download - Downloading macOS 26 [42%]');
    expect(progressLine(baseStatus({ state: 'not-built' }))).toBeNull();
  });
});

describe('runImage (status and cancel, one request each)', () => {
  const collect = (): { io: ImageIo; out: string[]; err: string[]; sent: CliRequest[]; reply: (r: CliResponse) => void } => {
    const out: string[] = [];
    const err: string[] = [];
    const sent: CliRequest[] = [];
    let next: CliResponse = { success: false, error: 'unset' };
    return {
      out,
      err,
      sent,
      reply: (r) => (next = r),
      io: {
        send: async (request) => {
          sent.push(request);
          return next;
        },
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      },
    };
  };

  it('prints the formatted status, or JSON with --json', async () => {
    const c = collect();
    c.reply({ success: true, command: 'image-status', data: { status: baseStatus({ state: 'building', phase: 'install', step: 'Installing', percent: 10 }) } });
    expect(await runImage('status', {}, c.io)).toBe(0);
    expect(c.sent).toEqual([{ command: 'image-status' }]);
    expect(c.out.join('\n')).toMatch(/State:\s+building/);

    const j = collect();
    j.reply({ success: true, command: 'image-status', data: { status: baseStatus() } });
    expect(await runImage('status', { json: true }, j.io)).toBe(0);
    expect(JSON.parse(j.out.join('\n')).state).toBe('not-built');
  });

  it('prints the cancel message', async () => {
    const c = collect();
    c.reply({ success: true, command: 'image-cancel', message: 'Cancelling the golden image build.' });
    expect(await runImage('cancel', {}, c.io)).toBe(0);
    expect(c.sent).toEqual([{ command: 'image-cancel' }]);
    expect(c.out).toEqual(['Cancelling the golden image build.']);
  });

  it('reports an error answer and exits non-zero', async () => {
    const c = collect();
    c.reply({ success: false, error: 'This app has no macOS VM image' });
    expect(await runImage('status', {}, c.io)).toBe(1);
    expect(c.err).toEqual(['Error: This app has no macOS VM image']);
  });
});

describe('runImageBuild streams a build and detaches on Ctrl-C without cancelling', () => {
  let server: net.Server | null = null;
  const socketPath = path.join(os.tmpdir(), `localmost-image-test-${process.pid}.sock`);

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  });

  /** A fake app socket: `onRequest` gets the parsed request and the connection to stream on. */
  const fakeApp = async (onRequest: (request: CliRequest, socket: net.Socket, received: string[]) => void): Promise<void> => {
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      const received: string[] = [];
      let buffer = '';
      socket.on('data', (d: string) => {
        buffer += d;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim()) {
            received.push(line);
            onRequest(JSON.parse(line) as CliRequest, socket, received);
          }
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
  };

  const write = (socket: net.Socket, response: CliResponse): void => {
    socket.write(`${JSON.stringify(response)}\n`);
  };

  it('exits 0 once the image is ready', async () => {
    await fakeApp((request, socket) => {
      expect(request).toEqual({ command: 'image-build', args: { rebuild: false } });
      write(socket, { success: true, command: 'image-build', data: { status: baseStatus({ state: 'building', phase: 'catalog', step: 'Asking' }), done: false } });
      write(socket, { success: true, command: 'image-build', data: { status: baseStatus({ state: 'ready', disk: { freeBytes: 180 * 2 ** 30, neededBytes: 0 } }), done: true } });
    });
    const out: string[] = [];
    const code = await runImageBuild({ socketPath, out: (l) => out.push(l), err: () => undefined, installInterrupt: () => () => undefined });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/The golden image is ready/);
  });

  it('exits non-zero when the build fails', async () => {
    await fakeApp((request, socket) => {
      write(socket, { success: true, command: 'image-build', data: { status: baseStatus({ state: 'failed', reason: 'boom' }), done: true } });
    });
    const err: string[] = [];
    const code = await runImageBuild({ socketPath, out: () => undefined, err: (l) => err.push(l), installInterrupt: () => () => undefined });
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/boom/);
  });

  it('on Ctrl-C it detaches (exit 130) and never sends a cancel, so the build survives', async () => {
    let fire: (() => void) | null = null;
    const serverReceived: string[][] = [];
    await fakeApp((request, socket, received) => {
      serverReceived.push(received);
      // Stream one progress line, then stall: the build keeps running on the app side.
      write(socket, { success: true, command: 'image-build', data: { status: baseStatus({ state: 'building', phase: 'download', step: 'Downloading', percent: 3 }), done: false } });
    });
    const out: string[] = [];
    const codePromise = runImageBuild({
      socketPath,
      out: (l) => out.push(l),
      err: () => undefined,
      installInterrupt: (onDetach) => {
        fire = onDetach;
        return () => undefined;
      },
    });
    // Wait for the first streamed line to arrive, then press Ctrl-C.
    for (let i = 0; i < 200 && out.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(fire).not.toBeNull();
    fire!();
    const code = await codePromise;
    expect(code).toBe(130);
    expect(out.join('\n')).toMatch(/Detached. The golden image build keeps running/);
    // The client sent only the build request; it never sent a cancel.
    const sent = serverReceived[0] ?? [];
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]).command).toBe('image-build');
  });
});
