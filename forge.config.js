const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const { execSync } = require('child_process');
const path = require('path');
const { afterCopyExtraResources: removeUsageDescriptions } = require('./scripts/remove-usage-descriptions');
const vmResources = require('./scripts/check-vm-resources');
const { MACOS_MINIMUM } = require('./scripts/macos-minimum');

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

// The camera helper the app runs to tell when the camera is on. It comes
// from the is-camera-on package; the app runs it from Resources, where it is
// signed with the app (see src/main/resource-monitor/camera-helper.ts).
const CAMERA_HELPER = path.join(path.dirname(require.resolve('is-camera-on')), 'is-camera-on');

// The Docker VM: the helper that runs one Linux VM per job, the guest it
// boots, and the docker CLI jobs run. `npm run build:native` (generateAssets
// below) puts them in build/, where development runs also find them
// (src/main/vm/paths.ts); prePackage checks them before they are copied.
const VM_HELPER = path.join(__dirname, 'build', 'localmost-vm'); // -> Resources/localmost-vm
const GUEST_DIR = path.join(__dirname, 'build', 'guest'); // -> Resources/guest/
const DOCKER_CLI_DIR = path.join(__dirname, 'build', 'docker-cli'); // -> Resources/docker-cli/docker

// Languages to keep (English only for now)
const keepLanguages = ['en', 'en-US', 'en-GB'];

// Base packager config
const packagerConfig = {
  name: 'localmost',
  executableName: 'localmost',
  appBundleId: 'com.localmost.app',
  appCategoryType: 'public.app-category.developer-tools',
  icon: path.join(__dirname, 'build', 'generated', 'icon'),
  asar: true,
  darwinDarkModeSupport: true,
  extraResource: [
    path.join(__dirname, 'build', 'generated'),
    path.join(__dirname, 'build', 'dist', 'cli.js'),
    path.join(__dirname, 'scripts', 'localmost-cli'),
    path.join(__dirname, 'packaging', 'app-update.yml'),
    CAMERA_HELPER,
    VM_HELPER,
    GUEST_DIR,
    DOCKER_CLI_DIR,
  ],
  // The VM backend needs macOS 14 (design decision 12); Electron's template
  // says 12.0. The update manifest carries the same minimum
  // (scripts/macos-minimum.js).
  extendInfo: { LSMinimumSystemVersion: MACOS_MINIMUM },
  // Electron's template declares camera, microphone, audio capture and
  // Bluetooth usage the app has no entitlement for; extendInfo cannot remove
  // a key, so this hook does. It is the last step before osx-sign, so the
  // signature covers the edited Info.plist (see the script). Packager runs it
  // only when extraResource above is set: without that list, it is skipped
  // and the strings ship (src/main/packaging.test.ts checks both).
  afterCopyExtraResources: [removeUsageDescriptions],
  // Only the built app code, package.json and LICENSE go in the bundle.
  // build/ also holds forge's own output, so allow only build/dist within it.
  ignore: [
    /^\/(?!build$|build\/dist(\/|$)|package\.json$|LICENSE$)/,
    // Also exclude source maps
    /\.map$/,
  ],
};

// Entitlements for each file osx-sign signs. @electron/osx-sign reads
// entitlements and hardened runtime only from optionsForFile; without it,
// it signs the app with its own defaults, which grant camera, microphone,
// USB, Bluetooth, printing and location. The plugin helper keeps what
// Chromium gives its own; the camera helper, a Swift program, and the docker
// CLI, a Go program, need nothing; the VM helper gets Virtualization.framework
// and nothing else; everything else gets only JIT.
function signOptionsForFile(filePath) {
  let plist = 'entitlements.plist';
  if (filePath.includes('(Plugin).app')) {
    plist = 'entitlements.plugin.plist';
  } else if (inAppResources(filePath, path.basename(CAMERA_HELPER)) || inAppResources(filePath, 'docker-cli', 'docker')) {
    plist = 'entitlements.none.plist';
  } else if (inAppResources(filePath, path.basename(VM_HELPER))) {
    plist = 'entitlements.virtualization.plist';
  }
  return {
    hardenedRuntime: true,
    entitlements: path.join(__dirname, 'packaging', plist),
  };
}

// The app's own Resources, <name>.app/Contents/Resources: not a nested
// helper app's, which also ends in .app/Contents/Resources.
const APP_RESOURCES = path.join(path.sep + `${packagerConfig.name}.app`, 'Contents', 'Resources');

// Whether filePath is exactly Resources/<...parts> of the app.
function inAppResources(filePath, ...parts) {
  return filePath.endsWith(path.join(APP_RESOURCES, ...parts));
}

// Passed as osxSign's `ignore`. The guest is data for the VM, not macOS
// code. Without this, osx-sign signs every file isbinaryfile flags
// (vmlinux, the initramfs, the erofs root) and gives each an xattr signature
// carrying the app's entitlements. The app's own signature still seals them
// as resources.
function ignoreGuest(filePath) {
  return filePath.includes(path.join(APP_RESOURCES, path.basename(GUEST_DIR)) + path.sep);
}

// Override with signing config if credentials are available
if (shouldSign) {
  packagerConfig.osxSign = {
    identity: signingIdentity,
    optionsForFile: signOptionsForFile,
    ignore: ignoreGuest,
    // Unset, @electron/packager takes this as true and only warns when
    // signing fails, so the build would go on to ship unsigned code.
    continueOnError: false,
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
  outDir: 'build/out',
  packagerConfig,
  rebuildConfig: {},
  hooks: {
    // Build the helper and the guest and fetch the docker CLI into build/.
    // Each step keeps its own cache. The guest build boots a VM, so it runs
    // outside any localmost job (docs/release-checklist.md).
    generateAssets: async () => {
      const { spawnSync } = require('child_process');
      const result = spawnSync('npm', ['run', 'build:native'], { cwd: __dirname, stdio: 'inherit' });
      if (result.status !== 0) {
        const why = result.error ? result.error.message : `exit status ${result.status}`;
        throw new Error(`npm run build:native failed: ${why}`);
      }
    },
    // localmost is built for Apple silicon only: refuse an Intel or
    // universal build rather than make one. And never ship without the VM,
    // or with anything beside it that was not meant to ship.
    prePackage: async (config, platform, arch) => {
      if (arch !== 'arm64') {
        throw new Error(`localmost is built for Apple silicon (arm64) only, not ${arch}`);
      }
      vmResources.checkVmResources({
        helper: VM_HELPER,
        guestDir: GUEST_DIR,
        dockerCliDir: DOCKER_CLI_DIR,
      });
    },
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
        icon: path.join(__dirname, 'build', 'generated', 'icon.icns'),
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
