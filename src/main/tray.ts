import { Tray, Menu, nativeImage } from 'electron';
import { TRAY_ANIMATION_FRAMES, TRAY_ANIMATION_INTERVAL_MS } from '../shared/constants';
import { RunnerState } from '../shared/types';
import { getLogger } from './app-state';

/**
 * Callback types for tray actions.
 */
export interface TrayCallbacks {
  onShowStatus: () => void;
  onShowSettings: () => void;
  onShowWindow: () => void;
  onHideWindow: () => void;
  onPause: () => void | Promise<void>;
  onResume: () => void | Promise<void>;
  onQuit: () => Promise<void>;
}

/**
 * Status information for tray display.
 */
export interface TrayStatusInfo {
  isAuthenticated: boolean;
  isConfigured: boolean;
  runnerStatus?: RunnerState['status'];
  isBusy: boolean;
  isSleepBlocked?: boolean;
  isPaused?: boolean;
  pauseReason?: string | null;
  isWindowVisible?: boolean;
}

/**
 * TrayManager handles the system tray icon, animations, and context menu.
 * Encapsulates all tray-related state and behavior.
 */
export class TrayManager {
  private tray: Tray | null = null;
  private callbacks: TrayCallbacks;

  // Animation state
  private busyAnimationTimer: NodeJS.Timeout | null = null;
  private busyAnimationFrame = 0;
  private busyIconFrames: Electron.NativeImage[] = [];
  private notReadyAnimationTimer: NodeJS.Timeout | null = null;
  private notReadyAnimationFrame = 0;
  private notReadyIconFrames: Electron.NativeImage[] = [];
  private pausedAnimationTimer: NodeJS.Timeout | null = null;
  private pausedAnimationFrame = 0;
  private pausedIconFrames: Electron.NativeImage[] = [];

  // Asset finder function (passed in to avoid circular dependencies)
  private findAsset: (filename: string) => string | undefined;

  constructor(
    callbacks: TrayCallbacks,
    findAsset: (filename: string) => string | undefined
  ) {
    this.callbacks = callbacks;
    this.findAsset = findAsset;
  }

  /**
   * Create and initialize the system tray icon.
   */
  create(): void {
    let icon: Electron.NativeImage;
    const trayIconPath = this.findAsset('tray-iconTemplate.png');

    if (trayIconPath) {
      icon = nativeImage.createFromPath(trayIconPath);
    } else {
      // Fallback: minimal PNG icon
      const minimalPng = 'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAQklEQVR42mNgGAWjYBSMglEwCkYBDQATAwMDw38iNDMwMDA0EKuZiYGB4T8xmhkYGBgaSDGYoGYSDSaoeTQKRgEFAABX2wgPnpmT0AAAAABJRU5ErkJggg==';
      try {
        icon = nativeImage.createFromDataURL(`data:image/png;base64,${minimalPng}`);
      } catch {
        icon = nativeImage.createEmpty();
      }
    }

    icon.setTemplateImage(true);
    this.tray = new Tray(icon);

    // On macOS, clicking the tray icon shows the context menu by default
    // No click handler needed - let the menu handle all interactions

    // Pre-load animation frames
    this.loadBusyIconFrames();
    this.loadNotReadyIconFrames();
    this.loadPausedIconFrames();
  }

  /**
   * Update the tray menu and icon based on current status.
   */
  updateMenu(status: TrayStatusInfo): void {
    if (!this.tray) return;

    getLogger()?.debug('[Tray] updateMenu: ' + JSON.stringify({
      isAuthenticated: status.isAuthenticated,
      isConfigured: status.isConfigured,
      isPaused: status.isPaused,
      isWindowVisible: status.isWindowVisible,
    }));

    // Update icon animation based on status
    this.updateIconAnimation(status);

    // Build status label
    const statusLabel = this.getStatusLabel(status);

    // Build context menu
    const menuItems: Electron.MenuItemConstructorOptions[] = [
      {
        label: statusLabel,
        enabled: false,
      },
    ];

    // Add sleep blocked indicator if active
    if (status.isSleepBlocked) {
      menuItems.push({
        label: '☕ Sleep blocked',
        enabled: false,
      });
    }

    menuItems.push({ type: 'separator' });

    // Add pause/resume option when configured
    if (status.isAuthenticated && status.isConfigured) {
      if (status.isPaused) {
        menuItems.push({
          label: '▶  Resume',
          click: () => {
            getLogger()?.info('[Tray] Resume clicked');
            this.callbacks.onResume();
          },
        });
      } else {
        menuItems.push({
          label: '⏸  Pause',
          click: () => {
            getLogger()?.info('[Tray] Pause clicked');
            this.callbacks.onPause();
          },
        });
      }
    }

    menuItems.push(
      {
        label: 'Status',
        click: () => this.callbacks.onShowStatus(),
      },
      {
        label: 'Settings...',
        click: () => this.callbacks.onShowSettings(),
      },
      { type: 'separator' }
    );

    // Show/Hide window option
    if (status.isWindowVisible) {
      menuItems.push({
        label: 'Hide localmost',
        click: () => {
          getLogger()?.info('[Tray] Hide clicked');
          this.callbacks.onHideWindow();
        },
      });
    } else {
      menuItems.push({
        label: 'Show localmost',
        click: () => {
          getLogger()?.info('[Tray] Show clicked');
          this.callbacks.onShowWindow();
        },
      });
    }

    menuItems.push({
      label: '⏻  Quit',
      click: () => this.callbacks.onQuit(),
    });

    getLogger()?.debug('[Tray] Menu items: ' + menuItems.map(m => m.label || m.type).join(', '));
    const contextMenu = Menu.buildFromTemplate(menuItems);

    this.tray.setToolTip(`localmost - ${statusLabel}`);
    this.tray.setContextMenu(contextMenu);
  }

  /**
   * Clean up resources when shutting down.
   */
  destroy(): void {
    this.stopBusyAnimation();
    this.stopNotReadyAnimation();
    this.stopPausedAnimation();
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  /**
   * Load busy animation frames from assets.
   * Loads both 1x and 2x versions for smooth Retina display animation.
   */
  private loadBusyIconFrames(): void {
    this.busyIconFrames = [];
    for (let i = 0; i < TRAY_ANIMATION_FRAMES; i++) {
      const iconPath = this.findAsset(`tray-icon-busy-${i}.png`);
      const icon2xPath = this.findAsset(`tray-icon-busy-${i}@2x.png`);
      if (iconPath) {
        const icon = nativeImage.createFromPath(iconPath);
        // Add 2x representation for Retina displays
        if (icon2xPath) {
          const icon2x = nativeImage.createFromPath(icon2xPath);
          icon.addRepresentation({ scaleFactor: 2, buffer: icon2x.toPNG() });
        }
        icon.setTemplateImage(false);
        this.busyIconFrames.push(icon);
      }
    }
  }

  /**
   * Load not-ready animation frames from assets.
   * Loads both 1x and 2x versions for smooth Retina display animation.
   */
  private loadNotReadyIconFrames(): void {
    this.notReadyIconFrames = [];
    for (let i = 0; i < TRAY_ANIMATION_FRAMES; i++) {
      const iconPath = this.findAsset(`tray-icon-notready-${i}.png`);
      const icon2xPath = this.findAsset(`tray-icon-notready-${i}@2x.png`);
      if (iconPath) {
        const icon = nativeImage.createFromPath(iconPath);
        // Add 2x representation for Retina displays
        if (icon2xPath) {
          const icon2x = nativeImage.createFromPath(icon2xPath);
          icon.addRepresentation({ scaleFactor: 2, buffer: icon2x.toPNG() });
        }
        icon.setTemplateImage(false);
        this.notReadyIconFrames.push(icon);
      }
    }
  }

  /**
   * Load paused animation frames from assets.
   * Loads both 1x and 2x versions for smooth Retina display animation.
   */
  private loadPausedIconFrames(): void {
    this.pausedIconFrames = [];
    for (let i = 0; i < TRAY_ANIMATION_FRAMES; i++) {
      const iconPath = this.findAsset(`tray-icon-paused-${i}.png`);
      const icon2xPath = this.findAsset(`tray-icon-paused-${i}@2x.png`);
      if (iconPath) {
        const icon = nativeImage.createFromPath(iconPath);
        // Add 2x representation for Retina displays
        if (icon2xPath) {
          const icon2x = nativeImage.createFromPath(icon2xPath);
          icon.addRepresentation({ scaleFactor: 2, buffer: icon2x.toPNG() });
        }
        icon.setTemplateImage(false);
        this.pausedIconFrames.push(icon);
      }
    }
  }

  /**
   * Update icon animation based on runner status.
   */
  private updateIconAnimation(status: TrayStatusInfo): void {
    const isListening = status.runnerStatus === 'listening';

    // Paused state takes priority over other animations
    if (status.isPaused) {
      this.stopBusyAnimation();
      this.stopNotReadyAnimation();
      this.startPausedAnimation();
    } else if (status.isBusy) {
      this.stopNotReadyAnimation();
      this.stopPausedAnimation();
      this.startBusyAnimation();
    } else if (isListening) {
      this.stopBusyAnimation();
      this.stopNotReadyAnimation();
      this.stopPausedAnimation();
      this.setNormalIcon();
    } else {
      this.stopBusyAnimation();
      this.stopPausedAnimation();
      this.startNotReadyAnimation();
    }
  }

  /**
   * Set the normal (non-animated) tray icon.
   */
  private setNormalIcon(): void {
    const iconPath = this.findAsset('tray-iconTemplate.png');
    if (iconPath && this.tray) {
      const icon = nativeImage.createFromPath(iconPath);
      icon.setTemplateImage(true);
      this.tray.setImage(icon);
    }
  }

  /**
   * Start the busy (running job) animation.
   */
  private startBusyAnimation(): void {
    if (this.busyAnimationTimer || !this.tray || this.busyIconFrames.length === 0) return;

    this.busyAnimationFrame = 0;
    // Show first frame immediately
    this.tray.setImage(this.busyIconFrames[0]);

    this.busyAnimationTimer = setInterval(() => {
      if (!this.tray || this.busyIconFrames.length === 0) {
        this.stopBusyAnimation();
        return;
      }
      this.busyAnimationFrame = (this.busyAnimationFrame + 1) % this.busyIconFrames.length;
      this.tray.setImage(this.busyIconFrames[this.busyAnimationFrame]);
    }, TRAY_ANIMATION_INTERVAL_MS);
  }

  /**
   * Stop the busy animation.
   */
  private stopBusyAnimation(): void {
    if (this.busyAnimationTimer) {
      clearInterval(this.busyAnimationTimer);
      this.busyAnimationTimer = null;
    }
    this.busyAnimationFrame = 0;
  }

  /**
   * Start the not-ready (offline) animation.
   */
  private startNotReadyAnimation(): void {
    if (this.notReadyAnimationTimer || !this.tray || this.notReadyIconFrames.length === 0) return;

    this.notReadyAnimationFrame = 0;
    // Show first frame immediately
    this.tray.setImage(this.notReadyIconFrames[0]);

    this.notReadyAnimationTimer = setInterval(() => {
      if (!this.tray || this.notReadyIconFrames.length === 0) {
        this.stopNotReadyAnimation();
        return;
      }
      this.notReadyAnimationFrame = (this.notReadyAnimationFrame + 1) % this.notReadyIconFrames.length;
      this.tray.setImage(this.notReadyIconFrames[this.notReadyAnimationFrame]);
    }, TRAY_ANIMATION_INTERVAL_MS);
  }

  /**
   * Stop the not-ready animation.
   */
  private stopNotReadyAnimation(): void {
    if (this.notReadyAnimationTimer) {
      clearInterval(this.notReadyAnimationTimer);
      this.notReadyAnimationTimer = null;
    }
    this.notReadyAnimationFrame = 0;
  }

  /**
   * Start the paused animation.
   */
  private startPausedAnimation(): void {
    if (this.pausedAnimationTimer || !this.tray || this.pausedIconFrames.length === 0) return;

    this.pausedAnimationFrame = 0;
    // Show first frame immediately
    this.tray.setImage(this.pausedIconFrames[0]);

    this.pausedAnimationTimer = setInterval(() => {
      if (!this.tray || this.pausedIconFrames.length === 0) {
        this.stopPausedAnimation();
        return;
      }
      this.pausedAnimationFrame = (this.pausedAnimationFrame + 1) % this.pausedIconFrames.length;
      this.tray.setImage(this.pausedIconFrames[this.pausedAnimationFrame]);
    }, TRAY_ANIMATION_INTERVAL_MS);
  }

  /**
   * Stop the paused animation.
   */
  private stopPausedAnimation(): void {
    if (this.pausedAnimationTimer) {
      clearInterval(this.pausedAnimationTimer);
      this.pausedAnimationTimer = null;
    }
    this.pausedAnimationFrame = 0;
  }

  /**
   * Get a human-readable status label for the tray menu.
   */
  private getStatusLabel(status: TrayStatusInfo): string {
    if (!status.isAuthenticated) {
      return 'GitHub: Not connected';
    }
    if (!status.isConfigured) {
      return 'Runner: Not configured';
    }

    // Show pause reason if paused
    if (status.isPaused && status.pauseReason) {
      return `⏸ ${status.pauseReason}`;
    }

    switch (status.runnerStatus) {
      case 'busy':
        return 'Job: Running';
      case 'starting':
        return 'Runner: Starting';
      case 'listening':
        return 'Runner: Listening';
      case 'error':
        return 'Runner: Error';
      case 'shutting_down':
        return 'Runner: Shutting down';
      case 'offline':
      default:
        return 'Runner: Offline';
    }
  }
}
