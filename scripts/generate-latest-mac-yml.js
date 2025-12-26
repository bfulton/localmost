#!/usr/bin/env node
/**
 * Generate latest-mac.yml for electron-updater.
 * Run after `npm run make` to create the file for GitHub release upload.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pkg = require('../package.json');
const version = pkg.version;

const outDir = path.join(__dirname, '..', 'out', 'make');

function sha512(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha512').update(data).digest('base64');
}

function getFileSize(filePath) {
  return fs.statSync(filePath).size;
}

const files = [];

// Check for arm64 DMG
const arm64Dmg = path.join(outDir, `localmost-${version}-arm64.dmg`);
if (fs.existsSync(arm64Dmg)) {
  files.push({
    url: path.basename(arm64Dmg),
    sha512: sha512(arm64Dmg),
    size: getFileSize(arm64Dmg),
  });
}

// Check for x64 DMG
const x64Dmg = path.join(outDir, `localmost-${version}-x64.dmg`);
if (fs.existsSync(x64Dmg)) {
  files.push({
    url: path.basename(x64Dmg),
    sha512: sha512(x64Dmg),
    size: getFileSize(x64Dmg),
  });
}

if (files.length === 0) {
  console.error('No DMG files found in out/make/');
  process.exit(1);
}

const yaml = `version: ${version}
files:
${files.map(f => `  - url: ${f.url}
    sha512: ${f.sha512}
    size: ${f.size}`).join('\n')}
path: ${files[0].url}
sha512: ${files[0].sha512}
releaseDate: '${new Date().toISOString()}'
`;

const outFile = path.join(outDir, 'latest-mac.yml');
fs.writeFileSync(outFile, yaml);
console.log(`Generated ${outFile}`);
console.log(yaml);
