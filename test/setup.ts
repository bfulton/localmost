// Global test setup
import { jest } from '@jest/globals';

// Mock fetch globally
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

// Reset mocks between tests
beforeEach(() => {
  jest.clearAllMocks();
});
