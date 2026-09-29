import { admitJob, buildAdmissionDeps, checkRepoPolicyApproval, JobAdmissionDeps, PolicyApprovalDeps } from './job-admission';
import type { GitHubJobInfo } from './broker-proxy-service';
import type { PolicyDecision } from './policy-cache';

describe('admitJob', () => {
  const target = { id: 't1', displayName: 'owner/repo' };
  const info: GitHubJobInfo = {
    githubRunId: 42,
    githubJobId: 7,
    githubRepo: 'owner/repo',
    githubActor: 'me',
    githubSha: 'abc1234def',
    githubRef: 'refs/heads/main',
    githubWorkflow: 'ci',
  };

  /** Every call the admission makes, in order, so tests can say what happened before what. */
  function setup(overrides: {
    verdict?: { allowed: boolean; reason: string };
    policyReason?: string | null;
    spawn?: () => Promise<boolean>;
    findTarget?: JobAdmissionDeps['findTarget'];
  } = {}) {
    const calls: string[] = [];
    const deps = {
      findTarget: overrides.findTarget ?? ((id: string) => (id === target.id ? target : undefined)),
      runnerManager: {
        evaluateJobFilter: jest.fn(async () => {
          calls.push('filter');
          return overrides.verdict ?? { allowed: true, reason: '' };
        }),
        recordRefusedJob: jest.fn(() => { calls.push('record'); return 'refused-42-1'; }),
        cancelRun: jest.fn(async () => { calls.push('cancel'); }),
        setPendingTargetContext: jest.fn(() => { calls.push('context'); }),
        spawnWorkerForJob: jest.fn(async () => {
          calls.push('spawn');
          return overrides.spawn ? overrides.spawn() : true;
        }),
      },
      broker: {
        dropJob: jest.fn(() => { calls.push('drop'); }),
        refuseJob: jest.fn(() => { calls.push('refuse'); }),
      },
      checkPolicyApproval: jest.fn(async () => {
        calls.push('policy');
        return overrides.policyReason ?? null;
      }),
      log: jest.fn(),
    };
    return { deps: deps as unknown as JobAdmissionDeps & typeof deps, calls };
  }

  it('spawns the worker for an admitted job and leaves the job with the broker', async () => {
    const { deps, calls } = setup();

    await admitJob(deps, 't1', 'req-1', info);

    expect(calls).toEqual(['filter', 'policy', 'context', 'spawn']);
    expect(deps.runnerManager.setPendingTargetContext).toHaveBeenCalledWith(
      'next', 't1', 'owner/repo', expect.any(String), 42, 7, 'me', 'abc1234def', 'refs/heads/main', 'ci', 'req-1', 'owner/repo'
    );
    expect(deps.broker.dropJob).not.toHaveBeenCalled();
    expect(deps.broker.refuseJob).not.toHaveBeenCalled();
  });

  it('drops a job the user filter refuses before cancelling it', async () => {
    // The broker had already acquired the job, stored its payload and queued
    // it. A refusal that only recorded and cancelled left all of that behind,
    // and an idle listener could bind the leftover assignment and run it.
    const { deps, calls } = setup({ verdict: { allowed: false, reason: 'stranger' } });

    await admitJob(deps, 't1', 'req-1', info);

    expect(deps.broker.refuseJob).toHaveBeenCalledWith('t1', 'req-1');
    expect(calls.indexOf('refuse')).toBeLessThan(calls.indexOf('cancel'));
    expect(deps.runnerManager.spawnWorkerForJob).not.toHaveBeenCalled();
  });

  it('has a failed cancel noted on the entry it recorded for this job', async () => {
    // Two jobs of one run can be refused at once; "the latest entry for the
    // run" can be the other one's by the time a cancel fails.
    const { deps } = setup({ verdict: { allowed: false, reason: 'stranger' } });

    await admitJob(deps, 't1', 'req-1', info);

    expect(deps.runnerManager.cancelRun).toHaveBeenCalledWith('owner', 'repo', 42, 'stranger', 'refused-42-1');
  });

  it('drops a job whose policy is not approved', async () => {
    const { deps, calls } = setup({ policyReason: 'not approved' });

    await admitJob(deps, 't1', 'req-1', info);

    expect(deps.broker.refuseJob).toHaveBeenCalledWith('t1', 'req-1');
    expect(calls.indexOf('refuse')).toBeLessThan(calls.indexOf('cancel'));
    expect(deps.runnerManager.spawnWorkerForJob).not.toHaveBeenCalled();
  });

  it("hands the worker an organization target's job under the repository GitHub named", async () => {
    // The display name of an organization target is the organization. The
    // policy was checked, and approved, under the job's own repository, so
    // that is the name the worker's policy has to be resolved under.
    const { deps } = setup({ findTarget: () => ({ id: 't1', displayName: 'myorg' }) });

    await admitJob(deps, 't1', 'req-1', { ...info, githubRepo: 'MyOrg/App' });

    expect(deps.runnerManager.setPendingTargetContext.mock.calls[0]).toEqual([
      'next', 't1', 'myorg', expect.any(String), 42, 7, 'me', 'abc1234def', 'refs/heads/main', 'ci', 'req-1', 'MyOrg/App',
    ]);
  });

  it("asks about the policy with the job's repository id", async () => {
    const { deps } = setup();

    await admitJob(deps, 't1', 'req-1', { ...info, repositoryId: 4242 });

    expect(deps.checkPolicyApproval).toHaveBeenCalledWith('owner', 'repo', 'abc1234def', 4242);
  });

  it("carries the job's repository id through to the policy decision", async () => {
    // index.ts builds its admission from here. Written there as its own
    // lambda, one that forgot the id still compiled, and the approval went
    // back to whichever repository held the name.
    const { deps } = setup();
    const policy = {
      getAccessToken: jest.fn(async () => 'token'),
      getFileContent: jest.fn(async () => null),
      decidePolicyForJob: jest.fn((..._args: unknown[]): PolicyDecision => ({ action: 'allow', reason: 'no-policy' })),
      recordPendingPolicy: jest.fn(),
      announce: jest.fn(),
    } satisfies PolicyApprovalDeps;
    const admission = buildAdmissionDeps(policy, {
      findTarget: deps.findTarget, runnerManager: deps.runnerManager, broker: deps.broker, log: deps.log,
    });

    await admitJob(admission, 't1', 'req-1', { ...info, repositoryId: 4242 });

    expect(policy.decidePolicyForJob).toHaveBeenCalledWith('owner/repo', null, 'abc1234def', 4242);
    expect(deps.runnerManager.spawnWorkerForJob).toHaveBeenCalled();
  });

  it('drops a job for a target it no longer knows', async () => {
    const { deps } = setup({ findTarget: () => undefined });

    await admitJob(deps, 't-gone', 'req-1', info);

    expect(deps.broker.refuseJob).toHaveBeenCalledWith('t-gone', 'req-1');
    expect(deps.runnerManager.spawnWorkerForJob).not.toHaveBeenCalled();
  });

  it('still asks the filter when the job names no actor', async () => {
    // An acquire response the broker could not parse leaves the job with no
    // identity. The checks used to be skipped outright for it, and the job
    // spawned as if it had passed them.
    const { deps } = setup({ verdict: { allowed: false, reason: 'no actor' } });

    await admitJob(deps, 't1', 'req-1', { ...info, githubActor: undefined });

    expect(deps.runnerManager.evaluateJobFilter).toHaveBeenCalledWith('owner', 'repo', undefined, 'abc1234def');
    expect(deps.broker.refuseJob).toHaveBeenCalledWith('t1', 'req-1');
    expect(deps.runnerManager.spawnWorkerForJob).not.toHaveBeenCalled();
  });

  it('refuses a job whose repository it cannot tell', async () => {
    // An org target's display name is the org alone, so without the job's own
    // repository there is nothing to check a filter or a policy against.
    const { deps } = setup();
    const orgTarget = { id: 't1', displayName: 'owner' };
    deps.findTarget = () => orgTarget;

    await admitJob(deps, 't1', 'req-1', { githubRunId: 42 });

    expect(deps.runnerManager.recordRefusedJob).toHaveBeenCalled();
    expect(deps.broker.refuseJob).toHaveBeenCalledWith('t1', 'req-1');
    expect(deps.runnerManager.spawnWorkerForJob).not.toHaveBeenCalled();
  });

  it('refuses when a check throws rather than letting the job through', async () => {
    const { deps } = setup();
    deps.runnerManager.evaluateJobFilter.mockRejectedValueOnce(new Error('config unreadable'));

    await admitJob(deps, 't1', 'req-1', info);

    expect(deps.broker.refuseJob).toHaveBeenCalledWith('t1', 'req-1');
    expect(deps.runnerManager.spawnWorkerForJob).not.toHaveBeenCalled();
  });

  it('drops an admitted job no worker could be started for', async () => {
    // Nothing else will ever take it: only the worker spawned for a job may.
    const { deps } = setup({ spawn: async () => false });

    await admitJob(deps, 't1', 'req-1', info);

    expect(deps.broker.dropJob).toHaveBeenCalledWith('t1', 'req-1');
  });

  it('drops an admitted job whose spawn throws', async () => {
    const { deps } = setup({ spawn: async () => { throw new Error('sandbox build failed'); } });

    await admitJob(deps, 't1', 'req-1', info);

    expect(deps.broker.dropJob).toHaveBeenCalledWith('t1', 'req-1');
  });

  it('leaves a job it failed to start free to be offered again', async () => {
    // Nothing judged it: a redelivery is the retry, so the broker must not
    // remember it as refused.
    const { deps } = setup({ spawn: async () => false });

    await admitJob(deps, 't1', 'req-1', info);

    expect(deps.broker.refuseJob).not.toHaveBeenCalled();
  });

  it('drops the job when anything between the checks and the spawn throws', async () => {
    // index.ts only logs a rejected admission, so a throw that escaped here
    // left the job at the broker, payload held, for the life of the process.
    const { deps } = setup();
    deps.runnerManager.setPendingTargetContext.mockImplementationOnce(() => { throw new Error('boom'); });

    await expect(admitJob(deps, 't1', 'req-1', info)).rejects.toThrow('boom');

    expect(deps.broker.dropJob).toHaveBeenCalledWith('t1', 'req-1');
  });

  it('keeps a refusal a refusal when recording it throws', async () => {
    // The job was already refused at the broker; dropping it again after the
    // throw would forget that, and GitHub's next offer of it would be refused
    // and recorded anew.
    const { deps } = setup({ verdict: { allowed: false, reason: 'stranger' } });
    deps.runnerManager.recordRefusedJob.mockImplementationOnce(() => { throw new Error('history unwritable'); });

    await expect(admitJob(deps, 't1', 'req-1', info)).rejects.toThrow('history unwritable');

    expect(deps.broker.refuseJob).toHaveBeenCalledWith('t1', 'req-1');
    expect(deps.broker.dropJob).not.toHaveBeenCalled();
  });
});

describe('checkRepoPolicyApproval', () => {
  const approvalRequest = { repository: 'owner/repo', newConfig: { version: 1 }, diffs: [], isNewRepo: true };

  function deps(decision: PolicyDecision) {
    return {
      getAccessToken: jest.fn(async () => 'token'),
      getFileContent: jest.fn(async () => 'version: 1\n'),
      decidePolicyForJob: jest.fn((..._args: unknown[]) => decision),
      recordPendingPolicy: jest.fn(),
      announce: jest.fn(),
    } satisfies PolicyApprovalDeps;
  }

  it("decides and records the pending policy with the job's repository id", async () => {
    const d = deps({ action: 'needs-approval', request: approvalRequest });

    const reason = await checkRepoPolicyApproval(d, 'owner', 'repo', 'abc1234', 4242);

    expect(d.decidePolicyForJob).toHaveBeenCalledWith('owner/repo', 'version: 1\n', 'abc1234', 4242);
    expect(d.recordPendingPolicy).toHaveBeenCalledWith('owner/repo', approvalRequest.newConfig, 4242);
    // A repository that has simply not been approved keeps the plain request.
    expect(reason).toMatch(/has not been approved/);
    expect(reason).not.toMatch(/different repository/);
  });

  it('says so when a different repository now holds the approved name', async () => {
    // The approval belongs to repository 41. The CLI cannot move it to 4242 -
    // only the app's approval card, which shows the id changing - so pointing
    // at `localmost policy approve` sent the operator to a command that
    // leaves the job refused.
    const d = deps({ action: 'needs-approval', request: { ...approvalRequest, replacesRepositoryId: 41 } });

    const reason = await checkRepoPolicyApproval(d, 'owner', 'repo', 'abc1234', 4242);

    expect(reason).toMatch(/different repository/);
    expect(reason).toContain('Settings > Job Security');
    expect(reason).not.toMatch(/has not been approved|policy approve/);
  });
});
