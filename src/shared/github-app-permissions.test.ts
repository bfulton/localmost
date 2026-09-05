import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { GITHUB_APP_PERMISSIONS, GitHubAppPermission } from './github-app-permissions';

/**
 * The App's permissions are configured on github.com, and three documents
 * restate them: the description text we paste into the App settings, the
 * README table, and the SECURITY.md list. Nothing else keeps those in step,
 * so this checks all three against one declared list - in both directions,
 * to catch a permission added to a doc but not declared here.
 */

const repoRoot = path.join(__dirname, '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(repoRoot, file), 'utf-8');

/** How each doc spells a level. */
const readmeLevel = (p: GitHubAppPermission) => (p.level === 'read-write' ? 'Read & Write' : 'Read');
const describedLevel = (p: GitHubAppPermission) =>
  p.level === 'read-write' ? 'Read and write' : 'Read';

/** Sorted "name (scope): level" lines, so mismatches diff readably. */
const declared = (): string[] =>
  GITHUB_APP_PERMISSIONS.map(p => `${p.name} (${p.scope}): ${readmeLevel(p)}`).sort();

describe('GitHub App permissions', () => {
  it('declares each permission once per scope', () => {
    const keys = GITHUB_APP_PERMISSIONS.map(p => `${p.name}/${p.scope}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe('README table', () => {
    /** Rows of the Required Permissions table: | **Name** (org) | Level | ... */
    const rows = (): string[] => {
      const body = read('README.md').split('### Required Permissions')[1].split('\n###')[0];
      return body
        .split('\n')
        .map(line => line.match(/^\|\s*\*\*(.+?)\*\*(\s*\(org\))?\s*\|\s*([^|]+?)\s*\|/))
        .filter((m): m is RegExpMatchArray => Boolean(m))
        .map(m => `${m[1]} (${m[2] ? 'org' : 'repo'}): ${m[3]}`)
        .sort();
    };

    it('lists exactly the declared permissions, at the declared levels', () => {
      expect(rows()).toEqual(declared());
    });
  });

  describe('SECURITY.md list', () => {
    /** Bullets of the Required Permissions list: - `Name: Level` (org-level) */
    const bullets = (): string[] => {
      const body = read('SECURITY.md').split('- **Required Permissions**:')[1].split('\n##')[0];
      return body
        .split('\n')
        .map(line => line.match(/^\s+-\s*`([^`:]+):\s*([^`]+)`(\s*\(org-level\))?/))
        .filter((m): m is RegExpMatchArray => Boolean(m))
        .map(m => `${m[1]} (${m[3] ? 'org' : 'repo'}): ${m[2]}`)
        .sort();
    };

    it('lists exactly the declared permissions, at the declared levels', () => {
      expect(bullets()).toEqual(declared());
    });
  });

  describe('App description text', () => {
    const doc = (): string => read('docs/github-app-description.md');

    /** Bullets under one heading: - Read and write access to thing (why) */
    const bullets = (heading: string): string[] => {
      const body = doc().split(`${heading} Permissions`)[1].split('\n\n')[0];
      return body
        .split('\n')
        .map(line => line.match(/^-\s*(Read and write|Read) access to ([^(]+?)\s*\(/))
        .filter((m): m is RegExpMatchArray => Boolean(m))
        .map(m => `${m[2]}: ${m[1]}`)
        .sort();
    };

    const declaredFor = (scope: 'repo' | 'org'): string[] =>
      GITHUB_APP_PERMISSIONS.filter(p => p.scope === scope)
        .map(p => `${p.describedAs}: ${describedLevel(p)}`)
        .sort();

    it('lists exactly the declared repo permissions', () => {
      expect(bullets('Repo')).toEqual(declaredFor('repo'));
    });

    it('lists exactly the declared org permissions', () => {
      expect(bullets('Org')).toEqual(declaredFor('org'));
    });
  });
});
