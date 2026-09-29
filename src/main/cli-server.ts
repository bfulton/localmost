/**
 * CLI Server - Unix domain socket server for CLI communication.
 *
 * Enables the CLI to communicate with the running Electron app.
 * Supports commands: status, pause, resume, jobs, quit
 */

import * as net from 'net';
import * as fs from 'fs';
import { app } from 'electron';
import { getCliSocketPath } from './paths';
import { getRunnerManager, getHeartbeatManager, getAuthState, getRunnerState, getResourceMonitor } from './app-state';
import { pauseRunner, resumeRunner } from './runner-pause';
import { getSnapshot, selectEffectivePauseState } from './runner-state-service';
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
  ErrorResponse,
  TargetSummary,
} from '../shared/cli-protocol';

// Re-exported so importers of ./cli-server keep working.
export type {
  CliRequest,
  CliResponse,
  StatusResponse,
  JobsResponse,
  ActionResponse,
  TargetsListResponse,
  TargetMutationResponse,
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

  constructor(options: {
    onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  }) {
    this.socketPath = getCliSocketPath();
    this.onLog = options.onLog;
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
   * Stop the CLI server.
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
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle an incoming connection.
   */
  private handleConnection(socket: net.Socket): void {
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
        const response = await this.handleCommand(request);
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
            resourcePause: {
              isPaused: pauseState.isPaused,
              reason: pauseState.reason,
              conditions: [],
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
          let message = outcome === 'already-running' ? 'Runner is already running' : 'Runner resumed';
          // Resuming lifts the pause, not the condition behind a resource
          // pause, and new jobs wait on the condition.
          const resourceMonitor = getResourceMonitor();
          if (resourceMonitor?.shouldPause()) {
            const reason = resourceMonitor.getPauseState().reason || 'a resource condition';
            message += `, but it takes no new jobs until this clears: ${reason}`;
          }
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
