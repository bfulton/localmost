/**
 * Keys a check can read the way the service it guards reads them.
 *
 * A filter that judges a JSON body by its key names has to read each key as
 * the decoder behind it will. Upstream decoders match keys case-insensitively
 * (Go's encoding/json and .NET's both do), and beyond ASCII each folds its own
 * way: Go's reads U+017F (long s) as `s` and U+212A (Kelvin sign) as `k`,
 * escaped or not, and .NET's reads neither. No check here can match every one
 * of those, so a key that is not printable ASCII is refused instead. Every
 * client these checks serve - the runner, the docker CLI - writes its keys in
 * ASCII.
 *
 * Pure: imports nothing, so both main-process filters can share it.
 */

const PLAIN_ASCII = /^[\x20-\x7e]*$/;

/** True when every character is printable ASCII, which no decoder folds past ASCII case. */
export const isPlainAscii = (value: string): boolean => PLAIN_ASCII.test(value);

/**
 * A key spelled so it can be read and logged: each character outside
 * printable ASCII as a \uXXXX escape, so a look-alike such as `HoſtConfig`
 * shows as `Ho\u017ftConfig` rather than passing for the key it imitates.
 */
export const asciiEscaped = (value: string): string =>
  value.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
