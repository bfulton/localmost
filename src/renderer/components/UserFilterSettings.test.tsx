import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import UserFilterSettings from './UserFilterSettings';
import { mockLocalmost } from '../../../test/setup-renderer';
import { UserFilterConfig } from '../../shared/types';

describe('UserFilterSettings', () => {
  const defaultFilter: UserFilterConfig = { scope: 'everyone', allowedUsers: 'just-me', allowlist: [] };
  const mockOnFilterChange = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockLocalmost.github.searchUsers.mockResolvedValue({ success: true, users: [] });
  });

  describe('Scope Selection', () => {
    it('should render with everyone scope selected by default', () => {
      render(
        <UserFilterSettings
          userFilter={defaultFilter}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      // Verify all scope buttons are rendered
      expect(screen.getByRole('button', { name: 'Everyone' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Trigger author' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'All contributors' })).toBeInTheDocument();
      // Verify hint text for everyone scope
      expect(screen.getByText(/Accept workflow jobs triggered by any user/)).toBeInTheDocument();
    });

    it('should switch to trigger scope when clicked', async () => {
      render(
        <UserFilterSettings
          userFilter={defaultFilter}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Trigger author' }));
      });

      expect(mockOnFilterChange).toHaveBeenCalledWith({
        scope: 'trigger',
        allowedUsers: 'just-me',
        allowlist: [],
      });
    });

    it('should switch to contributors scope when clicked', async () => {
      render(
        <UserFilterSettings
          userFilter={defaultFilter}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'All contributors' }));
      });

      expect(mockOnFilterChange).toHaveBeenCalledWith({
        scope: 'contributors',
        allowedUsers: 'just-me',
        allowlist: [],
      });
    });

    it('should show correct hint for each scope', () => {
      const { rerender } = render(
        <UserFilterSettings
          userFilter={{ scope: 'everyone', allowedUsers: 'just-me', allowlist: [] }}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      expect(screen.getByText(/Accept workflow jobs triggered by any user/)).toBeInTheDocument();

      rerender(
        <UserFilterSettings
          userFilter={{ scope: 'trigger', allowedUsers: 'just-me', allowlist: [] }}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      expect(screen.getByText(/Check who triggered the workflow/)).toBeInTheDocument();

      rerender(
        <UserFilterSettings
          userFilter={{ scope: 'contributors', allowedUsers: 'just-me', allowlist: [] }}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      expect(screen.getByText(/Check all contributors to the repository/)).toBeInTheDocument();
    });
  });

  describe('AllowedUsers Selection', () => {
    it('should show allowedUsers selector when scope is trigger', () => {
      render(
        <UserFilterSettings
          userFilter={{ scope: 'trigger', allowedUsers: 'just-me', allowlist: [] }}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      expect(screen.getByRole('button', { name: 'Just me' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Allowlist' })).toBeInTheDocument();
    });

    it('should not show allowedUsers selector when scope is everyone', () => {
      render(
        <UserFilterSettings
          userFilter={{ scope: 'everyone', allowedUsers: 'just-me', allowlist: [] }}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      // Only the scope buttons should be visible, not the allowedUsers buttons
      expect(screen.queryAllByRole('button', { name: 'Just me' })).toHaveLength(0);
    });

    it('should switch to allowlist when clicked', async () => {
      render(
        <UserFilterSettings
          userFilter={{ scope: 'trigger', allowedUsers: 'just-me', allowlist: [] }}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Allowlist' }));
      });

      expect(mockOnFilterChange).toHaveBeenCalledWith({
        scope: 'trigger',
        allowedUsers: 'allowlist',
        allowlist: [],
      });
    });
  });

  describe('Allowlist Mode', () => {
    const allowlistFilter: UserFilterConfig = { scope: 'trigger', allowedUsers: 'allowlist', allowlist: [] };

    it('should show search input when allowedUsers is allowlist and scope is not everyone', () => {
      render(
        <UserFilterSettings
          userFilter={allowlistFilter}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      expect(screen.getByPlaceholderText('Search GitHub users...')).toBeInTheDocument();
    });

    it('should not show search input in everyone scope', () => {
      render(
        <UserFilterSettings
          userFilter={{ scope: 'everyone', allowedUsers: 'just-me', allowlist: [] }}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      expect(screen.queryByPlaceholderText('Search GitHub users...')).not.toBeInTheDocument();
    });

    it('should search users when typing in search input', async () => {
      jest.useFakeTimers();

      mockLocalmost.github.searchUsers.mockResolvedValue({
        success: true,
        users: [
          { login: 'user1', avatar_url: 'https://example.com/avatar1.png', name: 'User One' },
          { login: 'user2', avatar_url: 'https://example.com/avatar2.png', name: null },
        ],
      });

      render(
        <UserFilterSettings
          userFilter={allowlistFilter}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      const searchInput = screen.getByPlaceholderText('Search GitHub users...');

      await act(async () => {
        fireEvent.focus(searchInput);
        fireEvent.change(searchInput, { target: { value: 'user' } });
      });

      // Advance timers for debounce (1 second)
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });

      expect(mockLocalmost.github.searchUsers).toHaveBeenCalledWith('user');

      jest.useRealTimers();
    });

    it('should display search results', async () => {
      jest.useFakeTimers();

      mockLocalmost.github.searchUsers.mockResolvedValue({
        success: true,
        users: [
          { login: 'user1', avatar_url: 'https://example.com/avatar1.png', name: 'User One' },
        ],
      });

      render(
        <UserFilterSettings
          userFilter={allowlistFilter}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      const searchInput = screen.getByPlaceholderText('Search GitHub users...');

      await act(async () => {
        fireEvent.focus(searchInput);
        fireEvent.change(searchInput, { target: { value: 'user' } });
      });

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });

      await waitFor(() => {
        expect(screen.getByText('User One')).toBeInTheDocument();
        expect(screen.getByText('@user1')).toBeInTheDocument();
      });

      jest.useRealTimers();
    });

    it('should add user to allowlist when clicked', async () => {
      jest.useFakeTimers();

      mockLocalmost.github.searchUsers.mockResolvedValue({
        success: true,
        users: [
          { login: 'newuser', avatar_url: 'https://example.com/avatar.png', name: 'New User' },
        ],
      });

      render(
        <UserFilterSettings
          userFilter={allowlistFilter}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      const searchInput = screen.getByPlaceholderText('Search GitHub users...');

      await act(async () => {
        fireEvent.focus(searchInput);
        fireEvent.change(searchInput, { target: { value: 'newuser' } });
      });

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });

      await waitFor(() => {
        expect(screen.getByText('New User')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('New User'));
      });

      expect(mockOnFilterChange).toHaveBeenCalledWith({
        scope: 'trigger',
        allowedUsers: 'allowlist',
        allowlist: [{ login: 'newuser', avatar_url: 'https://example.com/avatar.png', name: 'New User' }],
      });

      jest.useRealTimers();
    });

    it('should display existing allowlist users', () => {
      const filterWithUsers: UserFilterConfig = {
        scope: 'trigger',
        allowedUsers: 'allowlist',
        allowlist: [
          { login: 'existinguser', avatar_url: '', name: 'Existing User' },
        ],
      };

      render(
        <UserFilterSettings
          userFilter={filterWithUsers}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      expect(screen.getByText('Existing User')).toBeInTheDocument();
      expect(screen.getByText('@existinguser')).toBeInTheDocument();
    });

    it('should remove user from allowlist when remove button clicked', async () => {
      const filterWithUsers: UserFilterConfig = {
        scope: 'trigger',
        allowedUsers: 'allowlist',
        allowlist: [
          { login: 'usertoremove', avatar_url: '', name: 'User To Remove' },
        ],
      };

      render(
        <UserFilterSettings
          userFilter={filterWithUsers}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      const removeButton = screen.getByRole('button', { name: 'Remove user' });

      await act(async () => {
        fireEvent.click(removeButton);
      });

      expect(mockOnFilterChange).toHaveBeenCalledWith({
        scope: 'trigger',
        allowedUsers: 'allowlist',
        allowlist: [],
      });
    });

    it('should show empty message when allowlist is empty', () => {
      render(
        <UserFilterSettings
          userFilter={allowlistFilter}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      expect(screen.getByText(/No users added yet/)).toBeInTheDocument();
    });

    it('should filter out users already in allowlist from search results', async () => {
      jest.useFakeTimers();

      const filterWithUsers: UserFilterConfig = {
        scope: 'trigger',
        allowedUsers: 'allowlist',
        allowlist: [
          { login: 'existinguser', avatar_url: '', name: 'Existing User' },
        ],
      };

      mockLocalmost.github.searchUsers.mockResolvedValue({
        success: true,
        users: [
          { login: 'existinguser', avatar_url: '', name: 'Existing User' },
          { login: 'newuser', avatar_url: '', name: 'New User' },
        ],
      });

      render(
        <UserFilterSettings
          userFilter={filterWithUsers}
          currentUserLogin="testuser"
          onFilterChange={mockOnFilterChange}
        />
      );

      const searchInput = screen.getByPlaceholderText('Search GitHub users...');

      await act(async () => {
        fireEvent.focus(searchInput);
        fireEvent.change(searchInput, { target: { value: 'user' } });
      });

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });

      // Should only show newuser in search results, not existinguser
      await waitFor(() => {
        expect(screen.getByText('New User')).toBeInTheDocument();
      });

      // There should be only one "New User" text (in search results)
      // and one "Existing User" text (in the allowlist)
      const newUserElements = screen.getAllByText('New User');
      expect(newUserElements).toHaveLength(1);

      jest.useRealTimers();
    });
  });
});
