import { describe, it, expect } from '@jest/globals';
import { isGitHubOwnerName, isGitHubRepoName } from './github-names';

describe('isGitHubOwnerName', () => {
  it('accepts the logins GitHub issues', () => {
    for (const name of ['bfulton', 'a', 'Octo-Cat', 'org2', 'octocat_acme', '0x0']) {
      expect({ name, ok: isGitHubOwnerName(name) }).toEqual({ name, ok: true });
    }
  });

  it('refuses anything that could carry a path, a query or a dot segment', () => {
    for (const name of ['', '.', '..', '../x', 'a/b', 'a?b', 'a#b', 'a%2Fb', '-a', 'a-', ' a', 'a b', 'a.b', 'é', 42, null]) {
      expect({ name, ok: isGitHubOwnerName(name) }).toEqual({ name, ok: false });
    }
  });
});

describe('isGitHubRepoName', () => {
  it('accepts the names GitHub allows, dots included', () => {
    for (const name of ['supdb', 'my.repo', '.github', '_x', 'a-b_c.d']) {
      expect({ name, ok: isGitHubRepoName(name) }).toEqual({ name, ok: true });
    }
  });

  it('refuses dot segments and anything that could carry a path or query', () => {
    for (const name of ['', '.', '..', '../x', 'a/b', 'a?b', 'a#b', 'a%2Fb', 'a b', undefined]) {
      expect({ name, ok: isGitHubRepoName(name) }).toEqual({ name, ok: false });
    }
  });
});
