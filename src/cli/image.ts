/**
 * CLI `image` command: build and watch the golden macOS VM image from the
 * terminal, so the VM-only runner can be provisioned on a headless CI Mac
 * without the Settings GUI. It drives the same MacVmImageManager the GUI
 * does, over the app's CLI socket.
 *
 *   localmost image status            # the manager's current status
 *   localmost image build             # start/follow a build, streaming progress
 *   localmost image build --rebuild   # build even when an image is ready
 *   localmost image cancel            # cancel a running build
 *
 * A build belongs to the app, not this process: Ctrl-C detaches from the
 * stream and leaves the build running, to be checked or cancelled later. The
 * build survives the CLI disconnecting.
 */

import * as net from 'net';
import { getCliSocketPath } from '../shared/paths';
import type {
  CliRequest,
  CliResponse,
  ImageStatusResponse,
  ActionResponse,
} from '../shared/cli-protocol';
import type { MacVmSetupState, MacVmSetupStatus } from '../shared/macos-vm-setup';

export type ImageSubcommand = 'status' | 'build' | 'cancel';

export interface ImageOptions {
  rebuild?: boolean;
  json?: boolean;
}

/** Parse `image` arguments into a subcommand and its options. */
export function parseImageArgs(args: string[]): { subcommand: ImageSubcommand; options: ImageOptions } {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'status' && subcommand !== 'build' && subcommand !== 'cancel') {
    throw new Error(`Unknown image subcommand: ${subcommand ?? '(none)'}. Use status, build, or cancel.`);
  }
  const options: ImageOptions = {};
  for (const arg of rest) {
    if (arg === '--rebuild') options.rebuild = true;
    else if (arg === '--json') options.json = true;
    else throw new Error(`Unknown option for localmost image: ${arg}. See localmost image --help.`);
  }
  if (options.rebuild && subcommand !== 'build') {
    throw new Error('--rebuild applies only to localmost image build.');
  }
  return { subcommand, options };
}

const formatGiB = (bytes: number): string => `${(bytes / 2 ** 30).toFixed(bytes < 10 * 2 ** 30 ? 1 : 0)} GB`;

function describeState(state: MacVmSetupState): string {
  switch (state) {
    case 'unsupported':
      return 'unsupported (this Mac cannot build a macOS VM image)';
    case 'not-built':
      return 'not built';
    case 'building':
      return 'building';
    case 'needs-guided-setup':
      return 'waiting for the guided setup window (open it in the app: Settings > macOS VM)';
    case 'ready':
      return 'ready';
    case 'failed':
      return 'failed';
    default:
      return state;
  }
}

/** A one-line view of what a build is doing now, or null before it has a phase. */
export function progressLine(status: MacVmSetupStatus): string | null {
  if (!status.phase) return status.step ? status.step : null;
  const percent = status.percent !== undefined ? ` [${status.percent}%]` : '';
  return `${status.phase}${status.step ? ` - ${status.step}` : ''}${percent}`;
}

/** Pretty-print the image status as lines. */
export function formatImageStatus(status: MacVmSetupStatus): string[] {
  const lines: string[] = [];
  lines.push('localmost golden macOS VM image');
  lines.push('');
  lines.push(`  State:  ${describeState(status.state)}`);
  const progress = progressLine(status);
  if (status.state === 'building' && progress) {
    lines.push(`  Doing:  ${progress}`);
  }
  if (status.image) {
    const slots = status.image.slots.length > 0 ? status.image.slots.join(', ') : 'none';
    const stale = status.image.stale ? ' (built on an older macOS; a rebuild is recommended)' : '';
    lines.push(`  Image:  macOS ${status.image.os} (${status.image.build}), ${formatGiB(status.image.diskAllocatedBytes)} on disk, slot(s) ${slots}${stale}`);
  }
  const { freeBytes, neededBytes } = status.disk;
  lines.push(`  Disk:   ${formatGiB(freeBytes)} free${neededBytes > 0 ? ` / about ${formatGiB(neededBytes)} needed to build` : ''}`);
  lines.push(`  Ready:  ${status.state === 'ready' ? 'yes' : 'no'}`);
  if (status.reason) lines.push(`  Error:  ${status.reason}`);
  return lines;
}

/** How the CLI talks to the app and the terminal; injectable for tests. */
export interface ImageIo {
  send: (request: CliRequest) => Promise<CliResponse>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * Run `image status` or `image cancel` (one request, one answer) and
 * `image build` (a streamed build). Returns the process exit code.
 */
export async function runImage(subcommand: ImageSubcommand, options: ImageOptions, io: ImageIo): Promise<number> {
  if (subcommand === 'build') {
    return runImageBuild({ rebuild: options.rebuild, out: io.out, err: io.err });
  }

  const command: CliRequest['command'] = subcommand === 'status' ? 'image-status' : 'image-cancel';
  const response = await io.send({ command });
  if (!response.success) {
    io.err(`Error: ${response.error}`);
    return 1;
  }

  if (subcommand === 'status') {
    const { status } = (response as ImageStatusResponse).data;
    if (options.json) io.out(JSON.stringify(status, null, 2));
    else for (const line of formatImageStatus(status)) io.out(line);
  } else {
    io.out((response as ActionResponse).message);
  }
  return 0;
}

/** Install a Ctrl-C handler that detaches from the build; returns a remover. */
function defaultInstallInterrupt(onDetach: () => void): () => void {
  const handler = (): void => onDetach();
  process.once('SIGINT', handler);
  return () => process.removeListener('SIGINT', handler);
}

/**
 * Start (or follow) a golden-image build over the CLI socket, streaming its
 * progress until it settles. Returns 0 on a ready image, non-zero otherwise.
 *
 * Closing the socket only detaches: the app does not cancel the build when
 * the connection goes away, so Ctrl-C leaves it running.
 */
export function runImageBuild(opts: {
  rebuild?: boolean;
  socketPath?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  installInterrupt?: (onDetach: () => void) => () => void;
}): Promise<number> {
  const out = opts.out ?? ((line: string) => console.log(line));
  const err = opts.err ?? ((line: string) => console.error(line));
  const socketPath = opts.socketPath ?? getCliSocketPath();

  return new Promise<number>((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    let buffer = '';
    let lastProgress = '';
    let settled = false;
    let removeInterrupt = (): void => {};

    const done = (code: number): void => {
      if (settled) return;
      settled = true;
      removeInterrupt();
      socket.destroy();
      resolve(code);
    };

    // Ctrl-C detaches from the stream; it never cancels the build.
    removeInterrupt = (opts.installInterrupt ?? defaultInstallInterrupt)(() => {
      out('');
      out('Detached. The golden image build keeps running in the localmost app.');
      out('  Check it:  localmost image status');
      out('  Cancel it: localmost image cancel');
      done(130);
    });

    const handle = (response: CliResponse): void => {
      if (!response.success) {
        err(`Error: ${response.error}`);
        done(1);
        return;
      }
      if (response.command !== 'image-build') return;
      const { status, done: isDone, note } = response.data;
      if (note === 'already-running') {
        out('A golden image build is already running; following it.');
      } else if (note === 'already-ready') {
        out('A golden image is already ready. Pass --rebuild to build a new one.');
      }
      const line = progressLine(status);
      if (!isDone && line && line !== lastProgress) {
        lastProgress = line;
        out(`  ${line}`);
      }
      if (isDone) {
        if (status.state === 'ready') {
          out(note === 'already-ready' ? '' : 'The golden image is ready.');
          done(0);
        } else {
          err(status.reason ? `The build did not finish: ${status.reason}` : `The build did not finish (state: ${status.state}).`);
          done(1);
        }
      }
    };

    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ command: 'image-build', args: { rebuild: !!opts.rebuild } } as CliRequest)}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let response: CliResponse;
        try {
          response = JSON.parse(line) as CliResponse;
        } catch {
          continue;
        }
        handle(response);
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        err('localmost app is not running (start it with "localmost start")');
      } else {
        err(`Error: ${error.message}`);
      }
      done(1);
    });
    socket.on('close', () => {
      if (!settled) {
        err('The localmost app closed the connection before the build finished.');
        done(1);
      }
    });
  });
}

/** Print `image` command help. */
export function printImageHelp(): void {
  console.log(`
localmost image - Build and watch the golden macOS VM image

USAGE:
  localmost image <status|build|cancel> [options]

SUBCOMMANDS:
  status            Show the golden image's current state, progress and disk
  build             Build the golden image if none is ready, streaming progress
  cancel            Cancel a running golden image build

OPTIONS:
  --rebuild         (build) Build a new image even when one is already ready
  --json            (status) Print the raw status as JSON

NOTES:
  A build runs in the localmost app, not this command. Pressing Ctrl-C during
  "image build" detaches from the stream and leaves the build running; check
  it with "localmost image status" and stop it with "localmost image cancel".
  The build fails fast if this Mac cannot build the image (unsupported host,
  missing helper, or too little free disk), naming the reason.

EXAMPLES:
  localmost image status
  localmost image build
  localmost image build --rebuild
  localmost image cancel
`);
}
