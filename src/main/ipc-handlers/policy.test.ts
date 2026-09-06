import { describe, it, expect } from '@jest/globals';

jest.mock('electron', () => ({ ipcMain: { handle: jest.fn() } }));
jest.mock('../policy-cache', () => ({
  listCachedPolicies: jest.fn(), approvePolicy: jest.fn(), denyPolicy: jest.fn(),
  removeCachedPolicy: jest.fn(), recordPolicyDecision: jest.fn(),
}));
jest.mock('../app-state', () => ({ getRunnerManager: jest.fn(), getLogger: jest.fn() }));

import { summarizeGrants } from './policy';

describe('summarizeGrants', () => {
  it('shows docker grants, which an operator is consenting to when they approve', () => {
    const grants = summarizeGrants({
      shared: {
        docker: {
          pull: { registries: ['docker.io'] },
          run: { images: ['alpine:3'], mounts: [{ path: './', mode: 'ro' }], network: 'bridge' },
        },
      },
    });
    expect(grants.join('\n')).toMatch(/docker pull: docker\.io/);
    expect(grants.join('\n')).toMatch(/docker run image: alpine:3/);
    expect(grants.join('\n')).toMatch(/docker mount: \.\/ \(ro\)/);
    expect(grants.join('\n')).toMatch(/docker network: bridge/);
  });

  it('shows a bare action block, which grants the action itself', () => {
    expect(summarizeGrants({ shared: { docker: { build: {} } } }).join('\n')).toMatch(/docker build/);
    expect(summarizeGrants({ shared: { docker: { run: {} } } }).join('\n')).toMatch(/docker run/);
  });

  it('shows docker grants from a per-workflow section too', () => {
    const grants = summarizeGrants({ workflows: { integration: { docker: { run: { images: ['redis:7'] } } } } });
    expect(grants.join('\n')).toMatch(/integration: docker run image: redis:7/);
  });

  it('still shows the non-docker grants', () => {
    const grants = summarizeGrants({ shared: { network: { allow: ['example.com'] }, filesystem: { write: ['~/.npm'] } } });
    expect(grants).toEqual(['network: example.com', 'write: ~/.npm']);
  });
});
