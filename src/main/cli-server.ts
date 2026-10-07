/**
 * CLI Server - Unix domain socket server for CLI communication.
 *
 * Enables the CLI to communicate with the running Electron app.
 * Supports commands: status, pause, resume, jobs, quit, the targets
 * commands, and test-vm, which lends `localmost test` a macOS VM for as long
 * as its connection stays open.
 */

import * as crypto from 'crypto';
import * as net from 'net';
import * as fs from 'fs';
import { app } from 'electron';
import { getCliSocketPath } from './paths';
import { getRunnerManager, getHeartbeatManager, getAuthState, getRunnerState, getResourceMonitor } from './app-state';
import { pauseRunner, resumeRunner } from './runner-pause';
import { getSnapshot, isRunning as isRunnerStarted, isStarting as isRunnerStarting, selectEffectivePauseState } from './runner-state-service';
import { resourcePauseOverriddenText } from '../shared/resource-pause-text';
import { getTargetManager } from './target-manager';
import { getRunnerProxyManager } from './runner-proxy-manager';
import type { Target } from '../shared/types';
import { isGitHubOwnerName, isGitHubRepoName } from '../shared/github-names';
import type {
  CliRequest,
  CliResponse,
  StatusResponse,
  JobsResponse,
  ActionResponse,
  TargetsListResponse,
  TargetMutationResponse,
  ImageStatusResponse,
  ImageBuildResponse,
  ErrorResponse,
  TargetSummary,
} from '../shared/cli-protocol';
import type { MacVmSetupStatus } from '../shared/macos-vm-setup';
import type { IsolationAvailability, VmLease } from './isolation/macos-vm';

// Re-exported so importers of ./cli-server keep working.
export type {
  CliRequest,
  CliResponse,
  StatusResponse,
  JobsResponse,
  ActionResponse,
  TargetsListResponse,
  TargetMutationResponse,
  ImageStatusResponse,
  ImageBuildResponse,
  ErrorResponse,
  TargetSummary,
};

/**
 * Coerce a request field to a trimmed non-empty string, or null. Requests
 * arrive as arbitrary JSON over the socket, so nothing here can be assumed
 * to be the type the CLI would have sent.
 */
const asName = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** Longer than any request the CLI sends, by orders of magnitude. */
const MAX_REQUEST_LINE_CHARS = 64 * 1024;

/**
 * Requests one connection may have waiting before the server stops reading
 * it. The CLI sends one at a time; this is room for a script that pipelines.
 */
const MAX_QUEUED_REQUESTS = 32;

/** The macOS VMs a `localmost test` run can borrow: the job backend's. */
export interface TestVmProvider {
  available(): IsolationAvailability;
  /** Boots a VM for the lease and resolves with its agent socket. */
  prepareTestRun(lease: VmLease, signal?: AbortSignal): Promise<string>;
  release(lease: VmLease): Promise<void>;
}

/**
 * The golden-image manager the CLI's `image` commands reach: the same
 * MacVmImageManager the Settings GUI drives, so a headless CI Mac can build
 * and watch the image without the window. Unlike a test VM's lease, nothing
 * here is tied to the connection: build() runs on, and the image stays, when
 * the CLI disconnects.
 */
export interface ImageControl {
  status(): MacVmSetupStatus;
  ready(): unknown | null;
  build(): void;
  cancel(): void;
  on(event: 'status', listener: (status: MacVmSetupStatus) => void): unknown;
  off(event: 'status', listener: (status: MacVmSetupStatus) => void): unknown;
}

/** A build is settled once its status reaches one of these: nothing more streams. */
const isSettledImageState = (status: MacVmSetupStatus): boolean =>
  status.state === 'ready' || status.state === 'failed' || status.state === 'unsupported' || status.state === 'not-built';

/** A build (or a wait for the guided setup) is in flight. */
const isBuildingImageState = (status: MacVmSetupStatus): boolean =>
  status.state === 'building' || status.state === 'needs-guided-setup';

const formatGiB = (bytes: number): string => `${(bytes / 2 ** 30).toFixed(bytes < 10 * 2 ** 30 ? 1 : 0)} GB`;

const isPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;

/**
 * Describe a target for the CLI, including how many runner proxies are
 * registered for it.
 */
const toTargetSummary = (target: Target): TargetSummary => ({
  id: target.id,
  displayName: target.displayName,
  type: target.type,
  url: target.url,
  enabled: target.enabled,
  proxyRunnerName: target.proxyRunnerName,
  runnerCount: getRunnerProxyManager().loadAllCredentials(target.id).length,
  addedAt: target.addedAt,
});

/**
 * CLI Server class - manages Unix domain socket for CLI communication.
 */
export class CliServer {
  private server: net.Server | null = null;
  private socketPath: string;
  private onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  private testVms: TestVmProvider | undefined;
  private images: ImageControl | undefined;
  /** Open connections, so stop() can end them rather than wait on them. */
  private sockets = new Set<net.Socket>();
  /**
   * Connections holding (or booting) a test VM, one lease each, and how to
   * release it: once, resolving when the VM is gone.
   */
  private leasing = new Map<net.Socket, () => Promise<void>>();

  constructor(options: {
    onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
    testVms?: TestVmProvider;
    images?: ImageControl;
  }) {
    this.socketPath = getCliSocketPath();
    this.onLog = options.onLog;
    this.testVms = options.testVms;
    this.images = options.images;
  }

  /**
   * Start the CLI server.
   */
  async start(): Promise<void> {
    // Clean up stale socket file if it exists
    if (fs.existsSync(this.socketPath)) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch (err) {
        this.onLog('warn', `Failed to clean up stale socket: ${(err as Error).message}`);
      }
    }

    // Ensure parent directory exists
    const parentDir = this.socketPath.substring(0, this.socketPath.lastIndexOf('/'));
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        this.onLog('error', `CLI server error: ${err.message}`);
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        // Set socket permissions to user-only for security
        try {
          fs.chmodSync(this.socketPath, 0o600);
        } catch (chmodErr) {
          this.onLog('warn', `Failed to set socket permissions: ${(chmodErr as Error).message}`);
        }
        this.onLog('info', `CLI server listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  /**
   * Stop the CLI server. Open connections are destroyed rather than waited
   * for: a `localmost test` run holds its connection for the whole run, and
   * close() alone would hold up the app's quit until it finished. Destroying
   * a connection releases the VM it borrowed.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          // Clean up socket file
          if (fs.existsSync(this.socketPath)) {
            try {
              fs.unlinkSync(this.socketPath);
            } catch {
              // Socket cleanup failed - non-fatal
            }
          }
          this.server = null;
          resolve();
        });
        for (const socket of this.sockets) socket.destroy();
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle an incoming connection.
   */
  private handleConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => {
      this.sockets.delete(socket);
      this.leasing.delete(socket);
    });
    let buffer = '';
    // Requests on one connection run one at a time, in the order sent. Each
    // data event used to start its own, so a pause still stopping the runner
    // could be overtaken by the resume sent after it. While the queue is full
    // the socket is not read, so a client sending faster than it is answered
    // waits in its own buffers rather than growing ours.
    const queue: string[] = [];
    let draining = false;
    let paused = false;
    let refused = false;
    // Decoded as one stream, so a character split across two reads survives.
    socket.setEncoding('utf8');

    const answer = async (line: string): Promise<void> => {
      try {
        const request = JSON.parse(line) as CliRequest;
        // image-build streams many lines on this connection and writes them
        // itself, so it is not one response for answer() to write.
        if (request?.command === 'image-build') {
          this.streamImageBuild(socket, request.args);
          return;
        }
        const response = request?.command === 'test-vm'
          ? await this.lendTestVm(socket, request.args)
          : request?.command === 'test-vm-release'
            ? await this.releaseTestVm(socket)
            : await this.handleCommand(request);
        socket.write(JSON.stringify(response) + '\n');
      } catch (parseError) {
        const errorResponse: ErrorResponse = {
          success: false,
          error: `Invalid request: ${(parseError as Error).message}`,
        };
        socket.write(JSON.stringify(errorResponse) + '\n');
      }
    };

    const drain = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      while (queue.length > 0 && !socket.destroyed) {
        await answer(queue.shift()!);
        if (paused && queue.length < MAX_QUEUED_REQUESTS) {
          paused = false;
          socket.resume();
        }
      }
      queue.length = 0;
      draining = false;
    };

    socket.on('data', (data: string) => {
      if (refused) return;
      buffer += data;

      // Try to parse complete JSON messages
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      // A request is a line of JSON a few hundred bytes long. Buffering an
      // unterminated one without limit let any client grow the app's memory
      // until it was killed.
      if (buffer.length > MAX_REQUEST_LINE_CHARS) {
        refused = true;
        buffer = '';
        const errorResponse: ErrorResponse = { success: false, error: 'Invalid request: too large' };
        // The rest of the upload is read and dropped rather than left unread,
        // which would reset the connection before the client saw the answer;
        // a client that keeps sending is cut off shortly after.
        socket.end(JSON.stringify(errorResponse) + '\n');
        setTimeout(() => socket.destroy(), 1000).unref();
        return;
      }

      for (const line of lines) {
        if (line.trim()) queue.push(line);
      }
      if (queue.length >= MAX_QUEUED_REQUESTS && !paused) {
        paused = true;
        socket.pause();
      }
      void drain();
    });

    socket.on('error', (err) => {
      this.onLog('warn', `CLI client error: ${err.message}`);
    });
  }

  /**
   * Boot a macOS VM for a `localmost test` run and answer with its agent
   * socket. The VM is the connection's: it is released when the connection
   * closes, and a connection that closes while the VM boots cancels it.
   */
  private async lendTestVm(socket: net.Socket, args: CliRequest['args']): Promise<CliResponse> {
    this.onLog('info', 'CLI request: test-vm');
    const vms = this.testVms;
    if (!vms) return { success: false, error: 'This app has no macOS VMs to run a workflow in' };
    const proxyPort = args?.proxyPort;
    const brokerPort = args?.brokerPort;
    if (!isPort(proxyPort) || !isPort(brokerPort) || proxyPort === brokerPort) {
      return { success: false, error: 'Missing or invalid ports for the test run' };
    }
    // A run needs one VM. Leasing more on the same connection would let one
    // client hold every slot the runner has.
    if (this.leasing.has(socket)) {
      return { success: false, error: 'This connection already has a macOS VM' };
    }
    const availability = vms.available();
    if (!availability.ok) {
      return { success: false, error: `No macOS VM can run the workflow: ${availability.reason}` };
    }
    const lease: VmLease = { key: `test-${crypto.randomBytes(6).toString('hex')}`, proxyPort, brokerPort };
    const abort = new AbortController();
    let released: Promise<void> | null = null;
    const release = (): Promise<void> => {
      released ??= (() => {
        abort.abort();
        return vms.release(lease).catch((err: Error) => this.onLog('warn', `Releasing the macOS VM of ${lease.key} failed: ${err.message}`));
      })();
      return released;
    };
    this.leasing.set(socket, release);
    socket.once('close', () => void release());
    try {
      const agentSocket = await vms.prepareTestRun(lease, abort.signal);
      if (socket.destroyed) {
        void release();
        this.leasing.delete(socket);
        return { success: false, error: 'The test run went away while its macOS VM started' };
      }
      this.onLog('info', `Lent a macOS VM to localmost test (${lease.key})`);
      return { success: true, command: 'test-vm', data: { agentSocket } };
    } catch (err) {
      void release();
      this.leasing.delete(socket);
      return { success: false, error: `Could not lend the test run a macOS VM: ${(err as Error).message}` };
    }
  }

  /**
   * Release the test VM this connection holds, and answer once it is gone:
   * the run keeps its proxy and broker ports until then, so no other
   * process can take a port the VM's relays still lead to.
   */
  private async releaseTestVm(socket: net.Socket): Promise<CliResponse> {
    const release = this.leasing.get(socket);
    if (!release) return { success: false, error: 'This connection has no macOS VM' };
    await release();
    return { success: true, command: 'test-vm-release' };
  }

  /**
   * Build the golden image (or follow a build already running) and stream its
   * progress on this connection: a line each time the status changes, then a
   * last line with `done: true` once it settles.
   *
   * The build belongs to the app, not this connection. Closing the connection
   * only detaches from the stream - the status listener is removed and nothing
   * is cancelled - so a build survives the CLI disconnecting, which is the
   * whole point on a headless CI Mac. Cancelling is its own command.
   */
  private streamImageBuild(socket: net.Socket, args: CliRequest['args']): void {
    const images = this.images;
    if (!images) {
      socket.write(JSON.stringify({ success: false, error: 'This app has no macOS VM image to build' } as ErrorResponse) + '\n');
      return;
    }
    const status = images.status();

    // A build is already running: do not start a second one; follow this one.
    if (isBuildingImageState(status)) {
      this.onLog('info', 'CLI request: image-build (a build is already running; streaming it)');
      this.streamStatusUntilSettled(socket, images, 'already-running');
      return;
    }

    // An image is already ready: say so and finish, unless a rebuild is asked.
    if (images.ready() && args?.rebuild !== true) {
      this.onLog('info', 'CLI request: image-build (an image is already ready)');
      socket.write(JSON.stringify({ success: true, command: 'image-build', data: { status, done: true, note: 'already-ready' } } as ImageBuildResponse) + '\n');
      return;
    }

    // Fail fast with the specific reason the status gives when this Mac cannot
    // build, rather than letting build() throw a bare message or stall.
    const refusal = this.buildRefusal(status);
    if (refusal) {
      this.onLog('info', `CLI request: image-build refused: ${refusal}`);
      socket.write(JSON.stringify({ success: false, error: refusal } as ErrorResponse) + '\n');
      return;
    }

    try {
      images.build();
    } catch (err) {
      // build()'s own guards (e.g. the runner is not downloaded) surface here.
      socket.write(JSON.stringify({ success: false, error: (err as Error).message } as ErrorResponse) + '\n');
      return;
    }
    this.onLog('info', 'CLI request: image-build (started)');
    this.streamStatusUntilSettled(socket, images);
  }

  /** The reason this Mac cannot build the image now, or null when it can. */
  private buildRefusal(status: MacVmSetupStatus): string | null {
    if (status.state === 'unsupported') {
      return status.reason ?? 'this Mac cannot build a macOS VM image';
    }
    const { freeBytes, neededBytes } = status.disk;
    if (neededBytes > 0 && freeBytes < neededBytes) {
      return `not enough free disk to build the golden image: ${formatGiB(freeBytes)} free, about ${formatGiB(neededBytes)} needed`;
    }
    return null;
  }

  /**
   * Write the current status at once, then one line per status change, until
   * the build settles; `note` rides the first line. Removes its listener when
   * the build ends or the connection closes - and closing, nothing else.
   */
  private streamStatusUntilSettled(socket: net.Socket, images: ImageControl, note?: 'already-running'): void {
    let finished = false;
    const write = (status: MacVmSetupStatus, done: boolean, withNote?: ImageBuildResponse['data']['note']): void => {
      const data: ImageBuildResponse['data'] = { status, done, ...(withNote ? { note: withNote } : {}) };
      socket.write(JSON.stringify({ success: true, command: 'image-build', data } as ImageBuildResponse) + '\n');
    };
    const finish = (status: MacVmSetupStatus): void => {
      if (finished) return;
      finished = true;
      images.off('status', listener);
      write(status, true);
    };
    const listener = (status: MacVmSetupStatus): void => {
      if (finished || socket.destroyed) return;
      if (isSettledImageState(status)) finish(status);
      else write(status, false);
    };
    images.on('status', listener);
    socket.once('close', () => {
      // Detaching from the stream must not cancel the build.
      if (!finished) {
        finished = true;
        images.off('status', listener);
      }
    });
    // The status right now: either already settled, or the first progress line.
    const now = images.status();
    if (isSettledImageState(now)) finish(now);
    else write(now, false, note);
  }

  /**
   * Handle a CLI command.
   */
  private async handleCommand(request: CliRequest): Promise<CliResponse> {
    this.onLog('info', `CLI request: ${request.command}`);

    const runnerManager = getRunnerManager();
    const heartbeatManager = getHeartbeatManager();
    const authState = getAuthState();

    switch (request.command) {
      case 'status': {
        // Status from the runner; the machine is never told about jobs.
        const snapshot = getSnapshot();
        const runnerState = getRunnerState();
        const pauseState = snapshot ? selectEffectivePauseState(snapshot) : { isPaused: false, reason: null };
        const runnerName = runnerManager?.getStatusDisplayName() || 'unknown';
        const overridden = getResourceMonitor()?.getPauseState().overridden ?? null;

        return {
          success: true,
          command: 'status',
          data: {
            runner: runnerState,
            runnerName,
            heartbeat: {
              isRunning: heartbeatManager?.isRunning() || false,
            },
            // Authenticated means the app can act as this user. A session
            // whose refresh token is spent cannot, so it is reported apart
            // from "not connected at all" - the login is still known, and
            // reconnecting is a different action from signing in fresh.
            authenticated: !!authState && !authState.expired,
            authExpired: !!authState?.expired,
            userName: authState?.user?.login,
            // A pause is recorded whatever state the runner is in; the CLI
            // shows it in place of the status only for the runner it holds.
            runnerStarted: isRunnerStarted() || isRunnerStarting(),
            resourcePause: {
              isPaused: pauseState.isPaused,
              reason: pauseState.reason,
              conditions: [],
              overridden,
            },
          },
        };
      }

      case 'jobs': {
        const jobs = runnerManager?.getJobHistory() || [];
        return {
          success: true,
          command: 'jobs',
          data: { jobs },
        };
      }

      case 'pause': {
        if (!runnerManager) {
          return { success: false, error: 'Runner manager not initialized' };
        }

        // The pause the tray sets. Whether the runner is paused is that flag,
        // not whether it has workers: they are spawned per job, so an idle
        // runner has none and this used to call it paused while it took jobs.
        try {
          const outcome = await pauseRunner();
          if (outcome === 'not-started') {
            return { success: false, error: 'Runner is not started, so there is nothing to pause' };
          }
          return {
            success: true,
            command: 'pause',
            message: outcome === 'already-paused'
              ? 'Runner is already paused'
              : 'Runner paused: it takes no new jobs, and a job already running finishes',
          };
        } catch (err) {
          return { success: false, error: `Failed to pause: ${(err as Error).message}` };
        }
      }

      case 'resume': {
        if (!runnerManager) {
          return { success: false, error: 'Runner manager not initialized' };
        }

        if (!runnerManager.isConfigured()) {
          return { success: false, error: 'Runner is not configured. Please complete setup in the app.' };
        }

        try {
          const outcome = await resumeRunner();
          if (outcome === 'not-started') {
            return { success: false, error: 'Runner is not started. Start it from the app.' };
          }
          // A resume overrides the resource conditions holding, until each
          // clears; say which, since one recurring then pauses it again.
          const overridden = getResourceMonitor()?.getPauseState().overridden;
          const message = outcome === 'already-running'
            ? 'Runner is already running'
            : outcome === 'starting'
              ? 'Runner is still starting, and is not paused'
              : overridden
                ? resourcePauseOverriddenText(overridden)
                : 'Runner resumed';
          return { success: true, command: 'resume', message };
        } catch (err) {
          return { success: false, error: `Failed to resume: ${(err as Error).message}` };
        }
      }

      case 'targets-list': {
        const targets = getTargetManager().getTargets().map(toTargetSummary);
        return {
          success: true,
          command: 'targets-list',
          data: { targets },
        };
      }

      case 'targets-add': {
        const { type, owner, repo } = request.args || {};

        if (type !== 'repo' && type !== 'org') {
          return { success: false, error: 'Invalid target type: expected "repo" or "org"' };
        }

        const ownerName = asName(owner);
        if (!ownerName) {
          return { success: false, error: 'Missing or invalid target owner' };
        }
        // The names become GitHub API paths requested with the user's token;
        // anything GitHub would not accept as a name is refused here.
        if (!isGitHubOwnerName(ownerName)) {
          return { success: false, error: `"${ownerName}" is not a valid GitHub user or organization name` };
        }

        const repoName = asName(repo);
        if (type === 'repo' && !repoName) {
          return { success: false, error: 'Missing or invalid repo name for a repo target' };
        }
        if (type === 'repo' && !isGitHubRepoName(repoName)) {
          return { success: false, error: `"${repoName}" is not a valid GitHub repository name` };
        }

        const result = await getTargetManager().addTargetAndAttach(
          type,
          ownerName,
          type === 'repo' ? repoName! : undefined
        );
        if (!result.success) {
          return { success: false, error: result.error };
        }
        if (!result.data) {
          return { success: false, error: 'Failed to add target' };
        }

        return {
          success: true,
          command: 'targets-add',
          data: { target: toTargetSummary(result.data) },
        };
      }

      case 'targets-remove': {
        const ref = asName(request.args?.ref);
        if (!ref) {
          return { success: false, error: 'Missing or invalid target reference' };
        }

        const target = getTargetManager().findTargetByRef(ref);
        if (!target) {
          return { success: false, error: `No target matching "${ref}"` };
        }

        // Capture the summary before the credentials are deleted.
        const summary = toTargetSummary(target);

        const result = await getTargetManager().removeTargetAndDetach(target.id);
        if (!result.success) {
          return { success: false, error: result.error };
        }

        return {
          success: true,
          command: 'targets-remove',
          data: { target: summary },
        };
      }

      case 'targets-update': {
        const { enabled } = request.args || {};
        const ref = asName(request.args?.ref);
        if (!ref) {
          return { success: false, error: 'Missing or invalid target reference' };
        }
        if (typeof enabled !== 'boolean') {
          return { success: false, error: 'Missing or invalid enabled state' };
        }

        const target = getTargetManager().findTargetByRef(ref);
        if (!target) {
          return { success: false, error: `No target matching "${ref}"` };
        }

        const result = await getTargetManager().updateTarget(target.id, { enabled });
        if (!result.success) {
          return { success: false, error: result.error };
        }
        if (!result.data) {
          return { success: false, error: 'Failed to update target' };
        }

        return {
          success: true,
          command: 'targets-update',
          data: { target: toTargetSummary(result.data) },
        };
      }

      case 'image-status': {
        if (!this.images) {
          return { success: false, error: 'This app has no macOS VM image' };
        }
        return { success: true, command: 'image-status', data: { status: this.images.status() } };
      }

      case 'image-cancel': {
        if (!this.images) {
          return { success: false, error: 'This app has no macOS VM image' };
        }
        if (!isBuildingImageState(this.images.status())) {
          return { success: true, command: 'image-cancel', message: 'No golden image build is running.' };
        }
        this.images.cancel();
        return { success: true, command: 'image-cancel', message: 'Cancelling the golden image build.' };
      }

      case 'quit': {
        // Send response before quitting
        const response: ActionResponse = {
          success: true,
          command: 'quit',
          message: 'localmost is shutting down...',
        };

        // Schedule quit after response is sent
        setImmediate(() => {
          app.quit();
        });

        return response;
      }

      default:
        return { success: false, error: `Unknown command: ${(request as CliRequest).command}` };
    }
  }
}
