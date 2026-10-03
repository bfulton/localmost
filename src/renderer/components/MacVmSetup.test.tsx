import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import MacVmSetup from './MacVmSetup';
import type { MacVmSetupStatus } from '../../shared/macos-vm-setup';
import { guidedSetupSteps } from '../../shared/macos-vm-setup';

const GiB = 2 ** 30;

/** The macosVm API, with a status the test sets and pushes. */
function fakeApi(initial: MacVmSetupStatus) {
  let listener: ((s: MacVmSetupStatus) => void) | null = null;
  const api = {
    getStatus: jest.fn().mockResolvedValue(initial),
    build: jest.fn().mockResolvedValue({ success: true }),
    cancel: jest.fn().mockResolvedValue({ success: true }),
    openGuidedSetup: jest.fn().mockResolvedValue({ success: true }),
    remove: jest.fn().mockResolvedValue({ success: true }),
    onStatusChange: jest.fn((cb: (s: MacVmSetupStatus) => void) => {
      listener = cb;
      return () => (listener = null);
    }),
  };
  const push = (s: MacVmSetupStatus) => act(() => listener?.(s));
  return { api, push };
}

const base: MacVmSetupStatus = { state: 'not-built', disk: { freeBytes: 80 * GiB, neededBytes: 60 * GiB }, provisioning: 'guided', busy: false };

const shown = async (status: MacVmSetupStatus) => {
  const fake = fakeApi(status);
  await act(async () => {
    render(<MacVmSetup api={fake.api} />);
  });
  return fake;
};

describe('MacVmSetup', () => {
  it('says why this Mac cannot run macOS VMs', async () => {
    await shown({ ...base, state: 'unsupported', reason: 'macOS VMs need a Mac with Apple silicon' });
    expect(screen.getByText(/not available on this Mac: macOS VMs need a Mac with Apple silicon/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers the build with the disk it needs, and says the guided setup will need the operator', async () => {
    const { api } = await shown(base);
    expect(screen.getByText(/Needs about 60 GB free while it builds; 80 GB is free/)).toBeInTheDocument();
    expect(screen.getByText(/needs you for a few minutes in a setup window/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Build the golden image' }));
    });
    expect(api.build).toHaveBeenCalled();
  });

  it('will not start a build the disk cannot hold', async () => {
    await shown({ ...base, disk: { freeBytes: 30 * GiB, neededBytes: 60 * GiB }, provisioning: 'headless' });
    expect(screen.getByRole('button', { name: 'Build the golden image' })).toBeDisabled();
    expect(screen.getByText(/builds without your help/)).toBeInTheDocument();
  });

  it('shows the build as it goes, and cancels it', async () => {
    const { api, push } = await shown(base);
    push({ ...base, state: 'building', phase: 'install', percent: 42, step: 'Installing macOS 26.6.2 into the golden image' });
    expect(screen.getByText('Installing macOS')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(api.cancel).toHaveBeenCalled();
  });

  it('shows the guided setup\'s values and steps, and opens its window on request', async () => {
    const account = { username: 'localmost-admin', fullName: 'localmost setup', password: 'abcd-efgh-jkmn-pqrs-tuvw' };
    const { api, push } = await shown(base);
    push({ ...base, state: 'needs-guided-setup', phase: 'provision', guided: { ...account, steps: guidedSetupSteps(account), windowOpen: false } });
    expect(screen.getByText('abcd-efgh-jkmn-pqrs-tuvw')).toBeInTheDocument();
    expect(screen.getByText('localmost-admin')).toBeInTheDocument();
    expect(screen.getByText(/turn on Remote Login/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open the setup window' }));
    });
    expect(api.openGuidedSetup).toHaveBeenCalled();
    push({ ...base, state: 'building', phase: 'provision', guided: { ...account, steps: guidedSetupSteps(account), windowOpen: true } });
    expect(screen.queryByRole('button', { name: 'Open the setup window' })).toBeNull();
    expect(screen.getByText(/localmost takes over once Remote Login is on/)).toBeInTheDocument();
  });

  it('describes a ready image, recommends a rebuild when stale, and removes it only once confirmed and idle', async () => {
    const ready: MacVmSetupStatus = {
      ...base, state: 'ready', image: { os: '26.6.2', build: '25G83', diskAllocatedBytes: 21 * GiB, slots: [1, 2], stale: true },
    };
    const { api, push } = await shown(ready);
    expect(screen.getByText(/macOS 26.6.2 \(25G83\), 21 GB on disk. Two jobs can run at once./)).toBeInTheDocument();
    expect(screen.getByText(/Rebuilding is recommended/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    });
    expect(api.remove).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove it' }));
    });
    expect(api.remove).toHaveBeenCalled();

    push({ ...ready, busy: true, image: { ...ready.image!, slots: [1], stale: false } });
    expect(screen.getByText(/One job runs at a time/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  it('shows a refusal from the main process', async () => {
    const { api } = await shown(base);
    api.build.mockResolvedValue({ success: false, error: 'download the runner first' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Build the golden image' }));
    });
    expect(screen.getByText('download the runner first')).toBeInTheDocument();
  });
});
