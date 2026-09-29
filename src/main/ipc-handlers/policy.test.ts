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

describe('the level on the approval screen', () => {
  it('shows a loosened level, which grants more than any other line', () => {
    // A level-only policy used to summarise as nothing at all, and the card
    // read "Grants nothing beyond the baseline" for level: permissive.
    expect(summarizeGrants({ version: 1, level: 'permissive' } as never)).toEqual([
      expect.stringMatching(/^level: permissive\b/),
    ]);
  });

  it('shows the level ahead of the grants it widens', () => {
    const grants = summarizeGrants({
      level: 'moderate',
      shared: { network: { allow: ['example.com'] } },
      workflows: { ci: { network: { allow: ['ci.example.com'] } } },
    } as never);
    expect(grants[0]).toMatch(/^level: moderate\b/);
    expect(grants.slice(1)).toEqual(['network: example.com', 'ci: network: ci.example.com']);
  });

  it('shows no level line for strict, which is the baseline', () => {
    expect(summarizeGrants({ level: 'strict', shared: {} } as never)).toEqual([]);
  });
});

describe('network grants on the approval screen', () => {
  it('shows a declared network and whether it is routable', () => {
    const grants = summarizeGrants({
      shared: { docker: { run: { networks: [{ name: 'vk-*', internal: true }, { name: 'build', internal: false }] } } },
    });
    expect(grants.join('\n')).toMatch(/docker network create: vk-\* \(internal\)/);
    expect(grants.join('\n')).toMatch(/docker network create: build \(routable\)/);
  });
});
