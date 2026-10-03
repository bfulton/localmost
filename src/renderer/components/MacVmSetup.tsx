/**
 * The macOS VM mode's setup: the golden image's state, its build and the
 * disk it needs, the guided setup's window and values on a Mac older than
 * macOS 27, and rebuilding or removing the image. Self-contained, for the
 * Settings page to mount; everything it does goes through the macosVm API
 * (src/main/ipc-handlers/macos-vm.ts). See docs/roadmap/macos-vm-jobs.md.
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { MacVmBuildPhase, MacVmSetupApi, MacVmSetupStatus } from '../../shared/macos-vm-setup';
import styles from './MacVmSetup.module.css';
import shared from '../styles/shared.module.css';

const PHASES: Record<MacVmBuildPhase, string> = {
  catalog: 'Finding macOS',
  download: 'Downloading macOS',
  verify: 'Checking the download',
  install: 'Installing macOS',
  provision: 'First boot',
  setup: 'Setting up the VM',
  'save-state': 'Saving for fast starts',
  check: 'Checking the image',
};

export const formatGiB = (bytes: number): string => `${(bytes / 2 ** 30).toFixed(bytes < 10 * 2 ** 30 ? 1 : 0)} GB`;

interface MacVmSetupProps {
  /** window.localmost.macosVm by default. */
  api?: MacVmSetupApi;
}

const MacVmSetup: React.FC<MacVmSetupProps> = ({ api: given }) => {
  const api: MacVmSetupApi = given ?? window.localmost.macosVm;
  const [status, setStatus] = useState<MacVmSetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    let live = true;
    api.getStatus().then((s) => live && setStatus(s)).catch((err: Error) => live && setError(err.message));
    const off = api.onStatusChange((s) => setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, [api]);

  const run = useCallback(
    async (action: () => Promise<{ success: boolean; error?: string }>) => {
      setError(null);
      const result = await action();
      if (!result.success) setError(result.error ?? 'that did not work');
    },
    []
  );

  if (!status) return <div className={styles.macVmSetup}>Checking macOS VM support...</div>;

  const enoughDisk = status.disk.freeBytes >= status.disk.neededBytes;
  const building = status.state === 'building' || status.state === 'needs-guided-setup';

  return (
    <div className={styles.macVmSetup} data-state={status.state}>
      {status.state === 'unsupported' && <p className={shared.formHint}>macOS VMs are not available on this Mac: {status.reason}</p>}

      {(status.state === 'not-built' || status.state === 'failed') && (
        <>
          {status.state === 'failed' && <p className={shared.errorMessage}>The golden image is not usable: {status.reason}</p>}
          <p className={shared.formHint}>
            Jobs that ask for macOS VM isolation run in a fresh macOS VM cloned from a golden image that localmost builds once:
            macOS from Apple, the Xcode Command Line Tools and the runner.{' '}
            {status.provisioning === 'guided'
              ? 'On this macOS, its first boot needs you for a few minutes in a setup window.'
              : 'It builds without your help.'}
          </p>
          <p className={enoughDisk ? shared.formHint : shared.errorMessage}>
            Needs about {formatGiB(status.disk.neededBytes)} free while it builds; {formatGiB(status.disk.freeBytes)} is free.
          </p>
          <button className={shared.btnPrimary} disabled={!enoughDisk} onClick={() => run(api.build)}>
            {status.state === 'failed' ? 'Build again' : 'Build the golden image'}
          </button>
        </>
      )}

      {building && (
        <>
          <div className={styles.phase}>
            <span>{status.phase ? PHASES[status.phase] : 'Building'}</span>
            {status.percent !== undefined && <span>{status.percent}%</span>}
          </div>
          {status.percent !== undefined && (
            <div className={styles.progress} role="progressbar" aria-valuenow={status.percent} aria-valuemin={0} aria-valuemax={100}>
              <div className={styles.progressFill} style={{ width: `${status.percent}%` }} />
            </div>
          )}
          {status.step && <p className={shared.formHint}>{status.step}</p>}
        </>
      )}

      {status.guided && (
        <div className={styles.guided}>
          <p className={shared.formHint}>
            {status.guided.windowOpen
              ? 'In the setup window, follow these steps. localmost takes over once Remote Login is on.'
              : 'Open the setup window when you have a few minutes. It shows the new VM; follow these steps in it:'}
          </p>
          <dl className={styles.values}>
            <dt>Full name</dt>
            <dd>{status.guided.fullName}</dd>
            <dt>Account name</dt>
            <dd>{status.guided.username}</dd>
            <dt>Password</dt>
            <dd className={styles.password}>{status.guided.password}</dd>
          </dl>
          <ol className={styles.steps}>
            {status.guided.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {!status.guided.windowOpen && (
            <button className={shared.btnPrimary} onClick={() => run(api.openGuidedSetup)}>
              Open the setup window
            </button>
          )}
        </div>
      )}

      {building && (
        <button className={shared.btnSecondary} onClick={() => run(api.cancel)}>
          Cancel
        </button>
      )}

      {status.state === 'ready' && status.image && (
        <>
          <p className={shared.formHint}>
            Golden image: macOS {status.image.os} ({status.image.build}), {formatGiB(status.image.diskAllocatedBytes)} on disk.{' '}
            {status.image.slots.length > 1 ? 'Two jobs can run at once.' : 'One job runs at a time.'}
          </p>
          {status.reason && <p className={shared.errorMessage}>{status.reason}</p>}
          {status.image.stale && <p className={shared.formHint}>This Mac now runs a newer macOS than the image was built on. Rebuilding is recommended.</p>}
          <div className={styles.actions}>
            <button className={shared.btnSecondary} disabled={!enoughDisk} onClick={() => run(api.build)}>
              Rebuild
            </button>
            {confirmRemove ? (
              <>
                <button className={shared.btnSecondary} disabled={status.busy} onClick={() => (setConfirmRemove(false), run(api.remove))}>
                  Remove it
                </button>
                <button className={shared.btnSecondary} onClick={() => setConfirmRemove(false)}>
                  Keep it
                </button>
              </>
            ) : (
              <button className={shared.btnSecondary} disabled={status.busy} onClick={() => setConfirmRemove(true)}>
                Remove
              </button>
            )}
          </div>
          {status.busy && <p className={shared.formHint}>A macOS VM job is running; the image can be removed once it ends.</p>}
        </>
      )}

      {error && <p className={shared.errorMessage}>{error}</p>}
    </div>
  );
};

export default MacVmSetup;
