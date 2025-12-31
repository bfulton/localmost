/**
 * Minimal process shim for sandboxed Electron preload scripts.
 *
 * The 'debug' library (bundled in @zubridge/electron) uses 'supports-color'
 * which needs:
 * - process.argv for hasFlag() checks
 * - process.stderr.fd for useColors check
 * - process.env for various environment checks
 *
 * DEBUG_COLORS=false disables color detection to avoid the process.stderr.fd check
 */
module.exports = {
  argv: [],
  env: {
    DEBUG_COLORS: 'false',
  },
  platform: 'browser',
  version: '',
  versions: {},
  stdout: { isTTY: false, fd: 1 },
  stderr: { isTTY: false, fd: 2 },
};
