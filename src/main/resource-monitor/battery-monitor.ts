/**
 * BatteryMonitor - Monitors battery state for resource-aware scheduling.
 *
 * Uses Electron's powerMonitor to detect:
 * - Whether running on battery vs AC power
 * - Battery level (via shell command on macOS)
 */

import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { powerMonitor } from 'electron';
import { BatteryPauseThreshold } from '../../shared/types';

export interface BatteryState {
  isOnBattery: boolean;
  batteryLevel: number | null; // 0-100, null if unknown
}

interface BatteryMonitorEvents {
  'state-changed': (state: BatteryState) => void;
}

export class BatteryMonitor extends EventEmitter {
  private state: BatteryState = {
    isOnBattery: false,
    batteryLevel: null,
  };
  private levelCheckInterval: NodeJS.Timeout | null = null;
  private started = false;

  constructor() {
    super();
  }

  /**
   * Start monitoring battery state.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Get initial state
    this.state.isOnBattery = powerMonitor.isOnBatteryPower();
    this.checkBatteryLevel();

    // Listen for power state changes
    powerMonitor.on('on-battery', this.handleOnBattery);
    powerMonitor.on('on-ac', this.handleOnAC);

    // Check battery level periodically (every 60s)
    this.levelCheckInterval = setInterval(() => {
      this.checkBatteryLevel();
    }, 60000);
  }

  /**
   * Stop monitoring battery state.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    powerMonitor.off('on-battery', this.handleOnBattery);
    powerMonitor.off('on-ac', this.handleOnAC);

    if (this.levelCheckInterval) {
      clearInterval(this.levelCheckInterval);
      this.levelCheckInterval = null;
    }
  }

  /**
   * Get current battery state.
   */
  getState(): BatteryState {
    return { ...this.state };
  }

  /**
   * Check if we should pause based on battery threshold setting.
   */
  shouldPause(threshold: BatteryPauseThreshold): boolean {
    if (threshold === 'no') return false;
    if (!this.state.isOnBattery) return false;

    // If we're on battery, check level threshold
    const level = this.state.batteryLevel;
    if (level === null) {
      // Unknown level but on battery - be conservative and pause
      return true;
    }

    switch (threshold) {
      case '<25%':
        return level < 25;
      case '<50%':
        return level < 50;
      case '<75%':
        return level < 75;
      default:
        return false;
    }
  }

  /**
   * Get human-readable reason for pause.
   */
  getPauseReason(threshold: BatteryPauseThreshold): string | null {
    if (!this.shouldPause(threshold)) return null;

    const level = this.state.batteryLevel;
    if (level !== null) {
      return `Battery at ${level}%`;
    }
    return 'Running on battery';
  }

  private handleOnBattery = (): void => {
    this.state.isOnBattery = true;
    this.checkBatteryLevel(); // Get fresh level
    this.emit('state-changed', this.getState());
  };

  private handleOnAC = (): void => {
    this.state.isOnBattery = false;
    this.emit('state-changed', this.getState());
  };

  /**
   * Check battery level using macOS pmset command.
   */
  private checkBatteryLevel(): void {
    exec("pmset -g batt | grep -Eo '\\d+%' | head -1 | tr -d '%'", (error, stdout) => {
      if (error) {
        // Likely a desktop Mac with no battery
        this.state.batteryLevel = null;
        return;
      }

      const level = parseInt(stdout.trim(), 10);
      if (!isNaN(level) && level >= 0 && level <= 100) {
        const prevLevel = this.state.batteryLevel;
        this.state.batteryLevel = level;

        // Only emit if level changed significantly (by 5% or crossed threshold)
        if (prevLevel === null || Math.abs(level - prevLevel) >= 5) {
          this.emit('state-changed', this.getState());
        }
      }
    });
  }

  // Type-safe event emitter methods
  on<K extends keyof BatteryMonitorEvents>(
    event: K,
    listener: BatteryMonitorEvents[K]
  ): this {
    return super.on(event, listener);
  }

  emit<K extends keyof BatteryMonitorEvents>(
    event: K,
    ...args: Parameters<BatteryMonitorEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}
