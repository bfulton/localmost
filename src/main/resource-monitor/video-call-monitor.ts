/**
 * VideoCallMonitor - Detects active video calls via camera usage.
 *
 * Uses macOS system commands to check if the camera is in use.
 * Implements a grace period before resuming after a call ends.
 */

import { EventEmitter } from 'events';
import { exec } from 'child_process';

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
  private checkInterval: NodeJS.Timeout | null = null;
  private gracePeriodTimer: NodeJS.Timeout | null = null;
  private gracePeriodSeconds: number;
  private started = false;

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
   * Start monitoring for video calls.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Check immediately
    this.checkCameraUsage();

    // Check every 5 seconds
    this.checkInterval = setInterval(() => {
      this.checkCameraUsage();
    }, 5000);
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

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
   * Check if camera is in use using macOS commands.
   */
  private checkCameraUsage(): void {
    // Check for camera usage via lsof - looks for processes accessing camera devices
    // VDCAssistant is the macOS camera daemon
    exec("lsof 2>/dev/null | grep -E 'VDCAssistant|AppleCamera' | wc -l", (error, stdout) => {
      if (error) {
        // Can't determine camera state - assume not in use
        this.handleCameraState(false);
        return;
      }

      const count = parseInt(stdout.trim(), 10);
      this.handleCameraState(count > 0);
    });
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
    } else if (inUse && wasInUse) {
      // Still in a call - reset grace period timer if one was started
      if (this.gracePeriodTimer) {
        clearTimeout(this.gracePeriodTimer);
        this.gracePeriodTimer = null;
        this.state.inGracePeriod = false;
        this.state.gracePeriodEndsAt = null;
        this.emit('state-changed', this.getState());
      }
    }
    // If !inUse && !wasInUse, no change needed
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
