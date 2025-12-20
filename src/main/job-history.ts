/**
 * Job history management for tracking completed workflow jobs.
 * Extracted from runner-manager.ts for better separation of concerns.
 */

import * as fs from 'fs';
import * as path from 'path';
import { JobHistoryEntry } from '../shared/types';

export type LogCallback = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
export type HistoryUpdateCallback = (jobs: JobHistoryEntry[]) => void;

export class JobHistoryManager {
  private history: JobHistoryEntry[] = [];
  private maxHistory: number;
  private historyPath: string;
  private onUpdate: HistoryUpdateCallback;
  private log: LogCallback;

  constructor(options: {
    baseDir: string;
    maxHistory?: number;
    onUpdate: HistoryUpdateCallback;
    onLog: LogCallback;
  }) {
    this.historyPath = path.join(options.baseDir, 'job-history.json');
    this.maxHistory = options.maxHistory || 100;
    this.onUpdate = options.onUpdate;
    this.log = options.onLog;
  }

  /**
   * Load job history from disk.
   */
  load(): void {
    try {
      if (fs.existsSync(this.historyPath)) {
        const data = fs.readFileSync(this.historyPath, 'utf-8');
        this.history = JSON.parse(data);
        this.log('debug', `Loaded ${this.history.length} jobs from history`);
      }
    } catch (loadErr) {
      this.log('warn', `Failed to load job history: ${(loadErr as Error).message}`);
      this.history = [];
    }
  }

  /**
   * Save job history to disk.
   */
  save(): void {
    try {
      const dir = path.dirname(this.historyPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.historyPath, JSON.stringify(this.history, null, 2));
    } catch (saveErr) {
      this.log('error', `Failed to save job history: ${(saveErr as Error).message}`);
    }
  }

  /**
   * Add a new job to history.
   */
  add(job: JobHistoryEntry): void {
    this.log('debug', `Adding job to history: ${job.id} (${job.jobName})`);
    this.history.push(job);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
    this.save();
    this.onUpdate([...this.history]);
  }

  /**
   * Update an existing job in history.
   */
  update(jobId: string, updates: Partial<JobHistoryEntry>): void {
    const job = this.history.find((j) => j.id === jobId);
    if (job) {
      this.log('debug', `Updating job ${jobId}: ${JSON.stringify(updates)}`);
      Object.assign(job, updates);
      this.save();
      this.onUpdate([...this.history]);
    } else {
      this.log(
        'warn',
        `Could not find job ${jobId} to update. History has ${this.history.length} jobs: ${this.history.map(j => j.id).join(', ')}`
      );
    }
  }

  /**
   * Get all jobs in history.
   */
  getAll(): JobHistoryEntry[] {
    return [...this.history];
  }

  /**
   * Find a job by ID.
   */
  find(jobId: string): JobHistoryEntry | undefined {
    return this.history.find((j) => j.id === jobId);
  }

  /**
   * Clear all history.
   */
  clear(): void {
    this.history = [];
    this.save();
    this.onUpdate([]);
  }
}
