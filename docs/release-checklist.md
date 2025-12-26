# Release Checklist

## Pre-Release
- [ ] Cut release-prep-vX.Y.Z branch
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
- [ ] Set notarization credentials:
  ```bash
  export APPLE_ID="your@email.com"
  export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
  export APPLE_TEAM_ID="XXXXXXXXXX"
  ```
- [ ] `npm run make`
- [ ] Verify output shows:
  - `Signing: Developer ID Application: ...`
  - `Notarize: true`
  - `Release build: true`

## Post-Build
- [ ] Test the DMG installs correctly
- [ ] Test basic functionality (add target, run job)
- [ ] Upload DMG to GitHub release
- [ ] Tag the release: `git tag vX.Y.Z && git push --tags`
- [ ] Bump the release version in [package.json](https://github.com/bfulton/localmost/edit/main/package.json)
- [ ] Update [CHANGELOG.md](https://github.com/bfulton/localmost/edit/main/CHANGELOG.md) with proper release dates and links, and section for next unreleased version
