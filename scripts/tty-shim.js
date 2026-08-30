/**
 * Minimal tty shim for sandboxed Electron preload scripts.
 *
 * The 'supports-color' library (bundled in @zubridge/electron via debug)
 * calls tty.isatty() to check if output is a terminal.
 */
module.exports = {
  isatty: () => false,
};
