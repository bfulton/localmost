/**
 * Tests for Workspace Snapshot and Management
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  getWorkspacesDir,
  createWorkspace,
  listWorkspaces,
  removeWorkspace,
  cleanupWorkspaces,
  getWorkspacesTotalSize,
  getGitInfo,
  isGitRepo,
  getRepositoryFromDir,
} from './workspace';

// Mock fs
jest.mock('fs');
// Mock child_process
jest.mock('child_process');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe('Workspace Management', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // getWorkspacesDir
  // ===========================================================================

  describe('getWorkspacesDir', () => {
    it('should return workspaces directory under app data', () => {
      const result = getWorkspacesDir();

      expect(result).toContain('workspaces');
      expect(result).toContain('.localmost');
    });
  });

  // ===========================================================================
  // listWorkspaces
  // ===========================================================================

  describe('listWorkspaces', () => {
    it('should return empty array when directory does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = listWorkspaces();

      expect(result).toEqual([]);
    });

    it('should list workspaces with metadata', () => {
      mockFs.existsSync.mockImplementation((p) => {
        const pathStr = String(p);
        return pathStr.includes('workspaces') || pathStr.includes('.localmost-workspace.json');
      });
      (mockFs.readdirSync as jest.Mock).mockReturnValue([
        { name: 'ws-abc123', isDirectory: () => true },
        { name: 'ws-def456', isDirectory: () => true },
        { name: 'other-file', isDirectory: () => false },
      ]);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          id: 'ws-abc123',
          path: '/path/to/ws-abc123',
          sourceDir: '/repo',
          createdAt: '2024-01-01T00:00:00.000Z',
        })
      );

      const result = listWorkspaces();

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].id).toContain('ws-');
    });

    it('should skip non-workspace directories', () => {
      mockFs.existsSync.mockReturnValue(true);
      (mockFs.readdirSync as jest.Mock).mockReturnValue([
        { name: 'regular-dir', isDirectory: () => true },
        { name: 'file.txt', isDirectory: () => false },
      ]);

      const result = listWorkspaces();

      expect(result).toEqual([]);
    });

    it('should handle invalid metadata gracefully', () => {
      mockFs.existsSync.mockReturnValue(true);
      (mockFs.readdirSync as jest.Mock).mockReturnValue([
        { name: 'ws-abc123', isDirectory: () => true },
      ]);
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('Invalid JSON');
      });
      mockFs.statSync.mockReturnValue({
        birthtime: new Date('2024-01-01'),
      } as fs.Stats);

      const result = listWorkspaces();

      expect(result.length).toBe(1);
      expect(result[0].id).toBe('ws-abc123');
    });
  });

  // ===========================================================================
  // removeWorkspace
  // ===========================================================================

  describe('removeWorkspace', () => {
    it('should return false if workspace does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = removeWorkspace('ws-nonexistent');

      expect(result).toBe(false);
    });

    it('should remove workspace directory', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.rmSync.mockImplementation(() => {});

      const result = removeWorkspace('ws-test123');

      expect(result).toBe(true);
      expect(mockFs.rmSync).toHaveBeenCalledWith(
        expect.stringContaining('ws-test123'),
        { recursive: true, force: true }
      );
    });
  });

  // ===========================================================================
  // cleanupWorkspaces
  // ===========================================================================

  describe('cleanupWorkspaces', () => {
    it('should remove old workspaces', () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours ago
      const newDate = new Date();

      mockFs.existsSync.mockReturnValue(true);
      (mockFs.readdirSync as jest.Mock).mockReturnValue([
        { name: 'ws-old', isDirectory: () => true },
        { name: 'ws-new', isDirectory: () => true },
      ]);
      mockFs.readFileSync.mockImplementation((p) => {
        const pathStr = String(p);
        if (pathStr.includes('ws-old')) {
          return JSON.stringify({
            id: 'ws-old',
            path: '/path/ws-old',
            sourceDir: '/repo',
            createdAt: oldDate.toISOString(),
          });
        }
        return JSON.stringify({
          id: 'ws-new',
          path: '/path/ws-new',
          sourceDir: '/repo',
          createdAt: newDate.toISOString(),
        });
      });
      mockFs.rmSync.mockImplementation(() => {});

      const result = cleanupWorkspaces({ maxAgeHours: 24 });

      expect(result.removed).toBe(1);
      expect(result.kept).toBe(1);
    });

    it('should remove workspaces exceeding max count', () => {
      const now = Date.now();
      mockFs.existsSync.mockReturnValue(true);
      (mockFs.readdirSync as jest.Mock).mockReturnValue(
        Array.from({ length: 15 }, (_, i) => ({
          name: `ws-${i}`,
          isDirectory: () => true,
        }))
      );
      mockFs.readFileSync.mockImplementation((p) => {
        const pathStr = String(p);
        const match = pathStr.match(/ws-(\d+)/);
        const idx = match ? parseInt(match[1]) : 0;
        return JSON.stringify({
          id: `ws-${idx}`,
          path: `/path/ws-${idx}`,
          sourceDir: '/repo',
          createdAt: new Date(now - idx * 1000).toISOString(),
        });
      });
      mockFs.rmSync.mockImplementation(() => {});

      const result = cleanupWorkspaces({ maxCount: 10, maxAgeHours: 9999 });

      expect(result.removed).toBe(5);
      expect(result.kept).toBe(10);
    });
  });

  // ===========================================================================
  // getWorkspacesTotalSize
  // ===========================================================================

  describe('getWorkspacesTotalSize', () => {
    it('should return 0 if directory does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = getWorkspacesTotalSize();

      expect(result).toBe(0);
    });

    it('should calculate total size of files', () => {
      mockFs.existsSync.mockReturnValue(true);
      (mockFs.readdirSync as jest.Mock).mockImplementation((p: string) => {
        const pathStr = String(p);
        if (pathStr.includes('workspaces') && !pathStr.includes('ws-')) {
          return [
            { name: 'ws-1', isDirectory: () => true },
          ];
        }
        if (pathStr.includes('ws-1')) {
          return [
            { name: 'file1.txt', isDirectory: () => false },
            { name: 'file2.txt', isDirectory: () => false },
          ];
        }
        return [];
      });
      mockFs.statSync.mockReturnValue({
        size: 1000,
      } as fs.Stats);

      const result = getWorkspacesTotalSize();

      expect(result).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Git Integration
  // ===========================================================================

  describe('isGitRepo', () => {
    it('should return true if .git directory exists', () => {
      mockFs.existsSync.mockReturnValue(true);

      const result = isGitRepo('/repo');

      expect(result).toBe(true);
      expect(mockFs.existsSync).toHaveBeenCalledWith('/repo/.git');
    });

    it('should return false if .git directory does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = isGitRepo('/not-a-repo');

      expect(result).toBe(false);
    });
  });

  describe('getGitInfo', () => {
    it('should return git info for a repository', () => {
      mockExecSync.mockImplementation((cmd) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('rev-parse HEAD') && !cmdStr.includes('symbolic-ref')) {
          return 'abc123def456';
        }
        if (cmdStr.includes('symbolic-ref HEAD')) {
          return 'refs/heads/main';
        }
        if (cmdStr.includes('status --porcelain')) {
          return '';
        }
        return '';
      });

      const result = getGitInfo('/repo');

      expect(result).not.toBeNull();
      expect(result?.sha).toBe('abc123def456');
      expect(result?.branch).toBe('main');
      expect(result?.dirty).toBe(false);
    });

    it('should detect dirty working tree', () => {
      mockExecSync.mockImplementation((cmd) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('rev-parse HEAD') && !cmdStr.includes('symbolic-ref')) {
          return 'abc123';
        }
        if (cmdStr.includes('symbolic-ref HEAD')) {
          return 'refs/heads/main';
        }
        if (cmdStr.includes('status --porcelain')) {
          return 'M  file.txt\n';
        }
        return '';
      });

      const result = getGitInfo('/repo');

      expect(result?.dirty).toBe(true);
    });

    it('should return null if not a git repo', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not a git repository');
      });

      const result = getGitInfo('/not-a-repo');

      expect(result).toBeNull();
    });
  });

  describe('getRepositoryFromDir', () => {
    it('should parse SSH remote URL', () => {
      mockExecSync.mockReturnValue('git@github.com:owner/repo.git\n');

      const result = getRepositoryFromDir('/repo');

      expect(result).toBe('owner/repo');
    });

    it('should parse HTTPS remote URL', () => {
      mockExecSync.mockReturnValue('https://github.com/owner/repo.git\n');

      const result = getRepositoryFromDir('/repo');

      expect(result).toBe('owner/repo');
    });

    it('should handle URL without .git suffix', () => {
      mockExecSync.mockReturnValue('https://github.com/owner/repo\n');

      const result = getRepositoryFromDir('/repo');

      expect(result).toBe('owner/repo');
    });

    it('should return null for non-GitHub remotes', () => {
      mockExecSync.mockReturnValue('https://gitlab.com/owner/repo.git\n');

      const result = getRepositoryFromDir('/repo');

      expect(result).toBeNull();
    });

    it('should return null if no remote', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('No remote');
      });

      const result = getRepositoryFromDir('/repo');

      expect(result).toBeNull();
    });
  });
});
