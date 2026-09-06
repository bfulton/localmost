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
import { getRunnerManager, getHeartbeatManager, getAuthState } from './app-state';
import { getSnapshot, selectRunnerStatus, selectEffectivePauseState } from './runner-state-service';
import { getTargetManager } from './target-manager';
import { getRunnerProxyManager } from './runner-proxy-manager';
import type { Target } from '../shared/types';
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

    socket.on('data', async (data) => {
      buffer += data.toString();

      // Try to parse complete JSON messages
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

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
      }
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
        // Use state machine for consistent status with UI
        const snapshot = getSnapshot();
        const runnerState = snapshot ? selectRunnerStatus(snapshot) : { status: 'offline' as const };
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
            authenticated: !!authState,
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

        if (!runnerManager.isRunning()) {
          return {
            success: true,
            command: 'pause',
            message: 'Runner is already paused',
          };
        }

        try {
          await runnerManager.stop();
          heartbeatManager?.stop();
          return {
            success: true,
            command: 'pause',
            message: 'Runner paused successfully',
          };
        } catch (err) {
          return { success: false, error: `Failed to pause: ${(err as Error).message}` };
        }
      }

      case 'resume': {
        if (!runnerManager) {
          return { success: false, error: 'Runner manager not initialized' };
        }

        if (runnerManager.isRunning()) {
          return {
            success: true,
            command: 'resume',
            message: 'Runner is already running',
          };
        }

        if (!runnerManager.isConfigured()) {
          return { success: false, error: 'Runner is not configured. Please complete setup in the app.' };
        }

        try {
          await runnerManager.start();
          // Note: heartbeat resume would require more setup (auth tokens, etc.)
          // For now, CLI resume just starts the runner
          return {
            success: true,
            command: 'resume',
            message: 'Runner resumed successfully',
          };
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

        const repoName = asName(repo);
        if (type === 'repo' && !repoName) {
          return { success: false, error: 'Missing or invalid repo name for a repo target' };
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
