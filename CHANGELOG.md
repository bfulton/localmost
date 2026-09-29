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
- **Opt-in container work through a filtering Docker socket**: an approved
  `.localmostrc` may declare the `pull`, `run` and `build` actions a job needs,
  with the registries, images, workspace mounts (`ro`/`rw`), network mode and
  build context each covers. The job is never handed the daemon socket: each
  worker gets a socket localmost owns, and only declared requests are forwarded
  to the daemon. Anything unlisted is denied, host bind mounts and
  `--privileged`/`--pid=host`/`--network=host`/`--device` are refused, and
  registry credentials are attached by the proxy so the job never reads
  `~/.docker/config.json`. Default off. Allowed in `shared` and per workflow.
  See `docs/superpowers/specs/2026-09-05-docker-isolation-design.md`
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

### Removed
- **`sockets:` policy key**: it was honoured by `localmost test` only, never by the
  runner, and accepted arbitrary socket paths. Declare `docker:` instead

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
- `localmost test` reads a secret from `LOCALMOST_SECRET_<name>`, no longer from
  a variable under the secret's own name, so a workflow cannot ask for
  `AWS_SECRET_ACCESS_KEY` or `GITHUB_TOKEN` and get what you exported for other
  tools. Re-export secrets under the prefix; the CLI says when one is set but unused.
- A `localmost test` step reaches only the run's proxy on loopback, and signals
  only processes under its own sandbox. A test suite that starts local servers
  declares `shared.network.loopback: true` (or its fixed ports) in `.localmostrc`,
  which is listed and confirmed with the rest of the policy; `--updaterc` cannot
  discover it. A later step can no longer kill a server an earlier step started;
  the end of the job reaps it.
- `localmost test` fetches an action pinned to a commit SHA, and keeps each
  cached action in a directory of its own. Actions cached under the old layout
  are fetched again, and their old directories under `actions/` in the app's data
  directory can be deleted.
- The step script, which contains expanded secrets while a step runs, is written
  0700 rather than 0755.
- The broker no longer logs the head of a job payload, which carries the job's
  secrets, and drops the payload once the worker has taken it instead of holding
  it for the life of the process.
- A runner job reaches loopback only on the broker's port and the ports its
  approved `shared.network.loopback` declares, whether it connects directly or
  through `HTTP_PROXY`: a request for `127.0.0.1:<port>` sent through the proxy
  now gets 403 on any other port, and `localhost`, as a name, is refused through
  the proxy on every port. A test suite that binds ephemeral ports declares
  `loopback: true`.
- A runner job's approved `network.deny` and `filesystem.deny` are enforced, and
  a change to its filesystem deny list or loopback grant retires the workers
  built under the old one.
- A `filesystem.deny` entry with `*` in it now refuses what it matches in a
  runner job; it was written as a literal path and matched nothing. Every deny,
  in a runner job and in `localmost test`, is also applied by its real path, so
  one written through `/tmp`, `/etc`, `/var` or a symlink of your own holds.
- `.localmostrc` refuses a network entry that is not a host pattern - a URL such
  as `https://evil.com`, a path, surrounding spaces, or a host in a spelling the
  proxy never compares - and a relative `filesystem.deny` entry. Each was
  accepted and shown, and allowed or denied nothing.
- An approved policy is bound to the repository's id as well as its name. A job
  from a different repository that now holds an approved name - the approved one
  deleted or renamed, and the name taken since - is refused until the policy is
  reviewed again in Settings > Job Security.
- Under the **Repo contributors** scope, a repository with any commit author
  not linked to a GitHub account (an unattributed commit) is refused, since
  anyone can write such a commit and no allowlist can admit it. In practice so
  is one with more than 500 author emails, since GitHub links only the first 500
  to accounts and lists the rest as anonymous. Repositories
  this scope admitted before can now be refused; the refusal names the
  unattributed commit, email or name.

### Fixed
- Pausing stops the runner taking jobs. A paused runner went on acquiring every
  job GitHub offered it; a job offered while paused is now left queued with
  GitHub. `localmost pause` and `resume` do what the tray's do: pause no longer
  answers "already paused" for an idle runner or kills a running job, and
  `localmost status` shows the pause. A pause made while the runner is still
  starting holds, and it comes up paused.
- An organization target's jobs get their repository's approved policy. The
  policy was looked up under the target's display name, the organization, which
  names no repository, so they ran with none of their grants.
- A worker's policy follows the job it claimed - that job's repository and
  workflow - rather than the one it was spawned for, and a policy lookup still
  in flight when its worker exits is no longer installed on the slot's next
  worker.
- Per-workflow policy sections now match the workflow filename, as documented.
  They were matched against the job name scraped from the runner's output, so a
  `workflows.<name>` section fired only when a job happened to share its
  workflow's name.
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
- `localmost test --updaterc` no longer writes a `.localmostrc` it cannot read
  back. Env patterns such as `*_TOKEN` and workflow names containing `: ` are
  quoted, as is a workflow name such as `1.0` or `True` that YAML would read
  back as a different key, and a section left empty is omitted rather than
  written as a bare key.

### Changed
- **Breaking policy change**: `docker: socket | contexts | credentials`, accepted
  by pre-release 0.3.0 builds, is now a validation error naming the actions that
  replace it. Migrate by declaring what the job does: `socket` and `contexts`
  become `run:` (with `images`, plus `mounts` and `network` if the job binds the
  workspace or needs a network mode) and `pull:` naming the registries it pulls
  from; `credentials` becomes a private registry listed under `pull.registries`.
  The proxy authenticates on the job's behalf, so the job no longer reads
  `~/.docker/config.json` and nothing under `~/.docker` is opened at any level.
  `localmost test --updaterc` writes the actions from a run's denials
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
