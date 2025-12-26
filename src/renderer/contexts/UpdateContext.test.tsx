import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { UpdateProvider, useUpdate } from './UpdateContext';
import { mockLocalmost } from '../../../test/setup-renderer';
import { UpdateStatus } from '../../shared/types';

// Test component that uses the context
const TestConsumer: React.FC = () => {
  const update = useUpdate();

  return (
    <div>
      <span data-testid="status">{update.status.status}</span>
      <span data-testid="current-version">{update.status.currentVersion}</span>
      <span data-testid="available-version">{update.status.availableVersion || 'none'}</span>
      <span data-testid="download-progress">{update.status.downloadProgress ?? 'none'}</span>
      <span data-testid="error">{update.status.error || 'none'}</span>
      <span data-testid="auto-check">{String(update.settings.autoCheck)}</span>
      <span data-testid="check-interval">{update.settings.checkIntervalHours}</span>
      <span data-testid="is-checking">{String(update.isChecking)}</span>
      <span data-testid="is-dismissed">{String(update.isDismissed)}</span>
      <span data-testid="last-checked">{update.lastChecked ? 'set' : 'null'}</span>
      <button data-testid="check-updates" onClick={update.checkForUpdates}>Check</button>
      <button data-testid="download-update" onClick={update.downloadUpdate}>Download</button>
      <button data-testid="install-update" onClick={update.installUpdate}>Install</button>
      <button data-testid="dismiss-update" onClick={update.dismissUpdate}>Dismiss</button>
      <button
        data-testid="toggle-auto-check"
        onClick={() => update.setSettings({ ...update.settings, autoCheck: !update.settings.autoCheck })}
      >
        Toggle Auto-Check
      </button>
    </div>
  );
};

// Helper to render with provider and wait for initial load
const renderWithProvider = async () => {
  let result: ReturnType<typeof render>;

  await act(async () => {
    result = render(
      <UpdateProvider>
        <TestConsumer />
      </UpdateProvider>
    );
  });

  // Wait for initial async effects to complete
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  return result!;
};

describe('UpdateContext', () => {
  let statusChangeCallback: ((status: UpdateStatus) => void) | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    statusChangeCallback = null;

    // Setup default mocks
    mockLocalmost.update.getStatus.mockResolvedValue({
      status: 'idle',
      currentVersion: '1.0.0',
    });
    mockLocalmost.update.check.mockResolvedValue({ success: true });
    mockLocalmost.update.download.mockResolvedValue({ success: true });
    mockLocalmost.update.install.mockResolvedValue({ success: true });
    mockLocalmost.update.onStatusChange.mockImplementation((callback: (status: UpdateStatus) => void) => {
      statusChangeCallback = callback;
      return () => { statusChangeCallback = null; };
    });
    mockLocalmost.settings.get.mockResolvedValue({});
    mockLocalmost.settings.set.mockResolvedValue({ success: true });
  });

  describe('useUpdate hook', () => {
    it('should throw when used outside provider', () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        render(<TestConsumer />);
      }).toThrow('useUpdate must be used within an UpdateProvider');

      spy.mockRestore();
    });
  });

  describe('Initial State', () => {
    it('should load initial status from API', async () => {
      mockLocalmost.update.getStatus.mockResolvedValue({
        status: 'idle',
        currentVersion: '2.0.0',
      });

      await renderWithProvider();

      expect(screen.getByTestId('current-version').textContent).toBe('2.0.0');
      expect(screen.getByTestId('status').textContent).toBe('idle');
    });

    it('should use default settings when none saved', async () => {
      mockLocalmost.settings.get.mockResolvedValue({});

      await renderWithProvider();

      expect(screen.getByTestId('auto-check').textContent).toBe('true');
      expect(screen.getByTestId('check-interval').textContent).toBe('24');
    });

    it('should load saved settings', async () => {
      mockLocalmost.settings.get.mockResolvedValue({
        updateSettings: {
          autoCheck: false,
          checkIntervalHours: 12,
        },
      });

      await renderWithProvider();

      expect(screen.getByTestId('auto-check').textContent).toBe('false');
      expect(screen.getByTestId('check-interval').textContent).toBe('12');
    });

    it('should subscribe to status updates', async () => {
      await renderWithProvider();

      expect(mockLocalmost.update.onStatusChange).toHaveBeenCalled();
    });
  });

  describe('Status Updates', () => {
    it('should update status when receiving updates', async () => {
      await renderWithProvider();

      // Simulate update available
      await act(async () => {
        statusChangeCallback!({
          status: 'available',
          currentVersion: '1.0.0',
          availableVersion: '2.0.0',
        });
      });

      expect(screen.getByTestId('status').textContent).toBe('available');
      expect(screen.getByTestId('available-version').textContent).toBe('2.0.0');
    });

    it('should update isChecking when checking status received', async () => {
      await renderWithProvider();

      await act(async () => {
        statusChangeCallback!({
          status: 'checking',
          currentVersion: '1.0.0',
        });
      });

      expect(screen.getByTestId('is-checking').textContent).toBe('true');

      await act(async () => {
        statusChangeCallback!({
          status: 'idle',
          currentVersion: '1.0.0',
        });
      });

      expect(screen.getByTestId('is-checking').textContent).toBe('false');
    });

    it('should reset dismissed state when update available', async () => {
      await renderWithProvider();

      // First dismiss
      fireEvent.click(screen.getByTestId('dismiss-update'));
      expect(screen.getByTestId('is-dismissed').textContent).toBe('true');

      // Then receive update available - should reset dismissed
      await act(async () => {
        statusChangeCallback!({
          status: 'available',
          currentVersion: '1.0.0',
          availableVersion: '2.0.0',
        });
      });

      expect(screen.getByTestId('is-dismissed').textContent).toBe('false');
    });

    it('should show download progress', async () => {
      await renderWithProvider();

      await act(async () => {
        statusChangeCallback!({
          status: 'downloading',
          currentVersion: '1.0.0',
          downloadProgress: 50,
        });
      });

      expect(screen.getByTestId('status').textContent).toBe('downloading');
      expect(screen.getByTestId('download-progress').textContent).toBe('50');
    });

    it('should show error status', async () => {
      await renderWithProvider();

      await act(async () => {
        statusChangeCallback!({
          status: 'error',
          currentVersion: '1.0.0',
          error: 'Network error',
        });
      });

      expect(screen.getByTestId('status').textContent).toBe('error');
      expect(screen.getByTestId('error').textContent).toBe('Network error');
    });
  });

  describe('Actions', () => {
    it('should call check API when checkForUpdates called', async () => {
      await renderWithProvider();

      await act(async () => {
        fireEvent.click(screen.getByTestId('check-updates'));
      });

      expect(mockLocalmost.update.check).toHaveBeenCalled();
    });

    it('should reset dismissed state when checking', async () => {
      await renderWithProvider();

      // Dismiss first
      fireEvent.click(screen.getByTestId('dismiss-update'));
      expect(screen.getByTestId('is-dismissed').textContent).toBe('true');

      // Check for updates - should reset dismissed
      await act(async () => {
        fireEvent.click(screen.getByTestId('check-updates'));
      });

      expect(screen.getByTestId('is-dismissed').textContent).toBe('false');
    });

    it('should call download API when downloadUpdate called', async () => {
      await renderWithProvider();

      await act(async () => {
        fireEvent.click(screen.getByTestId('download-update'));
      });

      expect(mockLocalmost.update.download).toHaveBeenCalled();
    });

    it('should call install API when installUpdate called', async () => {
      await renderWithProvider();

      await act(async () => {
        fireEvent.click(screen.getByTestId('install-update'));
      });

      expect(mockLocalmost.update.install).toHaveBeenCalled();
    });

    it('should set isDismissed when dismissUpdate called', async () => {
      await renderWithProvider();

      expect(screen.getByTestId('is-dismissed').textContent).toBe('false');

      fireEvent.click(screen.getByTestId('dismiss-update'));

      expect(screen.getByTestId('is-dismissed').textContent).toBe('true');
    });
  });

  describe('Settings', () => {
    it('should update settings and persist to API', async () => {
      await renderWithProvider();

      expect(screen.getByTestId('auto-check').textContent).toBe('true');

      await act(async () => {
        fireEvent.click(screen.getByTestId('toggle-auto-check'));
      });

      expect(screen.getByTestId('auto-check').textContent).toBe('false');
      expect(mockLocalmost.settings.set).toHaveBeenCalledWith({
        updateSettings: { autoCheck: false, checkIntervalHours: 24 },
      });
    });

    it('should handle settings persistence failure gracefully', async () => {
      mockLocalmost.settings.set.mockRejectedValue(new Error('Save failed'));

      await renderWithProvider();

      expect(screen.getByTestId('auto-check').textContent).toBe('true');

      // Should still update UI even if save fails (optimistic update)
      await act(async () => {
        fireEvent.click(screen.getByTestId('toggle-auto-check'));
      });

      expect(screen.getByTestId('auto-check').textContent).toBe('false');
    });
  });

  describe('Error Handling', () => {
    it('should handle getStatus failure gracefully', async () => {
      mockLocalmost.update.getStatus.mockRejectedValue(new Error('API error'));

      await renderWithProvider();

      // Should not crash, uses default status
      expect(screen.getByTestId('status').textContent).toBe('idle');
    });

    it('should handle settings load failure gracefully', async () => {
      mockLocalmost.settings.get.mockRejectedValue(new Error('Load failed'));

      await renderWithProvider();

      // Should use defaults
      expect(screen.getByTestId('auto-check').textContent).toBe('true');
    });

    it('should reset isChecking on check failure', async () => {
      mockLocalmost.update.check.mockRejectedValue(new Error('Check failed'));

      await renderWithProvider();

      await act(async () => {
        fireEvent.click(screen.getByTestId('check-updates'));
      });

      expect(screen.getByTestId('is-checking').textContent).toBe('false');
    });
  });

  describe('Cleanup', () => {
    it('should unsubscribe from status updates on unmount', async () => {
      const unsubscribe = jest.fn();
      mockLocalmost.update.onStatusChange.mockReturnValue(unsubscribe);

      const { unmount } = await renderWithProvider();

      expect(mockLocalmost.update.onStatusChange).toHaveBeenCalled();

      unmount();

      expect(unsubscribe).toHaveBeenCalled();
    });
  });

  describe('lastChecked auto-clear', () => {
    it('should set lastChecked after successful check', async () => {
      await renderWithProvider();

      expect(screen.getByTestId('last-checked').textContent).toBe('null');

      await act(async () => {
        fireEvent.click(screen.getByTestId('check-updates'));
      });

      expect(screen.getByTestId('last-checked').textContent).toBe('set');
    });

    it('should clear lastChecked after timeout', async () => {
      // Use real timers but with a shorter wait
      jest.useFakeTimers();

      await act(async () => {
        render(
          <UpdateProvider>
            <TestConsumer />
          </UpdateProvider>
        );
      });

      // Run pending timers to complete initial load
      await act(async () => {
        jest.runAllTimers();
      });

      // Trigger check
      await act(async () => {
        fireEvent.click(screen.getByTestId('check-updates'));
        jest.runAllTimers(); // Run the check promise
      });

      expect(screen.getByTestId('last-checked').textContent).toBe('set');

      // Fast-forward past the 5 second timeout
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });

      expect(screen.getByTestId('last-checked').textContent).toBe('null');

      jest.useRealTimers();
    });
  });
});
