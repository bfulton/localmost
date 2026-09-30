#!/usr/bin/env node
/**
 * Generate latest-mac.yml for electron-updater.
 * Run after `npm run make`, to create the files for GitHub release upload:
 * latest-mac.yml and the update zip, in build/out/make (or the make
 * directory given as the first argument).
 *
 * localmost is built for Apple silicon (arm64) only. electron-updater on a
 * Mac installs only from a zip: it picks the listed zip for the Mac's arch,
 * and a manifest without one fails every download with
 * ERR_UPDATER_ZIP_FILE_NOT_FOUND. maker-zip leaves the zip under
 * zip/darwin/arm64/; it is copied up beside the DMG under the name the
 * release carries, localmost-<version>-arm64-mac.zip. The DMG is listed too,
 * for completeness; the updater never picks one. An Intel Mac finds no file
 * of its arch in the manifest, so it downloads nothing.
 *
 * Any other DMG or zip in the make directory - an Intel (x64) or universal
 * build, or one left from another version - is refused rather than ignored,
 * so that no build but this one is published beside the manifest.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pkg = require('../package.json');
const version = pkg.version;

const outDir = process.argv[2] || path.join(__dirname, '..', 'build', 'out', 'make');

// The only arch a release ships.
const ARCH = 'arm64';

function sha512(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha512').update(data).digest('base64');
}

function getFileSize(filePath) {
  return fs.statSync(filePath).size;
}

function describe(filePath) {
  return {
    url: path.basename(filePath),
    sha512: sha512(filePath),
    size: getFileSize(filePath),
  };
}

const build = {
  madeZip: path.join(outDir, 'zip', 'darwin', ARCH, `localmost-darwin-${ARCH}-${version}.zip`),
  zip: path.join(outDir, `localmost-${version}-${ARCH}-mac.zip`),
  dmg: path.join(outDir, `localmost-${version}-${ARCH}.dmg`),
};

const missing = [build.madeZip, build.dmg].filter(file => !fs.existsSync(file));
if (missing.length > 0) {
  console.error(`Missing from ${outDir} (run \`npm run make\`):`);
  for (const file of missing) console.error(`  ${path.relative(outDir, file)}`);
  process.exit(1);
}

const shipped = new Set([build.madeZip, build.zip, build.dmg].map(file => path.relative(outDir, file)));
const others = fs.readdirSync(outDir, { recursive: true })
  .filter(file => /\.(dmg|zip)$/.test(file) && !shipped.has(file));
if (others.length > 0) {
  console.error(`Not part of this ${ARCH} release, in ${outDir} (clear it with \`rm -rf\` and run \`npm run make\` again):`);
  for (const file of others) console.error(`  ${file}`);
  process.exit(1);
}

fs.copyFileSync(build.madeZip, build.zip);
const zip = describe(build.zip);
const dmg = describe(build.dmg);

// Zips first: path and sha512 are the single-file form older updaters read.
const files = [zip, dmg];

const yaml = `version: ${version}
files:
${files.map(f => `  - url: ${f.url}
    sha512: ${f.sha512}
    size: ${f.size}`).join('\n')}
path: ${zip.url}
sha512: ${zip.sha512}
releaseDate: '${new Date().toISOString()}'
`;

const outFile = path.join(outDir, 'latest-mac.yml');
fs.writeFileSync(outFile, yaml);
console.log(`Generated ${outFile}`);
console.log(yaml);
