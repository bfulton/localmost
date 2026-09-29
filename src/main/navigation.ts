/**
 * Where the app's window may go, and what it may hand to the browser.
 *
 * The renderer holds the preload API, which reaches every IPC channel. Any
 * page that loads in its window holds that API too, so the window stays on
 * the app's own page; and a link it opens goes to the default browser only
 * when it points somewhere the app itself links to.
 */

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;

/**
 * Whether a URL is the app's own page: the entry the window was loaded from,
 * with any query or fragment. Not any file:// URL - a page anywhere on disk
 * would load with the preload API attached.
 */
export const isAppEntryUrl = (url: string, entry: string = MAIN_WINDOW_WEBPACK_ENTRY): boolean => {
  try {
    const target = new URL(url);
    const home = new URL(entry);
    return target.protocol === home.protocol && target.host === home.host && target.pathname === home.pathname;
  } catch {
    return false;
  }
};

/**
 * Hosts the app links to. Every link in the app - a job's run, the runner's
 * release notes, the device-flow page, the repository and privacy policy - is
 * on github.com; anything else the renderer asks to open is not the app's.
 */
const EXTERNAL_HOSTS: ReadonlySet<string> = new Set(['github.com']);

export const isAllowedExternalUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      EXTERNAL_HOSTS.has(parsed.hostname) &&
      parsed.port === '' &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
};
