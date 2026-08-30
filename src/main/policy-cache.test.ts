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

import { decidePolicyForJob, cachePolicyConfig, removeCachedPolicy } from './policy-cache';

const REPO = 'owner/repo';
const POLICY = `version: 1

shared:
  network:
    allow:
      - "index.crates.io"
`;

describe('decidePolicyForJob', () => {
  beforeEach(() => {
    removeCachedPolicy(REPO);
  });

  it('allows a repository that has no policy at all', () => {
    // Nothing is being granted beyond the baseline, so there is nothing to
    // consent to. Asking here would block every repository on its first job.
    expect(decidePolicyForJob(REPO, null)).toEqual({ action: 'allow', reason: 'no-policy' });
  });

  it('requires approval the first time a policy appears', () => {
    const decision = decidePolicyForJob(REPO, POLICY);

    expect(decision.action).toBe('needs-approval');
    if (decision.action === 'needs-approval') {
      expect(decision.request.isNewRepo).toBe(true);
    }
  });

  it('allows an approved policy that has not changed', () => {
    const first = decidePolicyForJob(REPO, POLICY);
    if (first.action !== 'needs-approval') throw new Error('expected approval request');
    cachePolicyConfig(REPO, first.request.newConfig, true);

    expect(decidePolicyForJob(REPO, POLICY)).toEqual({ action: 'allow', reason: 'unchanged' });
  });

  it('requires approval again once an approved policy changes', () => {
    const first = decidePolicyForJob(REPO, POLICY);
    if (first.action !== 'needs-approval') throw new Error('expected approval request');
    cachePolicyConfig(REPO, first.request.newConfig, true);

    const widened = POLICY + '      - "evil.example.com"\n';
    const decision = decidePolicyForJob(REPO, widened);

    expect(decision.action).toBe('needs-approval');
    if (decision.action === 'needs-approval') {
      expect(decision.request.isNewRepo).toBe(false);
      expect(decision.request.diffs.length).toBeGreaterThan(0);
    }
  });

  it('does not ask again when a policy is merely recorded, not approved', () => {
    const first = decidePolicyForJob(REPO, POLICY);
    if (first.action !== 'needs-approval') throw new Error('expected approval request');
    cachePolicyConfig(REPO, first.request.newConfig, false);

    // Recording what is pending must not count as consent.
    expect(decidePolicyForJob(REPO, POLICY).action).toBe('needs-approval');
  });

  it('holds a job whose .localmostrc cannot be parsed', () => {
    // A repository that has a policy but an unreadable one is the worst case to
    // guess at: allowing it runs code under a file nobody has reviewed, so the
    // job must not be treated as if the repository were unpoliced.
    const decision = decidePolicyForJob(REPO, 'version: 1\nshared: [not a mapping');

    expect(decision.action).toBe('invalid');
  });

  it('does not fall back to the approved policy when the new one is unparseable', () => {
    const first = decidePolicyForJob(REPO, POLICY);
    if (first.action !== 'needs-approval') throw new Error('expected approval');
    cachePolicyConfig(REPO, first.request.newConfig, true);

    expect(decidePolicyForJob(REPO, ': : :').action).toBe('invalid');
  });

  describe('a change that only narrows access', () => {
    const TWO_HOSTS = 'version: 1\nshared:\n  network:\n    allow:\n      - "index.crates.io"\n      - "registry.npmjs.org"\n';
    const ONE_HOST = 'version: 1\nshared:\n  network:\n    allow:\n      - "index.crates.io"\n';
    const DENIES = 'version: 1\nshared:\n  network:\n    allow:\n      - "index.crates.io"\n    deny:\n      - "evil.example"\n';

    const approve = (content: string) => {
      const d = decidePolicyForJob(REPO, content);
      if (d.action !== 'needs-approval') throw new Error('expected approval');
      cachePolicyConfig(REPO, d.request.newConfig, true);
    };

    it('runs without asking again when a host is dropped', () => {
      // Giving up access cannot hurt the machine owner, so making them
      // re-approve it is friction that buys nothing.
      approve(TWO_HOSTS);

      expect(decidePolicyForJob(REPO, ONE_HOST)).toMatchObject({
        action: 'allow',
        reason: 'narrowed',
      });
    });

    it('runs without asking when a deny entry is added', () => {
      approve(ONE_HOST);

      expect(decidePolicyForJob(REPO, DENIES)).toMatchObject({ action: 'allow' });
    });

    it('still asks when a deny entry is removed', () => {
      // Dropping a deny widens access even though it is a removal.
      approve(DENIES);

      expect(decidePolicyForJob(REPO, ONE_HOST).action).toBe('needs-approval');
    });

    it('still asks when a change both adds and removes', () => {
      approve(ONE_HOST);

      expect(decidePolicyForJob(REPO, TWO_HOSTS).action).toBe('needs-approval');
    });

    it('asks again if the narrowed policy widens back out', () => {
      approve(TWO_HOSTS);
      const narrowed = decidePolicyForJob(REPO, ONE_HOST);
      if (narrowed.action !== 'allow' || !narrowed.config) throw new Error('expected narrowed config');
      cachePolicyConfig(REPO, narrowed.config, true);

      // The narrower policy is the approved one now, so going back is a widening.
      expect(decidePolicyForJob(REPO, TWO_HOSTS).action).toBe('needs-approval');
    });
  });

  it('allows a repository that removes its policy', () => {
    cachePolicyConfig(REPO, { version: 1, shared: {} }, true);

    expect(decidePolicyForJob(REPO, null)).toEqual({ action: 'allow', reason: 'narrowed' });
  });
});
