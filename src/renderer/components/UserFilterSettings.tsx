import React, { useState, useEffect, useRef, useCallback } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { UserFilterMode, AllowlistUser, UserFilterConfig } from '../../shared/types';
import styles from './UserFilterSettings.module.css';
import shared from '../styles/shared.module.css';

interface UserFilterSettingsProps {
  userFilter: UserFilterConfig;
  currentUserLogin?: string;
  onFilterChange: (filter: UserFilterConfig) => void;
}

const UserFilterSettings: React.FC<UserFilterSettingsProps> = ({
  userFilter,
  currentUserLogin,
  onFilterChange,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<AllowlistUser[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced user search
  const searchUsers = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    try {
      const result = await window.localmost.github.searchUsers(query);
      if (result.success && result.users) {
        // Filter out users already in the allowlist
        const filtered = result.users.filter(
          (user: AllowlistUser) => !userFilter.allowlist.some((u) => u.login === user.login)
        );
        setSearchResults(filtered);
      }
    } catch (error) {
      console.error('User search failed:', error);
    } finally {
      setIsSearching(false);
    }
  }, [userFilter.allowlist]);

  // Handle search input change with debounce
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setSearchQuery(query);
    setShowDropdown(true);

    // Clear existing timeout
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    // Debounce search
    searchTimeoutRef.current = setTimeout(() => {
      searchUsers(query);
    }, 300);
  };

  const handleModeChange = (mode: UserFilterMode) => {
    onFilterChange({
      ...userFilter,
      mode,
    });
  };

  const handleAddUser = (user: AllowlistUser) => {
    onFilterChange({
      ...userFilter,
      allowlist: [...userFilter.allowlist, user],
    });
    setSearchQuery('');
    setSearchResults([]);
    setShowDropdown(false);
  };

  const handleRemoveUser = (login: string) => {
    onFilterChange({
      ...userFilter,
      allowlist: userFilter.allowlist.filter((u) => u.login !== login),
    });
  };

  return (
    <div className={styles.userFilterSettings}>
      <div className={shared.formGroup}>
        <label>Accept jobs from</label>
        <div className={styles.modeSelector}>
          <button
            className={userFilter.mode === 'everyone' ? styles.modeOptionActive : styles.modeOption}
            onClick={() => handleModeChange('everyone')}
          >
            Everyone
          </button>
          <button
            className={userFilter.mode === 'just-me' ? styles.modeOptionActive : styles.modeOption}
            onClick={() => handleModeChange('just-me')}
            title={currentUserLogin ? `Only jobs triggered by @${currentUserLogin}` : 'Only jobs triggered by you'}
          >
            Just me
          </button>
          <button
            className={userFilter.mode === 'allowlist' ? styles.modeOptionActive : styles.modeOption}
            onClick={() => handleModeChange('allowlist')}
          >
            Specific users
          </button>
        </div>
        <p className={shared.formHint}>
          {userFilter.mode === 'everyone' && 'Accept workflow jobs triggered by any user.'}
          {userFilter.mode === 'just-me' && (
            currentUserLogin
              ? `Only accept jobs triggered by @${currentUserLogin}. Jobs from other users will be cancelled.`
              : 'Only accept jobs you trigger. Jobs from other users will be cancelled.'
          )}
          {userFilter.mode === 'allowlist' && 'Only accept jobs triggered by users in the list below.'}
        </p>
      </div>

      {userFilter.mode === 'allowlist' && (
        <div className={styles.allowlistSection}>
          <div className={styles.searchContainer} ref={dropdownRef}>
            <input
              type="text"
              value={searchQuery}
              onChange={handleSearchChange}
              onFocus={() => setShowDropdown(true)}
              placeholder="Search GitHub users..."
              className={styles.searchInput}
            />
            {showDropdown && (searchQuery.trim() || searchResults.length > 0) && (
              <div className={styles.searchDropdown}>
                {isSearching ? (
                  <div className={styles.searchLoading}>
                    <div className={shared.spinner} />
                    <span>Searching...</span>
                  </div>
                ) : searchResults.length > 0 ? (
                  searchResults.map((user) => (
                    <button
                      key={user.login}
                      className={styles.searchResultItem}
                      onClick={() => handleAddUser(user)}
                    >
                      <img
                        src={user.avatar_url}
                        alt={user.login}
                        className={styles.userAvatar}
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                      <div className={styles.userInfo}>
                        <span className={styles.userName}>{user.name || user.login}</span>
                        <span className={styles.userLogin}>@{user.login}</span>
                      </div>
                    </button>
                  ))
                ) : searchQuery.trim() ? (
                  <div className={styles.noResults}>No users found</div>
                ) : null}
              </div>
            )}
          </div>

          {userFilter.allowlist.length > 0 && (
            <div className={styles.allowlist}>
              {userFilter.allowlist.map((user) => (
                <div key={user.login} className={styles.allowlistItem}>
                  <img
                    src={user.avatar_url}
                    alt={user.login}
                    className={styles.userAvatar}
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  <div className={styles.userInfo}>
                    <span className={styles.userName}>{user.name || user.login}</span>
                    <span className={styles.userLogin}>@{user.login}</span>
                  </div>
                  <button
                    className={styles.removeButton}
                    onClick={() => handleRemoveUser(user.login)}
                    title="Remove user"
                  >
                    <FontAwesomeIcon icon={faXmark} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {userFilter.allowlist.length === 0 && (
            <p className={styles.emptyMessage}>
              No users added yet. Search for GitHub users to add them to the allowlist.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default UserFilterSettings;
