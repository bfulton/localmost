import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import PolicyApprovals from './PolicyApprovals';

const api = () => window.localmost.policy;

describe('PolicyApprovals', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    api().list.mockResolvedValue([]);
  });

  it('says nothing is waiting when no repository has a policy', async () => {
    render(<PolicyApprovals />);

    await waitFor(() => {
      expect(screen.getByTestId('policy-approvals-empty')).toBeInTheDocument();
    });
  });

  it('lists what a pending policy grants', async () => {
    api().list.mockResolvedValue([
      {
        repository: 'owner/repo',
        approved: false,
        cachedAt: '2026-08-30T00:00:00Z',
        grants: ['network: index.crates.io', 'read: /opt/homebrew'],
      },
    ]);

    render(<PolicyApprovals />);

    await waitFor(() => {
      expect(screen.getByText('owner/repo')).toBeInTheDocument();
    });
    // A reviewer has to see what they are agreeing to.
    expect(screen.getByText('network: index.crates.io')).toBeInTheDocument();
    expect(screen.getByText('read: /opt/homebrew')).toBeInTheDocument();
  });

  it('approves a policy and refreshes', async () => {
    api().list.mockResolvedValue([
      { repository: 'owner/repo', approved: false, cachedAt: '', grants: ['network: a.example.com'] },
    ]);

    render(<PolicyApprovals />);
    await waitFor(() => expect(screen.getByText('owner/repo')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });

    expect(api().approve).toHaveBeenCalledWith('owner/repo');
    expect(api().list).toHaveBeenCalledTimes(2);
  });

  it('rejects a policy', async () => {
    api().list.mockResolvedValue([
      { repository: 'owner/repo', approved: false, cachedAt: '', grants: [] },
    ]);

    render(<PolicyApprovals />);
    await waitFor(() => expect(screen.getByText('owner/repo')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    });

    expect(api().reject).toHaveBeenCalledWith('owner/repo');
  });

  it('does not offer buttons for an already approved policy', async () => {
    api().list.mockResolvedValue([
      { repository: 'owner/repo', approved: true, cachedAt: '', grants: ['network: a.example.com'] },
    ]);

    render(<PolicyApprovals />);

    await waitFor(() => expect(screen.getByTestId('approved-count')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});
