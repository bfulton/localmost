import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { MacVmSetupStatus } from '../shared/macos-vm-setup';

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
const mockGetStatus = jest.fn<() => { status: string; jobName?: string; repository?: string }>();
const mockGetJobHistory = jest.fn<() => unknown[]>();
const mockIsRunning = jest.fn<() => boolean>();
const mockIsConfigured = jest.fn<() => boolean>();
const mockInitialize = jest.fn<() => Promise<void>>();
const mockStop = jest.fn<() => Promise<void>>();
const mockHeartbeatIsRunning = jest.fn<() => boolean>();
const mockHeartbeatStop = jest.fn<() => void>();
const mockResourceShouldPause = jest.fn<() => boolean>();
const mockResourceOverridden = jest.fn<() => string | null>();

jest.mock('./app-state', () => ({
  getRunnerState: () => mockGetStatus(),
  getRunnerManager: () => ({
    getStatusDisplayName: mockGetStatusDisplayName,
    getJobHistory: mockGetJobHistory,
    isRunning: mockIsRunning,
    isConfigured: mockIsConfigured,
    initialize: mockInitialize,
    stop: mockStop,
  }),
  getHeartbeatManager: () => ({
    isRunning: mockHeartbeatIsRunning,
    stop: mockHeartbeatStop,
  }),
  getAuthState: () => ({
    user: { login: 'testuser' },
  }),
  getResourceMonitor: () => ({
    shouldPause: mockResourceShouldPause,
    getPauseState: () => ({
      isPaused: mockResourceShouldPause(),
      reason: 'Battery at 20%',
      conditions: [],
      overridden: mockResourceOverridden(),
    }),
  }),
}));

// Mock the pause and resume the tray shares
const mockPauseRunner = jest.fn<() => Promise<string>>();
const mockResumeRunner = jest.fn<() => Promise<string>>();
jest.mock('./runner-pause', () => ({
  pauseRunner: () => mockPauseRunner(),
  resumeRunner: () => mockResumeRunner(),
}));

// Mock runner-state-service
const mockSnapshot = { value: { running: 'listening' }, context: {} };
const mockSelectRunnerStatus = jest.fn<() => { status: string }>();
const mockSelectEffectivePauseState = jest.fn<() => { isPaused: boolean; reason: string | null }>();
const mockMachineStarted = jest.fn<() => boolean>();
const mockMachineStarting = jest.fn<() => boolean>();

jest.mock('./runner-state-service', () => ({
  getSnapshot: () => mockSnapshot,
  selectRunnerStatus: () => mockSelectRunnerStatus(),
  selectEffectivePauseState: () => mockSelectEffectivePauseState(),
  isRunning: () => mockMachineStarted(),
  isStarting: () => mockMachineStarting(),
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
    mockInitialize.mockReset();
    mockStop.mockReset();
    mockHeartbeatIsRunning.mockReset();
    mockHeartbeatStop.mockReset();
    mockSelectRunnerStatus.mockReset();
    mockSelectEffectivePauseState.mockReset();
    mockResourceShouldPause.mockReset();
    mockResourceOverridden.mockReset();
    mockPauseRunner.mockReset();
    mockResumeRunner.mockReset();

    // Default mock implementations
    mockGetStatusDisplayName.mockReturnValue('localmost.test');
    mockGetJobHistory.mockReturnValue([]);
    mockIsRunning.mockReturnValue(true);
    mockIsConfigured.mockReturnValue(true);
    mockHeartbeatIsRunning.mockReturnValue(true);
    mockSelectRunnerStatus.mockReturnValue({ status: 'listening' });
    mockGetStatus.mockReturnValue({ status: 'listening' });
    mockSelectEffectivePauseState.mockReturnValue({ isPaused: false, reason: null });
    mockMachineStarted.mockReturnValue(true);
    mockMachineStarting.mockReturnValue(false);
    mockResourceShouldPause.mockReturnValue(false);
    mockResourceOverridden.mockReturnValue(null);
    mockPauseRunner.mockResolvedValue('paused');
    mockResumeRunner.mockResolvedValue('resumed');

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
        authExpired: false,
        userName: 'testuser',
        runnerStarted: true,
        resourcePause: { isPaused: false, reason: null, conditions: [], overridden: null },
      },
    });
  });

  it('says whether the runner a pause holds is started, so a failed start is not shown as only paused', async () => {
    // The monitor's pause is recorded in any state; read first, it hid a
    // runner in error behind the pause.
    mockSelectEffectivePauseState.mockReturnValue({ isPaused: true, reason: 'Battery at 20%' });
    mockMachineStarted.mockReturnValue(false);
    await server.start();

    const notStarted = await sendRequest({ command: 'status' });
    expect((notStarted as { data: { runnerStarted?: boolean } }).data.runnerStarted).toBe(false);

    mockMachineStarting.mockReturnValue(true);
    const starting = await sendRequest({ command: 'status' });
    expect((starting as { data: { runnerStarted?: boolean } }).data.runnerStarted).toBe(true);
  });

  it('reports a resource pause a resume overrode, until its condition clears', async () => {
    mockResourceOverridden.mockReturnValue('battery power');
    await server.start();

    const response = await sendRequest({ command: 'status' });

    expect((response as { data: { resourcePause: unknown } }).data.resourcePause).toEqual({
      isPaused: false,
      reason: null,
      conditions: [],
      overridden: 'battery power',
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

  it('pauses a listening runner that has no worker', async () => {
    // Workers are spawned per job, so an idle runner has none. Deciding by
    // them answered "already paused" for a runner that was taking jobs, and
    // set no pause, so `localmost status` went on saying Listening.
    mockIsRunning.mockReturnValue(false);

    await server.start();

    const response = await sendRequest({ command: 'pause' });

    expect(response).toEqual({
      success: true,
      command: 'pause',
      message: 'Runner paused: it takes no new jobs, and a job already running finishes',
    });
    expect(mockPauseRunner).toHaveBeenCalledTimes(1);
  });

  it('leaves a running job to finish when pausing', async () => {
    // It used to stop the pool, killing the job; the tray's pause never did.
    mockIsRunning.mockReturnValue(true);

    await server.start();

    await sendRequest({ command: 'pause' });

    expect(mockPauseRunner).toHaveBeenCalledTimes(1);
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('should handle pause command when already paused', async () => {
    mockIsRunning.mockReturnValue(true);
    mockPauseRunner.mockResolvedValue('already-paused');

    await server.start();

    const response = await sendRequest({ command: 'pause' });

    expect(response).toEqual({
      success: true,
      command: 'pause',
      message: 'Runner is already paused',
    });
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('does not claim to pause a runner that was never started', async () => {
    mockPauseRunner.mockResolvedValue('not-started');

    await server.start();

    const response = await sendRequest({ command: 'pause' });

    expect(response).toEqual({
      success: false,
      error: 'Runner is not started, so there is nothing to pause',
    });
  });

  it('resumes a paused runner that still has a job running', async () => {
    // A pause leaves running jobs to finish, so a paused runner can have a
    // worker. Deciding by workers called it already running and left it paused.
    mockIsRunning.mockReturnValue(true);

    await server.start();

    const response = await sendRequest({ command: 'resume' });

    expect(response).toEqual({
      success: true,
      command: 'resume',
      message: 'Runner resumed',
    });
    expect(mockResumeRunner).toHaveBeenCalledTimes(1);
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it('should handle resume command when already running', async () => {
    mockIsRunning.mockReturnValue(false);
    mockResumeRunner.mockResolvedValue('already-running');

    await server.start();

    const response = await sendRequest({ command: 'resume' });

    expect(response).toEqual({
      success: true,
      command: 'resume',
      message: 'Runner is already running',
    });
  });

  it('says a resume overrode a resource pause, and until when', async () => {
    // The resume used to leave the condition in force, and new jobs waiting
    // on it; it overrides it now, until the condition clears.
    mockResumeRunner.mockImplementation(async () => {
      mockResourceOverridden.mockReturnValue('battery power');
      return 'resumed';
    });

    await server.start();

    const response = await sendRequest({ command: 'resume' });

    expect(response).toEqual({
      success: true,
      command: 'resume',
      message: 'Resumed (resource pause overridden until battery power clears)',
    });
  });

  it('says a runner that is starting and not paused is starting, not resumed', async () => {
    mockResumeRunner.mockResolvedValue('starting');

    await server.start();

    const response = await sendRequest({ command: 'resume' });

    expect(response).toEqual({
      success: true,
      command: 'resume',
      message: 'Runner is still starting, and is not paused',
    });
  });

  it('does not claim to resume a runner that was never started', async () => {
    mockResumeRunner.mockResolvedValue('not-started');

    await server.start();

    const response = await sendRequest({ command: 'resume' });

    expect(response).toEqual({
      success: false,
      error: 'Runner is not started. Start it from the app.',
    });
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

  it('refuses a request line too long to be one, and closes the connection instead of buffering it', async () => {
    await server.start();

    const { received, closed } = await new Promise<{ received: string; closed: boolean }>((resolve, reject) => {
      const socket = net.createConnection(testSocketPath);
      let got = '';
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ received: got, closed: false });
      }, 2000);
      socket.on('data', (data) => { got += data.toString(); });
      socket.on('close', () => {
        clearTimeout(timer);
        resolve({ received: got, closed: true });
      });
      socket.on('error', (err: NodeJS.ErrnoException) => {
        // The server may cut the connection while the client is still writing.
        if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') reject(err);
      });
      // A megabyte with no newline: no CLI request is anywhere near this.
      socket.write('x'.repeat(1024 * 1024));
    });

    expect(closed).toBe(true);
    expect(received).toMatch(/too large/);
  });

  it('answers the requests on one connection in the order they were sent', async () => {
    let finishPause: () => void = () => {};
    mockPauseRunner.mockImplementation(() => new Promise<string>((resolve) => { finishPause = () => resolve('paused'); }));
    await server.start();

    const responses = await new Promise<Array<{ command?: string }>>((resolve, reject) => {
      const socket = net.createConnection(testSocketPath, async () => {
        socket.write(JSON.stringify({ command: 'pause' }) + '\n');
        await new Promise((r) => setTimeout(r, 20));
        socket.write(JSON.stringify({ command: 'jobs' }) + '\n');
        await new Promise((r) => setTimeout(r, 20));
        finishPause();
      });
      const seen: Array<{ command?: string }> = [];
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) seen.push(JSON.parse(line));
        if (seen.length === 2) {
          socket.end();
          resolve(seen);
        }
      });
      socket.on('error', reject);
    });

    expect(responses.map((r) => r.command)).toEqual(['pause', 'jobs']);
  });

  it('stops reading a connection whose requests are queued faster than they are answered', async () => {
    // The first request holds the line; everything after it waits its turn.
    // Reading on regardless kept every waiting request in memory, however
    // many a client sent.
    let finishPause: () => void = () => {};
    mockPauseRunner.mockImplementation(() => new Promise<string>((resolve) => { finishPause = () => resolve('paused'); }));
    await server.start();

    const socket = net.createConnection(testSocketPath);
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    socket.write(JSON.stringify({ command: 'pause' }) + '\n');
    const flood = (JSON.stringify({ command: 'jobs' }) + '\n').repeat(50_000);
    socket.write(flood);
    await new Promise((r) => setTimeout(r, 300));

    // Most of the flood is still the client's to send: the server stopped
    // taking it once enough requests were waiting.
    expect(socket.writableLength).toBeGreaterThan(flood.length / 2);

    finishPause();
    socket.destroy();
  });

  it('reads a request whose characters arrive split across writes', async () => {
    await server.start();

    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(testSocketPath, async () => {
        const bytes = Buffer.from(JSON.stringify({ command: 'caf\u00e9' }) + '\n');
        const split = bytes.indexOf(0xc3) + 1;
        socket.write(bytes.subarray(0, split));
        await new Promise((r) => setTimeout(r, 20));
        socket.write(bytes.subarray(split));
      });
      let got = '';
      socket.setEncoding('utf8');
      socket.on('data', (data) => {
        got += data;
        if (got.includes('\n')) {
          socket.end();
          resolve(got);
        }
      });
      socket.on('error', reject);
    });

    expect(JSON.parse(reply).error).toBe('Unknown command: caf\u00e9');
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

    it('rejects an owner or repo that is not a GitHub name, before anything is fetched', async () => {
      await server.start();

      for (const args of [
        { type: 'repo' as const, owner: '../x', repo: 'supdb' },
        { type: 'repo' as const, owner: 'bfulton', repo: '..' },
        { type: 'repo' as const, owner: 'bfulton', repo: 'supdb/../../orgs/x' },
        { type: 'repo' as const, owner: 'bfulton', repo: 'supdb?x=1' },
        { type: 'org' as const, owner: 'x/../user' },
      ]) {
        const response = await sendRequest({ command: 'targets-add', args }) as { success: boolean; error: string };
        expect({ args, success: response.success }).toEqual({ args, success: false });
        expect(response.error).toMatch(/not a valid GitHub/);
      }
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


  describe('status reports the job the runner is actually running', () => {
    it('reports a running job, which the state machine never learns about', async () => {
      // The machine is only ever sent pause and resume events - JOB_START and
      // JOB_COMPLETE are declared on it and sent by nobody - so it sits in
      // `listening` with no job for the life of the process. Reading status from
      // it meant `localmost status` said "Job: Inactive" through a 34-hour job
      // that `localmost jobs` listed as running the whole time.
      await server.start();
      mockGetStatus.mockReturnValue({ status: 'busy', jobName: 'full', repository: 'bfulton/supdb' });
      mockSelectRunnerStatus.mockReturnValue({ status: 'listening' });

      const response = await sendRequest({ command: 'status' });

      expect((response as { data: { runner: { status: string; jobName?: string } } }).data.runner.status).toBe('busy');
      expect((response as { data: { runner: { jobName?: string } } }).data.runner.jobName).toBe('full');
    });

    it('still takes the pause overlay from the machine, which does track it', async () => {
      await server.start();
      mockGetStatus.mockReturnValue({ status: 'listening' });
      mockSelectEffectivePauseState.mockReturnValue({ isPaused: true, reason: 'Paused by user' });

      const response = await sendRequest({ command: 'status' });

      expect((response as { data: { resourcePause: { isPaused: boolean } } }).data.resourcePause.isPaused).toBe(true);
    });
  });

  describe('test-vm lends localmost test a macOS VM for as long as its connection stays open', () => {
    type Lease = { key: string; proxyPort: number; brokerPort: number };
    let leases: Lease[];
    let released: Lease[];
    let available: { ok: boolean; reason?: string };
    let prepare: (lease: Lease, signal?: AbortSignal) => Promise<string>;
    let releaseVm: () => Promise<void>;

    beforeEach(async () => {
      await server.stop();
      leases = [];
      released = [];
      available = { ok: true };
      prepare = async () => '/data/macos-vm/vms/1-abc/agent.sock';
      releaseVm = async () => undefined;
      server = new CliServer({
        onLog: (level, message) => logMessages.push(`${level}: ${message}`),
        testVms: {
          available: () => available,
          prepareTestRun: (lease, signal) => {
            leases.push(lease);
            return prepare(lease, signal);
          },
          release: async (lease) => {
            released.push(lease);
            await releaseVm();
          },
        },
      });
      await server.start();
    });

    /** Asks for a VM and keeps the connection, as the CLI does for the run. */
    const lend = (args: Record<string, unknown>) =>
      new Promise<{ response: Record<string, unknown>; socket: net.Socket }>((resolve, reject) => {
        const socket = net.createConnection(testSocketPath, () => socket.write(`${JSON.stringify({ command: 'test-vm', args })}\n`));
        let buffer = '';
        socket.on('data', (d) => {
          buffer += d.toString();
          const nl = buffer.indexOf('\n');
          if (nl !== -1) resolve({ response: JSON.parse(buffer.slice(0, nl)), socket });
        });
        socket.on('error', reject);
      });

    const until = async (check: () => boolean) => {
      for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    };

    it('boots a VM with the run\'s ports, answers its agent socket, and releases it when the connection closes', async () => {
      const { response, socket } = await lend({ proxyPort: 41000, brokerPort: 41001 });
      expect(response).toEqual({ success: true, command: 'test-vm', data: { agentSocket: '/data/macos-vm/vms/1-abc/agent.sock' } });
      expect(leases).toEqual([{ key: expect.stringMatching(/^test-[0-9a-f]{12}$/), proxyPort: 41000, brokerPort: 41001 }]);
      expect(released).toEqual([]);
      socket.destroy();
      await until(() => released.length > 0);
      expect(released).toEqual(leases);
    });

    it('cancels the boot when the connection closes before the VM is up', async () => {
      let aborted = false;
      prepare = (_lease, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('cancelled'));
        });
      });
      const socket = net.createConnection(testSocketPath, () => socket.write(`${JSON.stringify({ command: 'test-vm', args: { proxyPort: 1, brokerPort: 2 } })}\n`));
      await until(() => leases.length > 0);
      socket.destroy();
      await until(() => aborted && released.length > 0);
      expect(aborted).toBe(true);
      expect(released).toEqual(leases);
    });

    it('says why no VM can run the workflow, and boots none', async () => {
      available = { ok: false, reason: 'no golden macOS image has been built: build one in Settings' };
      const { response, socket } = await lend({ proxyPort: 1, brokerPort: 2 });
      socket.destroy();
      expect(response).toEqual({ success: false, error: 'No macOS VM can run the workflow: no golden macOS image has been built: build one in Settings' });
      expect(leases).toEqual([]);
    });

    it('refuses ports that are not two distinct port numbers', async () => {
      for (const args of [{}, { proxyPort: 1, brokerPort: 1 }, { proxyPort: 0, brokerPort: 2 }, { proxyPort: '41000', brokerPort: 2 }, { proxyPort: 1.5, brokerPort: 2 }, { proxyPort: 1, brokerPort: 70000 }]) {
        const { response, socket } = await lend(args);
        socket.destroy();
        expect(response).toEqual({ success: false, error: 'Missing or invalid ports for the test run' });
      }
      expect(leases).toEqual([]);
    });

    it('lends one connection one VM: a second test-vm on it is refused', async () => {
      const { response, socket } = await lend({ proxyPort: 41000, brokerPort: 41001 });
      expect(response.success).toBe(true);
      const second = new Promise<Record<string, unknown>>((resolve) => {
        let buffer = '';
        socket.removeAllListeners('data');
        socket.on('data', (d) => {
          buffer += d.toString();
          const nl = buffer.indexOf('\n');
          if (nl !== -1) resolve(JSON.parse(buffer.slice(0, nl)));
        });
      });
      socket.write(`${JSON.stringify({ command: 'test-vm', args: { proxyPort: 42000, brokerPort: 42001 } })}\n`);
      expect(await second).toEqual({ success: false, error: 'This connection already has a macOS VM' });
      expect(leases).toHaveLength(1);
      socket.destroy();
      await until(() => released.length > 0);
      expect(released).toEqual(leases);
    });

    it('stops without waiting for a test run\'s connection, and releases its VM', async () => {
      const { socket } = await lend({ proxyPort: 41000, brokerPort: 41001 });
      socket.on('error', () => undefined);
      const stopped = server.stop().then(() => 'stopped');
      const timeout = new Promise((r) => setTimeout(() => r('timed out'), 2000));
      expect(await Promise.race([stopped, timeout])).toBe('stopped');
      await until(() => released.length > 0);
      expect(released).toEqual(leases);
    });

    /** The next answer on a connection that already had one. */
    const nextAnswer = (socket: net.Socket) =>
      new Promise<Record<string, unknown>>((resolve) => {
        let buffer = '';
        socket.removeAllListeners('data');
        socket.on('data', (d) => {
          buffer += d.toString();
          const nl = buffer.indexOf('\n');
          if (nl !== -1) resolve(JSON.parse(buffer.slice(0, nl)));
        });
      });

    it('answers test-vm-release only once the VM is gone, and releases it once', async () => {
      const { socket } = await lend({ proxyPort: 41000, brokerPort: 41001 });
      let gone!: () => void;
      releaseVm = () => new Promise<void>((resolve) => { gone = resolve; });
      let answered = false;
      const answer = nextAnswer(socket).then((a) => { answered = true; return a; });
      socket.write(`${JSON.stringify({ command: 'test-vm-release' })}\n`);
      await until(() => released.length > 0);
      await new Promise((r) => setTimeout(r, 50));
      expect(answered).toBe(false);
      gone();
      expect(await answer).toEqual({ success: true, command: 'test-vm-release' });
      socket.destroy();
      await new Promise((r) => setTimeout(r, 50));
      expect(released).toEqual(leases);
    });

    it('refuses test-vm-release on a connection that holds no VM', async () => {
      const socket = net.createConnection(testSocketPath, () => socket.write(`${JSON.stringify({ command: 'test-vm-release' })}\n`));
      const answer = await nextAnswer(socket);
      socket.destroy();
      expect(answer).toEqual({ success: false, error: 'This connection has no macOS VM' });
      expect(released).toEqual([]);
    });

    it('answers a boot that failed with its reason, and releases what it took', async () => {
      prepare = async () => {
        throw new Error('the macOS VM did not start: helper exited');
      };
      const { response, socket } = await lend({ proxyPort: 1, brokerPort: 2 });
      socket.destroy();
      expect(response).toEqual({ success: false, error: 'Could not lend the test run a macOS VM: the macOS VM did not start: helper exited' });
      expect(released).toEqual(leases);
    });
  });

  describe('image builds and watches the golden macOS VM image headlessly', () => {
    /** A stand-in for MacVmImageManager: the status it reports, and whether build/cancel were called. */
    class FakeImages extends EventEmitter {
      built = 0;
      cancelled = 0;
      buildThrows: string | null = null;
      private status_: MacVmSetupStatus;
      private ready_: unknown | null;

      constructor(initial: MacVmSetupStatus, ready: unknown | null = null) {
        super();
        this.status_ = initial;
        this.ready_ = ready;
      }

      status(): MacVmSetupStatus {
        return this.status_;
      }
      ready(): unknown | null {
        return this.ready_;
      }
      build(): void {
        if (this.buildThrows) throw new Error(this.buildThrows);
        this.built++;
        // Like the real manager, build() moves the status to building at once.
        this.emitStatus({ ...this.status_, state: 'building', phase: 'catalog', step: 'Asking which macOS this Mac can run in a VM', percent: undefined, reason: undefined });
      }
      cancel(): void {
        this.cancelled++;
      }
      /** Drive a status change, as the manager does as a build proceeds. */
      emitStatus(status: MacVmSetupStatus): void {
        this.status_ = status;
        this.emit('status', status);
      }
    }

    const disk = { freeBytes: 200 * 2 ** 30, neededBytes: 60 * 2 ** 30 };
    const makeStatus = (over: Partial<MacVmSetupStatus> = {}): MacVmSetupStatus => ({
      state: 'not-built',
      disk,
      provisioning: 'headless',
      busy: false,
      ...over,
    });

    let images: FakeImages;

    const withImages = async (fake: FakeImages): Promise<void> => {
      await server.stop();
      images = fake;
      server = new CliServer({
        onLog: (level, message) => logMessages.push(`${level}: ${message}`),
        images: fake,
      });
      await server.start();
    };

    const until = async (check: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    };

    type Line = { success: boolean; command?: string; error?: string; data?: { status?: MacVmSetupStatus; done?: boolean; note?: string } };

    /** Open a streaming image-build connection, collecting each JSON line. */
    const buildStream = (args: Record<string, unknown> = {}): { socket: net.Socket; lines: Line[] } => {
      const lines: Line[] = [];
      const socket = net.createConnection(testSocketPath, () => socket.write(`${JSON.stringify({ command: 'image-build', args })}\n`));
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (d: string) => {
        buffer += d;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim()) lines.push(JSON.parse(line) as Line);
        }
      });
      socket.on('error', () => undefined);
      return { socket, lines };
    };

    it('image-status returns the manager\'s current status', async () => {
      await withImages(new FakeImages(makeStatus({ state: 'building', phase: 'download', step: 'Downloading', percent: 42 })));
      const response = (await sendRequest({ command: 'image-status' })) as Line;
      expect(response.success).toBe(true);
      expect(response.command).toBe('image-status');
      expect(response.data?.status).toMatchObject({ state: 'building', phase: 'download', percent: 42 });
    });

    it('image-build starts a build and streams progress to a ready image (exit-worthy)', async () => {
      await withImages(new FakeImages(makeStatus()));
      const { socket, lines } = buildStream();
      await until(() => lines.length >= 1);
      expect(images.built).toBe(1);
      expect(lines[0]).toMatchObject({ success: true, command: 'image-build', data: { done: false } });
      expect(lines[0].data?.status?.state).toBe('building');

      images.emitStatus(makeStatus({ state: 'building', phase: 'install', step: 'Installing', percent: 10 }));
      images.emitStatus(makeStatus({ state: 'ready', disk: { freeBytes: 180 * 2 ** 30, neededBytes: 0 }, image: { os: '26', build: '23A1', diskAllocatedBytes: 20 * 2 ** 30, slots: [1, 2], stale: false } }));

      await until(() => lines.some((l) => l.data?.done === true));
      const last = lines[lines.length - 1];
      expect(last).toMatchObject({ success: true, command: 'image-build', data: { done: true } });
      expect(last.data?.status?.state).toBe('ready');
      socket.destroy();
    });

    it('image-build streams a build that ends in failure', async () => {
      await withImages(new FakeImages(makeStatus()));
      const { socket, lines } = buildStream();
      await until(() => lines.length >= 1);
      images.emitStatus(makeStatus({ state: 'failed', reason: 'the first boot ended badly' }));
      await until(() => lines.some((l) => l.data?.done === true));
      const last = lines[lines.length - 1];
      expect(last.data?.done).toBe(true);
      expect(last.data?.status?.state).toBe('failed');
      expect(last.data?.status?.reason).toBe('the first boot ended badly');
      socket.destroy();
    });

    it('an image already ready finishes at once without rebuilding, unless --rebuild is passed', async () => {
      await withImages(new FakeImages(makeStatus({ state: 'ready', disk: { freeBytes: 180 * 2 ** 30, neededBytes: 0 } }), { imageId: 'img-1', slots: [1, 2] }));
      const { socket, lines } = buildStream();
      await until(() => lines.length >= 1);
      expect(images.built).toBe(0);
      expect(lines[0]).toMatchObject({ success: true, command: 'image-build', data: { done: true, note: 'already-ready' } });
      socket.destroy();

      // --rebuild builds a new one anyway.
      const { socket: s2, lines: l2 } = buildStream({ rebuild: true });
      await until(() => l2.length >= 1 && images.built > 0);
      expect(images.built).toBe(1);
      expect(l2[0].data?.done).toBe(false);
      s2.destroy();
    });

    it('a build already running is followed, not started again', async () => {
      await withImages(new FakeImages(makeStatus({ state: 'building', phase: 'download', step: 'Downloading', percent: 5 })));
      const { socket, lines } = buildStream();
      await until(() => lines.length >= 1);
      expect(images.built).toBe(0);
      expect(lines[0]).toMatchObject({ success: true, command: 'image-build', data: { done: false, note: 'already-running' } });
      socket.destroy();
    });

    it('fails fast with the specific reason when this Mac cannot build (unsupported host)', async () => {
      await withImages(new FakeImages(makeStatus({ state: 'unsupported', reason: 'this build of localmost has no macOS VM helper' })));
      const { socket, lines } = buildStream();
      await until(() => lines.length >= 1);
      expect(lines[0]).toEqual({ success: false, error: 'this build of localmost has no macOS VM helper' });
      expect(images.built).toBe(0);
      socket.destroy();
    });

    it('fails fast when there is not enough free disk', async () => {
      await withImages(new FakeImages(makeStatus({ disk: { freeBytes: 10 * 2 ** 30, neededBytes: 60 * 2 ** 30 } })));
      const { socket, lines } = buildStream();
      await until(() => lines.length >= 1);
      expect(lines[0].success).toBe(false);
      expect(lines[0].error).toMatch(/not enough free disk/);
      expect(images.built).toBe(0);
      socket.destroy();
    });

    it('surfaces build()\'s own refusal (e.g. the runner is not downloaded)', async () => {
      const fake = new FakeImages(makeStatus());
      fake.buildThrows = 'download the runner first: the golden image gets the same runner as this Mac';
      await withImages(fake);
      const { socket, lines } = buildStream();
      await until(() => lines.length >= 1);
      expect(lines[0]).toEqual({ success: false, error: 'download the runner first: the golden image gets the same runner as this Mac' });
      socket.destroy();
    });

    it('closing the connection detaches WITHOUT cancelling the build (it survives disconnect)', async () => {
      await withImages(new FakeImages(makeStatus()));
      const { socket, lines } = buildStream();
      await until(() => lines.length >= 1 && images.built > 0);
      expect(images.listenerCount('status')).toBe(1);

      socket.destroy();
      await until(() => images.listenerCount('status') === 0);
      // Unlike test-vm's lease, which releases on disconnect, the build is not cancelled.
      expect(images.cancelled).toBe(0);
      expect(images.listenerCount('status')).toBe(0);

      // The build goes on: a later status change has no stream to write to, and does not throw.
      expect(() => images.emitStatus(makeStatus({ state: 'ready', disk: { freeBytes: 180 * 2 ** 30, neededBytes: 0 } }))).not.toThrow();
      expect(images.cancelled).toBe(0);
    });

    it('image-cancel cancels a running build, and says so', async () => {
      await withImages(new FakeImages(makeStatus({ state: 'building', phase: 'download', step: 'Downloading', percent: 5 })));
      const response = (await sendRequest({ command: 'image-cancel' })) as Line;
      expect(response).toEqual({ success: true, command: 'image-cancel', message: 'Cancelling the golden image build.' });
      expect(images.cancelled).toBe(1);
    });

    it('image-cancel with no build running says nothing is running, and cancels nothing', async () => {
      await withImages(new FakeImages(makeStatus({ state: 'not-built' })));
      const response = (await sendRequest({ command: 'image-cancel' })) as Line;
      expect(response).toEqual({ success: true, command: 'image-cancel', message: 'No golden image build is running.' });
      expect(images.cancelled).toBe(0);
    });

    it('answers the image commands with an error when the app has no image manager', async () => {
      // The default server from the outer beforeEach has no image manager.
      await server.start();
      expect(await sendRequest({ command: 'image-status' })).toEqual({ success: false, error: 'This app has no macOS VM image' });
      expect(await sendRequest({ command: 'image-cancel' })).toEqual({ success: false, error: 'This app has no macOS VM image' });
      const { socket, lines } = buildStream();
      await until(() => lines.length >= 1);
      expect(lines[0]).toEqual({ success: false, error: 'This app has no macOS VM image to build' });
      socket.destroy();
    });
  });
});
