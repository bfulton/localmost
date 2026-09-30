import { describe, it, expect } from '@jest/globals';
import {
  isGitHubOwnerName,
  isGitHubRepoName,
  isGitHubLogin,
  parseGitHubRepoUrl,
  parseSavedGitHubRepoUrl,
} from './github-names';

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

  it('refuses a name ending in .git, which GitHub strips from any name it is given', () => {
    // So a ".git" at the end of a URL is always the clone suffix, never part
    // of the name, and a parser can drop it without losing a repository.
    for (const name of ['r.git', 'my.repo.git', '.git']) {
      expect({ name, ok: isGitHubRepoName(name) }).toEqual({ name, ok: false });
    }
    expect(isGitHubRepoName('r.github')).toBe(true);
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
    expect(parseGitHubRepoUrl('https://github.com/o/.github')).toEqual({ owner: 'o', repo: '.github' });
  });

  it('takes off the clone suffix and a trailing slash, as a pasted link has them', () => {
    for (const url of [
      'https://github.com/o/my.repo.git',
      'https://github.com/o/my.repo/',
      'https://github.com/o/my.repo.git/',
    ]) {
      expect({ url, parsed: parseGitHubRepoUrl(url) }).toEqual({ url, parsed: { owner: 'o', repo: 'my.repo' } });
    }
  });

  it('refuses any other URL, and names GitHub would not issue', () => {
    for (const url of [
      'https://github.com/../x',
      'https://github.com/o/..',
      'https://github.com/o/r/../../x',
      'https://github.com/o/r?x',
      'https://github.com/o/r#x',
      'https://github.com/o/r/tree/main',
      'https://github.com/o/r//',
      'https://github.com/o/.git',
      'https://github.com/o/r.git.git',
      'https://evil.example/github.com/o/r',
      'https://github.com.evil.example/o/r',
      'https://evil.example/?u=https://github.com/o/r',
      'https://user@github.com/o/r',
      ' https://github.com/o/r',
      'https://github.com/o/r\n',
      'http://github.com/o/r',
      // Remotes a checkout has, which no caller of this is ever handed.
      'git@github.com:o/r.git',
      'ssh://git@github.com/o/r.git',
      'o/r',
      'https://github.com/o',
      '',
      7,
    ]) {
      expect({ url, parsed: parseGitHubRepoUrl(url) }).toEqual({ url, parsed: null });
    }
  });
});

describe('parseSavedGitHubRepoUrl', () => {
  it('reads a saved URL whose owner is a login only older accounts can have', () => {
    // GitHub once issued logins with a trailing or doubled hyphen, and the
    // setup wizard saved such an owner's html_url as it was. A runner saved
    // before targets re-registers from that URL, so refusing the owner would
    // leave it registered nowhere.
    for (const owner of ['old-name-', 'a--b', '-lead']) {
      const url = `https://github.com/${owner}/my.repo`;
      expect({ url, parsed: parseSavedGitHubRepoUrl(url) }).toEqual({ url, parsed: { owner, repo: 'my.repo' } });
    }
    expect(parseGitHubRepoUrl('https://github.com/old-name-/r')).toBeNull();
  });

  it('otherwise reads exactly what parseGitHubRepoUrl reads', () => {
    expect(parseSavedGitHubRepoUrl('https://github.com/o/my.repo.git/')).toEqual({ owner: 'o', repo: 'my.repo' });
    for (const url of [
      'https://github.com/../x',
      'https://github.com/./r',
      'https://github.com/o.x/r',
      'https://github.com/o%2Fx/r',
      'https://github.com/o/r?x',
      'https://github.com/o/r.git.git',
      'https://evil.example/github.com/o/r',
      'https://github.com.evil.example/o/r',
      'git@github.com:o/r.git',
    ]) {
      expect({ url, parsed: parseSavedGitHubRepoUrl(url) }).toEqual({ url, parsed: null });
    }
  });
});
