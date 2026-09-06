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

// Mock runner-state-service
const mockSnapshot = { value: { running: 'listening' }, context: {} };
const mockSelectRunnerStatus = jest.fn<() => { status: string }>();
const mockSelectEffectivePauseState = jest.fn<() => { isPaused: boolean; reason: string | null }>();

jest.mock('./runner-state-service', () => ({
  getSnapshot: () => mockSnapshot,
  selectRunnerStatus: () => mockSelectRunnerStatus(),
  selectEffectivePauseState: () => mockSelectEffectivePauseState(),
}));

// Mock target-manager
const mockGetTargets = jest.fn<() => unknown[]>();
const mockFindTargetByRef = jest.fn<(ref: string) => unknown>();
const mockAddTargetAndAttach = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockRemoveTargetAndDetach = jest.fn<(id: string) => Promise<unknown>>();
const mockUpdateTarget = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('./target-manager', () => ({
  getTargetManager: () => ({
    getTargets: mockGetTargets,
    findTargetByRef: mockFindTargetByRef,
    addTargetAndAttach: mockAddTargetAndAttach,
    removeTargetAndDetach: mockRemoveTargetAndDetach,
    updateTarget: mockUpdateTarget,
  }),
}));

// Mock runner-proxy-manager (runner counts for target summaries)
const mockLoadAllCredentials = jest.fn<(targetId: string) => unknown[]>();
jest.mock('./runner-proxy-manager', () => ({
  getRunnerProxyManager: () => ({
    loadAllCredentials: mockLoadAllCredentials,
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
    mockGetStatusDisplayName.mockReset();
    mockGetJobHistory.mockReset();
    mockIsRunning.mockReset();
    mockIsConfigured.mockReset();
    mockStart.mockReset();
    mockStop.mockReset();
    mockHeartbeatIsRunning.mockReset();
    mockHeartbeatStop.mockReset();
    mockSelectRunnerStatus.mockReset();
    mockSelectEffectivePauseState.mockReset();

    // Default mock implementations
    mockGetStatusDisplayName.mockReturnValue('localmost.test');
    mockGetJobHistory.mockReturnValue([]);
    mockIsRunning.mockReturnValue(true);
    mockIsConfigured.mockReturnValue(true);
    mockHeartbeatIsRunning.mockReturnValue(true);
    mockSelectRunnerStatus.mockReturnValue({ status: 'listening' });
    mockSelectEffectivePauseState.mockReturnValue({ isPaused: false, reason: null });

    mockGetTargets.mockReset();
    mockFindTargetByRef.mockReset();
    mockAddTargetAndAttach.mockReset();
    mockRemoveTargetAndDetach.mockReset();
    mockUpdateTarget.mockReset();
    mockLoadAllCredentials.mockReset();
    mockGetTargets.mockReturnValue([]);
    mockLoadAllCredentials.mockReturnValue([{ instanceNum: 1 }, { instanceNum: 2 }, { instanceNum: 3 }, { instanceNum: 4 }]);
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
        runner: { status: 'listening' },
        runnerName: 'localmost.test',
        heartbeat: { isRunning: true },
        authenticated: true,
        userName: 'testuser',
        resourcePause: { isPaused: false, reason: null, conditions: [] },
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

  describe('target commands', () => {
    const target = {
      id: '3116ec9a',
      type: 'repo',
      owner: 'bfulton',
      repo: 'supdb',
      displayName: 'bfulton/supdb',
      url: 'https://github.com/bfulton/supdb',
      proxyRunnerName: 'localmost.test.bfulton-supdb',
      enabled: true,
      addedAt: '2026-08-22T14:33:57.884Z',
    };

    it('lists targets with their runner counts', async () => {
      mockGetTargets.mockReturnValue([target]);
      await server.start();

      const response = await sendRequest({ command: 'targets-list' }) as {
        success: boolean;
        data: { targets: Array<{ displayName: string; runnerCount: number; enabled: boolean }> };
      };

      expect(response.success).toBe(true);
      expect(response.data.targets).toEqual([
        expect.objectContaining({
          id: '3116ec9a',
          displayName: 'bfulton/supdb',
          runnerCount: 4,
          enabled: true,
          proxyRunnerName: 'localmost.test.bfulton-supdb',
        }),
      ]);
    });

    it('adds a repo target', async () => {
      mockAddTargetAndAttach.mockResolvedValue({ success: true, data: target });
      await server.start();

      const response = await sendRequest({
        command: 'targets-add',
        args: { type: 'repo', owner: 'bfulton', repo: 'supdb' },
      }) as { success: boolean; data: { target: { displayName: string; runnerCount: number } } };

      expect(mockAddTargetAndAttach).toHaveBeenCalledWith('repo', 'bfulton', 'supdb');
      expect(response.success).toBe(true);
      expect(response.data.target.displayName).toBe('bfulton/supdb');
      expect(response.data.target.runnerCount).toBe(4);
    });

    it('surfaces an add failure as an error response', async () => {
      mockAddTargetAndAttach.mockResolvedValue({ success: false, error: 'This target already exists' });
      await server.start();

      const response = await sendRequest({
        command: 'targets-add',
        args: { type: 'repo', owner: 'bfulton', repo: 'supdb' },
      });

      expect(response).toEqual({ success: false, error: 'This target already exists' });
    });

    it('removes a target resolved from its ref', async () => {
      mockFindTargetByRef.mockReturnValue(target);
      mockRemoveTargetAndDetach.mockResolvedValue({ success: true });
      await server.start();

      const response = await sendRequest({
        command: 'targets-remove',
        args: { ref: 'bfulton/supdb' },
      }) as { success: boolean; data: { target: { displayName: string } } };

      expect(mockRemoveTargetAndDetach).toHaveBeenCalledWith('3116ec9a');
      expect(response.success).toBe(true);
      expect(response.data.target.displayName).toBe('bfulton/supdb');
    });

    it('errors when the ref matches no target', async () => {
      mockFindTargetByRef.mockReturnValue(undefined);
      await server.start();

      const response = await sendRequest({
        command: 'targets-remove',
        args: { ref: 'bfulton/nope' },
      }) as { success: boolean; error: string };

      expect(response.success).toBe(false);
      expect(response.error).toContain('bfulton/nope');
      expect(mockRemoveTargetAndDetach).not.toHaveBeenCalled();
    });

    it('disables a target', async () => {
      mockFindTargetByRef.mockReturnValue(target);
      mockUpdateTarget.mockResolvedValue({ success: true, data: { ...target, enabled: false } });
      await server.start();

      const response = await sendRequest({
        command: 'targets-update',
        args: { ref: 'bfulton/supdb', enabled: false },
      }) as { success: boolean; data: { target: { enabled: boolean } } };

      expect(mockUpdateTarget).toHaveBeenCalledWith('3116ec9a', { enabled: false });
      expect(response.success).toBe(true);
      expect(response.data.target.enabled).toBe(false);
    });

    it('errors when updating a ref that matches no target', async () => {
      mockFindTargetByRef.mockReturnValue(undefined);
      await server.start();

      const response = await sendRequest({
        command: 'targets-update',
        args: { ref: 'bfulton/nope', enabled: true },
      }) as { success: boolean };

      expect(response.success).toBe(false);
      expect(mockUpdateTarget).not.toHaveBeenCalled();
    });

    it('rejects an add with an unknown target type', async () => {
      await server.start();

      const response = await sendRequest({
        command: 'targets-add',
        args: { type: 'foo' as 'repo', owner: 'bfulton', repo: 'supdb' },
      }) as { success: boolean; error: string };

      expect(response.success).toBe(false);
      expect(response.error).toMatch(/type/i);
      expect(mockAddTargetAndAttach).not.toHaveBeenCalled();
    });

    it('rejects an add whose owner is not a string', async () => {
      await server.start();

      const response = await sendRequest({
        command: 'targets-add',
        args: { type: 'repo', owner: 42 as unknown as string, repo: 'supdb' },
      }) as { success: boolean };

      expect(response.success).toBe(false);
      expect(mockAddTargetAndAttach).not.toHaveBeenCalled();
    });

    it('rejects an add for a repo target with no repo', async () => {
      await server.start();

      const response = await sendRequest({
        command: 'targets-add',
        args: { type: 'repo', owner: 'bfulton' },
      }) as { success: boolean };

      expect(response.success).toBe(false);
      expect(mockAddTargetAndAttach).not.toHaveBeenCalled();
    });

    it('trims whitespace around an added target', async () => {
      mockAddTargetAndAttach.mockResolvedValue({ success: true, data: target });
      await server.start();

      await sendRequest({
        command: 'targets-add',
        args: { type: 'repo', owner: '  bfulton  ', repo: ' supdb ' },
      });

      expect(mockAddTargetAndAttach).toHaveBeenCalledWith('repo', 'bfulton', 'supdb');
    });

    it('reports a structured error when ref is not a string', async () => {
      await server.start();

      const response = await sendRequest({
        command: 'targets-remove',
        args: { ref: 42 as unknown as string },
      }) as { success: boolean; error: string };

      expect(response.success).toBe(false);
      expect(response.error).not.toMatch(/invalid request/i);
      expect(mockFindTargetByRef).not.toHaveBeenCalled();
    });

    it('reports a structured error when an update ref is not a string', async () => {
      await server.start();

      const response = await sendRequest({
        command: 'targets-update',
        args: { ref: {} as unknown as string, enabled: true },
      }) as { success: boolean; error: string };

      expect(response.success).toBe(false);
      expect(response.error).not.toMatch(/invalid request/i);
      expect(mockFindTargetByRef).not.toHaveBeenCalled();
    });
  });

});
