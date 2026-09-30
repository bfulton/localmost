#!/usr/bin/env node
/**
 * Generate latest-mac.yml for electron-updater.
 * Run after `npm run make` for both arches, to create the files for GitHub
 * release upload: latest-mac.yml and each arch's update zip, in build/out/make
 * (or the make directory given as the first argument).
 *
 * electron-updater on a Mac installs only from a zip: it picks the listed zip
 * for the Mac's arch, and a manifest without one fails every download with
 * ERR_UPDATER_ZIP_FILE_NOT_FOUND. maker-zip leaves each arch's zip under
 * zip/darwin/<arch>/; it is copied up beside the DMGs under the name the
 * release carries, localmost-<version>-<arch>-mac.zip. The DMGs are listed
 * too, for completeness; the updater never picks one.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pkg = require('../package.json');
const version = pkg.version;

const outDir = process.argv[2] || path.join(__dirname, '..', 'build', 'out', 'make');

// Every arch a release ships. A Mac is offered only files of its own arch
// (an Intel Mac never an arm64 one), so a release without one of these
// leaves those Macs with nothing to update from.
const ARCHES = ['arm64', 'x64'];

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

const builds = ARCHES.map(arch => ({
  madeZip: path.join(outDir, 'zip', 'darwin', arch, `localmost-darwin-${arch}-${version}.zip`),
  zip: path.join(outDir, `localmost-${version}-${arch}-mac.zip`),
  dmg: path.join(outDir, `localmost-${version}-${arch}.dmg`),
}));

const missing = builds
  .flatMap(b => [b.madeZip, b.dmg])
  .filter(file => !fs.existsSync(file));
if (missing.length > 0) {
  console.error(`Missing from ${outDir} (run \`npm run make -- --arch=<arch>\` for ${ARCHES.join(' and ')}):`);
  for (const file of missing) console.error(`  ${path.relative(outDir, file)}`);
  process.exit(1);
}

const zips = [];
const dmgs = [];
for (const b of builds) {
  fs.copyFileSync(b.madeZip, b.zip);
  zips.push(describe(b.zip));
  dmgs.push(describe(b.dmg));
}

// Zips first: path and sha512 are the single-file form older updaters read.
const files = [...zips, ...dmgs];

const yaml = `version: ${version}
files:
${files.map(f => `  - url: ${f.url}
    sha512: ${f.sha512}
    size: ${f.size}`).join('\n')}
path: ${zips[0].url}
sha512: ${zips[0].sha512}
releaseDate: '${new Date().toISOString()}'
`;

const outFile = path.join(outDir, 'latest-mac.yml');
fs.writeFileSync(outFile, yaml);
console.log(`Generated ${outFile}`);
console.log(yaml);
