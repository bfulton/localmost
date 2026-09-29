/**
 * What an egress proxy checks before it connects anywhere.
 *
 * Shared by the runner's per-worker ProxyServer and the proxy `localmost test`
 * starts: who may use the proxy, how a CONNECT target is read, and which
 * addresses a host may resolve to before the proxy will dial it.
 */

import * as crypto from 'crypto';
import * as dns from 'dns';
import * as http from 'http';
import * as net from 'net';
import { URL, domainToASCII } from 'url';

/** Resolve a host to its addresses. */
export type HostLookup = (host: string) => Promise<string[]>;

/** Every address DNS returns for a host. */
export const dnsLookup: HostLookup = async (host: string) => {
  const results = await dns.promises.lookup(host, { all: true });
  return results.map((r) => r.address);
};

/** Our proxy credentials must not leak to the upstream origin. */
export function stripProxyAuth(headers: http.IncomingHttpHeaders): http.IncomingHttpHeaders {
  const copy = { ...headers };
  delete copy['proxy-authorization'];
  return copy;
}

/**
 * Whether a Proxy-Authorization header carries `token` as its Basic password.
 * The password is compared in constant time; the username is not a secret.
 */
export function isProxyAuthorized(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  let password: string;
  try {
    password = Buffer.from(header.slice(6), 'base64').toString('utf-8').split(':').slice(1).join(':');
  } catch {
    return false;
  }
  const expected = Buffer.from(token);
  const got = Buffer.from(password);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

/**
 * A host in the one spelling the checks compare and the dial uses, or null
 * when it cannot be read as a host. An IPv6 literal is compressed and
 * lowercased. Anything else goes through the WHATWG host mapping a URL's
 * host gets: lowercased, in ASCII (punycode) form, with the IDNA full stops
 * (U+3002, U+FF0E, U+FF61) as '.' and a numeric IPv4 shorthand written out.
 * That is how the resolver reads the name too, so a spelling it treats as
 * the same host cannot be a different host to the policy.
 */
export function canonicalHost(host: string): string | null {
  if (net.isIP(host) === 6) {
    try {
      return new URL(`http://[${host}]`).hostname.slice(1, -1);
    } catch {
      return null; // a zone id, which only link-local addresses carry
    }
  }
  return domainToASCII(host) || null;
}

/**
 * Parse a CONNECT request-target: authority-form host[:port] (RFC 9112
 * s3.2.3) - a bracketed IPv6 literal or a colon-free name/IPv4 literal. A
 * bare IPv6, userinfo, a path, an empty or out-of-range port are refused
 * rather than guessed at, so the host that is screened is exactly the host
 * dialled. Brackets come off here: net.isIP, the address screen and
 * net.connect all take the bare literal. (Not new URL('http://' + target):
 * that drops port 80 as the scheme default and accepts userinfo.)
 *
 * The host comes back in canonicalHost's spelling. A plain request's host
 * arrives that way already, having been read as a URL; a CONNECT target did
 * not, so a denied host written another way got past a deny that compared
 * spellings.
 */
const CONNECT_TARGET = /^(?:\[([0-9a-fA-F:.%a-zA-Z0-9]+)\]|([^[\]:/?#@\s]+))(?::(\d{1,5}))?$/;
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  const m = CONNECT_TARGET.exec(target);
  if (!m) return null;
  if (m[1] !== undefined && net.isIP(m[1]) !== 6) return null; // brackets hold only an IPv6 literal
  const host = canonicalHost(m[1] ?? m[2]);
  if (host === null) return null;
  const port = m[3] === undefined ? 443 : Number(m[3]);
  if (port < 1 || port > 65535) return null;
  return { host, port };
}

/** A network entry, as read by parseHostPattern. */
export interface HostPattern {
  /** Lowercased; for a wildcard, the suffix with its leading dot. */
  host: string;
  wildcard: boolean;
  /**
   * The port the entry spells. Undefined when it spells none, and null when
   * what follows the host is not a port - an entry no connection can match.
   */
  port: number | undefined | null;
}

function readPort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Read a network entry: an exact host or a *.suffix wildcard, optionally
 * followed by :port. An IPv6 literal takes a port only in brackets; a bare
 * one is all address, so 2606:4700::1111 is not read as a host and a port.
 */
export function parseHostPattern(entry: string): HostPattern {
  let host = entry.toLowerCase();
  let port: number | undefined | null;
  const bracketed = /^\[([^\]]*)\](?::(.*))?$/.exec(host);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2] === undefined ? undefined : readPort(bracketed[2]);
  } else if (host.indexOf(':') !== -1 && host.indexOf(':') === host.lastIndexOf(':')) {
    port = readPort(host.slice(host.indexOf(':') + 1));
    host = host.slice(0, host.indexOf(':'));
  }
  const wildcard = host.startsWith('*.');
  return { host: wildcard ? host.slice(1) : host, wildcard, port };
}

/**
 * Whether a host is the one an entry names, ignoring any port it spells:
 * which ports that allows is the caller's decision. A wildcard matches below
 * its suffix only, never the bare parent domain.
 */
export function hostPatternMatches(pattern: HostPattern, host: string): boolean {
  const normalizedHost = host.toLowerCase();
  return pattern.wildcard ? normalizedHost.endsWith(pattern.host) : normalizedHost === pattern.host;
}

function expandV6ToGroups(addr: string): number[] | null {
  let s = addr.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zoneCut = s.indexOf('%');
  if (zoneCut >= 0) s = s.slice(0, zoneCut);
  s = s.toLowerCase();
  if (s === '') return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const pieces = part.split(':');
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (piece.includes('.')) {
        // Embedded dotted IPv4 (only valid as the last piece).
        if (i !== pieces.length - 1) return null;
        const octets = piece.split('.').map((o) => parseInt(o, 10));
        if (octets.length !== 4 || octets.some((o) => isNaN(o) || o < 0 || o > 255)) return null;
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
        out.push(parseInt(piece, 16));
      }
    }
    return out;
  };
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (head === null || tail === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null; // :: must stand for at least one zero group
    groups = [...head, ...new Array(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  return groups.length === 8 ? groups : null;
}

function isBlockedV4(addr: string): boolean {
  const o = addr.split('.').map((n) => parseInt(n, 10));
  if (o.length !== 4 || o.some((n) => isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  if (a === 0) return true; // this-network / 0.0.0.0 - resolves to local
  // Loopback (127/8) is intentionally not blocked: the sandbox grants a job
  // direct loopback access, and the broker (also on loopback) is reached this
  // way, so screening it here changes nothing and would break control traffic.
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local incl. metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0 && o[2] === 0) return true; // IETF protocol assignments
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * An address the proxy must never connect to: link-local including the cloud
 * metadata endpoint 169.254.169.254, and the private and carrier-grade ranges.
 * The proxy exists to reach declared external hosts; a name that resolves here
 * is either a misconfiguration or an attempt to reach inside from a job.
 * Loopback is not in this set - see isLoopbackAddress.
 */
export function isBlockedAddress(ip: string): boolean {
  let addr = ip.trim();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  const v = net.isIP(addr);
  if (v === 4) return isBlockedV4(addr);
  if (v === 6) {
    const groups = expandV6ToGroups(addr);
    if (!groups) return true; // unparseable - refuse rather than allow
    // Loopback (::1) stays reachable, like 127/8: the sandbox grants loopback
    // directly and the broker rides it.
    if (groups.every((g, i) => (i === 7 ? g === 1 : g === 0))) return false;
    // Top 96 bits zero, optionally with 0xffff in the sixth group: the
    // unspecified address, IPv4-mapped (::ffff:a.b.c.d in any notation,
    // including the fully-expanded 0:0:0:0:0:ffff:0a00:0001) and
    // IPv4-compatible (::a.b.c.d). A real host's AAAA is native IPv6, never
    // one of these, so all are refused.
    if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
        groups[4] === 0 && (groups[5] === 0 || groups[5] === 0xffff)) {
      return true;
    }
    if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }
  // Not an IP literal: treat as unresolvable, which callers reject.
  return true;
}

/** Loopback: 127/8, ::1, and IPv4-mapped or -compatible loopback. */
export function isLoopbackAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return ip.split('.')[0] === '127';
  if (v === 6) {
    const groups = expandV6ToGroups(ip);
    if (!groups) return false;
    if (groups.every((g, i) => (i === 7 ? g === 1 : g === 0))) return true; // ::1
    // IPv4-mapped/compatible loopback (::ffff:127.x, ::127.x)
    if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
        groups[4] === 0 && (groups[5] === 0 || groups[5] === 0xffff)) {
      return (groups[6] >> 8) === 127;
    }
  }
  return false;
}

/**
 * The addresses it is safe to connect to for a host, or null: it must
 * resolve, and every address it resolves to must be routable off this
 * machine. Refusing when ANY resolved address is internal is stronger against
 * a rebinding answer than picking the first public one.
 *
 * A name that resolves to loopback is always refused - a repository-controlled
 * hostname must not rebind to a local service. A literal loopback target is
 * the caller's choice: the runner's proxy passes it, because the runner
 * reaches the broker at the literal 127.0.0.1 through it.
 */
export async function screenAddresses(
  host: string,
  lookup: HostLookup,
  options: { allowLiteralLoopback: boolean }
): Promise<string[] | null> {
  const literal = net.isIP(host) !== 0;
  let candidates: string[];
  if (literal) {
    candidates = [host];
  } else {
    try {
      candidates = await lookup(host);
    } catch {
      return null;
    }
  }
  if (candidates.length === 0) return null;
  const refused = (ip: string): boolean =>
    isBlockedAddress(ip) || ((!literal || !options.allowLiteralLoopback) && isLoopbackAddress(ip));
  if (!candidates.every((ip) => !refused(ip))) return null;
  return candidates;
}

/**
 * A DNS lookup that returns exactly the addresses already screened, so the
 * connection cannot be sent to something a second resolution turned up.
 * Keeps every screened address, so Node still falls back across a host's
 * IPv4 and IPv6 addresses under autoSelectFamily.
 */
export function pinnedLookup(addresses: string[]) {
  return (
    _hostname: string,
    options: dns.LookupOptions | ((err: Error | null, address: string, family: number) => void),
    callback?: (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void
  ): void => {
    const cb = (typeof options === 'function' ? options : callback) as (
      err: Error | null,
      address: string | dns.LookupAddress[],
      family?: number
    ) => void;
    const all = typeof options === 'object' && options?.all;
    const entries = addresses.map((address) => ({ address, family: net.isIP(address) || 4 }));
    if (all) {
      cb(null, entries);
    } else {
      cb(null, entries[0].address, entries[0].family);
    }
  };
}
