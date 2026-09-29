import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-ipc-'));
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const retireWorkersForRepository = jest.fn(async () => undefined);

jest.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
}));
// The sender check has tests of its own (trusted-ipc.test.ts); here the
// handlers are called directly, so they are registered on electron's ipcMain.
jest.mock('./trusted-ipc', () => ({ ipcMain: jest.requireMock<{ ipcMain: unknown }>('electron').ipcMain }));
jest.mock('../paths', () => ({ getAppDataDir: () => tmpRoot }));
jest.mock('../app-state', () => ({
  getRunnerManager: () => ({ retireWorkersForRepository }),
  getLogger: () => undefined,
}));

import { summarizeGrants, registerPolicyHandlers } from './policy';
import { recordPendingPolicy, getPolicyEntry, approvalStamp } from '../policy-cache';
import { IPC_CHANNELS, PolicySummary, Result } from '../../shared/types';

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

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
    expect(grants.join('\n')).toMatch(/integration \(any pull request can claim this\): docker run image: redis:7/);
  });

  it('still shows the non-docker grants', () => {
    const grants = summarizeGrants({ shared: { network: { allow: ['example.com'] }, filesystem: { write: ['~/.npm'] } } });
    expect(grants).toEqual(['network: example.com', 'write: ~/.npm']);
  });
});

describe('per-workflow grants on the approval screen', () => {
  it('says any pull request can claim a workflow section', () => {
    // A workflows: key is a file name, and a pull request can add a workflow
    // file of any name - so a per-workflow grant is not reserved for the
    // workflow the repository meant it for.
    const [grant] = summarizeGrants({ workflows: { deploy: { network: { allow: ['x.com'] } } } });
    expect(grant).toBe('deploy (any pull request can claim this): network: x.com');
  });

  it('says a per-workflow env allow is not applied', () => {
    const [grant] = summarizeGrants({ workflows: { deploy: { env: { allow: ['FASTLANE_*'] } } } });
    expect(grant).toMatch(/^deploy \(any pull request can claim this\): env: FASTLANE_\* \(not applied:/);
  });
});

describe('sensitive write paths on the approval screen', () => {
  it('marks a write the job could use to run code outside the sandbox', () => {
    const grants = summarizeGrants({ shared: { filesystem: { write: ['~/.zshrc', '~/.npm'] } } });
    expect(grants[0]).toMatch(/^write: ~\/\.zshrc \(warning: your shell runs this file/);
    expect(grants[1]).toBe('write: ~/.npm');
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
    expect(grants.slice(1)).toEqual(['network: example.com', 'ci (any pull request can claim this): network: ci.example.com']);
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

describe('approving from the app', () => {
  registerPolicyHandlers();
  const list = () => handlers.get(IPC_CHANNELS.POLICY_LIST)!({}) as PolicySummary[];
  const approve = (...args: unknown[]) => handlers.get(IPC_CHANNELS.POLICY_APPROVE)!({}, ...args) as Promise<Result>;
  const reject = (...args: unknown[]) => handlers.get(IPC_CHANNELS.POLICY_REJECT)!({}, ...args) as Result;
  const REPO = 'owner/repo';
  const approvedPolicy = () => getPolicyEntry(REPO)?.approved?.config ?? null;

  beforeEach(() => {
    fs.rmSync(path.join(tmpRoot, 'policies'), { recursive: true, force: true });
    retireWorkersForRepository.mockClear();
  });

  it('lists a pending policy with the stamp of exactly what it shows', () => {
    recordPendingPolicy(REPO, { version: 1, level: 'permissive' });
    const [summary] = list();
    expect(summary).toEqual(expect.objectContaining({ repository: REPO, approved: false }));
    expect(summary.grants[0]).toMatch(/^level: permissive\b/);
    expect(summary.stamp).toBe(approvalStamp(REPO, { version: 1, level: 'permissive' }));
  });

  it('approves what was listed', async () => {
    recordPendingPolicy(REPO, { version: 1, level: 'moderate' });
    const [summary] = list();

    await expect(approve(REPO, summary.stamp)).resolves.toEqual({ success: true });
    expect(approvedPolicy()).toEqual(expect.objectContaining({ level: 'moderate' }));
    expect(retireWorkersForRepository).toHaveBeenCalledWith(REPO);
  });

  it('refuses when the pending policy changed after it was listed', async () => {
    // The click used to approve whatever was on disk at that moment, which a
    // refused job could have replaced after the card was drawn.
    recordPendingPolicy(REPO, { version: 1, shared: { network: { allow: ['index.crates.io'] } } });
    const [shown] = list();
    recordPendingPolicy(REPO, { version: 1, level: 'permissive' });

    const result = await approve(REPO, shown.stamp);
    expect(result).toEqual({ success: false, error: expect.stringMatching(/changed since it was shown/) });
    expect(approvedPolicy()).toBeNull();
    expect(retireWorkersForRepository).not.toHaveBeenCalled();
  });

  it('refuses an approval that names no policy', async () => {
    recordPendingPolicy(REPO, { version: 1, level: 'moderate' });
    for (const stamp of [undefined, '', 'not-a-stamp', 42]) {
      expect((await approve(REPO, stamp)).success).toBe(false);
    }
    expect(approvedPolicy()).toBeNull();
  });

  it('refuses a repository name that is not one', async () => {
    for (const repository of ['a/../../../escaped', 'a/b/c', 7]) {
      expect((await approve(repository, 'a'.repeat(64))).success).toBe(false);
      expect(reject(repository).success).toBe(false);
    }
    expect(fs.existsSync(path.join(tmpRoot, 'escaped.json'))).toBe(false);
  });

  it('shows what a pending policy changes from the approved one, the level included', async () => {
    recordPendingPolicy(REPO, { version: 1, shared: { network: { allow: ['index.crates.io'] } } });
    await approve(REPO, list()[0].stamp);
    recordPendingPolicy(REPO, { version: 1, level: 'permissive', shared: { network: { allow: ['index.crates.io'] } } });

    const summaries = list();
    const pending = summaries.find((s) => !s.approved)!;
    const approved = summaries.find((s) => s.approved)!;
    expect(pending.changes).toEqual(['~ level: strict -> permissive']);
    expect(approved.grants).toEqual(['network: index.crates.io']);
  });

  it('rejecting a change leaves the approved policy in force', async () => {
    recordPendingPolicy(REPO, { version: 1, level: 'moderate' });
    await approve(REPO, list()[0].stamp);
    recordPendingPolicy(REPO, { version: 1, level: 'permissive' });

    expect(reject(REPO)).toEqual({ success: true });
    expect(approvedPolicy()).toEqual(expect.objectContaining({ level: 'moderate' }));
    expect(list().map((s) => s.approved)).toEqual([true]);
  });
});
