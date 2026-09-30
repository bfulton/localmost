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
- [ ] `npm run make` (Apple silicon only: the script passes `--arch=arm64`, and the build refuses any other arch)
- [ ] Verify output shows:
  - `Signing: Developer ID Application: ...`
  - `Notarize: true`
  - `Release build: true`
- [ ] Test the DMG installs correctly
- [ ] `codesign -d --entitlements -` on each of these (under `build/out/localmost-darwin-arm64/localmost.app`) lists only the keys shown, and no `device.*`, `personal-information.*` or `app-sandbox` key:
  - the app, and `Contents/Frameworks/localmost Helper (GPU).app`: only `com.apple.security.cs.allow-jit`
  - `Contents/Frameworks/localmost Helper (Plugin).app`: only `com.apple.security.cs.allow-unsigned-executable-memory` and `com.apple.security.cs.disable-library-validation`
- [ ] `plutil -p` on the app's `Contents/Info.plist` and on each `Contents/Frameworks/localmost Helper*.app/Contents/Info.plist` shows no `UsageDescription` key, and `codesign --verify --deep --strict --verbose=2` on the app passes (the plist is edited before signing, so the signature must cover it)
- [ ] `node scripts/generate-latest-mac-yml.js`
  - Needs the arm64 build made, and nothing else in `build/out/make` (it refuses an Intel, universal or other version's DMG or zip); copies the update zip to `build/out/make/localmost-X.Y.Z-arm64-mac.zip`
  - Verify `latest-mac.yml` lists the `-arm64-mac.zip` and `-arm64.dmg` files only, and `path:` names the zip (the in-app updater installs only from a zip)

## Post-Build
- [ ] Smoke test basic functionality through installed app:
  - Start from scratch
  - Authenticate
  - Download runner
  - Add targets
  - Run job
  - With "Pause during video calls" on, turn a camera on (for example in FaceTime): runners pause, and resume about a minute after it is off. The Info.plist declares no camera usage, so also check that `~/Library/Logs/DiagnosticReports` has no new crash report for `is-camera-on` or localmost
  - Exit
  - Restart
  - Run job
- [ ] Draft a [new release](https://github.com/bfulton/localmost/releases/new)
  - Tag: vX.Y.Z
  - Target: main
  - Release title: X.Y.Z
  - Release notes: copy from CHANGELOG.md
  - Attach `build/out/make/localmost-X.Y.Z-arm64.dmg`
  - Attach `build/out/make/localmost-X.Y.Z-arm64-mac.zip`
  - Attach `build/out/make/latest-mac.yml`
- [ ] Publish release
- [ ] Bump the release version in [package.json](https://github.com/bfulton/localmost/edit/main/package.json)
- [ ] Update [CHANGELOG.md](https://github.com/bfulton/localmost/edit/main/CHANGELOG.md) with proper release dates and links, and section for next unreleased version
