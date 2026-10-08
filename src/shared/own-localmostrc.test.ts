import { describe, it, expect } from '@jest/globals';
import * as path from 'path';
import { parseLocalmostrc } from './localmostrc';

/**
 * This repository's own .localmostrc, which its CI jobs run under when they
 * run on localmost. A mistake here fails every job, not a test.
 */
describe("this repository's .localmostrc", () => {
  const result = parseLocalmostrc(path.join(__dirname, '..', '..', '.localmostrc'));

  it('is valid', () => {
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('parses without a warning: nothing in it is ignored', () => {
    // Its suites bind ephemeral 127.0.0.1 ports, which the job's macOS VM
    // has of its own: the network.loopback it once declared is ignored now.
    expect(result.warnings).toEqual([]);
  });
});
