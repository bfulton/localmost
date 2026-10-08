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
        stamp: 'a'.repeat(64),
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
      { repository: 'owner/repo', approved: false, cachedAt: '', grants: ['network: a.example.com'], stamp: 'b'.repeat(64) },
    ]);

    render(<PolicyApprovals />);
    await waitFor(() => expect(screen.getByText('owner/repo')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });

    // The stamp is what binds the click to the policy on the card: main
    // refuses it if the pending policy has changed since.
    expect(api().approve).toHaveBeenCalledWith('owner/repo', 'b'.repeat(64));
    expect(api().list).toHaveBeenCalledTimes(2);
  });

  it('rejects a policy', async () => {
    api().list.mockResolvedValue([
      { repository: 'owner/repo', approved: false, cachedAt: '', grants: [], stamp: 'c'.repeat(64) },
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
      { repository: 'owner/repo', approved: true, cachedAt: '', grants: ['network: a.example.com'], stamp: 'd'.repeat(64) },
    ]);

    render(<PolicyApprovals />);

    await waitFor(() => expect(screen.getByTestId('approved-count')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('shows what a pending change does to the approved policy, the level included', async () => {
    api().list.mockResolvedValue([
      {
        repository: 'owner/repo',
        approved: false,
        cachedAt: '',
        grants: ['level: permissive (allows every network host)', 'network: a.example.com'],
        changes: ['~ level: strict -> permissive'],
        stamp: 'e'.repeat(64),
      },
      { repository: 'owner/repo', approved: true, cachedAt: '', grants: ['network: a.example.com'], stamp: 'f'.repeat(64) },
    ]);

    render(<PolicyApprovals />);

    await waitFor(() => expect(screen.getByText('~ level: strict -> permissive')).toBeInTheDocument());
    // It stays in force after a Reject too, so "until you decide" was wrong.
    expect(screen.getByTestId('policy-changes')).toHaveTextContent(/stays in force unless you approve this one/);
    expect(screen.getByText('level: permissive (allows every network host)')).toBeInTheDocument();
    expect(screen.getAllByTestId('pending-policy')).toHaveLength(1);
  });

  it('says only jobs carrying the pending policy are refused', async () => {
    // Jobs whose file matches the approved policy keep running while a
    // change waits, so "jobs from it are being refused" overstated it.
    api().list.mockResolvedValue([
      { repository: 'owner/repo', approved: false, cachedAt: '', grants: [], stamp: 'a'.repeat(64) },
    ]);

    render(<PolicyApprovals />);

    await waitFor(() => expect(screen.getByText('owner/repo')).toBeInTheDocument());
    expect(screen.getByTestId('policy-approvals')).toHaveTextContent(/Jobs that carry it are refused until you approve it/);
    expect(screen.getByTestId('policy-approvals')).not.toHaveTextContent(/until you decide/);
  });

  it('shows no empty list of changes', async () => {
    api().list.mockResolvedValue([
      { repository: 'owner/repo', approved: false, cachedAt: '', grants: [], changes: [], stamp: 'a'.repeat(64) },
    ]);

    render(<PolicyApprovals />);

    await waitFor(() => expect(screen.getByText('owner/repo')).toBeInTheDocument());
    expect(screen.queryByTestId('policy-changes')).not.toBeInTheDocument();
  });

  it('shows the error when approval is refused because the policy changed', async () => {
    api().list.mockResolvedValue([
      { repository: 'owner/repo', approved: false, cachedAt: '', grants: [], stamp: 'a'.repeat(64) },
    ]);
    api().approve.mockResolvedValue({ success: false, error: 'The policy for owner/repo changed since it was shown.' });

    render(<PolicyApprovals />);
    await waitFor(() => expect(screen.getByText('owner/repo')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });

    expect(screen.getByText(/changed since it was shown/)).toBeInTheDocument();
  });
});
