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
  /** A reason to refuse the job for its repository's policy, or null to proceed. */
  checkPolicyApproval: (owner: string, repo: string, sha?: string) => Promise<string | null>;
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
      runnerManager.recordRefusedJob({
        repository: target.displayName,
        jobName: githubInfo.githubJobId ? `job ${githubInfo.githubJobId}` : jobId,
        reason,
        actionsUrl,
        githubRunId: githubInfo.githubRunId,
      });
      if (owner && repo && githubInfo.githubRunId) {
        await runnerManager.cancelRun(owner, repo, githubInfo.githubRunId, reason);
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
        refusal = verdict.allowed ? await deps.checkPolicyApproval(owner, repo, githubInfo.githubSha) : verdict.reason;
      }
    } catch (err) {
      refusal = `could not decide whether job ${jobId} may run: ${(err as Error).message}`;
    }
    if (refusal) {
      await refuse(refusal);
      return;
    }

    log('info', `Spawning worker for job ${jobId} from ${target.displayName}...`);
    runnerManager.setPendingTargetContext('next', targetId, target.displayName, actionsUrl, githubInfo.githubRunId, githubInfo.githubJobId, githubInfo.githubActor, githubInfo.githubSha, githubInfo.githubRef, githubInfo.githubWorkflow, jobId);

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
