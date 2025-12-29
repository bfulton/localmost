/**
 * Minimal process shim for sandboxed Electron preload scripts.
 *
 * The 'debug' library (bundled in @zubridge/electron) uses 'supports-color'
 * which calls hasFlag() to check process.argv. This shim provides the
 * minimum needed for those checks to work without Node.js access.
 */
module.exports = {
  argv: [],
  env: {},
  platform: 'browser',
  version: '',
  versions: {},
  stdout: { isTTY: false },
  stderr: { isTTY: false },
};
