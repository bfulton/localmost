import React, { useState, useEffect, useRef, useCallback } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { FilterScope, AllowedUsers, AllowlistUser, UserFilterConfig } from '../../shared/types';
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
  const currentSearchRef = useRef<string>(''); // Track current search to prevent stale results

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

    // Track this search so we can ignore stale results
    currentSearchRef.current = query;
    setIsSearching(true);

    try {
      const result = await window.localmost.github.searchUsers(query);

      // Only update results if this is still the current search
      if (currentSearchRef.current !== query) {
        return; // Stale result, ignore
      }

      if (result.success && result.users) {
        // Filter out users already in the allowlist and limit to 10 results
        const filtered = result.users
          .filter((user: AllowlistUser) => !userFilter.allowlist.some((u) => u.login === user.login))
          .slice(0, 10);
        setSearchResults(filtered);
      }
    } catch (error) {
      console.error('User search failed:', error);
    } finally {
      // Only clear loading if this is still the current search
      if (currentSearchRef.current === query) {
        setIsSearching(false);
      }
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

    // Clear results immediately when query changes to avoid showing stale results
    if (!query.trim()) {
      setSearchResults([]);
      currentSearchRef.current = '';
      return;
    }

    // Debounce search - wait 1 second for user to pause typing
    searchTimeoutRef.current = setTimeout(() => {
      searchUsers(query);
    }, 1000);
  };

  const handleScopeChange = (scope: FilterScope) => {
    onFilterChange({
      ...userFilter,
      scope,
    });
  };

  const handleAllowedUsersChange = (allowedUsers: AllowedUsers) => {
    onFilterChange({
      ...userFilter,
      allowedUsers,
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

  // Get hint text for scope
  const getScopeHint = () => {
    switch (userFilter.scope) {
      case 'everyone':
        return 'Accept workflow jobs triggered by any user.';
      case 'trigger':
        return 'Check who triggered the workflow and filter based on that user.';
      case 'contributors':
        return 'Check all contributors to the repository and ensure all are trusted.';
      default:
        return '';
    }
  };

  // Get hint text for allowedUsers
  const getAllowedUsersHint = () => {
    if (userFilter.allowedUsers === 'just-me') {
      return currentUserLogin
        ? `Only @${currentUserLogin}. Jobs involving other users will be cancelled.`
        : 'Only you. Jobs involving other users will be cancelled.';
    }
    return 'Only users in the list below. Jobs involving other users will be cancelled.';
  };

  return (
    <div className={styles.userFilterSettings}>
      {/* Scope selector: What to check */}
      <div className={shared.formGroup}>
        <label>Filter scope</label>
        <div className={styles.modeSelector}>
          <button
            className={userFilter.scope === 'everyone' ? styles.modeOptionActive : styles.modeOption}
            onClick={() => handleScopeChange('everyone')}
          >
            Everyone
          </button>
          <button
            className={userFilter.scope === 'trigger' ? styles.modeOptionActive : styles.modeOption}
            onClick={() => handleScopeChange('trigger')}
          >
            Trigger author
          </button>
          <button
            className={userFilter.scope === 'contributors' ? styles.modeOptionActive : styles.modeOption}
            onClick={() => handleScopeChange('contributors')}
          >
            All contributors
          </button>
        </div>
        <p className={shared.formHint}>{getScopeHint()}</p>
      </div>

      {/* AllowedUsers selector: Who is allowed (shown when scope is not 'everyone') */}
      {userFilter.scope !== 'everyone' && (
        <div className={shared.formGroup}>
          <label>Who is allowed</label>
          <div className={styles.modeSelector}>
            <button
              className={userFilter.allowedUsers === 'just-me' ? styles.modeOptionActive : styles.modeOption}
              onClick={() => handleAllowedUsersChange('just-me')}
              title={currentUserLogin ? `Only @${currentUserLogin}` : 'Only you'}
            >
              Just me
            </button>
            <button
              className={userFilter.allowedUsers === 'allowlist' ? styles.modeOptionActive : styles.modeOption}
              onClick={() => handleAllowedUsersChange('allowlist')}
            >
              Allowlist
            </button>
          </div>
          <p className={shared.formHint}>{getAllowedUsersHint()}</p>
        </div>
      )}

      {/* Allowlist user search and list (shown when allowedUsers is 'allowlist' and scope is not 'everyone') */}
      {userFilter.scope !== 'everyone' && userFilter.allowedUsers === 'allowlist' && (
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
