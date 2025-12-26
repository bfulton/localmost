/**
 * ResourceMonitor - Orchestrates resource-aware scheduling.
 *
 * Monitors battery and video call state, and emits events when
 * the runner should pause or resume based on resource conditions.
 */

import { EventEmitter } from 'events';
import { Notification } from 'electron';
import { BatteryMonitor } from './battery-monitor';
import { VideoCallMonitor } from './video-call-monitor';
import {
  PowerConfig,
  DEFAULT_POWER_CONFIG,
  ResourceCondition,
  ResourcePauseState,
} from '../../shared/types';

/** Configuration for the ResourceMonitor */
export interface ResourceMonitorConfig extends PowerConfig {
  /** Show notifications when pausing/resuming (from NotificationsConfig) */
  notifyOnPause?: boolean;
}

const DEFAULT_RESOURCE_MONITOR_CONFIG: ResourceMonitorConfig = {
  ...DEFAULT_POWER_CONFIG,
  notifyOnPause: false,
};

interface ResourceMonitorEvents {
  'should-pause': (reason: string) => void;
  'should-resume': () => void;
  'state-changed': (state: ResourcePauseState) => void;
}

export class ResourceMonitor extends EventEmitter {
  private batteryMonitor: BatteryMonitor;
  private videoCallMonitor: VideoCallMonitor;
  private config: ResourceMonitorConfig;
  private isPaused = false;
  private pauseReason: string | null = null;
  private conditions: ResourceCondition[] = [];
  private started = false;

  constructor(config: Partial<ResourceMonitorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_RESOURCE_MONITOR_CONFIG, ...config };
    this.batteryMonitor = new BatteryMonitor();
    this.videoCallMonitor = new VideoCallMonitor(this.config.videoCallGracePeriod);
  }

  /**
   * Update configuration. Can be called while running.
   */
  updateConfig(config: Partial<ResourceMonitorConfig>): void {
    this.config = { ...this.config, ...config };

    // Update video call grace period if changed
    if (config.videoCallGracePeriod !== undefined) {
      this.videoCallMonitor.setGracePeriod(config.videoCallGracePeriod);
    }

    // Re-evaluate conditions with new config
    if (this.started) {
      this.evaluateConditions();
    }
  }

  /**
   * Get current configuration.
   */
  getConfig(): ResourceMonitorConfig {
    return { ...this.config };
  }

  /**
   * Start monitoring resources.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Set up battery monitor
    this.batteryMonitor.on('state-changed', () => {
      this.evaluateConditions();
    });

    // Set up video call monitor
    this.videoCallMonitor.on('state-changed', () => {
      this.evaluateConditions();
    });

    // Start monitors
    this.batteryMonitor.start();
    this.videoCallMonitor.start();

    // Initial evaluation
    this.evaluateConditions();
  }

  /**
   * Stop monitoring resources.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    this.batteryMonitor.stop();
    this.videoCallMonitor.stop();
  }

  /**
   * Get current pause state.
   */
  getPauseState(): ResourcePauseState {
    return {
      isPaused: this.isPaused,
      reason: this.pauseReason,
      conditions: [...this.conditions],
    };
  }

  /**
   * Check if any resource condition recommends pausing.
   */
  shouldPause(): boolean {
    return this.isPaused;
  }

  /**
   * Evaluate all conditions and determine if we should pause/resume.
   */
  private evaluateConditions(): void {
    const newConditions: ResourceCondition[] = [];
    const now = new Date().toISOString();

    // Check battery condition
    if (this.config.pauseOnBattery !== 'never') {
      const shouldPauseBattery = this.batteryMonitor.shouldPause(this.config.pauseOnBattery);
      const batteryReason = this.batteryMonitor.getPauseReason(this.config.pauseOnBattery);

      newConditions.push({
        type: 'battery',
        active: shouldPauseBattery,
        reason: batteryReason || 'Battery check',
        since: shouldPauseBattery ? now : undefined,
      });
    }

    // Check video call condition
    if (this.config.pauseOnVideoCall) {
      const shouldPauseVideo = this.videoCallMonitor.shouldPause();
      const videoReason = this.videoCallMonitor.getPauseReason();

      newConditions.push({
        type: 'video-call',
        active: shouldPauseVideo,
        reason: videoReason || 'Video call check',
        since: shouldPauseVideo ? now : undefined,
      });
    }

    this.conditions = newConditions;

    // Determine if we should be paused (any active condition)
    const activeConditions = newConditions.filter((c) => c.active);
    const shouldBePaused = activeConditions.length > 0;

    // Get the highest priority reason (battery > video-call)
    const priorityOrder: ResourceCondition['type'][] = ['battery', 'video-call'];
    let newReason: string | null = null;

    for (const type of priorityOrder) {
      const condition = activeConditions.find((c) => c.type === type);
      if (condition) {
        newReason = condition.reason;
        break;
      }
    }

    // Check if state changed
    const stateChanged = this.isPaused !== shouldBePaused;
    const reasonChanged = this.pauseReason !== newReason;

    if (stateChanged || reasonChanged) {
      const wasPaused = this.isPaused;
      this.isPaused = shouldBePaused;
      this.pauseReason = newReason;

      // Emit state change
      this.emit('state-changed', this.getPauseState());

      // Emit pause/resume events
      if (shouldBePaused && !wasPaused) {
        this.emit('should-pause', newReason || 'Resource constraint');
        this.showNotification('Runner paused', newReason || 'Resource constraint detected');
      } else if (!shouldBePaused && wasPaused) {
        this.emit('should-resume');
        this.showNotification('Runner resumed', 'Resource constraints cleared');
      }
    }
  }

  /**
   * Show a notification if enabled in config.
   */
  private showNotification(title: string, body: string): void {
    if (!this.config.notifyOnPause) return;

    try {
      const notification = new Notification({
        title,
        body,
        silent: true,
      });
      notification.show();
    } catch {
      // Notifications may fail in some environments - non-fatal
    }
  }

  // Type-safe event emitter methods
  on<K extends keyof ResourceMonitorEvents>(
    event: K,
    listener: ResourceMonitorEvents[K]
  ): this {
    return super.on(event, listener);
  }

  emit<K extends keyof ResourceMonitorEvents>(
    event: K,
    ...args: Parameters<ResourceMonitorEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}

export { BatteryMonitor } from './battery-monitor';
export { VideoCallMonitor } from './video-call-monitor';
