# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - Unreleased

Theme: Test Locally, Secure by Default. Catch workflow problems before pushing, and enforce least-privilege sandboxing.

### Added
- **Target management from the CLI**: `localmost targets` lists, adds, removes, enables, and disables targets
  - `localmost targets add <owner>/<repo>` registers runners without opening the app
  - `--org` for organization targets, `--json` on every subcommand for scripting
  - `remove` confirms interactively and requires `--yes` outside a terminal
- **GitHub App now requests `Contents: Read`**: needed to fetch `.localmostrc` from private
  repositories. Existing installations will be prompted to accept the new permission; until
  accepted, jobs from private repos with a policy are refused rather than run under a weaker
  sandbox
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
- **Policy Approval**: A repository's `.localmostrc` takes effect only once approved
  - A new or changed policy holds the job and cancels the run, with the diff logged
  - Review with `localmost policy diff`, approve with `localmost policy approve`
  - A repository with no policy is never held: it runs on the baseline, which
    grants nothing extra
  - The approved copy is applied, so a change pushed after approval cannot take
    effect until it is reviewed
- **Sandbox Policy Levels**: Choose enforcement strength in Settings under Job Security
  - `strict` (default): runner infrastructure plus what `.localmostrc` declares. Filesystem access is never granted implicitly, so a policy states everything a job may touch
  - `moderate`: also allows GitHub Actions infrastructure, common registries, and tool caches
  - `permissive`: no restrictions, for trusted repos or debugging
  - Per-job summary of allowed and blocked hosts in the runner log
- **Proxy-Enforced Network Policy**: Hostname filtering moved from `sandbox-exec` to the local proxy
  - macOS `sandbox-exec` cannot filter by hostname; its `(remote ...)` filter only matches
    IP addresses and ports, so the previous domain patterns never took effect
  - The sandbox now permits only localhost TCP and routes egress through the proxy,
    which enforces the hostname allowlist
  - Unix socket access is denied by default and opted into via a `sockets.allow` policy section
- **Per-Repository Network Policy**: The runner reads `.localmostrc` from the repository at the job's commit and applies its `network.allow` to that job's proxy
  - Lets a repository declare the hosts its own build needs, rather than relying only on the built-in allowlists
  - Applies per job, so one repository's hosts never leak into another's
- **Contributor-Based Job Filtering**: Decide which jobs may run by who is involved
  - Scope: everyone, the workflow trigger author, or every contributor to the repo
  - Allowed users: just you, or an explicit allowlist
  - The decision is made before a worker is spawned, so a disallowed job never
    starts; the run is then cancelled through the GitHub API
  - The check fails closed when contributors cannot be determined
- **Reusable Workflow Support** in `localmost test`
  - Local `uses: ./.github/workflows/...` references
  - `workflow_call` inputs and outputs, passed to dependent jobs via `needs`
- **Environment Comparison**: Detect differences between local and GitHub runner environments
  - `localmost env` command shows local tooling versions
  - Compare against any GitHub runner label
  - Suggestions for pinning versions in workflows

### Security
- Secret values are masked out of step output. A step that printed one - `set -x`,
  a tool dumping its config - previously spilled it into the console and the log
  file.
- Secrets are no longer exported into every step's environment. They reach a step
  only through `${{ secrets.X }}`, as on GitHub, rather than being visible to
  every child process.
- `localmost test` gained `--secret-file`, and `--secrets prompt` now actually
  prompts without echoing. A stubbed secret is announced instead of silently
  becoming an empty string.
- The step script, which contains expanded secrets while a step runs, is written
  0700 rather than 0755.
- The broker no longer logs the head of a job payload, which carries the job's
  secrets, and drops the payload once the worker has taken it instead of holding
  it for the life of the process.

### Fixed
- A step under `strict` no longer dies with an unexplained SIGABRT. The root
  directory node is now readable, so an absolute path can resolve; a policy that
  is missing something fails with the path that was blocked. `HOME` also pointed
  at the user's real home directory rather than the workspace, so tools failed on
  dotfiles the sandbox denies.
- Jobs are no longer dropped after being acquired from GitHub. The broker
  checked capacity, then acquired the job over the network before any worker
  existed, so concurrent jobs could take the last slot in between; the job was
  then never run and failed on its own timeout with no steps recorded. Worker
  slots are now claimed in a single step, and a job waits for a slot rather
  than being discarded.

### Changed
- CLI restructured with standalone commands that don't require the app
- Improved help text with examples for all commands

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

[0.3.0]: https://github.com/bfulton/localmost/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/bfulton/localmost/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bfulton/localmost/releases/tag/v0.1.0
