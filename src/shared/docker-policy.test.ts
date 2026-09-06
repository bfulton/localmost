import { describe, it, expect } from '@jest/globals';
import { isEmptyDockerPolicy, DockerPolicy } from './docker-policy';

describe('docker policy', () => {
  it('treats an absent or all-empty docker policy as empty', () => {
    expect(isEmptyDockerPolicy(undefined)).toBe(true);
    expect(isEmptyDockerPolicy({})).toBe(true);
    const granted: DockerPolicy = { run: { images: ['postgres:16'] } };
    expect(isEmptyDockerPolicy(granted)).toBe(false);
  });
});
