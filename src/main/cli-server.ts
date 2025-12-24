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
import { getRunnerManager, getHeartbeatManager, getAuthState, getResourceMonitor } from './app-state';
import { RunnerState, JobHistoryEntry, ResourcePauseState } from '../shared/types';

/** CLI command request */
export interface CliRequest {
  command: 'status' | 'pause' | 'resume' | 'jobs' | 'quit';
}

/** CLI response for status command */
export interface StatusResponse {
  success: true;
  command: 'status';
  data: {
    runner: RunnerState;
    runnerName: string;
    heartbeat: {
      isRunning: boolean;
    };
    authenticated: boolean;
    userName?: string;
    resourcePause?: ResourcePauseState;
  };
}

/** CLI response for jobs command */
export interface JobsResponse {
  success: true;
  command: 'jobs';
  data: {
    jobs: JobHistoryEntry[];
  };
}

/** CLI response for pause/resume/quit commands */
export interface ActionResponse {
  success: true;
  command: 'pause' | 'resume' | 'quit';
  message: string;
}

/** CLI error response */
export interface ErrorResponse {
  success: false;
  error: string;
}

export type CliResponse = StatusResponse | JobsResponse | ActionResponse | ErrorResponse;

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
            } catch (err) {
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
    const runnerManager = getRunnerManager();
    const heartbeatManager = getHeartbeatManager();
    const authState = getAuthState();

    switch (request.command) {
      case 'status': {
        const runnerState = runnerManager?.getStatus() || { status: 'offline' as const };
        const runnerName = runnerManager?.getStatusDisplayName() || 'unknown';
        const resourceMonitor = getResourceMonitor();
        const resourcePause = resourceMonitor?.getPauseState();

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
            resourcePause: resourcePause,
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
