import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import UpdateNotification from './UpdateNotification';
import { UpdateProvider } from '../contexts/UpdateContext';
import { mockLocalmost } from '../../../test/setup-renderer';
import { UpdateStatus } from '../../shared/types';

// Helper to render with provider
const renderWithProvider = () => {
  return render(
    <UpdateProvider>
      <UpdateNotification />
    </UpdateProvider>
  );
};

describe('UpdateNotification', () => {
  let statusChangeCallback: ((status: UpdateStatus) => void) | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    statusChangeCallback = null;

    // Default: idle state
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

  describe('Idle State', () => {
    it('should not render when status is idle', async () => {
      const { container } = renderWithProvider();

      // Wait for initial load
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(container.querySelector('[class*="banner"]')).toBeNull();
    });

    it('should not render when status is checking', async () => {
      mockLocalmost.update.getStatus.mockResolvedValue({
        status: 'checking',
        currentVersion: '1.0.0',
      });

      const { container } = renderWithProvider();

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(container.querySelector('[class*="banner"]')).toBeNull();
    });
  });

  describe('Update Available State', () => {
    beforeEach(() => {
      mockLocalmost.update.getStatus.mockResolvedValue({
        status: 'available',
        currentVersion: '1.0.0',
        availableVersion: '2.0.0',
      });
    });

    it('should show update available banner', async () => {
      renderWithProvider();

      await screen.findByText('Version 2.0.0 is available');
    });

    it('should show Download button', async () => {
      renderWithProvider();

      await screen.findByRole('button', { name: 'Download' });
    });

    it('should call downloadUpdate when Download clicked', async () => {
      renderWithProvider();

      const downloadBtn = await screen.findByRole('button', { name: 'Download' });
      fireEvent.click(downloadBtn);

      expect(mockLocalmost.update.download).toHaveBeenCalled();
    });

    it('should have dismiss button with correct title', async () => {
      renderWithProvider();

      const dismissBtn = await screen.findByTitle('Remind me later');
      expect(dismissBtn).toBeInTheDocument();
    });

    it('should hide banner when dismissed', async () => {
      const { container } = renderWithProvider();

      const dismissBtn = await screen.findByTitle('Remind me later');
      fireEvent.click(dismissBtn);

      // Banner should be gone
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(container.querySelector('[class*="banner"]')).toBeNull();
    });
  });

  describe('Downloading State', () => {
    beforeEach(() => {
      mockLocalmost.update.getStatus.mockResolvedValue({
        status: 'downloading',
        currentVersion: '1.0.0',
        downloadProgress: 45,
      });
    });

    it('should show downloading banner with progress', async () => {
      renderWithProvider();

      await screen.findByText('Downloading update... 45%');
    });

    it('should show progress bar', async () => {
      renderWithProvider();

      await screen.findByText(/Downloading update/);

      const progressFill = screen.getByTestId('progress-fill');
      expect(progressFill).toBeInTheDocument();
      expect(progressFill).toHaveStyle({ width: '45%' });
    });

    it('should update progress when status changes', async () => {
      renderWithProvider();

      await screen.findByText(/Downloading update/);

      // Simulate progress update
      statusChangeCallback!({
        status: 'downloading',
        currentVersion: '1.0.0',
        downloadProgress: 75,
      });

      await screen.findByText('Downloading update... 75%');
      const progressFill = screen.getByTestId('progress-fill');
      expect(progressFill).toHaveStyle({ width: '75%' });
    });

    it('should show 0% when downloadProgress is undefined', async () => {
      mockLocalmost.update.getStatus.mockResolvedValue({
        status: 'downloading',
        currentVersion: '1.0.0',
      });

      renderWithProvider();

      await screen.findByText('Downloading update... 0%');
    });
  });

  describe('Downloaded State', () => {
    beforeEach(() => {
      mockLocalmost.update.getStatus.mockResolvedValue({
        status: 'downloaded',
        currentVersion: '1.0.0',
        availableVersion: '2.0.0',
      });
    });

    it('should show update ready banner', async () => {
      renderWithProvider();

      await screen.findByText('Update ready to install');
    });

    it('should show Restart & Install button', async () => {
      renderWithProvider();

      await screen.findByRole('button', { name: /Restart.*Install/i });
    });

    it('should call installUpdate when Restart & Install clicked', async () => {
      renderWithProvider();

      const installBtn = await screen.findByRole('button', { name: /Restart.*Install/i });
      fireEvent.click(installBtn);

      expect(mockLocalmost.update.install).toHaveBeenCalled();
    });

    it('should have dismiss button with correct title', async () => {
      renderWithProvider();

      const dismissBtn = await screen.findByTitle('Install later');
      expect(dismissBtn).toBeInTheDocument();
    });

    it('should hide banner when dismissed', async () => {
      const { container } = renderWithProvider();

      const dismissBtn = await screen.findByTitle('Install later');
      fireEvent.click(dismissBtn);

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(container.querySelector('[class*="banner"]')).toBeNull();
    });
  });

  describe('Error State', () => {
    beforeEach(() => {
      mockLocalmost.update.getStatus.mockResolvedValue({
        status: 'error',
        currentVersion: '1.0.0',
        error: 'Network connection failed',
      });
    });

    it('should show error banner with message', async () => {
      renderWithProvider();

      await screen.findByText('Update failed: Network connection failed');
    });

    it('should have dismiss button', async () => {
      renderWithProvider();

      const dismissBtn = await screen.findByTitle('Dismiss');
      expect(dismissBtn).toBeInTheDocument();
    });

    it('should hide banner when dismissed', async () => {
      const { container } = renderWithProvider();

      const dismissBtn = await screen.findByTitle('Dismiss');
      fireEvent.click(dismissBtn);

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(container.querySelector('[class*="banner"]')).toBeNull();
    });
  });

  describe('Dismissed State', () => {
    it('should not show banner when dismissed even if update available', async () => {
      mockLocalmost.update.getStatus.mockResolvedValue({
        status: 'available',
        currentVersion: '1.0.0',
        availableVersion: '2.0.0',
      });

      const { container } = renderWithProvider();

      // Dismiss the update
      const dismissBtn = await screen.findByTitle('Remind me later');
      fireEvent.click(dismissBtn);

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(container.querySelector('[class*="banner"]')).toBeNull();
    });

    it('should show banner again when new update becomes available', async () => {
      mockLocalmost.update.getStatus.mockResolvedValue({
        status: 'available',
        currentVersion: '1.0.0',
        availableVersion: '2.0.0',
      });

      const { container } = renderWithProvider();

      // Dismiss the update
      const dismissBtn = await screen.findByTitle('Remind me later');
      fireEvent.click(dismissBtn);

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(container.querySelector('[class*="banner"]')).toBeNull();

      // New update available (simulates reopening app)
      statusChangeCallback!({
        status: 'available',
        currentVersion: '1.0.0',
        availableVersion: '3.0.0',
      });

      await screen.findByText('Version 3.0.0 is available');
    });
  });

  describe('State Transitions', () => {
    it('should transition from available to downloading', async () => {
      mockLocalmost.update.getStatus.mockResolvedValue({
        status: 'available',
        currentVersion: '1.0.0',
        availableVersion: '2.0.0',
      });

      renderWithProvider();

      await screen.findByText('Version 2.0.0 is available');

      statusChangeCallback!({
        status: 'downloading',
        currentVersion: '1.0.0',
        downloadProgress: 10,
      });

      await screen.findByText('Downloading update... 10%');
    });

    it('should transition from downloading to downloaded', async () => {
      mockLocalmost.update.getStatus.mockResolvedValue({
        status: 'downloading',
        currentVersion: '1.0.0',
        downloadProgress: 50,
      });

      renderWithProvider();

      await screen.findByText(/Downloading update/);

      statusChangeCallback!({
        status: 'downloaded',
        currentVersion: '1.0.0',
        availableVersion: '2.0.0',
      });

      await screen.findByText('Update ready to install');
    });

    it('should transition from downloading to error', async () => {
      mockLocalmost.update.getStatus.mockResolvedValue({
        status: 'downloading',
        currentVersion: '1.0.0',
        downloadProgress: 50,
      });

      renderWithProvider();

      await screen.findByText(/Downloading update/);

      statusChangeCallback!({
        status: 'error',
        currentVersion: '1.0.0',
        error: 'Download interrupted',
      });

      await screen.findByText('Update failed: Download interrupted');
    });
  });
});
