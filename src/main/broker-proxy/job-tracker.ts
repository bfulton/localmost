/**
 * Job Tracker
 *
 * Tracks job assignments and associated metadata for the broker proxy.
 */

import { getLogger } from '../app-state';

const log = () => getLogger();

/** Job assignment tracking */
export interface JobAssignment {
  jobId: string;
  targetId: string;
  sessionId: string;
  workerId?: number;
  assignedAt: Date;
}

/** Job info from upstream (billing, run service URL) */
export interface JobInfo {
  billingOwnerId?: string;
  runServiceUrl: string;
}

/** GitHub-specific job information */
export interface GitHubJobInfo {
  githubRunId?: number;
  githubJobId?: number;
  githubRepo?: string;
  githubActor?: string;
}

/**
 * Tracks job assignments and metadata for the broker proxy.
 */
export class JobTracker {
  private jobAssignments: Map<string, JobAssignment> = new Map();
  private jobRunServiceUrls: Map<string, string> = new Map();
  private acquiredJobDetails: Map<string, string> = new Map();
  private jobInfo: Map<string, JobInfo> = new Map();

  /**
   * Check if a job has already been assigned.
   */
  hasJob(jobId: string): boolean {
    return this.jobAssignments.has(jobId);
  }

  /**
   * Track a new job assignment.
   */
  trackJob(assignment: JobAssignment): void {
    this.jobAssignments.set(assignment.jobId, assignment);
    log()?.debug(`[JobTracker] Tracking job ${assignment.jobId} for target ${assignment.targetId}`);
  }

  /**
   * Get a job assignment by job ID.
   */
  getJob(jobId: string): JobAssignment | undefined {
    return this.jobAssignments.get(jobId);
  }

  /**
   * Remove a job assignment.
   */
  removeJob(jobId: string): void {
    this.jobAssignments.delete(jobId);
    this.jobRunServiceUrls.delete(jobId);
    this.acquiredJobDetails.delete(jobId);
  }

  /**
   * Store the run service URL for a job.
   */
  setRunServiceUrl(jobId: string, url: string): void {
    this.jobRunServiceUrls.set(jobId, url);
  }

  /**
   * Get the run service URL for a job.
   */
  getRunServiceUrl(jobId: string): string | undefined {
    return this.jobRunServiceUrls.get(jobId);
  }

  /**
   * Store acquired job details (the full response from acquireJob).
   */
  setAcquiredJobDetails(jobId: string, details: string): void {
    this.acquiredJobDetails.set(jobId, details);
  }

  /**
   * Get acquired job details.
   */
  getAcquiredJobDetails(jobId: string): string | undefined {
    return this.acquiredJobDetails.get(jobId);
  }

  /**
   * Store job info (billing owner, run service URL) by message ID.
   */
  setJobInfo(messageId: string, info: JobInfo): void {
    this.jobInfo.set(messageId, info);
  }

  /**
   * Get job info by message ID.
   */
  getJobInfo(messageId: string): JobInfo | undefined {
    return this.jobInfo.get(messageId);
  }

  /**
   * Clear job info by message ID.
   */
  clearJobInfo(messageId: string): void {
    this.jobInfo.delete(messageId);
  }

  /**
   * Get all active job assignments.
   */
  getAllJobs(): JobAssignment[] {
    return Array.from(this.jobAssignments.values());
  }

  /**
   * Get jobs for a specific target.
   */
  getJobsForTarget(targetId: string): JobAssignment[] {
    return this.getAllJobs().filter(job => job.targetId === targetId);
  }

  /**
   * Get the count of active jobs.
   */
  getJobCount(): number {
    return this.jobAssignments.size;
  }

  /**
   * Clear all job tracking data for a target.
   */
  clearTarget(targetId: string): void {
    for (const [jobId, assignment] of this.jobAssignments) {
      if (assignment.targetId === targetId) {
        this.removeJob(jobId);
      }
    }
  }

  /**
   * Clear all job tracking data.
   */
  clearAll(): void {
    this.jobAssignments.clear();
    this.jobRunServiceUrls.clear();
    this.acquiredJobDetails.clear();
    this.jobInfo.clear();
  }
}
