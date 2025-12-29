import '@testing-library/jest-dom';

// Type for mocked localmost API
export interface MockLocalmost {
  github: {
    getAuthStatus: jest.Mock;
    startDeviceFlow: jest.Mock;
    cancelAuth: jest.Mock;
    logout: jest.Mock;
    getRepos: jest.Mock;
    getOrgs: jest.Mock;
    onDeviceCode: jest.Mock;
    searchUsers: jest.Mock;
  };
  runner: {
    isDownloaded: jest.Mock;
    isConfigured: jest.Mock;
    getStatus: jest.Mock;
    getVersion: jest.Mock;
    getAvailableVersions: jest.Mock;
    getDisplayName: jest.Mock;
    onStatusUpdate: jest.Mock;
    onDownloadProgress: jest.Mock;
    download: jest.Mock;
    configure: jest.Mock;
    start: jest.Mock;
    stop: jest.Mock;
    setDownloadVersion: jest.Mock;
  };
  settings: {
    get: jest.Mock;
    set: jest.Mock;
  };
  logs: {
    onEntry: jest.Mock;
    getPath: jest.Mock;
    write: jest.Mock;
    clear: jest.Mock;
  };
  jobs: {
    getHistory: jest.Mock;
    onHistoryUpdate: jest.Mock;
    setMaxHistory: jest.Mock;
    cancel: jest.Mock;
  };
  app: {
    getHostname: jest.Mock;
    minimize: jest.Mock;
    quit: jest.Mock;
  };
  network: {
    isOnline: jest.Mock;
  };
  update: {
    check: jest.Mock;
    download: jest.Mock;
    install: jest.Mock;
    getStatus: jest.Mock;
    onStatusChange: jest.Mock;
  };
  targets: {
    list: jest.Mock;
    add: jest.Mock;
    remove: jest.Mock;
    update: jest.Mock;
    getStatus: jest.Mock;
    onStatusUpdate: jest.Mock;
  };
  resource: {
    getState: jest.Mock;
    onStateChange: jest.Mock;
  };
}

// Extend Window interface for tests
declare global {
  interface Window {
    localmost: MockLocalmost;
  }
}

// Mock window.localmost API
const mockLocalmost: MockLocalmost = {
  github: {
    getAuthStatus: jest.fn().mockResolvedValue({ isAuthenticated: false }),
    startDeviceFlow: jest.fn(),
    cancelAuth: jest.fn(),
    logout: jest.fn(),
    getRepos: jest.fn().mockResolvedValue({ success: true, repos: [] }),
    getOrgs: jest.fn().mockResolvedValue({ success: true, orgs: [] }),
    onDeviceCode: jest.fn().mockReturnValue(() => {}),
    searchUsers: jest.fn().mockResolvedValue({ success: true, users: [] }),
  },
  runner: {
    isDownloaded: jest.fn().mockResolvedValue(false),
    isConfigured: jest.fn().mockResolvedValue(false),
    getStatus: jest.fn().mockResolvedValue({ status: 'offline' }),
    getVersion: jest.fn().mockResolvedValue({ version: null, url: null }),
    getAvailableVersions: jest.fn().mockResolvedValue({ success: true, versions: [] }),
    getDisplayName: jest.fn().mockResolvedValue(''),
    onStatusUpdate: jest.fn().mockReturnValue(() => {}),
    onDownloadProgress: jest.fn().mockReturnValue(() => {}),
    download: jest.fn(),
    configure: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    setDownloadVersion: jest.fn(),
  },
  settings: {
    get: jest.fn().mockResolvedValue({}),
    set: jest.fn().mockResolvedValue({ success: true }),
  },
  logs: {
    onEntry: jest.fn().mockReturnValue(() => {}),
    getPath: jest.fn().mockResolvedValue('/tmp/localmost.log'),
    write: jest.fn(),
    clear: jest.fn(),
  },
  jobs: {
    getHistory: jest.fn().mockResolvedValue([]),
    onHistoryUpdate: jest.fn().mockReturnValue(() => {}),
    setMaxHistory: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue({ success: true }),
  },
  app: {
    getHostname: jest.fn().mockResolvedValue('test-host'),
    minimize: jest.fn(),
    quit: jest.fn(),
  },
  network: {
    isOnline: jest.fn().mockResolvedValue(true),
  },
  update: {
    check: jest.fn().mockResolvedValue({ success: true }),
    download: jest.fn().mockResolvedValue({ success: true }),
    install: jest.fn().mockResolvedValue({ success: true }),
    getStatus: jest.fn().mockResolvedValue({ status: 'idle', currentVersion: '0.1.1-alpha' }),
    onStatusChange: jest.fn().mockReturnValue(() => {}),
  },
  targets: {
    list: jest.fn().mockResolvedValue([]),
    add: jest.fn().mockResolvedValue({ success: true }),
    remove: jest.fn().mockResolvedValue({ success: true }),
    update: jest.fn().mockResolvedValue({ success: true }),
    getStatus: jest.fn().mockResolvedValue([]),
    onStatusUpdate: jest.fn().mockReturnValue(() => {}),
  },
  resource: {
    getState: jest.fn().mockResolvedValue({ isPaused: false, reason: null, conditions: [] }),
    onStateChange: jest.fn().mockReturnValue(() => {}),
  },
};

Object.defineProperty(window, 'localmost', {
  value: mockLocalmost,
  writable: true,
});

// Mock zubridge for Zustand store sync
Object.defineProperty(window, 'zubridge', {
  value: {
    getState: jest.fn().mockReturnValue(null),
    subscribe: jest.fn().mockReturnValue(() => {}),
    dispatch: jest.fn(),
  },
  writable: true,
});

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// Reset mocks between tests
beforeEach(() => {
  jest.clearAllMocks();
});

export { mockLocalmost };
