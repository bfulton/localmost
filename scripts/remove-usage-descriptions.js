/**
 * Take the privacy usage descriptions out of a packaged app's Info.plist
 * files.
 *
 * Electron's app template declares why it would use the camera, the
 * microphone, audio capture and Bluetooth (NSCameraUsageDescription and the
 * like), and @electron/packager keeps them: extendInfo can add keys but not
 * remove one. localmost uses none of these, and is signed without the
 * entitlements that would let it ask, so the strings only claim access it
 * does not have. Every NS...UsageDescription key goes, whatever device it
 * names, rather than a list of the ones Electron has today: the app declares
 * no usage at all.
 *
 * Run as @electron/packager's afterCopyExtraResources hook, the last step
 * before it signs the app, so the signature covers the edited plists.
 * Packager runs that hook only when the config sets extraResource.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PLUTIL = '/usr/bin/plutil';
const USAGE_DESCRIPTION = /^NS[A-Za-z]*UsageDescription$/;

/**
 * Every bundle's Info.plist under dir: the app's own and its helpers'.
 * Links are not followed, so nothing outside dir is touched and a
 * framework's Versions/Current is not visited twice.
 */
function bundlePlists(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (entry.name.endsWith('.app')) {
      const plist = path.join(child, 'Contents', 'Info.plist');
      if (fs.lstatSync(plist, { throwIfNoEntry: false })?.isFile()) found.push(plist);
    }
    found.push(...bundlePlists(child));
  }
  return found;
}

/** The top-level keys of a plist, read with the system's own parser. */
function plistKeys(file) {
  return Object.keys(JSON.parse(execFileSync(PLUTIL, ['-convert', 'json', '-o', '-', file], { encoding: 'utf-8' })));
}

/**
 * Remove every usage description from every app bundle under dir, and
 * return what was removed, as "<plist>: <key>". Throws when dir holds no app
 * at all, so a hook pointed at the wrong place fails the build rather than
 * shipping the strings.
 */
function removeUsageDescriptions(dir) {
  const plists = bundlePlists(dir);
  if (plists.length === 0) throw new Error(`No app bundle found under ${dir}`);
  const removed = [];
  for (const plist of plists) {
    for (const key of plistKeys(plist).filter((k) => USAGE_DESCRIPTION.test(k))) {
      execFileSync(PLUTIL, ['-remove', key, plist]);
      removed.push(`${path.relative(dir, plist)}: ${key}`);
    }
  }
  return removed;
}

/**
 * The hook, in @electron/packager's form. buildPath is the staging
 * directory, which holds the renamed app with its extra resources copied in.
 */
function afterCopyExtraResources(buildPath, electronVersion, platform, arch, done) {
  try {
    const removed = removeUsageDescriptions(buildPath);
    console.log(`Removed ${removed.length} usage description(s) from Info.plist`);
    done();
  } catch (err) {
    done(err);
  }
}

module.exports = { removeUsageDescriptions, afterCopyExtraResources, USAGE_DESCRIPTION };
