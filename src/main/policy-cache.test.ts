import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-cache-'));

jest.mock('./paths', () => ({
  getAppDataDir: () => tmpRoot,
}));

const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./app-state', () => ({
  getLogger: () => mockLogger,
}));

import {
  decidePolicyForJob,
  recordPendingPolicy,
  approvePolicy,
  approvalStamp,
  getPolicyEntry,
  getApprovedPolicyForCommit,
  rejectPolicy,
  approvedDockerForCommit,
} from './policy-cache';
import { LocalmostrcConfig } from '../shared/localmostrc';

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const REPO = 'owner/repo';
const SHA = 'a'.repeat(40);
const approvedPolicy = () => getPolicyEntry(REPO)?.approved?.config ?? null;
const POLICY = `version: 1

shared:
  network:
    allow:
      - "index.crates.io"
`;

/** Approve a policy the way the app does: record it pending, then quote its stamp. */
const approve = (config: LocalmostrcConfig) => {
  recordPendingPolicy(REPO, config);
  approvePolicy(REPO, approvalStamp(REPO, config));
};

beforeEach(() => {
  fs.rmSync(path.join(tmpRoot, 'policies'), { recursive: true, force: true });
});

describe('decidePolicyForJob', () => {

  it("logs the keys a policy has that are ignored, once per repository and content", () => {
    mockLogger.warn.mockClear();
    const ignoring = `version: 1

shared:
  isolation: seatbelt
  network:
    loopback: true
    allow:
      - "index.crates.io"
`;
    decidePolicyForJob(REPO, ignoring, SHA);
    decidePolicyForJob(REPO, ignoring, 'b'.repeat(40));
    const warned = () => mockLogger.warn.mock.calls.map(([m]) => m as string).filter((m) => m.startsWith('.localmostrc for '));
    expect(warned()).toEqual([
      expect.stringMatching(/^\.localmostrc for owner\/repo: shared\.isolation is ignored: /),
      expect.stringMatching(/^\.localmostrc for owner\/repo: shared\.network\.loopback is ignored: /),
    ]);
    // Another repository, or changed content, is said again.
    decidePolicyForJob('owner/other', ignoring, SHA);
    decidePolicyForJob(REPO, `${ignoring}\n# changed\n`, SHA);
    expect(warned()).toHaveLength(6);
  });

  it('allows a repository that has no policy at all', () => {
    // Nothing is being granted beyond the baseline, so there is nothing to
    // consent to. Asking here would block every repository on its first job.
    expect(decidePolicyForJob(REPO, null, SHA)).toEqual({ action: 'allow', reason: 'no-policy' });
  });

  it('requires approval the first time a policy appears', () => {
    const decision = decidePolicyForJob(REPO, POLICY, SHA);

    expect(decision.action).toBe('needs-approval');
    if (decision.action === 'needs-approval') {
      expect(decision.request.isNewRepo).toBe(true);
    }
  });

  it('allows an approved policy that has not changed', () => {
    const first = decidePolicyForJob(REPO, POLICY, SHA);
    if (first.action !== 'needs-approval') throw new Error('expected approval request');
    approve(first.request.newConfig);

    expect(decidePolicyForJob(REPO, POLICY, SHA)).toEqual({ action: 'allow', reason: 'unchanged' });
  });

  it('requires approval again once an approved policy changes', () => {
    const first = decidePolicyForJob(REPO, POLICY, SHA);
    if (first.action !== 'needs-approval') throw new Error('expected approval request');
    approve(first.request.newConfig);

    const widened = POLICY + '      - "evil.example.com"\n';
    const decision = decidePolicyForJob(REPO, widened, SHA);

    expect(decision.action).toBe('needs-approval');
    if (decision.action === 'needs-approval') {
      expect(decision.request.isNewRepo).toBe(false);
      expect(decision.request.diffs.length).toBeGreaterThan(0);
    }
  });

  it('does not ask again when a policy is merely recorded, not approved', () => {
    const first = decidePolicyForJob(REPO, POLICY, SHA);
    if (first.action !== 'needs-approval') throw new Error('expected approval request');
    recordPendingPolicy(REPO, first.request.newConfig);

    // Recording what is pending must not count as consent.
    expect(decidePolicyForJob(REPO, POLICY, SHA).action).toBe('needs-approval');
  });

  it('holds a job whose .localmostrc cannot be parsed', () => {
    // A repository that has a policy but an unreadable one is the worst case to
    // guess at: allowing it runs code under a file nobody has reviewed, so the
    // job must not be treated as if the repository were unpoliced.
    const decision = decidePolicyForJob(REPO, 'version: 1\nshared: [not a mapping', SHA);

    expect(decision.action).toBe('invalid');
  });

  it('does not fall back to the approved policy when the new one is unparseable', () => {
    const first = decidePolicyForJob(REPO, POLICY, SHA);
    if (first.action !== 'needs-approval') throw new Error('expected approval');
    approve(first.request.newConfig);

    expect(decidePolicyForJob(REPO, ': : :', SHA).action).toBe('invalid');
  });

  it('allows a repository that removes its policy', () => {
    approve({ version: 1, shared: {} });

    expect(decidePolicyForJob(REPO, null, SHA)).toEqual({ action: 'allow', reason: 'narrowed' });
  });
});

describe('a pending policy does not displace the approved one', () => {
  const permissive = 'version: 1\nlevel: permissive\n';

  it('keeps running jobs under the approved policy while a change waits', () => {
    // A refused job's policy used to overwrite the approved entry, so every
    // job afterwards - including ones whose file matched what was approved -
    // was refused until someone approved whatever had been written last.
    const first = decidePolicyForJob(REPO, POLICY, SHA);
    if (first.action !== 'needs-approval') throw new Error('expected approval request');
    approve(first.request.newConfig);

    const changed = decidePolicyForJob(REPO, permissive, SHA);
    if (changed.action !== 'needs-approval') throw new Error('expected approval request');
    recordPendingPolicy(REPO, changed.request.newConfig);

    expect(approvedPolicy()).toEqual(first.request.newConfig);
    expect(decidePolicyForJob(REPO, POLICY, SHA)).toEqual({ action: 'allow', reason: 'unchanged' });
  });

  it('refuses an approval quoting a policy that is no longer the pending one', () => {
    const shown = decidePolicyForJob(REPO, POLICY, SHA);
    if (shown.action !== 'needs-approval') throw new Error('expected approval request');
    recordPendingPolicy(REPO, shown.request.newConfig);
    const stamp = approvalStamp(REPO, shown.request.newConfig);

    const later = decidePolicyForJob(REPO, permissive, SHA);
    if (later.action !== 'needs-approval') throw new Error('expected approval request');
    recordPendingPolicy(REPO, later.request.newConfig);

    expect(() => approvePolicy(REPO, stamp)).toThrow(/changed since it was shown/);
    expect(approvedPolicy()).toBeNull();
  });

  it('records which policy was approved or rejected, by its stamp', () => {
    approve({ version: 1, level: 'moderate' });
    recordPendingPolicy(REPO, { version: 1, level: 'permissive' });
    rejectPolicy(REPO);

    const log = fs.readFileSync(path.join(tmpRoot, 'policies', 'decisions.log'), 'utf-8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(log).toEqual([
      expect.objectContaining({ repository: REPO, decision: 'approved', stamp: approvalStamp(REPO, { version: 1, level: 'moderate' }), via: 'app' }),
      expect.objectContaining({ repository: REPO, decision: 'rejected', stamp: approvalStamp(REPO, { version: 1, level: 'permissive' }), via: 'app' }),
    ]);
    expect(approvedPolicy()).toEqual(expect.objectContaining({ level: 'moderate' }));
  });

  it('applies nothing from a cache entry that does not validate', () => {
    fs.mkdirSync(path.join(tmpRoot, 'policies'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'policies', 'owner_repo.json'),
      JSON.stringify({ repository: REPO, config: { version: 1, level: 'wide-open' }, approved: true, cachedAt: '' })
    );
    expect(approvedPolicy()).toBeNull();
    expect(decidePolicyForJob(REPO, POLICY, SHA).action).toBe('needs-approval');
  });

  it('records a refused job over an entry that does not validate, so it can be approved', () => {
    // recordPendingPolicy threw on such an entry, so the job was refused as
    // "could not verify", nothing was left to approve, and every later job
    // was refused the same way until someone deleted the file.
    fs.mkdirSync(path.join(tmpRoot, 'policies'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'policies', 'owner_repo.json'),
      JSON.stringify({ repository: REPO, config: { version: 1, shared: { sockets: {} } }, approved: true, cachedAt: '' })
    );
    const decision = decidePolicyForJob(REPO, POLICY, SHA);
    if (decision.action !== 'needs-approval') throw new Error('expected approval request');

    recordPendingPolicy(REPO, decision.request.newConfig);
    approvePolicy(REPO, approvalStamp(REPO, decision.request.newConfig));
    expect(decidePolicyForJob(REPO, POLICY, SHA)).toEqual({ action: 'allow', reason: 'unchanged' });
  });

  it('records no decision when there was nothing to reject', () => {
    approve({ version: 1, level: 'moderate' });
    expect(() => rejectPolicy(REPO)).toThrow(/nothing waiting/);

    const log = fs.readFileSync(path.join(tmpRoot, 'policies', 'decisions.log'), 'utf-8').trim().split('\n');
    expect(log.map((line) => JSON.parse(line).decision)).toEqual(['approved']);
  });

  it('still applies an approval written in the format before the split', () => {
    fs.mkdirSync(path.join(tmpRoot, 'policies'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'policies', 'owner_repo.json'),
      JSON.stringify({ repository: REPO, config: { version: 1, shared: { network: { allow: ['index.crates.io'] } } }, approved: true, cachedAt: '' })
    );
    expect(decidePolicyForJob(REPO, POLICY, SHA)).toEqual({ action: 'allow', reason: 'unchanged' });
  });
});

describe('a commit without a .localmostrc runs on the baseline', () => {
  const approved = { version: 1, level: 'permissive' as const, shared: { network: { allow: ['index.crates.io'] } } };
  const PERMISSIVE = 'version: 1\nlevel: permissive\nshared:\n  network:\n    allow:\n      - "index.crates.io"\n';

  it('applies no approved grant to a commit whose policy was deleted', () => {
    // Deleting the file was allowed as "narrowed", but the job then ran under
    // the cached approved policy anyway: removing .localmostrc narrowed
    // nothing, and an owner who deleted it to withdraw a grant kept granting it.
    approve(approved);

    expect(decidePolicyForJob(REPO, null, 'deleted-sha')).toEqual({ action: 'allow', reason: 'narrowed' });
    expect(getApprovedPolicyForCommit(REPO, 'deleted-sha')).toBeNull();
  });

  it('still applies the approved policy to a commit whose file matches it', () => {
    approve(approved);
    decidePolicyForJob(REPO, null, 'deleted-sha');

    expect(decidePolicyForJob(REPO, PERMISSIVE, 'kept-sha')).toEqual({ action: 'allow', reason: 'unchanged' });
    expect(getApprovedPolicyForCommit(REPO, 'kept-sha')).toEqual(expect.objectContaining({ level: 'permissive' }));
  });

  it('applies no approved grant to a commit whose policy was refused', () => {
    // Such a job is refused before it runs; if one ran anyway, the grants
    // approved for different content are not the ones to give it.
    approve(approved);
    decidePolicyForJob(REPO, 'version: 1\nlevel: moderate\n', 'changed-sha');

    expect(getApprovedPolicyForCommit(REPO, 'changed-sha')).toBeNull();
  });

  it('applies nothing to a commit the check never saw', () => {
    // A job that skipped the pre-spawn check - no actor to filter on, or a
    // worker that claimed a job other than the one it was spawned for - was
    // given the repository's approved policy whether or not its commit
    // carried it. Only a commit found carrying the approved policy gets it.
    approve(approved);

    expect(getApprovedPolicyForCommit(REPO, 'unchecked-sha')).toBeNull();
  });

  it('applies nothing to a commit checked under another repository name', () => {
    // The check is keyed on the name GitHub reported, the policy lookup on the
    // target's name. After a rename they differ, and a commit that deleted
    // its file under the new name took the old name's approval.
    approve(approved);
    decidePolicyForJob('owner/renamed', null, 'shared-sha');

    expect(getApprovedPolicyForCommit(REPO, 'shared-sha')).toBeNull();
  });

  it('applies the approved policy to a commit checked under the name in another case', () => {
    // GitHub's names are case-insensitive, and the check and the lookup can
    // spell one differently: the check under the name GitHub reported, the
    // lookup under the one the worker's policy is resolved by.
    approve(approved);
    expect(decidePolicyForJob('Owner/Repo', PERMISSIVE, 'case-sha')).toEqual({ action: 'allow', reason: 'unchanged' });

    expect(getApprovedPolicyForCommit('owner/repo', 'case-sha')).toEqual(expect.objectContaining({ level: 'permissive' }));
  });

  it('applies nothing once a different policy has been approved since the check', () => {
    // The commit was found carrying the policy approved then. If another is
    // approved before the job starts, that one is not the commit's own file.
    approve(approved);
    expect(decidePolicyForJob(REPO, PERMISSIVE, 'kept-sha')).toEqual({ action: 'allow', reason: 'unchanged' });
    approve({ version: 1, level: 'moderate' });

    expect(getApprovedPolicyForCommit(REPO, 'kept-sha')).toBeNull();
  });

  it('forgets that a commit was covered once a later check finds it is not', () => {
    approve(approved);
    decidePolicyForJob(REPO, PERMISSIVE, 'kept-sha');
    decidePolicyForJob(REPO, null, 'kept-sha');

    expect(getApprovedPolicyForCommit(REPO, 'kept-sha')).toBeNull();
  });
});

describe('whether the approved policy grants a job Docker', () => {
  // What admission asks, to refuse a job a macOS VM cannot give Docker yet:
  // the approved policy for the job's commit - never the repository's current
  // file - with the shared section and the job's workflow's merged.
  const DOCKER = [
    'version: 1',
    'shared:',
    '  network:',
    '    allow: ["github.com"]',
    'workflows:',
    '  images:',
    '    docker:',
    '      pull:',
    '        registries: ["docker.io"]',
    '',
  ].join('\n');
  const approveDocker = () => {
    const first = decidePolicyForJob(REPO, DOCKER, 'first-sha');
    if (first.action !== 'needs-approval') throw new Error('expected approval request');
    approve(first.request.newConfig);
    expect(decidePolicyForJob(REPO, DOCKER, SHA)).toEqual({ action: 'allow', reason: 'unchanged' });
  };

  it("is true for the workflow whose section grants it, and false for the others", () => {
    approveDocker();

    expect(approvedDockerForCommit(REPO, SHA, 'images')).toBe(true);
    expect(approvedDockerForCommit(REPO, SHA, 'build')).toBe(false);
    expect(approvedDockerForCommit(REPO, SHA, undefined)).toBe(false);
  });

  it('is false for a commit the check never covered, or a job with no commit', () => {
    approveDocker();

    expect(approvedDockerForCommit(REPO, 'unchecked-sha', 'images')).toBe(false);
    expect(approvedDockerForCommit(REPO, undefined, 'images')).toBe(false);
  });
});

describe('the repository behind the name', () => {
  // An approval is recorded by name, and a name can be freed - by deleting
  // or renaming the repository - and taken by someone else, whose
  // .localmostrc need only match the approved one to inherit its grants.
  const config = { version: 1, shared: { network: { allow: ['index.crates.io'] } } };
  const approveAs = (repositoryId?: number) => {
    recordPendingPolicy(REPO, config, repositoryId);
    approvePolicy(REPO, approvalStamp(REPO, config, repositoryId));
  };

  it('asks again when a different repository presents the approved one\'s name', () => {
    approveAs(1);

    const decision = decidePolicyForJob(REPO, POLICY, SHA, 2);
    expect(decision.action).toBe('needs-approval');
    if (decision.action === 'needs-approval') {
      expect(decision.request.isNewRepo).toBe(true);
      expect(decision.request.replacesRepositoryId).toBe(1);
    }
    expect(getApprovedPolicyForCommit(REPO, SHA)).toBeNull();
  });

  it('allows the repository the policy was approved for', () => {
    approveAs(1);
    expect(decidePolicyForJob(REPO, POLICY, SHA, 1)).toEqual({ action: 'allow', reason: 'unchanged' });
  });

  it('binds an approval that predates ids to the first job that matches it', () => {
    approveAs(undefined);

    expect(decidePolicyForJob(REPO, POLICY, SHA, 7)).toEqual({ action: 'allow', reason: 'unchanged' });
    expect(getPolicyEntry(REPO)?.approved?.repositoryId).toBe(7);
    expect(decidePolicyForJob(REPO, POLICY, SHA, 8).action).toBe('needs-approval');
  });

  it('does not bind an approval to a job whose policy does not match it', () => {
    approveAs(undefined);
    decidePolicyForJob(REPO, POLICY + '      - "evil.example.com"\n', SHA, 7);
    expect(getPolicyEntry(REPO)?.approved?.repositoryId).toBeUndefined();
  });

  it('decides as before for a job that carries no id', () => {
    approveAs(1);
    expect(decidePolicyForJob(REPO, POLICY, SHA)).toEqual({ action: 'allow', reason: 'unchanged' });
  });

  it('treats an id that is not one as no id, and never records it', () => {
    // A malformed id from the job message used to be written into the entry,
    // which then failed to read back - and the next change dropped the
    // approval with it.
    approveAs(undefined);
    for (const bad of [NaN, 0, 1.5]) {
      expect(decidePolicyForJob(REPO, POLICY, SHA, bad)).toEqual({ action: 'allow', reason: 'unchanged' });
      recordPendingPolicy(REPO, config, bad);
    }
    const entry = getPolicyEntry(REPO);
    expect(entry?.approved?.config).toEqual(config);
    expect(entry?.approved?.repositoryId).toBeUndefined();
    expect(entry?.pending?.repositoryId).toBeUndefined();
  });

  it('decides a job with an id that is not one as a job without an id', () => {
    approveAs(1);
    for (const bad of [NaN, 0, -1]) {
      expect(decidePolicyForJob(REPO, POLICY, SHA, bad)).toEqual({ action: 'allow', reason: 'unchanged' });
    }
  });

  it('takes the id of the pending policy it approves, so the new repository then runs', () => {
    approveAs(1);
    const decision = decidePolicyForJob(REPO, POLICY, SHA, 2);
    if (decision.action !== 'needs-approval') throw new Error('expected approval request');
    recordPendingPolicy(REPO, decision.request.newConfig, 2);
    approvePolicy(REPO, approvalStamp(REPO, decision.request.newConfig, 2));

    expect(getPolicyEntry(REPO)?.approved?.repositoryId).toBe(2);
    expect(decidePolicyForJob(REPO, POLICY, SHA, 2)).toEqual({ action: 'allow', reason: 'unchanged' });
    expect(decidePolicyForJob(REPO, POLICY, SHA, 1).action).toBe('needs-approval');
  });
});
