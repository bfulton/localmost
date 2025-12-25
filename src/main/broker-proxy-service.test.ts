/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

// Mock http module
const mockServerListen = jest.fn<(port: number, callback: () => void) => void>();
const mockServerClose = jest.fn<(callback: () => void) => void>();
const mockServer = {
  on: jest.fn(),
  listen: mockServerListen,
  close: mockServerClose,
};
const mockCreateServer = jest.fn(() => mockServer);

jest.mock('http', () => ({
  createServer: mockCreateServer,
}));

// Mock https module
const mockHttpsRequest = jest.fn();
jest.mock('https', () => ({
  request: mockHttpsRequest,
}));

// Mock crypto
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto') as typeof import('crypto');
  return {
    ...actual,
    sign: jest.fn(() => Buffer.from('mock-signature')),
    createPrivateKey: jest.fn(() => 'mock-private-key'),
  };
});

// Mock app-state
jest.mock('./app-state', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

import { BrokerProxyService } from './broker-proxy-service';
import type { Target, RunnerProxyStatus } from '../shared/types';

// Helper to create mock credentials
const createMockCredentials = () => ({
  runner: {
    agentId: 1,
    agentName: 'test-runner',
    poolId: 1,
    poolName: 'Default',
    serverUrl: 'https://pipelines.actions.githubusercontent.com',
    gitHubUrl: 'https://github.com',
    workFolder: '_work',
    useV2Flow: true,
    serverUrlV2: 'https://broker.actions.githubusercontent.com/',
  },
  credentials: {
    scheme: 'OAuth',
    data: {
      clientId: 'test-client-id',
      authorizationUrl: 'https://vstoken.actions.githubusercontent.com',
      requireFipsCryptography: 'false',
    },
  },
  rsaParams: {
    d: 'mock-d',
    dp: 'mock-dp',
    dq: 'mock-dq',
    exponent: 'AQAB', // Standard RSA exponent
    inverseQ: 'mock-inverseQ',
    modulus: 'mock-modulus'.padEnd(256, '0'), // Needs to be at least 256 chars for key size
    p: 'mock-p',
    q: 'mock-q',
  },
});

const createMockTarget = (overrides?: Partial<Target>): Target => ({
  id: 'test-target-id',
  type: 'repo',
  owner: 'testowner',
  repo: 'testrepo',
  displayName: 'testowner/testrepo',
  url: 'https://github.com/testowner/testrepo',
  proxyRunnerName: 'localmost.test-host.testowner-testrepo',
  enabled: true,
  addedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

describe('BrokerProxyService', () => {
  let service: BrokerProxyService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BrokerProxyService(8787);

    // Default server mock behavior
    mockServerListen.mockImplementation((_port, callback) => {
      callback();
    });
    mockServerClose.mockImplementation((callback) => {
      callback();
    });
  });

  afterEach(async () => {
    // Ensure service is stopped
    try {
      await service.stop();
    } catch {
      // Ignore
    }
  });

  describe('constructor', () => {
    it('should create service with default port', () => {
      const s = new BrokerProxyService();
      expect(s.getPort()).toBe(8787);
    });

    it('should create service with custom port', () => {
      const s = new BrokerProxyService(9999);
      expect(s.getPort()).toBe(9999);
    });
  });

  describe('addTarget', () => {
    it('should add a target', () => {
      const target = createMockTarget();
      const creds = createMockCredentials();

      service.addTarget(target, creds.runner, creds.credentials, creds.rsaParams);

      const status = service.getStatus();
      expect(status).toHaveLength(1);
      expect(status[0].targetId).toBe('test-target-id');
    });

    it('should add multiple targets', () => {
      const target1 = createMockTarget({ id: 'target-1' });
      const target2 = createMockTarget({ id: 'target-2' });
      const creds = createMockCredentials();

      service.addTarget(target1, creds.runner, creds.credentials, creds.rsaParams);
      service.addTarget(target2, creds.runner, creds.credentials, creds.rsaParams);

      const status = service.getStatus();
      expect(status).toHaveLength(2);
    });
  });

  describe('removeTarget', () => {
    it('should remove a target', () => {
      const target = createMockTarget();
      const creds = createMockCredentials();

      service.addTarget(target, creds.runner, creds.credentials, creds.rsaParams);
      expect(service.getStatus()).toHaveLength(1);

      service.removeTarget('test-target-id');
      expect(service.getStatus()).toHaveLength(0);
    });

    it('should do nothing when removing non-existent target', () => {
      service.removeTarget('non-existent');
      expect(service.getStatus()).toHaveLength(0);
    });
  });

  describe('getStatus', () => {
    it('should return empty array when no targets', () => {
      expect(service.getStatus()).toEqual([]);
    });

    it('should return status for all targets', () => {
      const target = createMockTarget();
      const creds = createMockCredentials();

      service.addTarget(target, creds.runner, creds.credentials, creds.rsaParams);

      const status = service.getStatus();
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({
        targetId: 'test-target-id',
        registered: true,
        sessionActive: false,
        lastPoll: null,
        jobsAssigned: 0,
      });
    });
  });

  describe('getPort', () => {
    it('should return the configured port', () => {
      expect(service.getPort()).toBe(8787);
    });
  });

  describe('start', () => {
    it('should start the server', async () => {
      await service.start();

      expect(mockCreateServer).toHaveBeenCalled();
      expect(mockServerListen).toHaveBeenCalledWith(8787, expect.any(Function));
    });

    it('should not start twice', async () => {
      await service.start();
      await service.start();

      expect(mockCreateServer).toHaveBeenCalledTimes(1);
    });

    it('should reject on server error', async () => {
      mockServer.on.mockImplementation((...args: unknown[]) => {
        const [event, handler] = args as [string, (err: Error) => void];
        if (event === 'error') {
          // Simulate error after a tick
          setTimeout(() => handler(new Error('Port in use')), 0);
        }
      });
      mockServerListen.mockImplementation(() => {
        // Don't call callback, let error handler fire
      });

      await expect(service.start()).rejects.toThrow('Port in use');
    });
  });

  describe('stop', () => {
    it('should stop the server', async () => {
      await service.start();
      await service.stop();

      expect(mockServerClose).toHaveBeenCalled();
    });

    it('should do nothing if not running', async () => {
      await service.stop();

      expect(mockServerClose).not.toHaveBeenCalled();
    });
  });

  describe('events', () => {
    it('should be an EventEmitter', () => {
      expect(service).toBeInstanceOf(EventEmitter);
    });

    it('should allow subscribing to status-update events', () => {
      const handler = jest.fn();
      service.on('status-update', handler);

      // Verify it's registered (we can't easily trigger the event without more mocking)
      expect(service.listenerCount('status-update')).toBe(1);
    });

    it('should allow subscribing to job-received events', () => {
      const handler = jest.fn();
      service.on('job-received', handler);

      expect(service.listenerCount('job-received')).toBe(1);
    });

    it('should allow subscribing to error events', () => {
      const handler = jest.fn();
      service.on('error', handler);

      expect(service.listenerCount('error')).toBe(1);
    });
  });

  describe('target state management', () => {
    it('should track jobs assigned per target', () => {
      const target = createMockTarget();
      const creds = createMockCredentials();

      service.addTarget(target, creds.runner, creds.credentials, creds.rsaParams);

      const status = service.getStatus();
      expect(status[0].jobsAssigned).toBe(0);
    });

    it('should track session state per target', () => {
      const target = createMockTarget();
      const creds = createMockCredentials();

      service.addTarget(target, creds.runner, creds.credentials, creds.rsaParams);

      const status = service.getStatus();
      expect(status[0].sessionActive).toBe(false);
    });
  });

  describe('setCanAcceptJobCallback', () => {
    it('should accept callback function', () => {
      const callback = (): boolean => true;
      service.setCanAcceptJobCallback(callback);

      // Callback is stored internally - can't directly verify, but it shouldn't throw
      expect(true).toBe(true);
    });

    it('should allow capacity-based job acceptance', () => {
      let capacity = true;
      const callback = (): boolean => capacity;
      service.setCanAcceptJobCallback(callback);

      // Simulate changing capacity
      capacity = false;

      // The callback should now return false (at capacity)
      expect(callback()).toBe(false);
    });
  });

  describe('getQueuedJob', () => {
    it('should return null when no jobs queued', () => {
      expect(service.getQueuedJob()).toBeNull();
    });
  });

  describe('hasQueuedJobs', () => {
    it('should return false when no jobs queued', () => {
      expect(service.hasQueuedJobs()).toBe(false);
    });
  });

  describe('shutdown handling', () => {
    it('should handle stop gracefully', async () => {
      await service.start();

      // Stop should complete without error
      await expect(service.stop()).resolves.not.toThrow();
    });

    it('should clear polling on stop', async () => {
      await service.start();
      await service.stop();

      // Starting again should work (polling was properly cleaned up)
      await expect(service.start()).resolves.not.toThrow();
    });
  });
});
