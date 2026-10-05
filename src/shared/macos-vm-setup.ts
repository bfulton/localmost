/**
 * The macOS VM mode's setup, as the main process reports it and the setup
 * component (src/renderer/components/MacVmSetup.tsx) shows it: the golden
 * image's state, its build's progress, the disk it needs, and on a Mac
 * older than macOS 27 the values the guided setup asks the operator to
 * enter. See docs/roadmap/macos-vm-jobs.md.
 */

export const MACOS_VM_CHANNELS = {
  GET_STATUS: 'macos-vm:get-status',
  BUILD: 'macos-vm:build',
  CANCEL: 'macos-vm:cancel',
  OPEN_GUIDED_SETUP: 'macos-vm:open-guided-setup',
  REMOVE: 'macos-vm:remove',
  /** Main to renderer: the status, each time it changes. */
  STATUS_CHANGED: 'macos-vm:status-changed',
} as const;

export type MacVmSetupState =
  /** This Mac cannot run macOS VMs (reason says why). */
  | 'unsupported'
  /** No golden image yet. */
  | 'not-built'
  | 'building'
  /** The build waits for the operator to open the guided setup's window. */
  | 'needs-guided-setup'
  | 'ready'
  | 'failed';

export type MacVmBuildPhase = 'catalog' | 'download' | 'verify' | 'install' | 'provision' | 'setup' | 'save-state' | 'check';

export interface MacVmGuidedSetup {
  username: string;
  fullName: string;
  /** Typed by the operator into Setup Assistant once; replaced by one nobody keeps when the setup ends. */
  password: string;
  steps: string[];
  windowOpen: boolean;
}

export interface MacVmSetupStatus {
  state: MacVmSetupState;
  /** Why it is unsupported or failed. */
  reason?: string;
  phase?: MacVmBuildPhase;
  /** The phase's progress, 0-100, when it has one. */
  percent?: number;
  /** What is happening now, in a sentence. */
  step?: string;
  image?: {
    os: string;
    build: string;
    diskAllocatedBytes: number;
    /** The slots a job can run in: each has a saved state of its own. */
    slots: number[];
    /** Built on an older macOS than this Mac now runs: a rebuild is recommended. */
    stale: boolean;
  };
  disk: { freeBytes: number; neededBytes: number };
  provisioning: 'headless' | 'guided';
  guided?: MacVmGuidedSetup;
  /** A job VM is running: removing or rebuilding waits for it. */
  busy: boolean;
}

/** What the setup component asks of the main process (the preload's macosVm). */
export interface MacVmSetupApi {
  getStatus: () => Promise<MacVmSetupStatus>;
  build: () => Promise<{ success: boolean; error?: string }>;
  cancel: () => Promise<{ success: boolean; error?: string }>;
  openGuidedSetup: () => Promise<{ success: boolean; error?: string }>;
  remove: () => Promise<{ success: boolean; error?: string }>;
  onStatusChange: (callback: (status: MacVmSetupStatus) => void) => () => void;
}

/** The steps of the guided setup, with the account's values (MacVMCore/GuidedSetup.swift shows the same in the window). */
export function guidedSetupSteps(account: { username: string; fullName: string; password: string }): string[] {
  return [
    'Pick a language and a country or region. At Migration Assistant, choose Not Now.',
    'At Apple Account, choose Set Up Later, then Skip. The VM needs no Apple Account.',
    `Create the computer account exactly as follows. Full name: ${account.fullName}. Account name: ${account.username}. Password: ${account.password} (type it in both fields; leave the hint empty).`,
    'Turn off Location Services, analytics, Screen Time and Siri; any appearance will do.',
    'At the desktop, open System Settings, then General, then Sharing, and turn on Remote Login.',
    'Leave this window open. localmost connects over Remote Login, finishes the setup on its own, turns Remote Login off again and shuts the VM down; the window then closes.',
  ];
}
