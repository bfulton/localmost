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
  to the daemon. Anything unlisted is denied, host bind mounts,
  `--privileged`/`--pid=host`/`--network=host`/`--device` and a restart policy
  other than `no` (`--restart=always`, `unless-stopped`, `on-failure`) are
  refused, and registry credentials are attached by the proxy so the job never
  reads `~/.docker/config.json`. The containers and networks a job created are
  removed when the job ends, the containers with their anonymous volumes, if
  localmost is still running then (Docker Access in `SECURITY.md` has the
  exceptions). Default off. Allowed in `shared` and per workflow.
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
- **Sandbox Policy Levels**: A repository declares its enforcement strength in `.localmostrc` (`level:`), approved like the rest of its policy; one that declares none runs `strict`
  - `strict` (default): runner infrastructure, a fixed floor - mostly read-only - of the OS and `/Library/Developer` (the Command Line Tools), plus what `.localmostrc` declares. Xcode itself is read under `moderate` and `permissive`, or when declared
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
- **Cache work directory setting** (`preserveWorkDir`): it linked a worker's
  `_work` to a directory handed to whichever job next took that slot, from any
  repository, with the previous job's checkout in it, and writes through the
  link failed anyway. Every job now gets a fresh `_work` inside its own sandbox.
  A value an earlier build saved is ignored and dropped at the next save, and
  the directories it kept under `~/.localmost/runner/work` are removed at the
  next start

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
- A job whose name carries a runner status phrase - `Runner connect error`,
  `please re-configure` and the like - no longer frees its busy slot or starts
  re-registration. The runner prints the job's name in its output, which was
  read for those phrases before the job start, so the worker was marked failed
  while its job ran on, skipping the user filter and repository policy checks,
  and the next job, from any repository, was built in the same sandbox.
- Every job's sandbox is a new directory, `~/.localmost/runner/sandbox/<n>-<id>`
  with its docker socket inside, and its slot takes no other job until the
  worker's process group is empty or has been sent SIGKILL. A process a job left
  behind kept write access to the fixed `sandbox/<n>`, and so to the next job's
  runner, checkout and docker socket. Anything still running under a finished
  job's sandbox profile is killed, found by the profile's mark rather than the
  process group it can leave; that sweep runs a short script with the developer
  tools' `python3`, and without them only the process group, and the processes
  holding the marker file descriptor, are swept.
- A runner job's approved `network.deny` and `filesystem.deny` are enforced, and
  a change to its filesystem deny list or loopback grant retires the workers
  built under the old one.
- A `filesystem.deny` entry with `*` in it now refuses what it matches in a
  runner job; it was written as a literal path and matched nothing. Every deny,
  in a runner job and in `localmost test`, is also applied by its real path, so
  one written through `/tmp`, `/etc`, `/var` or a symlink of your own holds
  (for a `*` entry, up to the first `*`). The directories above a deny are
  closed to writes, so a job granted one can no longer rename it and read the
  denied path under the new name.
- `.localmostrc` refuses a network entry that is not a host pattern - a URL such
  as `https://evil.com`, a path, a range such as `10.0.0.0/8`, surrounding
  spaces - and a relative `filesystem.deny` entry. Each was accepted and shown,
  and allowed or denied nothing. A network entry must also be in the spelling a
  request's host arrives in (punycode, an address written out, no trailing
  dot), which an allow entry spelled otherwise never matched; the error gives
  the entry to write. An already approved policy with any such entry no longer
  loads, and its jobs are refused until it is fixed and approved again.
- `localmost test` applies the checkout's `network.deny` and reaches an allowed
  host only on its scheme's port (or the port an entry spells), as a runner job
  does. Its proxy took the allow list alone and matched a host on any port.
  `--updaterc` writes a host reached on another port as `host:port`, so the
  next run allows what discovery saw, and reports rather than writes a host no
  entry can name.
- A plain HTTP request, from a runner job or from `localmost test`, goes
  upstream with the host that was checked as its `Host`, not the header the
  client wrote, which on a shared front end - a CDN, a cloud load balancer -
  could name a site the policy does not allow.
- A runner job cannot read or write the app's own data directory
  (`~/.localmost`) or Electron's (`~/Library/Application Support/localmost`),
  whatever its policy grants, beyond its own sandbox and its target's caches,
  and cannot rename a directory above them. A grant of `~`, `~/Library` or the
  like keeps the rest of what it covers.
- The approval screen and `localmost policy show` mark a write grant that
  reaches past the job - LaunchAgents and LaunchDaemons, shell rc files,
  `~/.ssh`, `~/.gitconfig`, `~/.config`, `~/Library/Application Support` and
  the common PATH directories (`/usr/local/bin`, `/opt/homebrew/bin`,
  `~/.local/bin`, `~/bin`) - with what a write there lets a job do: leave code
  that runs as you, outside the sandbox, after the job ends. Such grants are
  still allowed.
- A job's Docker `/info` shows only the daemon's version, platform, kernel, CPU
  count, memory, storage driver, cgroup version and security options. In full
  it described the host: its name, the daemon's proxy URLs with any credentials
  in them, registry mirrors, labels, and how many containers and images you and
  other jobs have.
- The broker sends a job operation upstream on the runner's credentials only
  when it names the job delivered to that worker and no other: any request id
  it carries must have been delivered to that worker, and any plan and job ids
  must be those of the job details the worker acquired. `completejob` and
  `renewjob`, which name a job by those ids alone, were forwarded for whatever
  ids the request carried, as was any operation whose path was spelled in
  another case, or whose body named a job under a key in another case
  (`PlanId`, `RequestId`) or spelled with a letter Go reads as an ASCII one
  (`requeſtId`): the JSON decoders of .NET and Go read a key in any case, and
  GitHub's services may use either. A body with any such key, or any key that
  is not plain ASCII, is now refused, as is a path that decodes to anything but
  plain ASCII.
- The paths the broker answers itself - opening, polling and deleting a
  session, acknowledging a message, acquiring a job, and the worker's token
  endpoint - are no longer forwarded upstream when spelled another way
  (`/Message`, `/message/`, `/%6dessage`, `DELETE /Session`) or sent with
  another method. They went to GitHub's broker on the runner's credentials with
  the target's own session, so a job could poll that session, taking jobs
  before admission saw them, or delete it. Any other path that is not a job
  operation is still forwarded upstream as it comes, on the runner's
  credentials, with the target's session id in place of any session id it
  carries. A query that also names the session id another way (`SessionId`,
  `ſessionId`), or has any parameter name that is not plain ASCII, is refused
  instead, since upstream could read that name beside or instead of the id put
  in its place.
- The Docker filter refuses a request whose body has a key, at any depth, that
  is not plain ASCII, or whose query has such a parameter name. The daemon's Go
  decoder reads some other letters as ASCII ones: it took `HoſtConfig` (long s)
  as `HostConfig`, which the filter read as an unknown key and passed, so a
  create carrying `Privileged`, a bind of `/` or a mount propagation under that
  spelling reached the daemon unchecked. A label or container path named
  outside ASCII is refused as well; values are not affected.
- The Docker filter forwards every permitted JSON body as the object it judged,
  not the bytes it received. A key repeated exactly is kept once by JSON.parse
  but decoded every time by the daemon, whose maps keep what an earlier copy
  added: a network create with host-binding `Options` followed by `"Options":
  {}` was judged empty and created bound.
- The Docker filter refuses a body sent as a type the daemon reads parameters
  from. Go's server takes a form body's parameters over the URL's, and the
  filter streamed such a body through unread: a pull judged against
  `fromImage=postgres` pulled the body's image on the operator's docker.io
  credentials, and a build took `networkmode=host` from it. Each action now
  accepts only the content types that carry no form.
- The Docker filter refuses a body nested deeper than any Docker request.
  Checking its keys overflowed the stack, and the request was never answered.
- The Docker filter keeps the mount boundary where the app put it. It resolved
  the job's checkout through symlinks on every request, so with `./` declared a
  job that replaced its checkout or `_work` with a link to `~` could mount
  `~/.ssh`. The sandbox directory is now resolved once, when the socket starts,
  and a mount source reached through a symlink below it is refused.
- The Docker filter reads a pull's registry the way the daemon does: a first
  component with an uppercase letter (`LOCALHOST/x`, `Evil/x`) names a registry
  host, not a Docker Hub namespace. Such a pull was approved under `docker.io`
  and sent the operator's Docker Hub credential.
- The Docker filter answers 400 to a query that repeats a parameter in any case
  or spelling, or has a `;` or a `%` that starts no escape. Podman reads such a
  query differently from the filter, so a pull judged as `postgres` pulled
  another image on the `docker.io` credential. A build's `t` tags may still
  repeat. `networkmode` on a build and `fromSrc` on a pull are judged in any
  case, as Podman reads them.
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
- A run that could not be cancelled says so. When admission refuses a job and
  GitHub will not cancel its run, the job's history entry records "cancel
  failed" with the reason and, when job notifications are on, a "Cancel Failed"
  notification appears; the run's other jobs may still run. The job-start
  backstop, for a job that reached a
  worker without passing the user filter, now stops that worker as well as
  cancelling the run, whether or not the cancel succeeds, so its steps stop
  without waiting for GitHub. GitHub may show a job stopped this way as lost
  rather than cancelled.
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
- **Breaking policy change**: under `strict` and `moderate`, a runner job's proxy
  reaches an allowed host only on its scheme's port: 443 through `CONNECT` and 80
  for plain HTTP. A job that reaches a host on any other port - a registry on
  8443, SSH tunnelled through the proxy - needs a `host:port` entry (or
  `[v6-address]:port`) in its `network.allow`, which allows that port only.
  `permissive` is unchanged
- **Breaking**: a runner job can signal only processes in its own sandbox - its
  children and the members of its process group that share it. Stopping or
  killing a process it did not start - a server or app you launched, another
  worker's job, the app itself - is now refused
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
