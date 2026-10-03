/**
 * The macOS VM helper's seatbelt profile, one per command, written to a file
 * before the helper is spawned under it.
 *
 * Each grants the helper binary and exactly the files its command touches:
 *
 *   catalog      nothing: VZ's installation service fetches the catalog
 *   inspect      the restore image, read-only
 *   install      the restore image read-only; the new image's directory and its slot's lock
 *   provision    the image's directory and its slot's lock; with a window, what AppKit
 *                needs to draw one (see below)
 *   save-state   the image's directory and its slot's lock
 *   run          the golden image read-only (it is cloned, and its state restored);
 *                the VM's own directory, its socket and its slot's lock; and
 *                two loopback ports, the job's proxy and the broker
 *   check        the golden image, read-only
 *
 * No network beyond those two ports in any profile: the provisioning VM's
 * NAT is VZ's own service's, not the helper's, and the restore image is
 * downloaded by Electron. Every path comes from vm ids and image ids through
 * paths.ts, and is escaped as the job profile escapes its paths. The caller
 * passes `<data>` realpathed.
 */

import * as path from 'path';
import { imageDir, ipswPath, macVmIdSlot, macVmLayout, vmDir, IPSW_NAME_RE } from './paths';

export type MacVmHelperCommand = 'catalog' | 'inspect' | 'install' | 'provision' | 'save-state' | 'run' | 'check';

export interface MacVmProfileOptions {
  command: MacVmHelperCommand;
  /** The helper binary: the one thing the profile lets it exec. */
  helper: string;
  /** `<data>`, realpathed. Not needed by catalog. */
  dataDir?: string;
  imageId?: string;
  /** run: the VM, whose slot comes from its id. */
  vmId?: string;
  /** install and provision and save-state: the slot it runs in. */
  slot?: 1 | 2;
  /** inspect and install: the restore image's file name in ipsw/. */
  ipswName?: string;
  /** provision: whether the guided setup's window is shown. */
  window?: boolean;
  /** run: the job's proxy and the broker, on 127.0.0.1. */
  proxyPort?: number;
  brokerPort?: number;
  /**
   * Every command that boots a VM: the per-user cache directory
   * (DARWIN_USER_CACHE_DIR, realpathed), where Metal keeps the VM display's
   * shader cache.
   */
  userCacheDir?: string;
}

/**
 * The extension classes VZ issues for a Mac VM's devices: found by booting
 * the installer under the profile until VZ stopped asking (Failed to issue
 * ... sandbox extension).
 */
export const MAC_VM_DEVICE_EXTENSIONS = [
  'com.apple.virtualization.extension.usb-hci',
  'com.apple.virtualization.extension.io-surface',
  'com.apple.virtualization.extension.paravirtualized-graphics',
  'com.apple.virtualization.extension.fp',
  'com.apple.virtualization.extension.avp.rtc',
  'com.apple.virtualization.extension.videotoolbox',
  'com.apple.virtualization.extension.strong-identity',
];

/** Backslash first, then the quote, so a path cannot close its DSL string. */
const escape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * A path as a literal inside a seatbelt regex. Only a path of letters,
 * digits, `/`, `_`, `-` and `.` is taken - the per-user directories under
 * /private/var/folders are nothing else - and each `.` is put in brackets.
 */
function regexLiteral(value: string): string {
  if (!/^[A-Za-z0-9/_.-]+$/.test(value)) {
    throw new Error(`refusing to put ${JSON.stringify(value)} in a profile regex`);
  }
  return value.replace(/\./g, '[.]');
}

function requirePort(port: number | undefined, what: string): number {
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`a job VM's profile needs ${what}, 1-65535: ${String(port)}`);
  }
  return port;
}

function need<T>(value: T | undefined, what: string, command: string): T {
  if (value === undefined) throw new Error(`the ${command} profile needs ${what}`);
  return value;
}

export function buildMacVmProfile(opts: MacVmProfileOptions): string {
  const helper = opts.helper;
  if (typeof helper !== 'string' || !path.isAbsolute(helper)) {
    throw new Error(`the helper must be an absolute path: ${JSON.stringify(helper)}`);
  }
  const lines = [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    `(allow process-exec (literal "${escape(helper)}"))`,
    `(allow file-read* (literal "${escape(helper)}"))`,
  ];
  const c = opts.command;
  const data = (): string => need(opts.dataDir, 'the data directory', c);
  const image = (): string => imageDir(data(), need(opts.imageId, 'an image id', c));
  const slotLock = (slot: number): string => path.join(macVmLayout(data()).slotsDir, `${slot}.lock`);
  const ipsw = (): string => {
    const name = need(opts.ipswName, 'a restore image name', c);
    if (!IPSW_NAME_RE.test(name)) throw new Error(`not a restore image name: ${JSON.stringify(name)}`);
    return ipswPath(data(), name);
  };
  const slot = (): number => {
    const s = need(opts.slot, 'a slot', c);
    if (s !== 1 && s !== 2) throw new Error(`a macOS VM slot is 1 or 2, not ${String(s)}`);
    return s;
  };
  const readWrite = (dir: string) => `(allow file-read* file-write* (subpath "${escape(dir)}"))`;
  const readOnly = (dir: string) => `(allow file-read* (subpath "${escape(dir)}"))`;
  // VZ's own services open the restore image, the disks and the saved state
  // through sandbox extensions the helper issues for the paths it hands
  // them; without the rule, VZ fails with "Unable to create sandbox
  // extension". Each is scoped to the files that command hands over.
  const readExtension = (filter: string) =>
    `(allow file-issue-extension (require-all (extension-class "com.apple.app-sandbox.read") ${filter}))`;
  const readWriteExtension = (filter: string) =>
    `(allow file-issue-extension (require-all (extension-class "com.apple.app-sandbox.read-write" "com.apple.app-sandbox.read") ${filter}))`;
  // Every command that boots a VM: the devices of a Mac VM, which VZ's
  // service reaches through extensions of VZ's own classes, and the
  // display's Metal shader cache, com.apple.metal-<hash> in the per-user
  // cache directory, which it is handed the same way.
  const vmRules = (): string[] => {
    const cache = need(opts.userCacheDir, 'the per-user cache directory', c);
    if (!path.isAbsolute(cache) || path.normalize(cache) !== cache || cache.endsWith('/')) {
      throw new Error(`the per-user cache directory must be a plain absolute path: ${JSON.stringify(cache)}`);
    }
    return [
      ";; A Mac VM's devices, and its display's Metal shader cache.",
      `(allow generic-issue-extension (extension-class ${MAC_VM_DEVICE_EXTENSIONS.map((e) => `"${e}"`).join(' ')}))`,
      '(allow file-issue-extension (require-all (extension-class "com.apple.app-sandbox.read-write")',
      `  (regex #"^${regexLiteral(cache)}/com[.]apple[.]metal-[0-9a-f]+(/|$)")))`,
      ";; The display's frames, which VZ hands the helper as IOSurfaces once the",
      ";; guest's display comes up, headless or not. Mapping one opens IOSurface's",
      ";; user client, and IOSurface's first connect reads the main bundle - the",
      ";; helper's own directory, listed, not its contents. Without either, VZ",
      ";; traps (FIXME \"Handle this\") or IOSurface crashes on a null bundle as the",
      ";; installer's display turns on.",
      '(allow iokit-open (iokit-user-client-class "IOSurfaceRootUserClient"))',
      `(allow file-read* (literal "${escape(path.dirname(helper))}"))`,
    ];
  };
  const literal = (p: string) => `(literal "${escape(p)}")`;
  const subpath = (p: string) => `(subpath "${escape(p)}")`;
  const lock = (s: number) => [
    ';; Its slot: the flock that keeps the Mac to two macOS VMs, in the',
    ';; slots directory it opens without following a link.',
    `(allow file-read* (literal "${escape(macVmLayout(data()).slotsDir)}"))`,
    `(allow file-read* file-write* (literal "${escape(slotLock(s))}"))`,
  ];

  switch (c) {
    case 'catalog':
      break;
    case 'inspect':
      lines.push(`(allow file-read* (literal "${escape(ipsw())}"))`, readExtension(literal(ipsw())));
      break;
    case 'install':
      lines.push(
        ';; The restore image, in the ipsw directory it opens without following',
        ';; a link, and the new image the installer writes.',
        `(allow file-read* (literal "${escape(macVmLayout(data()).ipswDir)}") (literal "${escape(ipsw())}"))`,
        readExtension(literal(ipsw())),
        readWrite(image()),
        readWriteExtension(subpath(image())),
        ...vmRules(),
        ...lock(slot())
      );
      break;
    case 'provision':
      lines.push(readWrite(image()), readWriteExtension(subpath(image())), ...vmRules(), ...lock(slot()));
      if (opts.window) {
        lines.push(
          ';; The guided setup\'s window: AppKit reaches the window server, fonts,',
          ';; preferences and the frameworks it loads. Only for the one-time setup,',
          ';; before anything of a job exists; it writes only the image.',
          '(allow mach-lookup)',
          '(allow iokit-open)',
          '(allow user-preference-read)',
          '(allow file-read*)',
          '(allow ipc-posix-shm*)'
        );
      }
      break;
    case 'save-state':
      lines.push(readWrite(image()), readWriteExtension(subpath(image())), ...vmRules(), ...lock(slot()));
      break;
    case 'run': {
      const vmId = need(opts.vmId, 'a VM id', c);
      const vm = vmDir(data(), vmId);
      const proxy = requirePort(opts.proxyPort, 'the job\'s proxy port');
      const broker = requirePort(opts.brokerPort, 'the broker\'s port');
      lines.push(
        ';; The golden image, read-only: cloned, and its saved state restored.',
        readOnly(image()),
        readExtension(subpath(image())),
        ';; The VM\'s own directory: its clones, its pid file and agent.sock.',
        readWrite(vm),
        readWriteExtension(subpath(vm)),
        ...vmRules(),
        ...lock(macVmIdSlot(vmId)),
        ';; The guest\'s two ways out, each relayed to one loopback port.',
        `(allow network-outbound (remote ip "localhost:${proxy}"))`,
        `(allow network-outbound (remote ip "localhost:${broker}"))`,
        ';; agent.sock.',
        `(allow network-bind network-inbound (subpath "${escape(vm)}"))`
      );
      break;
    }
    case 'check':
      lines.push(readOnly(image()));
      break;
    default:
      throw new Error(`no profile for helper command ${JSON.stringify(c)}`);
  }
  lines.push('');
  return lines.join('\n');
}
