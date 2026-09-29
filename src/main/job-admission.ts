/**
 * Job admission
 *
 * The broker has acquired a job from GitHub and queued it before anything
 * here decides whether it may run. This is that decision: the user filter
 * and the repository's policy approval, made before any worker exists,
 * followed by the spawn of the one worker that job is for.
 *
 * Every job ends one of two ways. Admitted, it gets a worker announced to
 * the broker for it, and that worker is the only session that can take it.
 * Otherwise it is dropped at the broker - its queued message, its stored
 * payload (the job's secrets) and its routing - because nothing else will
 * ever run it, and anything left behind is what an idle listener could once
 * bind and run. A refused job is dropped as refused, so the broker ignores
 * GitHub offering it again; one that merely failed to start is not, and a
 * new offer is its retry.
 */

import type { GitHubJobInfo } from './broker-proxy-service';
import type { RunnerManager } from './runner-manager';
import type { PolicyApprovalRequest, PolicyDecision } from './policy-cache';
import type { LocalmostrcConfig } from '../shared/localmostrc';

export interface JobAdmissionDeps {
  findTarget: (targetId: string) => { id: string; displayName: string } | undefined;
  runnerManager: Pick<
    RunnerManager,
    'evaluateJobFilter' | 'recordRefusedJob' | 'cancelRun' | 'setPendingTargetContext' | 'spawnWorkerForJob'
  >;
  broker: {
    dropJob: (targetId: string, jobId: string) => void;
    refuseJob: (targetId: string, jobId: string) => void;
  };
  /**
   * A reason to refuse the job for its repository's policy, or null to
   * proceed. The repository id, when the job carries one, holds an approval
   * to the repository it was given to rather than to whichever holds the name.
   */
  checkPolicyApproval: (owner: string, repo: string, sha?: string, repositoryId?: number) => Promise<string | null>;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export async function admitJob(
  deps: JobAdmissionDeps,
  targetId: string,
  jobId: string,
  githubInfo: GitHubJobInfo
): Promise<void> {
  const { runnerManager, broker, log } = deps;
  log('info', `[job-received event] targetId=${targetId}, jobId=${jobId}, runId=${githubInfo.githubRunId}, actor=${githubInfo.githubActor}, sha=${githubInfo.githubSha?.slice(0, 7)}`);
  const target = deps.findTarget(targetId);
  if (!target) {
    log('warn', `[job-received] Target not found for id: ${targetId}; dropping job ${jobId}`);
    broker.refuseJob(targetId, jobId);
    return;
  }

  // Whatever throws from here on, the job must not stay at the broker: index.ts
  // only logs a rejected admission, so a job left there would sit acquired,
  // payload held, with nothing to run it. Once the broker has been told - the
  // job refused, dropped, or its worker started - there is nothing to undo,
  // and a refusal keeps its record that the job was refused.
  let told = false;
  try {
    // Construct actions URL directly from GitHub IDs
    let actionsUrl: string | undefined;
    if (githubInfo.githubRunId && githubInfo.githubJobId && githubInfo.githubRepo) {
      actionsUrl = `https://github.com/${githubInfo.githubRepo}/actions/runs/${githubInfo.githubRunId}/job/${githubInfo.githubJobId}`;
      log('info', `Constructed actions URL: ${actionsUrl}`);
    }

    const [owner, repo] = (githubInfo.githubRepo || target.displayName).split('/');
    const refuse = async (reason: string): Promise<void> => {
      // Dropped first, before anything awaits: until then the job sits at the
      // broker acquired and queued, payload and all.
      broker.refuseJob(targetId, jobId);
      told = true;
      const historyId = runnerManager.recordRefusedJob({
        repository: target.displayName,
        jobName: githubInfo.githubJobId ? `job ${githubInfo.githubJobId}` : jobId,
        reason,
        actionsUrl,
        githubRunId: githubInfo.githubRunId,
      });
      if (owner && repo && githubInfo.githubRunId) {
        await runnerManager.cancelRun(owner, repo, githubInfo.githubRunId, reason, historyId);
      }
    };

    // Decide whether this job may run before any worker exists. Cancelling
    // after a worker has started leaves untrusted steps executing for as long
    // as the check takes. Nothing here is skipped for want of information: a
    // job the broker could not read (an unparseable acquire response leaves no
    // repository and no actor) is one these checks cannot clear, so it is
    // refused - it could not have run anyway, having no stored payload.
    let refusal: string | null;
    try {
      if (!owner || !repo) {
        refusal = `cannot identify the repository of job ${jobId}`;
      } else {
        const verdict = await runnerManager.evaluateJobFilter(owner, repo, githubInfo.githubActor, githubInfo.githubSha);
        // A .localmostrc grants access beyond the baseline, so a new or
        // changed one needs the machine owner's consent before it takes effect.
        refusal = verdict.allowed
          ? await deps.checkPolicyApproval(owner, repo, githubInfo.githubSha, githubInfo.repositoryId)
          : verdict.reason;
      }
    } catch (err) {
      refusal = `could not decide whether job ${jobId} may run: ${(err as Error).message}`;
    }
    if (refusal) {
      await refuse(refusal);
      return;
    }

    log('info', `Spawning worker for job ${jobId} from ${target.displayName}...`);
    // The repository as GitHub named it goes with the job: it is the name the
    // policy was just checked, and approved, under - which for an
    // organization target the display name is not.
    runnerManager.setPendingTargetContext('next', targetId, target.displayName, actionsUrl, githubInfo.githubRunId, githubInfo.githubJobId, githubInfo.githubActor, githubInfo.githubSha, githubInfo.githubRef, githubInfo.githubWorkflow, jobId, githubInfo.githubRepo);

    let spawned = false;
    try {
      spawned = await runnerManager.spawnWorkerForJob();
    } catch (err) {
      log('error', `Failed to spawn worker for job ${jobId}: ${(err as Error).message}`);
    }
    if (!spawned) {
      // Only the worker spawned for a job may take it, so with none started
      // the job would sit at the broker, payload held, until the app quits.
      // A spawn that failed after announcing its worker has already withdrawn
      // it and dropped the job; dropping again is harmless.
      broker.dropJob(targetId, jobId);
    }
    told = true;
  } finally {
    if (!told) broker.dropJob(targetId, jobId);
  }
}

export interface PolicyApprovalDeps {
  getAccessToken: () => Promise<string | null | undefined>;
  /** The repository's file at a commit, or null when it has none. */
  getFileContent: (accessToken: string, owner: string, repo: string, filePath: string, ref: string) => Promise<string | null>;
  decidePolicyForJob: (repository: string, content: string | null, sha: string, repositoryId?: number) => PolicyDecision;
  recordPendingPolicy: (repository: string, config: LocalmostrcConfig, repositoryId?: number) => void;
  /** Tell the operator a policy is waiting for approval. */
  announce: (request: PolicyApprovalRequest) => void;
}

/**
 * Check whether a repository's .localmostrc has been approved for use.
 *
 * Returns a reason to refuse the job, or null to proceed. A repository with no
 * policy is never refused: it runs on the built-in baseline, which grants
 * nothing beyond what every job already gets.
 */
export async function checkRepoPolicyApproval(
  deps: PolicyApprovalDeps,
  owner: string,
  repo: string,
  sha?: string,
  /** github.repository_id of the job, which the approval is bound to. */
  repositoryId?: number
): Promise<string | null> {
  const repository = `${owner}/${repo}`;
  try {
    const accessToken = await deps.getAccessToken();
    if (!accessToken) {
      return `cannot check ${repository} policy: not authenticated`;
    }
    if (!sha) {
      // Without a commit there is no way to know which policy would apply.
      return `cannot check ${repository} policy: no commit SHA for this job`;
    }

    const content = await deps.getFileContent(accessToken, owner, repo, '.localmostrc', sha);
    const decision = deps.decidePolicyForJob(repository, content, sha, repositoryId);

    if (decision.action === 'allow') return null;
    if (decision.action === 'invalid') {
      return `${repository} has a .localmostrc that could not be parsed: ${decision.reason}`;
    }

    deps.recordPendingPolicy(repository, decision.request.newConfig, repositoryId);
    deps.announce(decision.request);
    if (decision.request.replacesRepositoryId !== undefined) {
      // The name's approval belongs to the repository that held it before -
      // deleted or renamed, and the name taken since. Only the app's approval
      // card shows the id changing and can move the approval; the CLI keeps
      // the old binding, so it is not offered here.
      return `${repository} is now a different repository from the one its .localmostrc was approved for. Review it in Settings > Job Security before approving it for this one.`;
    }
    return decision.request.isNewRepo
      ? `${repository} has a .localmostrc that has not been approved. Review and approve it in Settings > Job Security, or run "localmost policy approve" in a clone of the repository.`
      : `${repository} .localmostrc changed since it was approved. Review and approve it in Settings > Job Security, or run "localmost policy approve" in a clone of the repository.`;
  } catch (err) {
    // Fail closed: an unverifiable policy must not be applied silently.
    return `could not verify ${repository} policy: ${(err as Error).message}`;
  }
}
