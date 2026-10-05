/**
 * What this Mac can do for the macOS VM mode: its macOS, its chip, its
 * memory, and so how many macOS VMs it runs at once and how it provisions a
 * golden image. See docs/roadmap/macos-vm-jobs.md ("Availability").
 */

import { execFileSync } from 'child_process';
import * as os from 'os';

/** The size of every job VM, and of the saved states they restore: VZ restores a state only into its own shape. */
export const JOB_VM_CPUS = 4;
export const JOB_VM_MEMORY_MIB = 6144;

/** The golden disk's length. Sparse: it costs what macOS, the tools and a job write, not this. */
export const GOLDEN_DISK_GIB = 100;

/** What the host keeps for itself before it counts a VM's memory. */
export const HOST_MEMORY_RESERVE_BYTES = 4 * 2 ** 30;

/** The most macOS VMs a Mac may run at once: the macOS licence and VZ's own limit. */
export const MAX_MAC_VMS = 2;

export interface HostInfo {
  platform: string;
  arch: string;
  /** os.release(): the Darwin version. */
  darwin: string;
  /** kern.osversion: `25G83`. */
  build: string;
  totalMemoryBytes: number;
}

export function currentHost(): HostInfo {
  let build = '';
  try {
    build = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.osversion'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    // Unknown; the build matters only for saved states.
  }
  return { platform: process.platform, arch: process.arch, darwin: os.release(), build, totalMemoryBytes: os.totalmem() };
}

/** The macOS major release of a Darwin version: Darwin 23 is macOS 14, 25 is 26, 26 is 27. */
export function macosMajorOf(darwin: string): number | null {
  const major = Number(/^(\d+)\./.exec(darwin)?.[1]);
  if (!Number.isInteger(major)) return null;
  if (major >= 20 && major <= 24) return major - 9;
  if (major >= 25) return major + 1;
  return null;
}

/**
 * Why this Mac cannot run the macOS VM mode at all, or null: Apple silicon
 * (VZ runs macOS guests nowhere else), macOS 14 or later (save and restore
 * of a VM's state, which every job start relies on), and memory for one VM.
 */
export function hostRefusal(host: HostInfo): string | null {
  if (host.platform !== 'darwin' || host.arch !== 'arm64') return 'macOS VMs need a Mac with Apple silicon';
  const major = macosMajorOf(host.darwin);
  if (major === null || major < 14) return 'macOS VMs need macOS 14 or later on this Mac';
  if (concurrentVmLimit(host.totalMemoryBytes) < 1) {
    return `a macOS VM needs ${JOB_VM_MEMORY_MIB / 1024} GiB of memory beyond the ${HOST_MEMORY_RESERVE_BYTES / 2 ** 30} GiB this Mac keeps for itself`;
  }
  return null;
}

/** How many job VMs fit this Mac's memory at once, at most two. */
export function concurrentVmLimit(totalMemoryBytes: number): number {
  const fit = Math.floor((totalMemoryBytes - HOST_MEMORY_RESERVE_BYTES) / (JOB_VM_MEMORY_MIB * 2 ** 20));
  return Math.max(0, Math.min(MAX_MAC_VMS, fit));
}

/**
 * How the golden image's first boot is set up: headless with macOS 27's
 * guest provisioning when both the host and the helper can, else the guided
 * setup in a window.
 */
export function provisioningMode(host: HostInfo, helperHasProvisioning: boolean): 'headless' | 'guided' {
  const major = macosMajorOf(host.darwin);
  return major !== null && major >= 27 && helperHasProvisioning ? 'headless' : 'guided';
}
