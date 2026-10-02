import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { seedZubridge, resetZubridge } from '../../../test/zubridge-state';
import { RunnerProvider } from '../contexts/RunnerContext';
import { AppConfigProvider } from '../contexts/AppConfigContext';
import { UpdateProvider } from '../contexts/UpdateContext';
import SettingsPage from './SettingsPage';

/**
 * The expired-session UI on the path the app actually runs.
 *
 * Every other renderer test leaves the zubridge store null, so
 * `isZubridgeReady` is false and the context serves its fallback values. The
 * app is never in that state: the store is always populated, so production
 * always reads the store branch. Three defects in this feature shipped green
 * because the suite could not reach it.
 */
const renderSettings = () =>
  render(
    <AppConfigProvider>
      <UpdateProvider>
        <RunnerProvider>
          <SettingsPage onBack={() => undefined} scrollToSection={undefined} />
        </RunnerProvider>
      </UpdateProvider>
    </AppConfigProvider>
  );

describe('the expired session with the store populated, as in the app', () => {
  afterEach(() => resetZubridge());

  it('shows the badge and Reconnect beside the account', async () => {
    seedZubridge({ user: { login: 'testuser', name: 'Test User', avatar_url: '' } });
    (window as unknown as { localmost: { github: { getAuthStatus: jest.Mock } } }).localmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      expired: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });

    renderSettings();

    await waitFor(() => {
      expect(screen.getByText('Session expired')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(screen.getByText('Sign Out')).toBeInTheDocument();
  });

  it('shows the device code once the flow starts, where Reconnect ran', async () => {
    seedZubridge({
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
      deviceCode: { userCode: 'WXYZ-9876', verificationUri: 'https://github.com/login/device' },
    });
    (window as unknown as { localmost: { github: { getAuthStatus: jest.Mock } } }).localmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      expired: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });

    renderSettings();

    await waitFor(() => {
      expect(screen.getByText('WXYZ-9876')).toBeInTheDocument();
    });
  });

  it('clears the badge once Reconnect succeeds, without a restart', async () => {
    // Reconnect worked and the app went on showing "Session expired" until it
    // was quit and reopened: the renderer reads auth status when it mounts,
    // and nothing told it the flag had cleared.
    seedZubridge({ user: { login: 'testuser', name: 'Test User', avatar_url: '' } });
    const github = (window as unknown as {
      localmost: { github: { getAuthStatus: jest.Mock; reconnect: jest.Mock } };
    }).localmost.github;
    github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      expired: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });
    github.reconnect.mockImplementation(async () => {
      // The session is live again from this point on.
      github.getAuthStatus.mockResolvedValue({
        isAuthenticated: true,
        expired: false,
        user: { login: 'testuser', name: 'Test User', avatar_url: '' },
      });
      return { recovered: true };
    });

    renderSettings();
    await waitFor(() => expect(screen.getByText('Session expired')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));

    await waitFor(() => {
      expect(screen.queryByText('Session expired')).not.toBeInTheDocument();
    });
  });

  it('leaves a healthy session alone', async () => {
    seedZubridge({ user: { login: 'testuser', name: 'Test User', avatar_url: '' } });
    (window as unknown as { localmost: { github: { getAuthStatus: jest.Mock } } }).localmost.github.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      user: { login: 'testuser', name: 'Test User', avatar_url: '' },
    });

    renderSettings();

    await waitFor(() => {
      expect(screen.getByText('Sign Out')).toBeInTheDocument();
    });
    expect(screen.queryByText('Session expired')).not.toBeInTheDocument();
  });
});
