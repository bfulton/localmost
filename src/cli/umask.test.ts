/**
 * The CLI's file mode mask.
 *
 * The CLI writes approved policies, workspace copies and the action cache,
 * and a shell's usual umask (022) would leave them readable by every account
 * on the machine. It loads here the way it does from the shell - the entry
 * module runs main() on import - with the app treated as unreachable, so
 * main() waits on a socket probe that never answers and does nothing else.
 */

import { jest, describe, it, expect, afterEach } from '@jest/globals';

jest.mock('./app-running', () => ({ isSocketLive: () => new Promise(() => {}) }));

describe('the CLI entry point', () => {
  const originalArgv = process.argv;
  const originalMask = process.umask();

  afterEach(() => {
    process.argv = originalArgv;
    process.umask(originalMask);
  });

  it('makes everything it writes private to the user, whatever umask the shell had', () => {
    process.umask(0o022);
    process.argv = ['node', 'localmost', 'status'];

    jest.isolateModules(() => {
      require('./index');
    });

    expect(process.umask()).toBe(0o077);
  });
});
