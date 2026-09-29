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

  it('grants loopback, which its test suites need to reach the servers they start', () => {
    // The suites bind ephemeral 127.0.0.1 ports, so no fixed list would do.
    expect(result.config?.shared?.network?.loopback).toBe(true);
  });
});
