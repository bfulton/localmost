import { describe, it, expect } from '@jest/globals';
import { parseRepository } from './user-filter';

describe('parseRepository', () => {
  it('reads owner/repo as a job reports its repository', () => {
    expect(parseRepository('o/my.repo')).toEqual({ owner: 'o', repo: 'my.repo' });
  });

  it('reads a repository URL with the whole repo name, dots and all', () => {
    // The URL form used to stop the name at its first dot, so a job from
    // o/my.repo had its policy looked up, and its run cancelled, in o/my.
    for (const repository of [
      'https://github.com/o/my.repo',
      'https://github.com/o/my.repo.git',
      'https://github.com/o/my.repo/',
    ]) {
      expect({ repository, parsed: parseRepository(repository) }).toEqual({
        repository,
        parsed: { owner: 'o', repo: 'my.repo' },
      });
    }
  });

  it('names no repository for a URL that only mentions github.com, or is on another host', () => {
    for (const repository of [
      'https://evil.example/github.com/o/r',
      'https://github.com.evil.example/o/r',
      'x github.com/o/r',
    ]) {
      expect({ repository, parsed: parseRepository(repository) }).toEqual({ repository, parsed: null });
    }
  });
});
