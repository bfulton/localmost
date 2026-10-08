/**
 * The oldest macOS localmost runs on. forge.config.js writes it into the
 * app's Info.plist as LSMinimumSystemVersion, and
 * scripts/generate-latest-mac-yml.js writes its Darwin version into the
 * update manifest as minimumSystemVersion, so that the updater of an older
 * install on an older Mac does not download a release that Mac cannot open.
 * Squirrel.Mac checks only the code signature before it installs, so the
 * manifest is the only place the older Mac can be turned away.
 */

// The Docker VM backend needs macOS 14 (docs/roadmap/vm-docker-backend.md,
// decision 12). Electron's own template says 12.0.
const MACOS_MINIMUM = '14.0';

/**
 * The Darwin version, as os.release() reports it, of the first release of
 * macOS `macos` (a major release, "N.0"). electron-updater compares
 * minimumSystemVersion with os.release(). A point release is refused: its
 * Darwin minor does not follow the macOS one (macOS 13.0 is Darwin 22.1).
 */
function darwinVersionOf(macos) {
  const match = /^(\d+)\.0$/.exec(macos);
  if (!match) {
    throw new Error(`the minimum macOS must be a major release, such as 14.0, not ${macos}`);
  }
  const major = Number(match[1]);
  let darwin;
  if (major >= 11 && major <= 15) {
    // macOS 11 to 15 are Darwin 20 to 24.
    darwin = major + 9;
  } else if (major >= 26) {
    // macOS 26 followed 15 and is Darwin 25; Darwin still moves by one a year.
    darwin = major - 1;
  } else {
    throw new Error(`no Darwin version is known for macOS ${macos}`);
  }
  return `${darwin}.0.0`;
}

module.exports = { MACOS_MINIMUM, darwinVersionOf };
