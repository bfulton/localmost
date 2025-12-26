const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const { execSync } = require('child_process');
const path = require('path');

// Detect signing identities from keychain
function getSigningIdentities() {
  try {
    const output = execSync('security find-identity -v -p codesigning', { encoding: 'utf-8' });
    const identities = new Map(); // Use Map to dedupe by hash
    const regex = /^\s*\d+\)\s+([A-F0-9]+)\s+"(.+)"$/gm;
    let match;
    while ((match = regex.exec(output)) !== null) {
      const [, hash, name] = match;
      if (!identities.has(hash)) {
        identities.set(hash, name);
      }
    }
    return Array.from(identities.values());
  } catch {
    return [];
  }
}

// Check if this is a release build (on main with no uncommitted changes)
// Can be overridden with RELEASE_BUILD=true for testing
function isReleaseBuild() {
  if (process.env.RELEASE_BUILD === 'true') return true;
  if (process.env.RELEASE_BUILD === 'false') return false;

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
    const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
    return branch === 'main' && status === '';
  } catch (err) {
    console.error('Warning: Failed to detect git state for signing identity:', err.message);
    return false;
  }
}

// Find the appropriate signing identity
// For release builds (on main, clean tree), use "Developer ID Application" (for direct distribution)
// For dev builds (branch or uncommitted changes), use "Apple Development"
function getSigningIdentity() {
  if (process.env.APPLE_IDENTITY === '-') return null;
  if (process.env.APPLE_IDENTITY) return process.env.APPLE_IDENTITY;

  const identities = getSigningIdentities();
  const preferredPrefix = isReleaseBuild() ? 'Developer ID Application' : 'Apple Development';

  // First try preferred identity type
  const preferred = identities.find(id => id.startsWith(preferredPrefix));
  if (preferred) return preferred;

  // Fall back to any available identity
  return identities[0] || null;
}

const signingIdentity = getSigningIdentity();
const shouldSign = Boolean(signingIdentity);
// Only notarize for release builds (Distribution identity) with credentials
const shouldNotarize = Boolean(isReleaseBuild() && process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);

console.log(`Signing: ${shouldSign ? signingIdentity : 'disabled'}`);
console.log(`Notarize: ${shouldNotarize}`);
console.log(`Release build: ${isReleaseBuild()}`);

// Languages to keep (English only for now)
const keepLanguages = ['en', 'en-US', 'en-GB'];

// Base packager config
const packagerConfig = {
  name: 'localmost',
  executableName: 'localmost',
  appBundleId: 'com.localmost.app',
  appCategoryType: 'public.app-category.developer-tools',
  icon: path.join(__dirname, 'assets', 'generated', 'icon'),
  asar: true,
  darwinDarkModeSupport: true,
  extraResource: [
    path.join(__dirname, 'assets', 'generated'),
    path.join(__dirname, 'dist', 'cli.js'),
    path.join(__dirname, 'scripts', 'localmost-cli'),
    path.join(__dirname, 'build', 'app-update.yml'),
  ],
  // Only include dist/, package.json, and LICENSE in the app bundle
  ignore: [
    // Ignore everything except dist/, package.json, LICENSE
    /^\/(?!dist\/|dist$|package\.json$|LICENSE$)/,
    // Also exclude source maps
    /\.map$/,
  ],
};

// Override with signing config if credentials are available
if (shouldSign) {
  packagerConfig.osxSign = {
    identity: signingIdentity,
    hardenedRuntime: true,
    entitlements: path.join(__dirname, 'entitlements.plist'),
    'entitlements-inherit': path.join(__dirname, 'entitlements.inherit.plist'),
    'gatekeeper-assess': false,
  };

  // Only notarize if signing is enabled and notarize credentials are available
  if (shouldNotarize) {
    packagerConfig.osxNotarize = {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    };
  }
}

module.exports = {
  packagerConfig,
  rebuildConfig: {},
  hooks: {
    postPackage: async (config, packageResult) => {
      const fs = require('fs');

      // Strip unused locales to reduce app size
      const localesDir = path.join(packageResult.outputPaths[0], 'locales');

      if (fs.existsSync(localesDir)) {
        const files = fs.readdirSync(localesDir);
        let removed = 0;
        for (const file of files) {
          const lang = file.replace('.pak', '');
          if (!keepLanguages.includes(lang)) {
            fs.unlinkSync(path.join(localesDir, file));
            removed++;
          }
        }
        console.log(`Stripped ${removed} unused locale files (kept: ${keepLanguages.join(', ')})`);
      }

    },
    postMake: async (config, makeResults) => {
      // Open the DMG after build
      const dmg = makeResults.find(r => r.artifacts.some(a => a.endsWith('.dmg')));
      if (dmg) {
        const dmgPath = dmg.artifacts.find(a => a.endsWith('.dmg'));
        if (dmgPath) {
          // Use spawnSync with array args to prevent command injection
          const { spawnSync } = require('child_process');
          console.log(`Opening ${dmgPath}`);
          spawnSync('open', [dmgPath], { stdio: 'inherit' });
        }
      }
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        icon: path.join(__dirname, 'assets', 'generated', 'icon.icns'),
        format: 'ULFO',
      },
    },
  ],
  plugins: [
    // Auto-unpack-natives handles native modules, only needed with native deps
    // Security: Enable Electron Fuses for all builds to harden the application
    // These fuses disable dangerous Electron features that could be exploited
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,                           // Disable ELECTRON_RUN_AS_NODE
      [FuseV1Options.EnableCookieEncryption]: true,                // Encrypt cookies at rest
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, // Disable NODE_OPTIONS injection
      [FuseV1Options.EnableNodeCliInspectArguments]: false,        // Disable --inspect debugging
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true, // Validate asar integrity
      [FuseV1Options.OnlyLoadAppFromAsar]: true,                   // Only load from asar, not loose files
    }),
  ],
};
