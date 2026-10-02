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
- **Opt-in container work through a filtering Docker socket, in a Linux VM
  per job**: an approved `.localmostrc` may declare the `pull`, `run` and
  `build` actions a job needs, with the registries, images, workspace mounts
  (`ro`/`rw`), network mode, build context and build tags each covers. The job
  is never handed a daemon socket: each worker gets a socket localmost owns,
  and only declared requests are forwarded, to a Linux VM of that job's own,
  which localmost boots at the first Docker request, beyond `/_ping`, `/version`
  and `/info`, of a job whose policy has a `docker:` section, so a job that
  never runs `docker` has no VM
  (or, with the opt-in `dockerVm.prewarm`, as a spare when an idle worker is
  spawned, stopped at the claim unless that job uses it) and discards, with
  every container, network, volume and built image in it, when the job ends.
  The VM is given none of your files but the job's work folder, has no
  network card, and reaches the network only through the job's own proxy.
  Anything unlisted is denied, and host bind mounts,
  `--privileged`/`--pid=host`/`--network=host`/`--device` and a restart policy
  other than `no` (`--restart=always`, `unless-stopped`, `on-failure`) are
  refused. Images are pulled on the Mac, checked digest by digest and loaded
  into the VM, so registry credentials never enter the sandbox or the VM, and
  a repository's public images are cached for its later jobs. The VM runs
  localmost's own small Alpine-based guest, shipped inside the app, and the
  job's `docker` is a CLI bundled with the app. Default off. Allowed in
  `shared` and per workflow. See
  `docs/superpowers/specs/2026-09-05-docker-isolation-design.md` and
  `docs/roadmap/vm-docker-backend.md`
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

### Breaking
- Under `moderate` and `permissive` a job reads only `~/.local/bin` and
  `~/.local/lib` of `~/.local`, not `~/.local/share`, `~/.local/state` or the
  rest. A command in `~/.local/bin` that links elsewhere in `~/.local` fails
  with "Operation not permitted" until the repository declares the directory
  the link resolves into under `filesystem.read`: `~/.local/share/uv/tools`
  for `uv tool install`, `~/.local/share/uv/python` for a uv-managed Python,
  `~/.local/share/claude` for Claude's native installer,
  `~/.local/share/mise` for mise, and `~/.local/pipx` or
  `~/Library/Application Support/pipx` for pipx, depending on its version.
- uv's index credentials (`~/.local/share/uv/credentials`), the SSH keys
  into Podman's machines (`~/.local/share/containers/podman/machine`) and
  atuin's sync key (`~/.local/share/atuin/key`) are closed to reads and
  writes at every level, whatever the policy grants.
- A job, a `localmost test` step and `--updaterc` no longer write the
  `com.apple.dt.Xcode` preference domain. A workflow step that runs
  `defaults write com.apple.dt.Xcode ...` (to skip macro fingerprint
  validation, say) fails with "Could not write domain"; pass the setting to
  `xcodebuild` instead, as `-skipMacroValidation`,
  `-skipPackagePluginValidation`, `-skipPackageSignatureValidation` or
  `-<key>=<value>`. `xcodebuild` and `swift build` themselves write no
  preferences.
- `~/Library/Preferences` is closed to reads and writes at every level,
  whatever the policy grants.
- A job, a `localmost test` step and `--updaterc` read only the preference
  domains a build reads: the global domain, `com.apple.dt.Xcode`,
  `com.apple.dt.xcodebuild`, `xcodebuild`, `com.apple.dt.XCBuild`,
  `com.apple.dt.SWBBuildService`, `org.swift.swift-build`, `swift-build`,
  `com.apple.CoreSimulator`, `com.apple.security` and
  `com.apple.security.codesign`. A tool that reads another domain finds it
  empty.

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
  (for a `*` entry, up to the first `*`). The directories above a deny, and
  for a `*` entry every directory a wildcard stands for, are closed to writes,
  so a job granted one can no longer rename it and read the denied path under
  the new name.
- A job can no longer clone a directory, in a runner job or in `localmost
  test`. clonefile(2) copies the whole tree beneath a directory in one call
  without checking each file, so a job that could read a directory holding a
  denied file - a policy deny, a credential file inside a package cache its
  level reads (`~/.m2/settings.xml`), the Docker VM share's nonce - cloned it
  into its sandbox and read the copy. A file still clones, and `cp -c -R` and
  Foundation's `copyItem` copy a tree file by file, less what is denied.
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
  `~/.gitconfig`, `~/Library/Application Support`, the package caches
  `~/.gradle`, `~/.m2`, `~/.cargo` and `~/.nuget`, and the common PATH
  directories (`/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin`,
  `~/bin`) - with what a write there lets a job do: leave code that runs as
  you, outside the sandbox, after the job ends. Such grants are still allowed. A
  write grant on `~/.ssh`, `~/.config` or `~/Library/Preferences` is marked
  as doing nothing, since the sandbox refuses every write there whatever is
  granted.
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
- The Docker filter judges a build's tags. It read only the build's network and
  key names, so under `run.images: [postgres:16]` a build tagged `postgres:16`
  (or `ghcr.io/other/app`) was forwarded, replacing the local image every later
  `docker run postgres:16` in the job used. Each tag must now match
  `build.tags`, and one with a registry host or in a repository `run.images`
  names is refused whatever `build.tags` says, as is `t` in another case, which
  Podman reads as a tag and moby ignores.
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
- The credentials no job reaches - `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`,
  `~/.docker`, `~/.config`, `~/Library/Keychains`, `~/.netrc`, `~/.npmrc` and
  the credential files inside the package caches (`~/.m2/settings.xml`,
  `~/.gradle/gradle.properties`, cargo's credentials, `NuGet.Config`) - are
  denied to a runner job and a `localmost test` step for writes as well as
  reads, at every level and whatever the policy grants, and the directories
  above each are closed to writes, so none can be renamed out from under the
  deny. A runner job was denied them for reads only, and neither profile
  closed the directories above them to writes, so a write grant that covered
  one let a job rename it, or the directory it sits in, to a name the grants
  covered and read it there: with write on `~/.gradle`, renaming it with
  `mv ~/.gradle/gradle.properties ~/.gradle/p2` let the job print it, and
  every later `moderate` job could then read it too; with write on `~`,
  `mv ~/.ssh ~/.sshx` exposed the SSH keys; and in a `localmost test` step a
  write grant of `~/Library` renamed Application Support, and the app's
  credential store with it. Each is also denied by the path it resolves to
  when the job starts, so one a dotfile manager links into place (`~/.aws`
  linked to `~/dotfiles/aws`, say) is not read or renamed through the link.
- The same floor now names these files, where developer tools keep tokens and
  passwords in plain text: `~/.azure` (the Azure CLI's token cache),
  `~/.git-credentials`, `~/.pypirc`, `~/.gem/credentials` and
  `~/.local/share/gem/credentials`, `~/.terraform.d/credentials.tfrc.json`,
  `~/.terraformrc`, `~/.pgpass`, `~/.vault-token`, `~/.boto`, `~/.s3cfg`,
  `~/.my.cnf`, `~/.mylogin.cnf`, `~/.yarnrc.yml`, and Hugging Face's
  `~/.cache/huggingface/token` and `stored_tokens`. A policy granting read of
  `~` read them all, and `moderate`, which reads `~/.local` and `~/.cache` as
  toolchain trees, read the RubyGems push key and the Hugging Face tokens with
  no grant at all. The directories they sit in are not denied: installed
  gems, Terraform's plugin cache and `~/.cache/huggingface/hub` stay as the
  level and policy grant them.
- A job ends when its worker exits, not when a completion line is read. The
  runner prints the job's name, which the workflow spells, in that line, so a
  name carrying a newline and `Job b completed with result: Succeeded` closed
  its job with the result it chose as soon as the job started: the worker was
  shown idle while the job ran on, Cancel went away, sleep protection and the
  quit confirmation turned off, a policy change retired the worker as idle,
  and the job's real result was never recorded. GitHub's conclusion now
  decides the result, and without one a signal or a stop reads as cancelled
  and an error exit as failed; the last completion line read can only turn a
  clean exit into a failure or a cancel. A job whose worker the app stops in
  the moment before it exits, with no conclusion from GitHub yet, reads as
  cancelled.
- A `localmost test` workspace holds copies of the checkout's files - APFS
  clones where the volume can make them - rather than hard links to them, so
  a step, including one a third-party action runs, can no longer write the
  checkout's own files, its `.localmostrc` and build scripts among them. The
  files come from `git ls-files` with the checkout's ignore rules: rsync read
  a `.gitignore` line of only `!` as "forget every rule so far" and copied
  `.git` in. A submodule or nested repository is held to its own rules and
  the checkout's, where it was copied whole, a `.env` or credential file it
  ignores included; `--staged` no longer copies a nested repository's `.git`,
  or the contents of the file a tracked link points to. If git cannot list
  the files, the run is refused, naming `--no-ignore`. The workspace's
  metadata is written into the empty workspace before the copy, so an entry
  of the checkout's at that name, in any case or spelling the volume folds to
  it, never replaces it or has it written through a link; and a workspace is
  dated by its name rather than by its metadata, which a step could rewrite
  to keep the workspace past the cleanup limits, or replace with a FIFO that
  stalled every later run.
- `localmost test` and the `localmost policy` commands refuse a
  `.localmostrc` that is a link, dangling or not, a directory, a device or a
  FIFO, and `--updaterc` and `policy init` write one by renaming a new file
  over it, never through a link. A
  checkout committing `.localmostrc -> ../../.zshenv` had an approved
  `--updaterc` create `~/.zshenv` holding a workflow name the shell would
  expand, and a link to `/dev/zero` or a FIFO hung every command on the read.
  The `--updaterc` confirmation names the file it will write and lists a new
  policy's workflows entry with the other additions.
- The Docker filter holds a pull's `tag` parameter, however its name is
  cased, to a tag or a digest. Podman joins the tag to `fromImage` with `:`, so
  `fromImage=localhost&tag=5000/x` pulled `localhost:5000/x`, and
  `fromImage=evil.example.com&TAG=443/x` pulled from `evil.example.com:443`,
  each approved under `docker.io` and sent with the operator's Docker Hub
  credential.
- A repository URL is read whole, as `https://github.com/<owner>/<repo>` with
  an optional `.git` and trailing slash. Five places read it with a pattern
  that stopped the repository name at its first dot and matched
  `github.com/` anywhere in the string: configuring a runner for
  `https://github.com/o/my.repo` registered it with `o/my`'s token, as did
  re-registering a configuration saved for it, and
  `https://evil.example/github.com/o/r` named `o/r`. A configuration saved
  for an older account whose name GitHub no longer issues - one ending in a
  hyphen, say - still re-registers, and a settings change still saves it. In
  `localmost test`, an action ref naming a repository that ends in `.git`
  (`uses: o/r.git@v1`) is refused, since GitHub strips that suffix from every
  repository's name.
- Registration runs `config.sh` in a directory of its own, made with a unique
  name and mode 0700, and the startup sweep removes any that a quit or crash
  left. Each interrupted registration left its copy of the runner, about
  430 MB, with the registration's key (`.credentials_rsaparams`) beside it,
  in a directory made with the umask's mode rather than one only the app can
  open.
- The `localmost` command runs the `cli.js` bundled with the app, found by
  following the command's link to the real script. It ran the `cli.js` in
  the link's own directory, `/usr/local/bin`, where none is installed, so
  every command failed with "Cannot find module", and one placed there would
  have run instead; run as `sh localmost`, it ran `localmost/cli.js` under
  the working directory. The command runs with the `node` first on `PATH`,
  so it needs Node.js.
- The app is signed with only the entitlements each part needs: `cs.allow-jit`
  on the app, its main, GPU and renderer helpers and ShipIt, the plugin
  helper's two `cs.*` exceptions, none on the camera helper or the bundled
  `docker` CLI, and only `com.apple.security.virtualization` on the Docker VM
  helper, `localmost-vm`. Releases through 0.2.0 carried @electron/osx-sign's
  defaults - camera, microphone, USB, Bluetooth, printing and location - on
  the app, its main helper and ShipIt, since the signing options meant to
  replace them were ignored. A signing failure now stops the build, where it
  shipped unsigned or partly signed code.
- Pause during video calls runs the camera helper shipped in the app's
  `Contents/Resources`, signed with the hardened runtime and no entitlements.
  The packaged app ran the helper from the build machine's path
  (`/Users/<builder>/.../node_modules/is-camera-on/`), unsandboxed: on any
  other Mac the detection silently did nothing, and on one where that path
  existed it ran whatever was there. Stopping the monitor now stops the
  helper, which ran on until the camera next changed.
- A job's container could be given your home directory. Pre-release 0.3.0
  builds ran jobs' containers on your own daemon - Docker Desktop shares all
  of `/Users` into its VM - and the daemon resolved a bind source again when
  the container started: a job that created a container with an approved workspace bind and
  then replaced the source with a link to `~` started it with your home
  mounted read-write, and a container with a writable workspace mount could do
  the same from inside. Each job's containers now run in a VM that shares only
  the job's work folder, which the job cannot rename or replace, and the guest
  mounts it without following symlinks, re-enabling them only on the binds the
  filter approved, so a swapped bind source fails the start.
- Containers of different jobs reached each other by IP on Docker Desktop's
  shared default bridge, and so did builds, whose `RUN` steps run there. Each
  job's containers now run in a VM of its own, with no network card.
- A job could join another concurrent job's Docker network by naming it: the
  filter admitted any network whose name the policy allowed, even one the job
  had not created. Docker networks now exist only inside the job's own VM.
- Container traffic bypassed the job's network policy. It left through Docker
  Desktop's network, which the host allowlist never saw, and reached the Mac's
  loopback services through `host.docker.internal`. The job's VM has no
  network card: containers reach the network only through the job's own proxy,
  under the same allowlist and loopback rules as the job.
- `moderate` and `permissive` read `~/.local` whole as a toolchain tree, and
  with it the secrets tools keep under `~/.local/share`: a job that declared
  nothing printed uv's index credentials
  (`~/.local/share/uv/credentials/credentials.toml`), the SSH key into a
  Podman machine (`~/.local/share/containers/podman/machine/machine`) and
  atuin's sync key. They now read `~/.local/bin` and `~/.local/lib` only,
  and those three secrets are on the credential floor, so a policy that
  declares `~/.local/share/uv`, say, to run a tool linked into it does not
  hand the job uv's credentials beside it.
- Every profile let a job, a `localmost test` step and `--updaterc` write the
  `com.apple.dt.Xcode` preference domain, at every level: settings your own
  Xcode loads outside any sandbox. None of them writes a preference domain
  now. And a policy granting `~` or `~/Library` - or, under `--updaterc`, no
  policy at all - reached every app's preferences through their plists,
  which cfprefsd honours in place of the preference rules: write grants
  could set any app's preferences, read grants read them. `~/Library/Preferences`
  is now on the credential floor, read and write, with the directories above
  it closed as nodes.
- Every profile read every preference domain through cfprefsd, at every
  level, though the file floor kept a job out of `~/Library/Preferences`: a
  `strict` job with no grants printed all of Finder's preferences, and the
  licence and account keys other apps keep there. A job now reads only the
  domains `xcodebuild`, `swift build` and codesign read.

### Fixed
- In-app updates find a zip to install. The update feed listed only the
  DMGs, and the updater installs only from a zip, so every download failed
  with `ERR_UPDATER_ZIP_FILE_NOT_FOUND`. Each release now ships a zip,
  listed in the feed ahead of the DMG.
- `localmost policy init --force` replaces an existing policy. The flag was
  read and ignored, while the refusal without it said to pass it.
- The tray shows an expired GitHub session as "GitHub: Session expired,
  reconnect in Settings", as the Settings badge does, with no Pause or
  Resume. It showed the runner listening, with a Pause item, for a session
  that could not get a token, and it now redraws when the session expires.
- `localmost test --updaterc` runs inside a runner job. Its process watcher
  was written to `~/.localmost/bin` first, which a job cannot write, so
  every step failed there; it is now passed to Python on its command line.
- A registration GitHub has made is no longer reported as failed because its
  working directory could not be removed, and `config.sh`'s own error, or the
  runner's integrity failure, is no longer hidden behind the removal's.
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
- **Breaking**: localmost needs macOS 14 or later; 0.2.0 ran on macOS 12. The
  Docker VM is built on Virtualization.framework, and localmost supports it
  from macOS 14 on. On macOS 12 or 13, 0.2.x is not offered this update: the
  update feed names macOS 14 as its minimum (`minimumSystemVersion`), and
  the updater 0.2.0 shipped checks it, so stay on 0.2.0. An update
  downloaded and installed by hand on macOS 12 or 13 will not open, because
  the app requires macOS 14; reinstall 0.2.0 from its release
- **Breaking**: Intel Macs are no longer supported. localmost is built for
  Apple silicon (arm64) only; 0.2.0 was the last release with an Intel
  build. On an Intel Mac on macOS 14 or later, 0.2.x still reports this
  update as available, as that check reads only the version and the minimum
  macOS, but the update feed lists no Intel file, so downloading it fails
  with "No files provided" and nothing is installed
- **Updates download automatically**: the updater downloads a new release as
  soon as it finds one, and installs it when the app quits, as before; it
  used to wait to be asked to download. The app now ships a Linux kernel,
  `runc` and `dockerd` for its Docker VM, and their fixes arrive this way
- **Breaking, against pre-release 0.3.0 builds**: container work no longer
  uses Docker Desktop, or any other daemon of yours (Colima, Podman). Each
  job's containers run in a Linux VM of its own (see Added), and your own
  Docker installation is left alone. What changes for a policy:
  - A routable network - the default bridge, or one declared `internal:
    false` - means egress through the job's proxy, subject to its network
    allowlist, where it meant the daemon's own unfiltered network; the approval
    text says so. localmost injects `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`,
    `https_proxy` and `NO_PROXY` into routable containers and, as build args,
    into builds, keeping any value the job sets. Traffic that ignores them -
    plain TCP, ssh, UDP, DNS lookups of outside names - is refused at once,
    though a name lookup from a musl-based image (Alpine) waits out its
    resolver's 5 s timeout first
  - A build cannot pull its `FROM` image: `docker pull` base images first
  - Registries on the LAN, on the Mac itself or served over plain http cannot
    be pulled from, even when listed in `pull.registries`; only public https
    registries can
  - Listing a registry in `pull.registries` also grants localmost fetching
    from wherever that registry redirects (any public https host), outside the
    job's `network.allow`; the approval text says so
  - Pulls are anonymous first: a credential helper runs only when the
    registry refuses an anonymous request, once per registry per job, so a
    public image is pulled whatever state the helper is in. Credential
    helpers named by `credsStore` or `credHelpers` are looked up only in
    `/opt/homebrew/bin`, `/usr/local/bin` and Docker.app's bundled `bin`, not
    on `PATH`. When the registry wants credentials, a missing or failing
    helper fails the pull, naming the config key, where it used to pull
    anonymously; the error first says the registry refused an anonymous pull,
    which Docker Hub also does for a repository that does not exist. With `credsStore: desktop` configured, a private image
    needs Docker Desktop's helper to answer (it hangs while Docker Desktop is
    installed but not running, and the pull fails after 10 s saying so)
  - An image that needed credentials is pulled again by every job; it is
    never cached for the repository
  - `chown` inside a container on a workspace bind does not persist; keep data
    directories on volumes
  - `--log-driver` other than `json-file`, `local` or `none` (and another
    driver's `--log-opt`) and `--annotation` are refused: a log driver would
    connect out from inside the VM on the container's behalf, around its
    network rules. A build that asks the daemon for BuildKit
    (`/build?version=2`) is refused too, as `DOCKER_BUILDKIT=1` already was
  - Every job's `_work`, Docker or not, holds a `.localmost-share` file the job
    can see but neither read nor change, so a `tar` of all of `_work` or an
    `rm -rf _work/.*` fails on it; `ls`, `find`, `du` and `stat` are unaffected
- **Breaking policy change**: `docker: socket | contexts | credentials`, accepted
  by pre-release 0.3.0 builds, is now a validation error naming the actions that
  replace it. Migrate by declaring what the job does: `socket` and `contexts`
  become `run:` (with `images`, plus `mounts` and `network` if the job binds the
  workspace or needs a network mode) and `pull:` naming the registries it pulls
  from; `credentials` becomes a private registry listed under `pull.registries`.
  The proxy authenticates on the job's behalf, so the job no longer reads
  `~/.docker/config.json` and nothing under `~/.docker` is opened at any level.
  `localmost test --updaterc` writes the actions from a run's denials
- **Breaking policy change**: a `docker build -t` tag must match a glob in the
  new `build.tags`, so a policy whose `build:` declares none now has every
  tagged build refused, with the line that would permit it logged. A tag with a
  registry host, or in a repository `run.images` names, is refused whatever
  `build.tags` says, so an image a job builds cannot also be run by name. An
  untagged build is unaffected
- **Breaking policy change**: under `strict` and `moderate`, a runner job's proxy
  reaches an allowed host only on its scheme's port: 443 through `CONNECT` and 80
  for plain HTTP. A job that reaches a host on any other port - a registry on
  8443, SSH tunnelled through the proxy - needs a `host:port` entry (or
  `[v6-address]:port`) in its `network.allow`, which allows that port only.
  `permissive` is unchanged
- **Breaking**: the credential floor holds against write grants (see
  Security). A job granted `~` can no longer create a missing `~/.gradle`,
  `~/.m2`, `~/.cargo`, `~/.nuget`, `~/.gem`, `~/.terraform.d`, `~/.local` or
  `~/.cache`, nor one granted `~/.local` a missing `~/.local/share` or
  `~/.local/share/gem`, nor one granted `~/.cache` a missing
  `~/.cache/huggingface`: create the directory yourself, and the grant writes
  in it. So `gem install --user-install` fails where it would create
  `~/.gem`, or, on RubyGems 3.4 and later under `strict`,
  `~/.local/share/gem`. A write grant on `~/.ssh` writes nothing there,
  `~/.ssh/known_hosts` included. A step granted `~` that logs in by writing
  a credential file - `az login` and `azure/login` (`~/.azure`),
  `hashicorp/setup-terraform` with `cli_config_credentials_token`
  (`~/.terraformrc`) - fails with "Operation not permitted" rather than
  overwrite your own login; point the tool at a file in the workspace with
  `AZURE_CONFIG_DIR` or `TF_CLI_CONFIG_FILE`. The files the floor newly names
  cannot be read or written whatever the policy grants
- **Breaking**: a runner job can signal only processes in its own sandbox - its
  children and the members of its process group that share it. Stopping or
  killing a process it did not start - a server or app you launched, another
  worker's job, the app itself - is now refused
- **Breaking policy change**: in a `filesystem.deny` entry `*` matches within
  one name and never a `/`, in a runner job and in `localmost test`; it used to
  match any run of characters, so `~/out/*.pem` covered `~/out/a/b.pem` and now
  covers only the `.pem` names directly in `~/out`. `**` in a deny now means
  the same as `*`, one name, where it too used to reach any depth. To reach
  deeper, write each level (`~/out/*/*.pem`) or deny the directory. An
  approved policy is not prompted for again, so re-check any deny that relied
  on `*` or `**` spanning directories. Every
  directory a wildcard stands for is now closed to writes as a node, as the
  directories above a deny already were: under a deny of `~/out/sec*/key` a job
  cannot rename `~/out/secA`, nor create or rename anything in `~/out` whose
  name matches `sec*`
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
