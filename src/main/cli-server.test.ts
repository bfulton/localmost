import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock electron
const mockQuit = jest.fn();
jest.mock('electron', () => ({
  app: {
    quit: mockQuit,
  },
}));

// Mock paths
const testSocketPath = path.join(os.tmpdir(), `localmost-test-${process.pid}.sock`);
jest.mock('./paths', () => ({
  getCliSocketPath: () => testSocketPath,
}));

// Mock app-state
const mockGetStatus = jest.fn<() => { status: string }>();
const mockGetStatusDisplayName = jest.fn<() => string>();
const mockGetJobHistory = jest.fn<() => unknown[]>();
const mockIsRunning = jest.fn<() => boolean>();
const mockIsConfigured = jest.fn<() => boolean>();
const mockStart = jest.fn<() => Promise<void>>();
const mockStop = jest.fn<() => Promise<void>>();
const mockHeartbeatIsRunning = jest.fn<() => boolean>();
const mockHeartbeatStop = jest.fn<() => void>();

jest.mock('./app-state', () => ({
  getRunnerManager: () => ({
    getStatus: mockGetStatus,
    getStatusDisplayName: mockGetStatusDisplayName,
    getJobHistory: mockGetJobHistory,
    isRunning: mockIsRunning,
    isConfigured: mockIsConfigured,
    start: mockStart,
    stop: mockStop,
  }),
  getHeartbeatManager: () => ({
    isRunning: mockHeartbeatIsRunning,
    stop: mockHeartbeatStop,
  }),
  getAuthState: () => ({
    user: { login: 'testuser' },
  }),
}));

import { CliServer, CliRequest } from './cli-server';

describe('CliServer', () => {
  let server: CliServer;
  let logMessages: string[] = [];

  beforeEach(() => {
    // Clean up any existing socket
    if (fs.existsSync(testSocketPath)) {
      fs.unlinkSync(testSocketPath);
    }

    logMessages = [];
    server = new CliServer({
      onLog: (level, message) => {
        logMessages.push(`${level}: ${message}`);
      },
    });

    // Reset all mocks
    mockQuit.mockClear();
    mockGetStatus.mockReset();
    mockGetStatusDisplayName.mockReset();
    mockGetJobHistory.mockReset();
    mockIsRunning.mockReset();
    mockIsConfigured.mockReset();
    mockStart.mockReset();
    mockStop.mockReset();
    mockHeartbeatIsRunning.mockReset();
    mockHeartbeatStop.mockReset();

    // Default mock implementations
    mockGetStatus.mockReturnValue({ status: 'running' });
    mockGetStatusDisplayName.mockReturnValue('localmost.test');
    mockGetJobHistory.mockReturnValue([]);
    mockIsRunning.mockReturnValue(true);
    mockIsConfigured.mockReturnValue(true);
    mockHeartbeatIsRunning.mockReturnValue(true);
  });

  afterEach(async () => {
    await server.stop();
    if (fs.existsSync(testSocketPath)) {
      fs.unlinkSync(testSocketPath);
    }
  });

  async function sendRequest(request: CliRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(testSocketPath, () => {
        socket.write(JSON.stringify(request) + '\n');
      });

      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line);
              socket.end();
              resolve(response);
              return;
            } catch {
              // Not complete JSON yet
            }
          }
        }
      });

      socket.on('error', reject);
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error('Timeout'));
      });
    });
  }

  it('should start and create socket file', async () => {
    await server.start();
    expect(fs.existsSync(testSocketPath)).toBe(true);
  });

  it('should handle status command', async () => {
    await server.start();

    const response = await sendRequest({ command: 'status' });

    expect(response).toEqual({
      success: true,
      command: 'status',
      data: {
        runner: { status: 'running' },
        runnerName: 'localmost.test',
        heartbeat: { isRunning: true },
        authenticated: true,
        userName: 'testuser',
      },
    });
  });

  it('should handle jobs command', async () => {
    const mockJobs = [
      { id: 'job-1', jobName: 'test', repository: 'owner/repo', status: 'completed' },
    ];
    mockGetJobHistory.mockReturnValue(mockJobs);

    await server.start();

    const response = await sendRequest({ command: 'jobs' });

    expect(response).toEqual({
      success: true,
      command: 'jobs',
      data: { jobs: mockJobs },
    });
  });

  it('should handle pause command when running', async () => {
    mockIsRunning.mockReturnValue(true);
    mockStop.mockResolvedValue(undefined);

    await server.start();

    const response = await sendRequest({ command: 'pause' });

    expect(response).toEqual({
      success: true,
      command: 'pause',
      message: 'Runner paused successfully',
    });
    expect(mockStop).toHaveBeenCalled();
    expect(mockHeartbeatStop).toHaveBeenCalled();
  });

  it('should handle pause command when already paused', async () => {
    mockIsRunning.mockReturnValue(false);

    await server.start();

    const response = await sendRequest({ command: 'pause' });

    expect(response).toEqual({
      success: true,
      command: 'pause',
      message: 'Runner is already paused',
    });
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('should handle resume command when paused', async () => {
    mockIsRunning.mockReturnValue(false);
    mockIsConfigured.mockReturnValue(true);
    mockStart.mockResolvedValue(undefined);

    await server.start();

    const response = await sendRequest({ command: 'resume' });

    expect(response).toEqual({
      success: true,
      command: 'resume',
      message: 'Runner resumed successfully',
    });
    expect(mockStart).toHaveBeenCalled();
  });

  it('should handle resume command when already running', async () => {
    mockIsRunning.mockReturnValue(true);

    await server.start();

    const response = await sendRequest({ command: 'resume' });

    expect(response).toEqual({
      success: true,
      command: 'resume',
      message: 'Runner is already running',
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('should handle resume command when not configured', async () => {
    mockIsRunning.mockReturnValue(false);
    mockIsConfigured.mockReturnValue(false);

    await server.start();

    const response = await sendRequest({ command: 'resume' });

    expect(response).toEqual({
      success: false,
      error: 'Runner is not configured. Please complete setup in the app.',
    });
  });

  it('should handle quit command', async () => {
    await server.start();

    const response = await sendRequest({ command: 'quit' });

    expect(response).toEqual({
      success: true,
      command: 'quit',
      message: 'localmost is shutting down...',
    });

    // Give setImmediate time to run
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockQuit).toHaveBeenCalled();
  });

  it('should handle invalid JSON', async () => {
    await server.start();

    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection(testSocketPath, () => {
        socket.write('not valid json\n');
      });

      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const resp = JSON.parse(line);
              socket.end();
              resolve(resp);
              return;
            } catch {
              // Not complete JSON yet
            }
          }
        }
      });

      socket.on('error', reject);
    });

    expect(response).toMatchObject({
      success: false,
      error: expect.stringContaining('Invalid request'),
    });
  });

  it('should clean up socket on stop', async () => {
    await server.start();
    expect(fs.existsSync(testSocketPath)).toBe(true);

    await server.stop();
    expect(fs.existsSync(testSocketPath)).toBe(false);
  });
});
