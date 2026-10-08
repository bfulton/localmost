/**
 * The provisioning VM's address, from the lease macOS's DHCP server gave its
 * NAT interface. VZ's NAT attachment is vmnet's shared mode, whose bootpd
 * records each lease in /var/db/dhcpd_leases (world-readable) by hardware
 * address; the helper boots the provisioning VM with the MAC address in the
 * image's config.json, so the lease for that address is the guest's.
 *
 *   {
 *       name=localmost-admins-Virtual-Machine
 *       ip_address=192.168.64.5
 *       hw_address=1,2:11:22:33:44:55
 *       identifier=1,2:11:22:33:44:55
 *       lease=0x66f5a1b2
 *   }
 *
 * bootpd writes each octet without its leading zero ("2", not "02").
 */

import * as fs from 'fs';

export const DHCPD_LEASES = '/var/db/dhcpd_leases';

export interface Lease {
  ip: string;
  /** Lowercase, two digits an octet. */
  mac: string;
  /** When it expires, seconds since the epoch. */
  expires: number;
}

/** `2:11:a:...` as `02:11:0a:...`, or null for anything that is not six hex octets. */
export function normalizeMac(value: string): string | null {
  const parts = value.toLowerCase().split(':');
  if (parts.length !== 6 || !parts.every((p) => /^[0-9a-f]{1,2}$/.test(p))) return null;
  return parts.map((p) => p.padStart(2, '0')).join(':');
}

/** An address in a private IPv4 range, the only kind vmnet's shared mode hands out. */
export function isPrivateIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255) || d === 0 || d === 255) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function parseLeases(text: string): Lease[] {
  const leases: Lease[] = [];
  for (const block of text.matchAll(/\{([^{}]*)\}/g)) {
    const fields = new Map<string, string>();
    for (const line of block[1].split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    const hw = fields.get('hw_address') ?? '';
    const mac = normalizeMac(hw.startsWith('1,') ? hw.slice(2) : '');
    const ip = fields.get('ip_address') ?? '';
    const expires = Number.parseInt(fields.get('lease') ?? '', 16);
    if (mac && isPrivateIPv4(ip) && Number.isFinite(expires)) leases.push({ ip, mac, expires });
  }
  return leases;
}

/** The address of the newest live lease for `mac`, or null. */
export function leaseFor(text: string, mac: string, nowSeconds: number): string | null {
  const want = normalizeMac(mac);
  if (!want) throw new Error(`not a MAC address: ${JSON.stringify(mac)}`);
  const live = parseLeases(text)
    .filter((l) => l.mac === want && l.expires > nowSeconds)
    .sort((a, b) => b.expires - a.expires);
  return live[0]?.ip ?? null;
}

/** Reads the leases file; an absent file (no VM has had a lease yet) is no lease. */
export function readLeases(file = DHCPD_LEASES): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}
