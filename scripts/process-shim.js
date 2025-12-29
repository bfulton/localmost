/**
 * Minimal process shim for sandboxed Electron preload scripts.
 *
 * The 'debug' library (bundled in @zubridge/electron) uses 'supports-color'
 * which needs:
 * - process.argv for hasFlag() checks
 * - process.stderr.fd for useColors check
 * - process.env for various environment checks
 */
module.exports = {
  argv: [],
  env: {},
  platform: 'browser',
  version: '',
  versions: {},
  stdout: { isTTY: false, fd: 1 },
  stderr: { isTTY: false, fd: 2 },
};
