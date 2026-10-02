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

  const act = async (policy: PolicySummary, action: 'approve' | 'reject') => {
    const { repository } = policy;
    setBusy(repository);
    setError(null);
    try {
      // Approval quotes the stamp of the policy on this card, and main refuses
      // it if the pending policy has been replaced since the card was drawn.
      const result =
        action === 'approve'
          ? await window.localmost.policy.approve(repository, policy.stamp)
          : await window.localmost.policy.reject(repository);
      // Reload first: it clears the error, and a refusal has to stay visible
      // next to the policy that replaced the one it was for.
      await load();
      if (!result.success) {
        setError(result.error || `Could not ${action} ${repository}`);
      }
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
            {pending.length === 1 ? 'A policy is' : `${pending.length} policies are`} waiting
            for approval. Jobs that carry {pending.length === 1 ? 'it are' : 'one are'} refused until
            you approve it; jobs under an approved policy keep running.
          </p>
          {pending.map(policy => (
            <div key={policy.repository} className={styles.policy} data-testid="pending-policy">
              <div className={styles.policyHeader}>
                <span className={styles.repo}>{policy.repository}</span>
                <div className={styles.actions}>
                  <button
                    className={`${shared.btn} ${shared.btnSecondary}`}
                    disabled={busy === policy.repository}
                    onClick={() => act(policy, 'reject')}
                  >
                    Reject
                  </button>
                  <button
                    className={`${shared.btn} ${shared.btnPrimary}`}
                    disabled={busy === policy.repository}
                    onClick={() => act(policy, 'approve')}
                  >
                    Approve
                  </button>
                </div>
              </div>
              {policy.changes && policy.changes.length > 0 && (
                <div data-testid="policy-changes">
                  <p className={shared.formHint}>
                    Changes from the approved policy, which stays in force unless you approve this one:
                  </p>
                  <ul className={styles.grants}>
                    {policy.changes.map(change => (
                      <li key={change}>{change}</li>
                    ))}
                  </ul>
                  <p className={shared.formHint}>In full, it grants:</p>
                </div>
              )}
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
