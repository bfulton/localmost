# Release Checklist

## Pre-Release
- [ ] Cut release-prep-X.Y.Z branch
- [ ] Ensure correct release version in package.json
- [ ] Update CHANGELOG.md with release notes for unreleased version
- [ ] Merge release-prep branch to main and delete branch
- [ ] All changes merged to `main`
- [ ] `git checkout main && git pull`
- [ ] `git status` shows clean working tree
- [ ] `npm run build` passes with no warnings
- [ ] `npm run lint` passes with no warnings
- [ ] `npm test` passes with no warnings

## Build
- [ ] Set notarization credentials (usually in .envrc):
  ```bash
  export APPLE_ID="your@email.com"
  export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
  export APPLE_TEAM_ID="XXXXXXXXXX"
  ```
- [ ] `rm -rf build/out/make`
- [ ] `npm run make -- --arch=x64`
- [ ] Verify output shows:
  - `Signing: Developer ID Application: ...`
  - `Notarize: true`
  - `Release build: true`
- [ ] `npm run make -- --arch=arm64`
- [ ] Verify output shows:
  - `Signing: Developer ID Application: ...`
  - `Notarize: true`
  - `Release build: true`
- [ ] Test the DMG installs correctly
- [ ] `codesign -d --entitlements -` on each of these (both arches, under `build/out/localmost-darwin-<arch>/localmost.app`) lists only the keys shown, and no `device.*`, `personal-information.*` or `app-sandbox` key:
  - the app, and `Contents/Frameworks/localmost Helper (GPU).app`: only `com.apple.security.cs.allow-jit`
  - `Contents/Frameworks/localmost Helper (Plugin).app`: only `com.apple.security.cs.allow-unsigned-executable-memory` and `com.apple.security.cs.disable-library-validation`
- [ ] `plutil -p Contents/Info.plist` on each arch's app shows no `UsageDescription` key, and `codesign --verify --deep --strict --verbose=2` on the app passes (the plist is edited before signing, so the signature must cover it)
- [ ] `node scripts/generate-latest-mac-yml.js`
  - Needs both arches made; copies each arch's update zip to `build/out/make/localmost-X.Y.Z-<arch>-mac.zip`
  - Verify `latest-mac.yml` lists both `-mac.zip` files and `path:` names a zip (the in-app updater installs only from a zip)

## Post-Build
- [ ] Smoke test basic functionality through installed app:
  - Start from scratch
  - Authenticate
  - Download runner
  - Add targets
  - Run job
  - Exit
  - Restart
  - Run job
- [ ] Draft a [new release](https://github.com/bfulton/localmost/releases/new)
  - Tag: vX.Y.Z
  - Target: main
  - Release title: X.Y.Z
  - Release notes: copy from CHANGELOG.md
  - Attach `build/out/make/localmost-X.Y.Z-arm64.dmg`
  - Attach `build/out/make/localmost-X.Y.Z-x64.dmg`
  - Attach `build/out/make/localmost-X.Y.Z-arm64-mac.zip`
  - Attach `build/out/make/localmost-X.Y.Z-x64-mac.zip`
  - Attach `build/out/make/latest-mac.yml`
- [ ] Publish release
- [ ] Bump the release version in [package.json](https://github.com/bfulton/localmost/edit/main/package.json)
- [ ] Update [CHANGELOG.md](https://github.com/bfulton/localmost/edit/main/CHANGELOG.md) with proper release dates and links, and section for next unreleased version
