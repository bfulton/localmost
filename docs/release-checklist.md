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
- [ ] `rm -rf out/make`
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
- [ ] `node scripts/generate-latest-mac-yml.js`

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
  - Attach `out/make/localmost-X.Y.Z-arm64.dmg`
  - Attach `out/make/localmost-X.Y.Z-x64.dmg`
  - Attach `out/make/latest-mac.yml`
  - Attach `out/make/zip/darwin/arm64/localmost-darwin-arm64-X.Y.Z.zip`
  - Attach `out/make/zip/darwin/x64/localmost-darwin-x64-X.Y.Z.zip`
- [ ] Publish release
- [ ] Bump the release version in [package.json](https://github.com/bfulton/localmost/edit/main/package.json)
- [ ] Update [CHANGELOG.md](https://github.com/bfulton/localmost/edit/main/CHANGELOG.md) with proper release dates and links, and section for next unreleased version
