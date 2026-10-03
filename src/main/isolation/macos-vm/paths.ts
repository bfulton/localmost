/**
 * The macOS VM mode's identifiers and host paths, the same layout the helper
 * derives (native/localmost-macvm/Sources/MacVMCore/Layout.swift):
 *
 *   <data>/macos-vm/ipsw/<build>.ipsw        restore images, downloaded here
 *   <data>/macos-vm/images/<imageId>/        one golden image
 *   <data>/macos-vm/images/<imageId>/slot<n> one slot's saved state and the disk it goes with
 *   <data>/macos-vm/images/current.json      which image is the golden one, and how it was built
 *   <data>/macos-vm/vms/<vmId>/              one job VM's clones, socket and pid file
 *   <data>/macos-vm/slots/<1|2>.lock         the two macOS VM slots
 *   <data>/macos-vm/bootstrap/<imageId>/     what the one-time setup copies into the guest
 *
 * Every path is built here from ids checked against their form first, and
 * every removal asserts the exact form of what it removes: a VM directory is
 * the helper's, but `<data>` comes from the app, and a wrong join must throw,
 * never delete.
 */

import * as crypto from 'crypto';
import * as path from 'path';

/** A golden image: 12 lowercase hex. */
export const IMAGE_ID_RE = /^[0-9a-f]{12}$/;

/** A job VM: its slot, 1 or 2, and 12 hex of its own. */
export const MAC_VM_ID_RE = /^[12]-[0-9a-f]{12}$/;

/** A restore image's file name in ipsw/: a build, as VZ reports it, and `.ipsw`. */
export const IPSW_NAME_RE = /^[0-9A-Za-z]{3,16}\.ipsw$/;

/** The two macOS VMs a Mac may run at once. */
export const MAC_VM_SLOTS = [1, 2] as const;

const electronApp = (): Electron.App => (require('electron') as typeof import('electron')).app;

/** The helper and the guest agent, in Resources when packaged and in build/ otherwise. */
export const MACVM_HELPER_NAME = 'localmost-macvm';
export const MACVM_AGENT_NAME = 'localmost-macvm-agent';

/**
 * Replaces the helper's path in a development or test run, so that the fake
 * helper can stand in. A packaged app ignores it.
 */
export const MACVM_HELPER_OVERRIDE_ENV = 'LOCALMOST_MACVM_HELPER';

function requireForm(value: string, form: RegExp, what: string): string {
  if (typeof value !== 'string' || !form.test(value)) {
    throw new Error(`not a ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}

function requireAbsolute(dir: string, what: string): string {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || path.normalize(dir) !== dir || (dir.endsWith('/') && dir !== '/')) {
    throw new Error(`${what} must be a plain absolute path: ${JSON.stringify(dir)}`);
  }
  return dir;
}

export const newImageId = (): string => crypto.randomBytes(6).toString('hex');

export function newMacVmId(slot: number): string {
  if (!MAC_VM_SLOTS.includes(slot as 1 | 2)) {
    throw new Error(`macOS VM slot ${slot} is not 1 or 2`);
  }
  return `${slot}-${crypto.randomBytes(6).toString('hex')}`;
}

export interface MacVmLayout {
  root: string;
  ipswDir: string;
  imagesDir: string;
  currentFile: string;
  vmsDir: string;
  slotsDir: string;
  bootstrapDir: string;
}

/** The layout under `<data>`, which the caller passes realpathed. */
export function macVmLayout(dataDir: string): MacVmLayout {
  const root = path.join(requireAbsolute(dataDir, 'the data directory'), 'macos-vm');
  return {
    root,
    ipswDir: path.join(root, 'ipsw'),
    imagesDir: path.join(root, 'images'),
    currentFile: path.join(root, 'images', 'current.json'),
    vmsDir: path.join(root, 'vms'),
    slotsDir: path.join(root, 'slots'),
    bootstrapDir: path.join(root, 'bootstrap'),
  };
}

export function imageDir(dataDir: string, imageId: string): string {
  return path.join(macVmLayout(dataDir).imagesDir, requireForm(imageId, IMAGE_ID_RE, 'golden image id'));
}

/** `<image>/slot<n>`: made by Electron, filled by the helper's save-state. */
export function slotDir(dataDir: string, imageId: string, slot: number): string {
  if (!MAC_VM_SLOTS.includes(slot as 1 | 2)) throw new Error(`macOS VM slot ${slot} is not 1 or 2`);
  return path.join(imageDir(dataDir, imageId), `slot${slot}`);
}

export function vmDir(dataDir: string, vmId: string): string {
  return path.join(macVmLayout(dataDir).vmsDir, requireForm(vmId, MAC_VM_ID_RE, 'macOS VM id'));
}

export function bootstrapDir(dataDir: string, imageId: string): string {
  return path.join(macVmLayout(dataDir).bootstrapDir, requireForm(imageId, IMAGE_ID_RE, 'golden image id'));
}

export function ipswPath(dataDir: string, name: string): string {
  return path.join(macVmLayout(dataDir).ipswDir, requireForm(name, IPSW_NAME_RE, 'restore image name'));
}

/** The slot a macOS VM id was made for. */
export function macVmIdSlot(vmId: string): 1 | 2 {
  return Number(requireForm(vmId, MAC_VM_ID_RE, 'macOS VM id').slice(0, 1)) as 1 | 2;
}

/**
 * Throws unless `target` is exactly `<root>/<dir>/<name>` with `name` of the
 * given form: the one check before anything under macos-vm/ is removed.
 */
export function assertRemovable(dataDir: string, target: string, dir: 'images' | 'vms' | 'bootstrap' | 'ipsw', form: RegExp): void {
  const parent = path.join(macVmLayout(dataDir).root, dir);
  if (typeof target !== 'string' || path.dirname(target) !== parent || !form.test(path.basename(target))) {
    throw new Error(`refusing to remove ${JSON.stringify(target)}: not ${parent}/<${form.source}>`);
  }
}

/**
 * `<resources>`: the app's Resources when packaged, else the checkout's
 * build/, where build:macvm puts the helper and the agent.
 */
export function macVmResourcesDir(): string {
  if (electronApp().isPackaged) {
    if (!process.resourcesPath) throw new Error('the packaged app has no resources path');
    return process.resourcesPath;
  }
  const appPath = path.resolve(electronApp().getAppPath());
  const parent = path.dirname(appPath);
  if (path.basename(appPath) === 'dist' && path.basename(parent) === 'build') return parent;
  return path.join(appPath, 'build');
}

/** The helper: the one path the spawn, the profile and the sweep use. */
export function macVmHelperPath(): string {
  const override = process.env[MACVM_HELPER_OVERRIDE_ENV];
  if (!electronApp().isPackaged && override) {
    return requireAbsolute(override, MACVM_HELPER_OVERRIDE_ENV);
  }
  return path.join(macVmResourcesDir(), MACVM_HELPER_NAME);
}

/** The guest agent the setup copies into the golden image. */
export function macVmAgentPath(): string {
  return path.join(macVmResourcesDir(), MACVM_AGENT_NAME);
}
