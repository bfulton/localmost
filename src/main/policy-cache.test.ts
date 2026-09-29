import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-cache-'));

jest.mock('./paths', () => ({
  getAppDataDir: () => tmpRoot,
}));

jest.mock('./app-state', () => ({
  getLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import {
  decidePolicyForJob,
  recordPendingPolicy,
  approvePolicy,
  approvalStamp,
  getPolicyEntry,
  getApprovedPolicyForCommit,
  rejectPolicy,
} from './policy-cache';
import { LocalmostrcConfig } from '../shared/localmostrc';

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
