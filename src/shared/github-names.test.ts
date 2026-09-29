import { describe, it, expect } from '@jest/globals';
import { isGitHubOwnerName, isGitHubRepoName, isGitHubLogin, parseGitHubRepoUrl } from './github-names';

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

describe('isGitHubLogin', () => {
  it('accepts any login GitHub has issued, including legacy ones a new account could not take', () => {
    for (const name of ['octocat', 'old-name-', '-lead', 'a--b', 'octocat_acme']) {
      expect({ name, ok: isGitHubLogin(name) }).toEqual({ name, ok: true });
    }
  });

  it('refuses anything that could carry a path, a query or a dot segment', () => {
    for (const name of ['', '.', '..', '../x', 'a/b', 'a?b', 'a#b', 'a%2Fb', 'a.b', 'a b', 42, null]) {
      expect({ name, ok: isGitHubLogin(name) }).toEqual({ name, ok: false });
    }
  });
});

describe('parseGitHubRepoUrl', () => {
  it('reads the owner and repo of a repository page on github.com', () => {
    expect(parseGitHubRepoUrl('https://github.com/bfulton/my.repo')).toEqual({ owner: 'bfulton', repo: 'my.repo' });
  });

  it('refuses any other URL, and names GitHub would not issue', () => {
    for (const url of [
      'https://github.com/../x',
      'https://github.com/o/..',
      'https://github.com/o/r/../../x',
      'https://github.com/o/r?x',
      'https://evil.example/github.com/o/r',
      'http://github.com/o/r',
      'https://github.com/o',
      '',
      7,
    ]) {
      expect({ url, parsed: parseGitHubRepoUrl(url) }).toEqual({ url, parsed: null });
    }
  });
});
