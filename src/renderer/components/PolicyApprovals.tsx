import React, { useCallback, useEffect, useState } from 'react';
import { PolicySummary } from '../../shared/types';
import styles from './PolicyApprovals.module.css';
import shared from '../styles/shared.module.css';

/**
 * Review and approve the sandbox policies repositories ask for.
 *
 * A repository's `.localmostrc` grants access beyond the built-in baseline, so
 * the runner holds any job whose policy is new or changed until it is approved
 * here. Without this the only way to approve one was the CLI.
 */
const PolicyApprovals: React.FC = () => {
  const [policies, setPolicies] = useState<PolicySummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPolicies(await window.localmost.policy.list());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (repository: string, action: 'approve' | 'reject') => {
    setBusy(repository);
    setError(null);
    try {
      const result =
        action === 'approve'
          ? await window.localmost.policy.approve(repository)
          : await window.localmost.policy.reject(repository);
      if (!result.success) {
        setError(result.error || `Could not ${action} ${repository}`);
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  const pending = policies.filter(p => !p.approved);
  const approved = policies.filter(p => p.approved);

  if (policies.length === 0) {
    return (
      <p className={shared.formHint} data-testid="policy-approvals-empty">
        No repository has asked for extra sandbox access yet.
      </p>
    );
  }

  return (
    <div data-testid="policy-approvals">
      {pending.length > 0 && (
        <>
          <p className={shared.formHint}>
            {pending.length === 1 ? 'A repository is' : `${pending.length} repositories are`} waiting
            for approval. Jobs from {pending.length === 1 ? 'it' : 'them'} are being refused until
            you decide.
          </p>
          {pending.map(policy => (
            <div key={policy.repository} className={styles.policy} data-testid="pending-policy">
              <div className={styles.policyHeader}>
                <span className={styles.repo}>{policy.repository}</span>
                <div className={styles.actions}>
                  <button
                    className={`${shared.btn} ${shared.btnSecondary}`}
                    disabled={busy === policy.repository}
                    onClick={() => act(policy.repository, 'reject')}
                  >
                    Reject
                  </button>
                  <button
                    className={`${shared.btn} ${shared.btnPrimary}`}
                    disabled={busy === policy.repository}
                    onClick={() => act(policy.repository, 'approve')}
                  >
                    Approve
                  </button>
                </div>
              </div>
              {policy.grants.length === 0 ? (
                <p className={shared.formHint}>Grants nothing beyond the baseline.</p>
              ) : (
                <ul className={styles.grants}>
                  {policy.grants.map(grant => (
                    <li key={grant}>{grant}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </>
      )}

      {approved.length > 0 && (
        <p className={shared.formHint} data-testid="approved-count">
          {approved.length} approved {approved.length === 1 ? 'policy' : 'policies'}.
        </p>
      )}

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
};

export default PolicyApprovals;
