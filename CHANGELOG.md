# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - Unreleased

Theme: Test Locally, Secure by Default. Catch workflow problems before pushing, and enforce least-privilege sandboxing.

### Added
- **Workflow Test Mode**: Run workflows locally before pushing with `localmost test`
  - Intercepts `actions/checkout` to use local working tree
  - Intercepts `actions/cache` for local caching
  - Stubs `actions/upload-artifact` and `actions/download-artifact`
  - Matrix support with `--full-matrix` and `--matrix` options
  - Environment diff reporting with `--env` flag
- **Declarative Sandbox Policy**: Per-repo `.localmostrc` files that declare allowed access
  - Default-deny sandbox for network and filesystem
  - Per-workflow policy overrides
  - Discovery mode with `localmost test --updaterc`
  - Policy validation with `localmost policy validate`
- **Environment Comparison**: Detect differences between local and GitHub runner environments
  - `localmost env` command shows local tooling versions
  - Compare against any GitHub runner label
  - Suggestions for pinning versions in workflows
- **Policy Cache**: Background runner caches and validates `.localmostrc` changes
  - Requires approval when policy changes
  - Diff display for policy modifications

### Changed
- CLI restructured with standalone commands that don't require the app
- Improved help text with examples for all commands

## [0.2.1] - 2025-12-26

### Fixed
- Minor bug fixes

## [0.2.0] - 2025-12-26

Core improvements to architecture to enable multiple targets.

### Added
- Multi-target runner proxy support
- Resource-aware job scheduling
- CLI companion for terminal control
- Auto-update

### Fixed
- Runner state synchronization issues
- Proxy concurrency fixes
- Session persistence and cleanup

## [0.1.0] - 2025-12-20

Initial release of localmost, a Mac app which manages GitHub Actions runners.

[0.3.0]: https://github.com/bfulton/localmost/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/bfulton/localmost/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/bfulton/localmost/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bfulton/localmost/releases/tag/v0.1.0
