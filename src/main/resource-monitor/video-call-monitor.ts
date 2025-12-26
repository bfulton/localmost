/**
 * VideoCallMonitor - Detects active video calls via camera usage.
 *
 * Uses the is-camera-on package for reliable native camera detection.
 * Implements a grace period before resuming after a call ends.
 */

import { EventEmitter } from 'events';

export interface VideoCallState {
  isCameraInUse: boolean;
  inGracePeriod: boolean;
  gracePeriodEndsAt: string | null; // ISO timestamp
}

interface VideoCallMonitorEvents {
  'state-changed': (state: VideoCallState) => void;
}

export class VideoCallMonitor extends EventEmitter {
  private state: VideoCallState = {
    isCameraInUse: false,
    inGracePeriod: false,
    gracePeriodEndsAt: null,
  };
  private gracePeriodTimer: NodeJS.Timeout | null = null;
  private gracePeriodSeconds: number;
  private started = false;
  private abortController: AbortController | null = null;

  constructor(gracePeriodSeconds: number = 60) {
    super();
    this.gracePeriodSeconds = gracePeriodSeconds;
  }

  /**
   * Update grace period duration. Resets any active grace period.
   */
  setGracePeriod(seconds: number): void {
    this.gracePeriodSeconds = seconds;
  }

  /**
   * Start monitoring for video calls using native camera detection.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.abortController = new AbortController();
    this.startCameraMonitoring();
  }

  /**
   * Start async camera monitoring loop.
   */
  private async startCameraMonitoring(): Promise<void> {
    try {
      // Dynamic import for ESM package
      const { isCameraOnChanges } = await import('is-camera-on');

      for await (const isOn of isCameraOnChanges()) {
        // Check if we've been stopped
        if (!this.started || this.abortController?.signal.aborted) {
          break;
        }
        this.handleCameraState(isOn);
      }
    } catch (error) {
      // If is-camera-on fails (non-macOS, etc.), log and continue without video detection
      console.warn('Video call detection unavailable:', (error as Error).message);
    }
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    // Signal the async iterator to stop
    this.abortController?.abort();
    this.abortController = null;

    if (this.gracePeriodTimer) {
      clearTimeout(this.gracePeriodTimer);
      this.gracePeriodTimer = null;
    }
  }

  /**
   * Get current video call state.
   */
  getState(): VideoCallState {
    return { ...this.state };
  }

  /**
   * Check if we should pause (camera in use or in grace period).
   */
  shouldPause(): boolean {
    return this.state.isCameraInUse || this.state.inGracePeriod;
  }

  /**
   * Get human-readable reason for pause.
   */
  getPauseReason(): string | null {
    if (this.state.isCameraInUse) {
      return 'Video call detected';
    }
    if (this.state.inGracePeriod) {
      return 'Video call ended recently';
    }
    return null;
  }

  /**
   * Handle camera state change.
   */
  private handleCameraState(inUse: boolean): void {
    const wasInUse = this.state.isCameraInUse;

    if (inUse && !wasInUse) {
      // Camera just started being used - start/extend "call"
      this.state.isCameraInUse = true;
      this.state.inGracePeriod = false;
      this.state.gracePeriodEndsAt = null;

      // Clear any existing grace period timer
      if (this.gracePeriodTimer) {
        clearTimeout(this.gracePeriodTimer);
        this.gracePeriodTimer = null;
      }

      this.emit('state-changed', this.getState());
    } else if (!inUse && wasInUse) {
      // Camera just stopped being used - start grace period
      this.state.isCameraInUse = false;
      this.startGracePeriod();
      this.emit('state-changed', this.getState());
    }
    // If state hasn't changed, no event needed
  }

  /**
   * Start the grace period after camera stops being used.
   */
  private startGracePeriod(): void {
    // Clear any existing timer
    if (this.gracePeriodTimer) {
      clearTimeout(this.gracePeriodTimer);
    }

    this.state.inGracePeriod = true;
    this.state.gracePeriodEndsAt = new Date(
      Date.now() + this.gracePeriodSeconds * 1000
    ).toISOString();

    this.gracePeriodTimer = setTimeout(() => {
      this.state.inGracePeriod = false;
      this.state.gracePeriodEndsAt = null;
      this.gracePeriodTimer = null;
      this.emit('state-changed', this.getState());
    }, this.gracePeriodSeconds * 1000);
  }

  // Type-safe event emitter methods
  on<K extends keyof VideoCallMonitorEvents>(
    event: K,
    listener: VideoCallMonitorEvents[K]
  ): this {
    return super.on(event, listener);
  }

  emit<K extends keyof VideoCallMonitorEvents>(
    event: K,
    ...args: Parameters<VideoCallMonitorEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
