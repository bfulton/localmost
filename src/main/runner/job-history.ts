/**
 * Job History Manager
 *
 * Manages persistence and retrieval of job history.
 */

import * as fs from 'fs';
import { getJobHistoryPath } from '../paths';
import type { JobHistoryEntry } from '../../shared/types';

export interface JobHistoryOptions {
  maxHistory?: number;
  onUpdate?: (jobs: JobHistoryEntry[]) => void;
}

const DEFAULT_MAX_HISTORY = 100;

/**
 * Manages job history persistence.
 */
export class JobHistoryManager {
  private jobs: JobHistoryEntry[] = [];
  private maxHistory: number;
  private filePath: string;
  private onUpdate?: (jobs: JobHistoryEntry[]) => void;
  private jobIdCounter = 0;

  constructor(options: JobHistoryOptions = {}) {
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.filePath = getJobHistoryPath();
    this.onUpdate = options.onUpdate;
    this.load();
  }

  /**
   * Load job history from disk.
   */
  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        if (Array.isArray(data.jobs)) {
          this.jobs = data.jobs;

          // Mark stale "running" jobs as failed
          let staleCount = 0;
          for (const job of this.jobs) {
            if (job.status === 'running') {
              job.status = 'failed';
              job.error = 'Job was interrupted (app restart)';
              staleCount++;
            }
          }

          // Extract highest job ID
          for (const job of this.jobs) {
            const match = job.id.match(/job-(\d+)/);
            if (match) {
              const id = parseInt(match[1], 10);
              if (id > this.jobIdCounter) {
                this.jobIdCounter = id;
              }
            }
          }

          if (staleCount > 0) {
            this.save();
          }
        }
      }
    } catch {
      this.jobs = [];
    }
  }

  /**
   * Save job history to disk.
   */
  private save(): void {
    try {
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify({ jobs: this.jobs }, null, 2));
    } catch {
      // Ignore write errors
    }
  }

  /**
   * Generate a new unique job ID.
   */
  generateJobId(): string {
    return `job-${++this.jobIdCounter}`;
  }

  /**
   * Get all job history entries.
   */
  getAll(): JobHistoryEntry[] {
    return [...this.jobs];
  }

  /**
   * Add a job to history.
   */
  add(job: JobHistoryEntry): void {
    this.jobs.unshift(job);
    this.trimToMax();
    this.save();
    this.onUpdate?.(this.jobs);
  }

  /**
   * Update a job in history.
   */
  update(jobId: string, updates: Partial<JobHistoryEntry>): void {
    const job = this.jobs.find(j => j.id === jobId);
    if (job) {
      Object.assign(job, updates);

      // Calculate duration when job completes
      if (updates.status && updates.status !== 'running' && job.startedAt) {
        const startTime = new Date(job.startedAt).getTime();
        const endTime = updates.completedAt
          ? new Date(updates.completedAt).getTime()
          : Date.now();
        job.duration = Math.round((endTime - startTime) / 1000);
      }

      this.save();
      this.onUpdate?.(this.jobs);
    }
  }

  /**
   * Get a job by ID.
   */
  get(jobId: string): JobHistoryEntry | undefined {
    return this.jobs.find(j => j.id === jobId);
  }

  /**
   * Set maximum history size.
   */
  setMaxHistory(max: number): void {
    this.maxHistory = max;
    this.trimToMax();
  }

  /**
   * Trim history to maximum size.
   */
  private trimToMax(): void {
    if (this.jobs.length > this.maxHistory) {
      this.jobs = this.jobs.slice(0, this.maxHistory);
    }
  }

  /**
   * Clear all history.
   */
  clear(): void {
    this.jobs = [];
    this.save();
    this.onUpdate?.(this.jobs);
  }
}
