/**
 * Text from outside Electron - a registry's error body, a credential helper's
 * output, a daemon's answer - made safe to put in a message or a log line:
 * ANSI escapes and every other control character removed, whitespace runs
 * collapsed, and the result cut to a bound. Whoever wrote the text chose it,
 * so it must not be able to rewrite a terminal or a log with escapes, or
 * flood either.
 */

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
/** U+2028 and U+2029, which some viewers treat as line breaks. */
const LINE_SEPARATORS = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];

export function cleanText(text: string, max = 512): string {
  let cleaned = String(text).replace(ANSI, '').replace(CONTROL, ' ');
  for (const separator of LINE_SEPARATORS) cleaned = cleaned.split(separator).join(' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
