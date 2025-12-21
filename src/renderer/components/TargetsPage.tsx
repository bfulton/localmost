import React, { useState, useEffect, useCallback } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark, faTrash, faBuilding, faBook, faPlus } from '@fortawesome/free-solid-svg-icons';
import { Target, RunnerProxyStatus, GitHubRepo, GitHubOrg } from '../../shared/types';
import { useRunner } from '../contexts';
import styles from './TargetsPage.module.css';
import shared from '../styles/shared.module.css';

interface TargetsPageProps {
  onBack: () => void;
}

const TargetsPage: React.FC<TargetsPageProps> = ({ onBack }) => {
  const { repos, orgs, targets, refreshTargets } = useRunner();

  // State
  const [targetStatus, setTargetStatus] = useState<RunnerProxyStatus[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pending targets (being registered)
  interface PendingTarget {
    id: string;
    type: 'repo' | 'org';
    displayName: string;
  }
  const [pendingTargets, setPendingTargets] = useState<PendingTarget[]>([]);

  // Add form state
  const [addType, setAddType] = useState<'repo' | 'org'>('repo');
  const [searchQuery, setSearchQuery] = useState('');
  const [showResults, setShowResults] = useState(false);

  // Load status on mount
  useEffect(() => {
    const loadStatus = async () => {
      try {
        const status = await window.localmost.targets.getStatus();
        setTargetStatus(status);
      } catch (err) {
        setError((err as Error).message);
      }
    };
    loadStatus();

    // Subscribe to status updates
    const unsubscribe = window.localmost.targets.onStatusUpdate((status) => {
      setTargetStatus(status);
    });

    return () => unsubscribe();
  }, []);

  // Get status for a target
  const getTargetStatus = useCallback((targetId: string): RunnerProxyStatus | undefined => {
    return targetStatus.find(s => s.targetId === targetId);
  }, [targetStatus]);

  // Add a target
  const handleAddTarget = async (type: 'repo' | 'org', owner: string, repo?: string) => {
    setError(null);

    // Create pending target to show immediately
    const displayName = type === 'org' ? owner : `${owner}/${repo}`;
    const pendingId = `pending-${Date.now()}`;
    const pending: PendingTarget = { id: pendingId, type, displayName };

    setPendingTargets(prev => [...prev, pending]);
    setSearchQuery('');
    setShowResults(false);

    try {
      const result = await window.localmost.targets.add(type, owner, repo);
      if (result.success) {
        await refreshTargets();
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      // Remove from pending
      setPendingTargets(prev => prev.filter(p => p.id !== pendingId));
    }
  };

  // Remove a target
  const handleRemoveTarget = async (targetId: string) => {
    const target = targets.find(t => t.id === targetId);
    if (!target) return;

    if (!confirm(`Remove ${target.displayName}? This will unregister the runner from GitHub.`)) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await window.localmost.targets.remove(targetId);
      if (result.success) {
        await refreshTargets();
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  // Filter repos/orgs based on search
  const filteredRepos = (repos || []).filter(r =>
    r.full_name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const filteredOrgs = (orgs || []).filter(o =>
    o.login.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Check if already added
  const isTargetAdded = (type: 'repo' | 'org', owner: string, repo?: string): boolean => {
    return targets.some(t =>
      t.type === type &&
      t.owner === owner &&
      (type === 'org' || t.repo === repo)
    );
  };

  return (
    <div className={styles.targetsPage}>
      <div className={shared.pageHeader}>
        <h2>Targets</h2>
        <button className={shared.btnIcon} onClick={onBack} title="Close">
          <FontAwesomeIcon icon={faXmark} />
        </button>
      </div>

      <div className={styles.content}>
        {error && (
          <div className={shared.errorMessage}>{error}</div>
        )}

        {/* Current targets */}
        <section className={styles.section}>
          <h3>Registered Targets</h3>
          {targets.length === 0 && pendingTargets.length === 0 ? (
            <div className={styles.emptyState}>
              <p>No targets configured yet.</p>
              <p>Add a repository or organization below to start receiving jobs.</p>
            </div>
          ) : (
            <div className={styles.targetList}>
              {/* Pending targets (registering) */}
              {pendingTargets.map(pending => (
                <div key={pending.id} className={`${styles.targetItem} ${styles.targetItemPending}`}>
                  <div className={styles.targetInfo}>
                    <div className={styles.targetIcon}>
                      <FontAwesomeIcon icon={pending.type === 'org' ? faBuilding : faBook} />
                    </div>
                    <div className={styles.targetDetails}>
                      <div className={styles.targetName}>{pending.displayName}</div>
                      <div className={styles.targetMeta}>
                        <span>{pending.type === 'org' ? 'Organization' : 'Repository'}</span>
                        <span className={styles.targetStatus}>
                          <span className={styles.statusDot} data-status="pending" />
                          Registering...
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              {/* Registered targets */}
              {targets.map(target => {
                const status = getTargetStatus(target.id);
                const statusType = status?.error ? 'error' : status?.sessionActive ? 'active' : 'inactive';

                return (
                  <div key={target.id} className={styles.targetItem}>
                    <div className={styles.targetInfo}>
                      <div className={styles.targetIcon}>
                        <FontAwesomeIcon icon={target.type === 'org' ? faBuilding : faBook} />
                      </div>
                      <div className={styles.targetDetails}>
                        <div className={styles.targetName}>{target.displayName}</div>
                        <div className={styles.targetMeta}>
                          <span>{target.type === 'org' ? 'Organization' : 'Repository'}</span>
                          <span className={styles.targetStatus}>
                            <span className={styles.statusDot} data-status={statusType} />
                            {status?.error ? 'Error' : status?.sessionActive ? 'Connected' : 'Idle'}
                          </span>
                          {status?.jobsAssigned ? (
                            <span>{status.jobsAssigned} jobs</span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className={styles.targetActions}>
                      <button
                        className={styles.removeBtn}
                        onClick={() => handleRemoveTarget(target.id)}
                        disabled={isLoading}
                        title="Remove target"
                      >
                        <FontAwesomeIcon icon={faTrash} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Add target */}
        <section className={styles.section}>
          <h3>Add Target</h3>
          <div className={styles.addForm}>
            <div className={styles.typeSelector}>
              <button
                className={`${styles.typeBtn} ${addType === 'repo' ? styles.active : ''}`}
                onClick={() => setAddType('repo')}
              >
                <FontAwesomeIcon icon={faBook} /> Repository
              </button>
              <button
                className={`${styles.typeBtn} ${addType === 'org' ? styles.active : ''}`}
                onClick={() => setAddType('org')}
              >
                <FontAwesomeIcon icon={faBuilding} /> Organization
              </button>
            </div>

            <div className={styles.searchContainer}>
              <input
                type="text"
                className={styles.searchInput}
                placeholder={addType === 'repo' ? 'Search repositories...' : 'Search organizations...'}
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowResults(true);
                }}
                onFocus={() => setShowResults(true)}
                onBlur={() => setTimeout(() => setShowResults(false), 200)}
              />

              {showResults && searchQuery && (
                <div className={styles.searchResults}>
                  {addType === 'repo' ? (
                    filteredRepos.length > 0 ? (
                      filteredRepos.slice(0, 10).map(repo => {
                        const [owner, repoName] = repo.full_name.split('/');
                        const added = isTargetAdded('repo', owner, repoName);
                        return (
                          <div
                            key={repo.id}
                            className={styles.searchResultItem}
                            onClick={() => !added && handleAddTarget('repo', owner, repoName)}
                            style={{ opacity: added ? 0.5 : 1, cursor: added ? 'default' : 'pointer' }}
                          >
                            <FontAwesomeIcon icon={faBook} />
                            <span className={styles.searchResultName}>{repo.full_name}</span>
                            {added ? (
                              <span className={styles.searchResultType}>Added</span>
                            ) : (
                              <span className={styles.searchResultType}>
                                <FontAwesomeIcon icon={faPlus} />
                              </span>
                            )}
                          </div>
                        );
                      })
                    ) : (
                      <div className={styles.searchResultItem}>
                        <span className={styles.searchResultName}>No repositories found</span>
                      </div>
                    )
                  ) : (
                    filteredOrgs.length > 0 ? (
                      filteredOrgs.slice(0, 10).map(org => {
                        const added = isTargetAdded('org', org.login);
                        return (
                          <div
                            key={org.id}
                            className={styles.searchResultItem}
                            onClick={() => !added && handleAddTarget('org', org.login)}
                            style={{ opacity: added ? 0.5 : 1, cursor: added ? 'default' : 'pointer' }}
                          >
                            <FontAwesomeIcon icon={faBuilding} />
                            <span className={styles.searchResultName}>{org.login}</span>
                            {added ? (
                              <span className={styles.searchResultType}>Added</span>
                            ) : (
                              <span className={styles.searchResultType}>
                                <FontAwesomeIcon icon={faPlus} />
                              </span>
                            )}
                          </div>
                        );
                      })
                    ) : (
                      <div className={styles.searchResultItem}>
                        <span className={styles.searchResultName}>No organizations found</span>
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

      </div>
    </div>
  );
};

export default TargetsPage;
