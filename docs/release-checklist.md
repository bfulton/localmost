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
- [ ] Build the Docker VM's guest on this Mac, outside any localmost job (the guest build boots a VM, which a job's sandbox cannot, and no CI job can do it): `npm run build:guest -- --verify-reproducible`
  - It builds the guest twice and fails unless both are byte-identical, then smoke-boots it: the smoke boot must pass, and `build/guest/manifest.json` must carry the `baseline` and `docker` it recorded
  - `ls build/guest` shows exactly `LICENSES.md`, `initramfs.cpio.gz`, `manifest.json`, `rootfs.erofs` and `vmlinux`
- [ ] `rm -rf build/out/make`
- [ ] `npm run make` (Apple silicon only: the script passes `--arch=arm64`, and the build refuses any other arch)
  - It runs `npm run build:native` first (the VM helper, the guest from the cache the step above filled, and the pinned docker CLI), and refuses to package if `build/guest` holds anything but those five files, if a guest file differs from `manifest.json`, or if the helper or the CLI is missing
- [ ] Verify output shows:
  - `Signing: Developer ID Application: ...`
  - `Notarize: true`
  - `Release build: true`
- [ ] Test the DMG installs correctly
- [ ] `codesign -d --entitlements -` on each of these (under `build/out/localmost-darwin-arm64/localmost.app`) lists only the keys shown, and no `device.*`, `personal-information.*` or `app-sandbox` key:
  - the app, and `Contents/Frameworks/localmost Helper (GPU).app`: only `com.apple.security.cs.allow-jit`
  - `Contents/Frameworks/localmost Helper (Plugin).app`: only `com.apple.security.cs.allow-unsigned-executable-memory` and `com.apple.security.cs.disable-library-validation`
  - `Contents/Resources/localmost-vm`: only `com.apple.security.virtualization`
  - `Contents/Resources/docker-cli/docker` and `Contents/Resources/is-camera-on`: none
- [ ] `xattr -l` on each file in `Contents/Resources/guest` lists no `com.apple.cs.*` attribute: the guest is the VM's data, and signing leaves it alone
- [ ] `plutil -extract LSMinimumSystemVersion raw` on the app's `Contents/Info.plist` prints `14.0`
- [ ] `plutil -p` on the app's `Contents/Info.plist` and on each `Contents/Frameworks/localmost Helper*.app/Contents/Info.plist` shows no `UsageDescription` key, and `codesign --verify --deep --strict --verbose=2` on the app passes (the plist is edited before signing, so the signature must cover it)
- [ ] `node scripts/generate-latest-mac-yml.js`
  - Needs the arm64 build made, and nothing else in `build/out/make` (it refuses an Intel, universal or other version's DMG or zip); copies the update zip to `build/out/make/localmost-X.Y.Z-arm64-mac.zip`
  - Verify `latest-mac.yml` lists the `-arm64-mac.zip` and `-arm64.dmg` files only, and `path:` names the zip (the in-app updater installs only from a zip)
  - Verify `latest-mac.yml` has `minimumSystemVersion: 23.0.0`, the Darwin version of the `LSMinimumSystemVersion` above (macOS 14), so the updater on a Mac too old to open the release does not offer it

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
  - Attach the Docker VM guest's sources, since the app now ships GPL code in `Resources/guest`: `build/guest/LICENSES.md`; the Alpine aports commit it names; and the upstream source tarballs, with Alpine's patches from that commit, of every package it lists under a GPL or LGPL license (linux, busybox, iptables and e2fsprogs among them), at the versions `scripts/guest/packages.lock.json` pins
  - Attach the NOTICE files of the Apache-licensed code the app ships: the docker CLI (`scripts/docker-cli.lock.json` names its version) and, in the guest, docker-engine, containerd and runc
- [ ] Publish release
- [ ] Bump the release version in [package.json](https://github.com/bfulton/localmost/edit/main/package.json)
- [ ] Update [CHANGELOG.md](https://github.com/bfulton/localmost/edit/main/CHANGELOG.md) with proper release dates and links, and section for next unreleased version
