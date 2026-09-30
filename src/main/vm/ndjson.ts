/**
 * The framing the helper's stdio and the guest agent share (contract §2.4,
 * §3.4): UTF-8 JSON, one object per line, 64 KiB at most per line, each
 * object stamped `"v":1`. Also the rule for guest text: whatever the helper
 * or the guest says that reaches a log is stripped of control characters and
 * ANSI escapes, and capped, first.
 */

/** The longest line either side may send, newline excluded. */
export const MAX_LINE_BYTES = 64 * 1024;

/** The protocol version every object carries. */
export const PROTOCOL_V = 1;

/** A CSI or OSC escape sequence, then any other C0/C1 control character or DEL. */
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/**
 * What else can fake a line break or reorder what a reader sees: the line and
 * paragraph separators, every format character (the bidi overrides, isolates
 * and marks among them), and a lone surrogate, which is not text.
 */
const UNICODE_UNSAFE = /[\p{Zl}\p{Zp}\p{Cf}\p{Cs}]/gu;

/**
 * Text from the helper, the guest or dockerd, made fit for a log line: ANSI
 * escapes removed, every other control character (newlines included) and
 * every Unicode separator or format character turned into a space, and at
 * most `max` characters kept.
 */
export function sanitizeGuestText(value: unknown, max = 512): string {
  const text = typeof value === 'string' ? value : String(value);
  const clean = text.replace(ANSI_ESCAPE, '').replace(CONTROL, ' ').replace(UNICODE_UNSAFE, ' ');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Split a byte stream into lines, each handed over whole. A line longer than
 * MAX_LINE_BYTES is never buffered past the limit: `onOverflow` is called
 * once and nothing more is read.
 */
export function lineSplitter(onLine: (line: string) => void, onOverflow: () => void): (chunk: Buffer) => void {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let overflowed = false;
  return (chunk: Buffer) => {
    if (overflowed) return;
    let start = 0;
    for (let nl = chunk.indexOf(0x0a, start); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, nl);
      if (pendingBytes + piece.length > MAX_LINE_BYTES) {
        overflowed = true;
        onOverflow();
        return;
      }
      const line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
      pending = [];
      pendingBytes = 0;
      start = nl + 1;
      onLine(line.toString('utf8'));
      if (overflowed) return;
    }
    const rest = chunk.subarray(start);
    if (pendingBytes + rest.length > MAX_LINE_BYTES) {
      overflowed = true;
      onOverflow();
      return;
    }
    if (rest.length > 0) {
      pending.push(Buffer.from(rest));
      pendingBytes += rest.length;
    }
  };
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A JSON object with `"v":1`, or null for a line that is not one. */
export function parseFrame(line: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return isRecord(value) && value.v === PROTOCOL_V ? value : null;
}

/** One frame, as a line to write. */
export const frame = (body: Record<string, unknown>): string => `${JSON.stringify({ v: PROTOCOL_V, ...body })}\n`;
