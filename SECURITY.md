# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in localmost, please report it through [GitHub Security Advisories](https://github.com/bfulton/localmost/security/advisories/new).

**Please do not open public issues for security vulnerabilities.**

When reporting, please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

## Response Timeline

- **Acknowledgment**: Within 1 week of report
- **Initial assessment**: Within 2 weeks of report
- **Fix timeline**: Depends on severity; critical issues prioritized

We follow coordinated disclosure. If you report a vulnerability, we ask that you give us 90 days to address it before public disclosure.

## Supported Versions

Only the latest release receives security updates. Users should always run the latest version.

## Scope

### In Scope

- The localmost application (Electron app, main/renderer processes)
- Credential storage and handling
- Sandbox and network isolation mechanisms
- IPC between processes
- Authentication flows

### Out of Scope

- **GitHub Actions Runner binary itself** - Report vulnerabilities in the runner binary to [GitHub](https://github.com/actions/runner/security). However, vulnerabilities in localmost's sandboxing or network isolation *of* the runner are in scope.
- **Workflow code** - Security of workflows you write is your responsibility
- **Third-party dependencies** - Report upstream, but please let us know so we can update

## Security Updates

Security fixes are communicated through:
- [GitHub Security Advisories](https://github.com/bfulton/localmost/security/advisories)
- Release notes on [GitHub Releases](https://github.com/bfulton/localmost/releases)

---

# Security Architecture

This section describes the security design of localmost.

## Overview

localmost is an Electron desktop application that manages GitHub Actions self-hosted runners. It handles sensitive credentials and executes external binaries, requiring careful security considerations.

## Threat Model

### What localmost protects against

- **Filesystem writes**: Under `strict`, workflows write only to the workspace, their own temp directory inside the job's sandbox, their target's own tool cache when the persistent tool cache is selected, the entries a bare `mktemp` creates in the per-user temp directory (see Shared temp directories below), and whatever their `.localmostrc` declares. `moderate` and `permissive` additionally write a package cache the job's package managers are pointed at: their target's own (`~/.localmost/runner/caches/<target>/packages`) with the persistent cache selected, or one inside the job's sandbox with per-sandbox - never the tool caches in your home directory (`~/.npm`, `~/.cargo`, `~/.gradle`, `~/Library/Caches` and similar), which they can read but not write
- **Home directory access**: Workflows cannot read or write `~/.ssh`, `~/.aws`, `~/.config` or the other credential locations listed below, at any level, whatever write paths their policy declares - by the path as written and, where one is a link (a `~/.aws` kept in a dotfiles repository and linked into place, say), by the path it resolves to when the job starts. Nor can they rename one, or any directory above one (`~/.m2`, `~/.gradle`, `~/.cargo`, `~/.nuget/NuGet`, `~/.gem`, `~/.terraform.d`, `~/.local/share/gem`, `~/.local/share`, `~/.local`, `~/.cache/huggingface`, `~/.cache`, `~/Library`, `~` and so on), which would move it out from under that deny to be read under the new name: a write grant on a package cache or on `~` still writes what else it covers - a job granted `~/.gradle` writes its `caches` and `wrapper`, one granted `~/.terraform.d` its `plugins`, one granted `~/.cache` its `huggingface/hub` - but cannot move the credential files inside, nor create one of those directories where it is missing: granted `~`, a job cannot create a missing `~/.gradle`, `~/.m2`, `~/.cargo`, `~/.nuget`, `~/.gem`, `~/.terraform.d`, `~/.local` or `~/.cache`, nor granted `~/.local` a missing `~/.local/share` or `~/.local/share/gem`, nor granted `~/.cache` a missing `~/.cache/huggingface`, and you create the directory instead (so `gem install --user-install` fails where it would create `~/.gem`, or, on RubyGems 3.4 and later under `strict`, `~/.local/share/gem`; under `moderate` and `permissive` those RubyGems install into the package cache, where `XDG_DATA_HOME` points). Nor can a job granted `~` write a credential file in place: a step that logs in by writing one - `hashicorp/setup-terraform` with `cli_config_credentials_token` writes `~/.terraformrc`, `az login` and `azure/login` write `~/.azure` - fails with "Operation not permitted" rather than overwrite your own login, and the workflow points the tool at a file in its workspace instead (`TF_CLI_CONFIG_FILE`, `AZURE_CONFIG_DIR`). `HOME` is your real home directory, because the runner and the toolchains installed there look themselves up through it; the sandbox, not `HOME`, is what keeps a job out: within your home a job reads only what its level and policy grant, and writes only its own sandbox and caches under `~/.localmost` and whatever write paths its approved policy declares. `~/.localmost` and the app's Electron data directory (`~/Library/Application Support/localmost`) are closed to reads and writes whatever the policy declares, by their real paths and in any capitalization: a grant of `~`, `/Users`, `~/Library` or `~/Library/Application Support` grants everything else it covers, and the job still reaches nothing in either directory but its own sandbox and its target's caches, beyond listing the directories on the way down to them - not the logs, the job history, another worker's sandbox or another target's caches. Nor can it rename or replace any directory above them (`~`, `~/Library`, `~/Library/Application Support` and so on), which would move them out from under that deny
- **Environment**: A job does not inherit the app's environment. Launched from a shell, the app carries every token and agent socket that shell had; a worker gets only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TZ` and `__CF_USER_TEXT_ENCODING` from it, plus whatever the repository's approved `env: allow` names (`*` matches any run of characters), less whatever `env: deny` names. The variables localmost sets for the runner - the proxy, `TMPDIR`, `DOCKER_HOST`, the per-job configuration and the caches - are set after the policy is applied, so no policy can replace them. Secrets from GitHub reach steps through the job payload as usual; this is about what the host contributes
- **Filesystem reads**: Under `strict` a job reads the OS, the runner's own directories, its workspace, and whatever its `.localmostrc` declares - nothing else. `moderate` and `permissive` additionally grant the standard toolchain locations (`/opt/homebrew`, `/usr/local`, Xcode) and the package-manager caches. At every level a job is denied `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config`, `~/.azure`, `~/Library/Keychains`, `~/.netrc`, `~/.npmrc`, the files other tools keep tokens and passwords in as plain text (`~/.git-credentials`, `~/.pypirc`, `~/.gem/credentials` and `~/.local/share/gem/credentials`, `~/.terraform.d/credentials.tfrc.json`, `~/.terraformrc`, `~/.pgpass`, `~/.vault-token`, `~/.boto`, `~/.s3cfg`, `~/.my.cnf`, `~/.mylogin.cnf`, `~/.yarnrc.yml`, `~/.cache/huggingface/token` and `stored_tokens`), this app's credential store and approval cache, and the credential files kept inside the package-manager caches (`~/.m2/settings.xml`, `~/.gradle/gradle.properties`, cargo credentials, `NuGet.Config`), read and write, whatever write paths its policy declares, and none can be renamed into view (see Home directory access above). Granting write on `~/.gradle`, `~/.m2`, `~/.cargo` or `~/.nuget` is warned about on approval, since your own builds load and run what is kept there
- **Network exfiltration**: A job's sandbox permits no outbound connection except to its own filtering proxy and the local broker's port, so the host policy holds even for code that ignores `HTTP_PROXY` and opens a raw socket. A direct connection to any other loopback port is refused too, unless its approved policy declares that port with `network.loopback`, and the proxy holds a request for a loopback address to the same ports, so going through `HTTP_PROXY` does not reach a service bound only to loopback either. The proxy judges the Mac's own routable addresses - a global IPv6 address, or a public IPv4 one, on one of its interfaces - like any remote host, so under `permissive`, or with such an address in an allow entry, a job reaches a service listening on all interfaces there (Docker Desktop publishes ports that way by default). Under `strict` the reachable set is runner infrastructure plus what the repository declares — not npm, PyPI or other registries
- **Other processes**: A job can signal only processes in its own sandbox - its children and the members of its process group that share its sandbox - not the app, another worker's job or anything else you run. It cannot look up the app's own Chromium port rendezvous service either
- **What a job leaves running**: Nothing of a job is meant to outlive it. Every job's sandbox is a new directory (`~/.localmost/runner/sandbox/<n>-<id>`), with its docker socket inside, so the next job's runner, checkout and socket are at paths no earlier job's profile grants. When a worker exits, its process group is sent SIGTERM and, ten seconds later, SIGKILL, and its slot takes no other job until the group is empty or has been sent SIGKILL. Two seconds after that, anything still running under that job's sandbox profile is killed - found by asking the kernel which processes run under the profile carrying the job's mark, which a process cannot leave the way it can leave its process group with `setsid()` - and then, once nothing is left in its process group, the job's sandbox directory is removed. It is first moved aside, to a name in `~/.localmost/runner/sandbox` that no job's profile grants, so that a process still running under the job's profile can no longer change the tree, and it is removed from there without following a link planted anywhere in it - even one swapped in for a directory while the removal runs, by a container of the job's writing its bind-mounted workspace through the Docker VM's share, say, which the job's profile does not confine - so the removal deletes nothing outside the tree. If the app quits first, the next startup does the same for every job it had not swept. That sweep runs a short script with the developer tools' `python3`, found through `xcode-select`; without the developer tools only the process group, and the processes holding the marker file descriptor the runner's shells pass down, are swept. So a process that left the group with `setsid()` and closed its inherited descriptors keeps its finished job's profile for about twelve seconds after the job ends, and without the developer tools until it exits. Until then it can write its own old sandbox directory while that is still in place (and after that a new directory at the same path, which the next startup removes), the paths its policy declares, and its target's caches, which the target's next job uses; connect to the loopback ports its policy declares; and listen on any free loopback port, where a later job, or one running in another slot, whose policy declares that port reaches it instead of the service it expects. It cannot reach the next job's sandbox or docker socket, nor use its proxy, which stops serving it when the job ends
- **Container work**: A job is never handed a Docker daemon socket. It talks to a filtering socket localmost owns, which forwards only the `pull`, `run` and `build` requests the repository's approved `.localmostrc` declares, to a Linux VM of the job's own that is given none of your files but the job's work folder and whose only way out is the job's proxy - see Docker Access below
- **Credential exposure**: OAuth tokens are encrypted at rest using macOS Keychain

### Policy levels

A repository declares its level in `.localmostrc`:

```yaml
version: 1
level: strict    # strict (default) | moderate | permissive
```

A repository that declares no level runs `strict`. Silence means the tightest
setting, so a policy that says nothing cannot inherit something looser.

The level governs both halves of the policy. On the network side, `strict`
grants runner infrastructure plus declared hosts, while `moderate` adds the
common package registries. On the filesystem side, `strict` grants the runner's
floor plus declared paths, while `moderate` adds read access to the toolchain
locations and package-manager caches, and a package cache of the repository's
own to write.

Because a sandbox profile is fixed when a worker starts, approving a policy
retires that repository's idle workers. If a worker still claims a job after
its policy changed, the job runs under the boundary approved when that worker
started - which the machine owner approved, just not most recently - with its
network cut back to runner infrastructure, and the worker is retired
afterwards. A job already running is left alone.

The level is part of the policy, so changing it is a policy change: it appears
in the approval diff and takes effect only once approved. A repository cannot
loosen its own sandbox without the machine owner agreeing to it.

- **The app's own control plane**: A job cannot write the approval cache, the settings file, or reach the CLI control socket. Without this, a workflow could approve its own policy and the approval gate would mean nothing

### What localmost trusts (does NOT protect against)

- **GitHub's infrastructure**: OAuth, API responses, and runner binary distribution are trusted. If GitHub is compromised, localmost provides no additional protection.
- **Malware on your machine**: If your system is already compromised, localmost cannot protect you.
- **A compromised GitHub account**: If an attacker has access to your GitHub account, they can modify workflows that run on your runner.
- **Allowlisted hosts**: Data can be exfiltrated to any host the active policy allows. Under `strict` that is runner infrastructure plus whatever the repository declares; looser levels allow more. Among the infrastructure hosts allowed at every level, `github.com`, `api.github.com` and `*.blob.core.windows.net` accept writes from any account, so `strict` limits reach, not exfiltration - see Network Policy below.
- **Approved policies**: Once you approve a repository's `.localmostrc`, everything it declares is granted until you approve another. Approval is a judgement about that content, and is bound to it: what you approve is the policy you were shown, level included. A write grant on a place something outside the sandbox later acts on - `~/Library/LaunchAgents` and the other launchd directories, shell rc files, `~/.gitconfig`, `~/Library/Application Support`, the package caches `~/.gradle`, `~/.m2`, `~/.cargo` and `~/.nuget`, `/usr/local/bin`, `/opt/homebrew/bin`, or a parent of any of them, `~` and `/` included - is marked with a warning in the approval screen and `localmost policy show`. It is not refused: a job granted one can leave code that runs as you, unsandboxed, after it ends, and approving it means accepting that. A write grant on `~/.ssh` or `~/.config` is marked too, but does nothing: the sandbox refuses a job every write there whatever is granted (see Home directory access above).
- **Per-workflow filesystem sections**: A `workflows:` section can narrow or widen *network* access per workflow, because hosts are applied to the proxy when a job is claimed. Filesystem paths are taken from `shared:` only — the sandbox profile is built before the runner knows which workflow it will run, and cannot change afterwards.
- **Per-workflow env sections**: The environment is fixed when the worker starts, for the same reason. `env: allow` is taken from `shared:` only; a per-workflow allow is not applied. `env: deny` is taken from `shared:` and from every workflow, and applied to every job - a per-workflow deny is honoured more widely than written rather than not at all.
- **Per-workflow sections are not a boundary between contributors**: A `workflows.<name>` section is available to any commit that can run a workflow file with that name, including pull requests; approving a per-workflow grant approves it for anyone who can open a PR. The key matches a file name, and a pull request can add or change a workflow file like any other. Per-workflow sections keep a compromised dependency of one workflow from using another's grants, not a commit author.
- **Loopback services on declared ports, and the broker**: A job reaches loopback ports other than its own proxy's only when the repository declares them with `network.loopback`, directly or through its proxy, and it always reaches the broker's port, directly and through its proxy - see Network Policy below. A service on a declared port is protected from jobs only by its own authentication, as the broker is by its per-worker key. A job's containers reach loopback only through the job's proxy, so under the same rule: the ports its policy declares, and the broker's - see Docker Access below.
- **Processes running as you**: The CLI control socket is guarded only by file permissions (`0600` in a `0700` directory) and the job sandbox's deny of it. Any process running as your user can control the app through it - pause, resume, add or remove targets - as it could by editing `~/.localmost` directly.
- **Apple's Virtualization.framework, and the Docker VM's kernel**: A job's containers run in a Linux VM of its own. A bug in Apple's virtiofs server or device emulation, which is closed source and has not been fuzzed here, is not contained by anything localmost adds. A kernel exploit from a container gives root in that VM, which holds only what the job can already reach and its repository's cache of public images - see Docker Access below.

- **The runner's own floor**: A job's sandbox also contains the runner process, so the profile must grant what the runner needs to function - the OS, its own installation, the tool cache, the workspace and temp. A repository cannot narrow below that floor, only add to it.
- **Package caches under `moderate` and `permissive`**: These levels used to grant write on `~/.npm`, `~/.cargo`, `~/.rustup`, `~/.gradle`, `~/.m2`, `~/.nuget`, `~/.dotnet`, `~/.local`, `~/go`, `~/Library/Caches` and similar. Those trees are not only caches: they hold directories on your `PATH` and configuration your own tools load, so a job could plant code you would later run outside any sandbox. They are now read-only to jobs. Instead the job's environment points its package managers at a package cache of its own - its target's, or with per-sandbox selected one inside the job's sandbox - by these variables: `npm_config_cache`, `YARN_CACHE_FOLDER`, `YARN_GLOBAL_FOLDER`, `npm_config_store_dir` (pnpm), `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `CARGO_HOME`, `GRADLE_USER_HOME`, `MAVEN_OPTS` and `MAVEN_ARGS` (`maven.repo.local`), `GOPATH`, `GOCACHE`, `NUGET_PACKAGES`, `NUGET_HTTP_CACHE_PATH`, `DOTNET_CLI_HOME`, `PIP_CACHE_DIR`, `electron_config_cache` and `npm_config_devdir` (node-gyp). The trade-offs: a job starts from an empty cache rather than yours; your own configuration in those trees (`~/.cargo/config.toml`, `~/.gradle/init.d` and the like) no longer applies to jobs; rustup cannot install a toolchain that `rust-toolchain.toml` asks for, since `~/.rustup` is read-only; because `XDG_DATA_HOME` moves too, what you installed under `~/.local/share` - mise's tools, uv's Pythons, pipx's packages - is not found by a job, which installs its own copy into the package cache instead; a workflow that sets one of these variables itself back to your home directory is refused on write - which includes a workflow that sets `MAVEN_OPTS` for its JVM flags on a Maven older than 3.9, which reads only `MAVEN_OPTS`; and a tool that writes somewhere else in your home - `~/Library/Caches` for Playwright browsers, CocoaPods or Homebrew - fails with "Operation not permitted" unless the repository declares that path. With the persistent cache selected, the package cache is kept across a target's jobs and shared by all of them, like the tool cache - and it holds what those jobs execute, not only downloaded packages: Gradle's `init.d` scripts and `gradle.properties`, Cargo's `config.toml` (a `rustc-wrapper`, say) and `bin`, `GOPATH/bin`. Within a target, a pull request's job can leave configuration or binaries there that a later default-branch job loads with that branch's secrets. With per-sandbox selected, the package cache is inside the job's own sandbox and goes with it.
- **Tool cache**: With the persistent tool cache selected, each repository or organization target has its own (`~/.localmost/runner/caches/<target>/tool-cache`), readable and writable by that target's jobs and no other target's. `setup-node` and the other setup actions execute the highest matching version they find there, so a cache shared across targets would let one repository's job plant a toolchain another repository's job runs with its own secrets. Within one target the cache is still shared between jobs, including a pull request's and the default branch's. An organization target is one target: its cache is shared by every repository of the organization, so one repository's job can plant a toolchain another repository's job in the same organization runs with that repository's secrets. Choose per-sandbox to keep every job's tools to itself - and do, for an organization whose repositories do not trust each other. A worker with no target, or per-sandbox, gets no tool or package cache outside its sandbox at all. The single shared `tool-cache` directory earlier versions used is left on disk untouched and is no longer granted to any job; delete it when convenient.
- **Shared temp directories**: A job gets no access to `/tmp` or to the per-user `/var/folders` directories, at any level. Those are shared with every process you run, and some of what lives there is trusted by your own tools - the xcrun lookup cache and the clang module cache among them. `TMPDIR`, `TMP` and `TEMP` point at the job's own temp directory, and xcrun's cache, the clang and Swift module cache and zsh's here-documents are pointed there too (`xcrun_db`, `CLANG_MODULE_CACHE_PATH`, `TMPPREFIX`). macOS `mktemp` ignores `TMPDIR`, so a bare `mktemp` or `mktemp -d` is allowed to create its entry in the per-user temp directory - by the `tmp.XXXXXXXXXX` name it generates only, without the right to list or read anything else there. The trade-offs: `mktemp -t prefix`, a hard-coded `/tmp` path, and Foundation's `NSTemporaryDirectory()` / `FileManager.temporaryDirectory` fail with "Operation not permitted" inside a job; use `$RUNNER_TEMP` or a template under it (`mktemp -d "$RUNNER_TEMP/x.XXXXXX"`). And any entry named like `tmp.XXXXXXXXXX` in the per-user temp directory is reachable by a job that learns its exact name - not only your own, but those of every other job running at the same time, other repositories' included. Names are not hard to learn: a job can list every process you run with its full command line (`ps`, `pgrep -lf`), so a concurrent job's `tar -C "$d"` or `bash "$f"` on a bare-`mktemp` path hands that path to any job that looks, which can then read what is in it or replace a script before it runs. A workflow that keeps anything sensitive in a temp file, or runs a script from one, should create it under `$RUNNER_TEMP`, which is its own.
- **Declared system paths**: A policy that declares OS read paths grants them for the whole job. `localmost policy init` seeds that list with OS subpaths (`/usr/bin`, `/usr/lib`, `/System`, `/Library/Developer` and similar) because nothing runs without them. It deliberately excludes `/usr/local`, `/Library/Application Support` and `/Applications`, which hold third-party software and application data - but a policy is free to add them back, and approving one means accepting that.

## Network Policy

Job traffic is routed through a local proxy, which decides each connection by
hostname. macOS `sandbox-exec` cannot filter by hostname - its `(remote ...)`
filter matches only addresses and ports - so the sandbox permits the job's own
proxy on loopback, and the proxy makes the decision. It also permits the local
broker's port: the runner dials the broker directly at `127.0.0.1`, because its
HTTP client sends a loopback destination around the proxy. What guards the
broker is each worker's key (below), not a closed port.

Other loopback ports are closed to a job's direct connections by default: a
debugger listening on 9229, a browser's remote-debugging port, a local database
or another tool's proxy is not the job's to open a socket to, and neither is a
port a concurrent job opened, and its proxy will not forward to one for it
either (see below).
A repository whose jobs need loopback - a test suite that starts a server on an
ephemeral `127.0.0.1` port and connects to it, or a service container published
on a fixed port - declares it in `.localmostrc`, under `shared:` only, since the
profile is fixed when the worker starts:

```yaml
shared:
  network:
    loopback: true          # every loopback port
    # loopback: [5432, 6379]  # or only these; seatbelt has no port ranges
```

The grant is shown in the approval card and `localmost policy show` with a note
that the job can reach local services on those ports, and like every other key
it is part of the approval diff and stamp. Loopback is shared by everything on the Mac: a job
granted a port reaches whatever listens there, a concurrent job's server
included, whichever repository it belongs to, and two jobs that bind the same
fixed port collide.

The proxy holds a request for a loopback address to the same ports, at every
level, `permissive` included: a plain request or a `CONNECT` tunnel to
`127.0.0.1`, `::1` or any other `127/8` address is refused with 403 unless its
port is declared or is the broker's. `localhost`, and any other name for this
machine, is refused on every port, declared and broker's included: only a
literal address is forwarded to loopback. The broker's port stays
open, through the proxy and directly, because the runner reaches the local
broker. What keeps a job from using that port is the broker's own
authentication: each worker talks to it at an address carrying a key of its own
(`http://127.0.0.1:<port>/w/<key>/`), and the broker answers each key only
with its own worker's session and the jobs delivered to that worker. A job
operation it sends upstream on the runner's credentials (renewing, finishing
or completing a job) must name that worker's job and no other: any request id
it carries must be one delivered to that worker, and any plan and job ids
those of the job details it acquired. The operation is recognised however its
path is spelled, in any case or percent-encoded, and its body must write each
of those ids under its exact key (`planId`, not `PlanId`): the JSON decoders of
.NET and Go read a key in any case, and Go's reads some other letters as ASCII
ones (`requeſtId` as `requestId`), so a body that spells one otherwise, or has
any key that is not plain ASCII, is refused. A path that decodes to anything
but plain ASCII is refused too. The paths the broker answers itself (opening,
polling and deleting a session, acknowledging a message, acquiring a job, and
the worker's token endpoint) never go upstream: another spelling of one
(`/Message`, `/message/`, `/%6dessage`), or another method on it, is refused.
Any other path is not yet restricted: it is forwarded to GitHub's broker on
the runner's credentials as it comes, with the target's upstream session id in
place of any session id it carries. That id is put in under `sessionId`, so a
query that also spells it another way (`SessionId`, or with a letter Go reads
as an ASCII one), or has any parameter name that is not plain ASCII, is refused
rather than forwarded: upstream could read that spelling beside or instead of
the id put there.
Forwarding only the paths the runner uses would close that; it is an open
item. That key, not the closed port, is what keeps a job from acting as
another worker, and from acting as the runner through the operations above.

A repository declares one of three levels in its `.localmostrc` (`level:`; see
Policy levels above), and one that declares none runs `strict`. Settings under
Job Security describes them but does not choose one; a change of level is a
policy change, approved like any other:

- **strict** (default): runner infrastructure, plus whatever the repository's
  `.localmostrc` declares
- **moderate**: also GitHub Actions infrastructure, common package registries
  and tool caches
- **permissive**: unrestricted

A small set of hosts is allowed at every level, because the Actions runner is
launched with `HTTP_PROXY` pointed at this proxy and cannot register or poll for
jobs without them: the local broker on its own port, `github.com`,
`api.github.com`, `*.actions.githubusercontent.com` and `*.blob.core.windows.net`. A single proxy
cannot distinguish the runner's own requests from a job's, so jobs reach those
hosts too - and those hosts accept writes from any account (a gist, a push
to another repository, an upload to anyone's storage container), so even
`strict` limits what a job can reach, not what it can send out.

Under `strict` and `moderate`, an allowed host is reached only on its scheme's
port: 443 through a `CONNECT` tunnel and 80 for plain HTTP. Any other port must
be spelled in a `.localmostrc` network entry as `host:port` (or
`[v6-address]:port`), which allows that port only. An `http://` URL reaches
port 80 as a plain proxied request; a client that tunnels it through `CONNECT`
instead needs a `host:80` entry. `permissive` stays unrestricted, ports
included, except on this machine: a literal loopback address (`127.0.0.1`,
`::1`) is reachable through the proxy at every level on the broker's port,
because the runner reaches the broker at `127.0.0.1`, and on the
ports `shared.network.loopback` declares - no others. The broker is guarded by
each worker's key, not by its port. A name that resolves to loopback,
`localhost` included, is refused.

A `network.deny` entry is read the same way and refuses its host at every
level, `permissive` included, whatever the allow list says; an entry with a
port denies that port only. The runner infrastructure hosts on their scheme's
port, and the broker's port on loopback, cannot be denied; a declared loopback
port can. Like the allow list, it matches names, not addresses:
at `permissive` a job can still reach the same server by its address or another
name.

A runner job's filesystem starts from a fixed floor that its policy does not
list. Besides its own sandbox directory (workspace and temp), it can read the
operating system - `/System`, `/bin`, `/sbin`, `/usr/bin`, `/usr/lib`,
`/usr/libexec`, `/usr/sbin`, `/usr/share`, `/etc`, `/private/etc`,
`/private/var/db`, `/private/var/select`, `/Library/Apple`,
`/Library/Preferences`, `/Library/Frameworks` - and `/Library/Developer`
(the Command Line Tools and simulator support), and a few device files
(`/dev/null`, `/dev/random` and the like); it can read and write its target's
own tool cache when one is kept, and create files under the names `mktemp`
generates in the per-user temp directory. Xcode itself
(`/Applications/Xcode.app`, usually the active developer directory) is not on
the floor: under `strict` a job that runs `xcodebuild` from it declares it.
Under `moderate` and `permissive` it can also read Homebrew, `/usr/local`,
Xcode and the package-manager caches in your home, and write a package cache
of its own. Everything else must be declared in
`.localmostrc`, and the credential files and app directories listed under What
localmost protects against stay closed whatever it declares. A repository's
policy therefore tells you what a job may touch beyond that floor, not
everything it may touch. A `localmost test` step has no such floor: beyond its
workspace, the same few device files, the names `mktemp` generates in the
per-user temp directory and, read-only, the code of the actions it runs, its
policy lists everything it reads, system paths included. `localmost policy init` starts from a policy that runs,
and `localmost test --updaterc` records what a workflow actually needs.

Directory nodes on the way down - `/`, and for a runner job `/Users`, your home
directory and the app directories above its own sandbox and caches - are
readable so that an absolute path resolves at all. They grant no access to
anything inside.

A repository's `.localmostrc` only takes effect once approved. When the runner
sees a new or changed policy it refuses the job, cancels the run, and records
the policy as pending; review and approve it in Settings > Job Security, or in
a clone with `localmost policy approve`, which shows the policy and a stamp,
and `localmost policy approve --stamp <stamp>`, which approves it. A pending
policy never replaces the approved one: jobs whose file matches what was
approved keep running under it until another is approved. Approval is bound to
the exact policy shown - its sha256 stamp - and is refused if a later job has
replaced the pending policy since; every decision is appended, with its stamp,
to `decisions.log` beside the cache. A repository with no policy is never held
for approval — it gets the baseline, which grants nothing extra. So does a
commit whose `.localmostrc` was deleted: it is not held, and it runs on the
baseline rather than under the policy approved for the repository before. The
policy is the file named `.localmostrc` at the repository's root and no other:
a `.localmostrc.yml` or `.localmostrc.yaml` is not read, by the runner or by
`localmost test`, so it grants nothing and is never held for approval. The
approved policy is applied only to a commit the runner checked before spawning
its worker and found carrying exactly that policy; a job at any other commit,
or one approved away since the check, runs on the baseline.

`codeload.github.com` is deliberately **not** in that set, even though the
runner uses it to download actions during job setup. Actions are third-party
code, and allowing it grants a job the ability to fetch any tarball from GitHub.
Under `strict` a repository that uses actions declares the host in its own
`.localmostrc`; the runner log names any blocked host and points at that file.

## Workflow Secrets

`localmost test` runs a workflow locally, where GitHub is not there to supply
`${{ secrets.X }}`. Values come from a `--secret-file` (`KEY=value` lines) or
`LOCALMOST_SECRET_<name>` in the environment, in that order. `--secrets prompt`
asks for anything still missing without echoing it.

- **Never taken under their own names.** A workflow chooses which secrets it
  asks for, so a variable exported for other tools (`AWS_SECRET_ACCESS_KEY`,
  `GITHUB_TOKEN`) is not handed to it; the CLI says when one is set but unused.
- **Never stored.** localmost has no secret store. Nothing is written to disk,
  and nothing persists between runs.
- **Masked in output.** Secret values are replaced with `***` in everything a
  step prints, so a step that echoes one does not spill it into the console or
  the log file.
- **Not in the environment.** Secrets reach a step only through
  `${{ secrets.X }}`, including an explicit `env:` mapping. They are not
  exported into every step's environment, where every child process would see
  them.
- **Missing secrets are announced.** With the default `stub` mode a missing
  secret becomes an empty string and the run says so; a step will act on that
  empty value, so `--secrets abort` is the safer choice for anything that
  deploys or publishes.

For jobs run by the background runner, secrets come from GitHub in the job
payload as they would on any self-hosted runner. They pass through the local
proxy in transit, are handed to the runner binary, and are not parsed, logged
or stored by localmost.

## Local Test Mode

`localmost test` runs a checkout's workflow on the Mac, each step under its own
sandbox profile. The checkout is treated as untrusted, and so is its
`.localmostrc`, which is as much the checkout's to write as its code:

- **Its policy is asked about, not applied.** Before running, the CLI lists
  everything the checkout's `.localmostrc` grants beyond the workspace - every
  write, every read past the OS baseline, every allowed host - and asks. A yes
  is remembered for that checkout's location on disk and exactly those grants;
  any change is asked again. Without a terminal, only `--yes` runs it. A policy
  that stays within the workspace and the OS baseline runs without a prompt.
- **Rooted at the workspace.** Every step's profile is rooted at the run's
  workspace, a private (`0700`) copy of the checkout. Each file is its own
  copy - an APFS clone where the volume can make one, never a hard link - so
  a write to a workspace file never reaches the checkout. `.git`,
  `node_modules` and whatever git ignores are left out, the ignore rules read
  by git itself; in a submodule or a repository nested in the checkout, what
  either its own rules or the checkout's ignore. With `--staged` only tracked
  files are copied, and a submodule's directory is left empty. A
  `working-directory`, a local action's path or an action's entry point that
  resolves outside it is refused, and fetched action code is readable but not
  writable. A step can change anything inside the workspace but not remove or
  replace the workspace directory itself.
- **Never reachable.** Whatever the policy declares, a step cannot read or
  write the app's data directory (the runner template every worker is copied
  from, approvals, settings, other runs; `~/.localmost` is closed even when the
  CLI runs with another data directory) or the credentials the runner denies a
  job at every level (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, the
  keychains, `.netrc`, `.npmrc`, `.git-credentials`, `.pypirc` and the other
  plaintext token files, and the package-manager credential files), nor
  rename any directory above them - `~/Library/Application Support`,
  `~/Library`, `~/.m2` - to reach them under another name. The CLI socket is
  closed too.
- **Nothing in home or shared temp granted implicitly.** Steps run with `HOME`,
  `TMPDIR` and the tool cache inside the workspace; a home cache is writable
  only if the policy declares it. As in a runner job, `/tmp` and the per-user
  `/var/folders` directories are not granted - only the entry a bare `mktemp`
  creates - and xcrun's cache, the clang and Swift module cache and zsh's
  here-documents are pointed into the workspace. A hard-coded `/tmp` path fails
  here as it does in a job.
- **Proxy-only network.** A step can reach the run's proxy on loopback and
  nothing else directly. Other loopback ports - a local database, a debugger,
  another app's control port - are reached only when the checkout's
  `shared.network.loopback` grants them (`true` for every port, or a list), and
  that grant is listed and asked about with the rest of the policy. The
  broker's port stays closed either way; `NO_PROXY` keeps loopback off the
  proxy. The way out is the run's proxy, which needs a per-run token, refuses
  names that resolve to internal or loopback addresses, and connects only to
  the addresses it screened. It reads the checkout's network policy as a
  runner job's proxy does: a `network.deny` host is refused whatever the allow
  list covers, and an allowed host is reached on 443 through `CONNECT` and 80
  for plain HTTP, on another port only when an entry spells `host:port`.
  Discovery applies neither, since it observes every host, and records a host
  reached on another port as `host:port`, the entry that allows it; it leaves
  loopback open, says so, and records none of it: a checkout declares its
  loopback grant itself.
- **Discovery is asked about every time.** Under `--updaterc` reads are allowed
  and recorded, and writes outside the workspace are refused and reported.
  Discovery still lets a workflow read everything but the paths above and reach
  any host, since that is what it exists to observe, so the CLI says so and
  asks before each run (or takes `--yes`). Use it on checkouts whose code you
  trust with that much.
- **No unsandboxed code in the workspace.** The app's own work in the
  workspace - step scripts, output files, action metadata, the cache intercept
  (which copies with tar under the step's profile, scoped to the checkout's
  location on disk and the repository and ref read from it) and the checkout
  intercept (which runs no git) - never follows what a step left there.
- **Nothing outlives the job.** When a job ends, its steps' process groups are
  killed, and then every process still running under one of the job's
  profiles - found by asking the kernel about each process's sandbox, which a
  process cannot leave the way it can leave its process group. That sweep runs
  a short `python3` script; if python3 cannot run, only the process groups are
  killed and the CLI says so. Interrupting the CLI (Ctrl-C, a kill, or the
  terminal closing) runs the same cleanup.
- **Signals stay inside the step.** A step can signal only processes under its
  own sandbox, not your other processes. Each step has a sandbox of its own, so
  a later step cannot signal a server an earlier one left running; the end of
  the job reaps it.

What test mode still trusts: a loopback grant is shared, so a step granted a
port reaches whatever listens on it, not only what the step started.

## Authentication

- **OAuth Device Flow**: Uses GitHub's Device Flow for user authentication, appropriate for desktop applications that cannot securely store client secrets
- **Token Management**: Access tokens and refresh tokens are obtained via the GitHub App OAuth flow
- **Token Refresh**: Expired tokens are automatically refreshed using refresh tokens
- **Access tokens are never written to disk**: They live only in memory. Only the refresh token is persisted, and a fresh access token is obtained at startup
- **Required Permissions**:
  - `Administration: Read & Write` - Register and remove self-hosted runners on repositories
  - `Actions: Read & Write` - Check workflow status and cancel running jobs
  - `Variables: Read & Write` - Write the `LOCALMOST_HEARTBEAT` variable that workflows check
  - `Contents: Read` - Fetch the repository's `.localmostrc` sandbox policy at the job's commit
  - `Metadata: Read` - Access basic repository information (required by GitHub for all apps)
  - `Self-hosted runners: Read & Write` (org-level) - Register runners at the organization level
  - `Variables: Read & Write` (org-level) - Write the `LOCALMOST_HEARTBEAT` variable at the organization level

### Docker Access

A repository may declare `docker:` in its approved `.localmostrc`. The job is
never handed a daemon socket. localmost serves a unix socket of its own inside
the worker's sandbox directory and points `DOCKER_HOST` at it; a filtering proxy
behind that socket parses every Docker API request, checks it against the policy
bound to that worker, and forwards only what passes. The socket is created
denying everything, is bound to the repository's policy when the job is
claimed, and is destroyed with the job. A worker that claims a job for a
repository other than the one its socket is bound to gets no docker access at
all. The profile denies `~/.docker` in full. The job's `docker` is a pinned CLI
bundled with the app, first on its `PATH`, reading an empty configuration
directory in its sandbox (`DOCKER_CONFIG`); the only socket it can reach is the
one localmost serves, and it cannot unlink or replace it.

Behind the filter is a Linux VM that belongs to the job - see The Docker VM
below - not Docker Desktop or any other daemon of the operator's. localmost
never uses the operator's Docker installation for jobs, and nothing falls back
to one: a VM that fails to start, or fails any of its checks, means no Docker
for that job, and the socket answers every request beyond the baseline
(below) with 503 and the reason.

What the filter refuses, each of which is an executable test against the proxy:

- a bind mount of any host path outside the job workspace - `docker run -v
  ~/.ssh:/host-ssh` is refused - including `../` traversal and a symlink that
  resolves outside the workspace, since a source is resolved before it is
  checked. The workspace itself is never resolved again: the sandbox directory
  is resolved once, when the socket starts, and `_work/<repo>/<repo>` is joined
  to it as written, so a job that replaces its checkout with a link moves
  nothing. After resolving, each directory from the sandbox directory down to
  the source is checked, and a symlink among them is refused. The daemon is
  sent the resolved path, not the spelling it was given. The daemon resolves
  that path again when the container starts, inside the VM, where a link put
  in its place after the check makes the start fail (The Docker VM, below);
- mounting the daemon socket into a container;
- `--pid=host`, `--network=host`, `--device`, and the other host-reaching
  container settings (`IpcMode`, `UtsMode`, `UsernsMode`, `CgroupParent`,
  `SecurityOpt`), none of which has a spelling in the policy grammar, and
  `--privileged`, which has one that validation refuses (below);
- a restart policy other than `no` (`--restart=always`, `unless-stopped`,
  `on-failure`), with which the daemon brings a container back after it exits
  without any request the filter sees;
- an image, registry, mount, network mode or build context the policy did not
  declare;
- a request body with a key the daemon may read as another: two keys that
  differ only in case, which the daemon's Go decoder merges, or any key, at any
  depth, that is not plain ASCII, since that decoder also reads some other
  letters as ASCII ones (`HoſtConfig` is `HostConfig` to it, so an unchecked
  key could carry `--privileged` or a root bind); a query parameter named
  outside plain ASCII; and a body nested deeper than any Docker request. A key
  repeated exactly is not refused but never reaches the daemon: JSON.parse
  keeps its last copy, while the daemon would decode every copy and keep what
  the earlier ones put in a map or struct, so each permitted JSON body is
  forwarded as the object the filter judged rather than as the bytes received;
- a body sent as a type the daemon reads parameters from: Go's server takes a
  form body's `fromImage` or `networkmode` over the URL's, so each action
  accepts only the content types that carry no form - JSON for a create or
  network create, a tar or none for a build, none or `text/plain` otherwise;
- any endpoint, API version or request body the proxy does not fully
  understand. The filter fails closed: a request it cannot evaluate is refused,
  not passed through. `POST /auth` and the checkpoint endpoints are among
  those refused.

The top level of a container create body is not yet an allowlist the way
`HostConfig` is: a top-level key the filter does not know, such as a field a
later API version adds, is forwarded unexamined. Building that allowlist from
the bodies the CLI sends is an open item.

`privileged` is the one host-reaching setting the grammar names, and
validation refuses it. A privileged container would hold every capability,
the VM's raw data disk with the repository's cached images, the whole `_work`
(the runner's step scripts and the checkout's `.git` credentials included),
every vsock port and the proxy token: the VM's kernel, not only its root user.
It would also bypass `internal:` networks and the bind hook below. Nothing
here contains a privileged container, which is why none is granted.

**The Docker VM.** A VM is booted when a job whose bound policy has a
`docker:` section is claimed, and only then. When the worker exits, the VM is
stopped and its directory, with its disk, is deleted; its containers,
networks, volumes, built images and tags go with it, so nothing a job created
is left on a daemon and no removal sweep is needed. The guest is localmost's
own, shipped inside the app and updated with it: Alpine's `linux-virt`
kernel, `dockerd`, `containerd` and `runc` on a read-only root, with small
localmost init, agent and hook programs. Each VM is run by a separate helper
(`Contents/Resources/localmost-vm`), signed with only the
`com.apple.security.virtualization` entitlement and started under a
deny-default seatbelt profile written for that one VM.

**The user's home is out of reach.** Docker Desktop shares all of `/Users`
into its VM, so the daemon's second resolution of a bind source, at container
start, could land anywhere in the home directory: a job could create a
container with an approved bind, replace the source with a link to `~`, and
start it. The job's VM is given one directory of yours, the job's own
`<sandbox>/_work`: the runner's work folder, which holds the checkout and so
every path a policy's `mounts:` can name. Besides it the VM gets only Apple's
Rosetta runtime, when Rosetta for Linux is installed, and it has no network
card. localmost creates `_work` itself before any process runs in the sandbox,
and the job's profile denies writes to the `_work` and `<sandbox>` nodes
themselves, so the job cannot rename, remove, replace, chmod or relink either;
their contents stay writable. That matters because the job's steps are
already running while the VM boots, and Virtualization.framework resolves the
share's path only when the VM starts. Until then two layers stand between a
swapped `_work` and the VM: those node denies, and the helper. The helper is
given ids, never a path from the job. It derives the share's path itself and
checks that it is a real directory, not a link, on the same device as the
sandbox, and not a mount point, so a DMG, FUSE or SMB mount placed over
`_work` makes it refuse the share. Its profile lets Virtualization.framework's
service reach only that real path: the rule that issues the service its
sandbox extension is scoped to `_work`'s subtree, so if `_work` had been
replaced by a link, its target would lie outside that subtree and the VM
would fail to start. A tripwire detects a
failure of both layers: before the worker starts, localmost writes a random
nonce to `_work/.localmost-share`, which the job's profile lets it neither
read nor replace, and a VM whose guest reads anything else there is torn
down, with the mismatch logged as an error.

Inside the guest the share is mounted at the same absolute path it has on the
Mac, `nosymfollow`, `nosuid` and `nodev`, so no path lookup through it follows
a symlink, and a bind whose source is a link, or passes through one, fails to
mount. `runc` is wrapped so that every container start runs a hook
(`lm-bindpin`) that checks each mount from the share against the binds the
filter approved for that container - by source, destination and read-only
flag, then by mount id in the container's own mount namespace - and only then
turns symlink-following back on for those binds alone, so that links inside
an approved bind work and resolve within the container. A share mount that was
not approved, or any error at all, including an agent the hook cannot reach,
fails the start. So create, swap, start fails at the start, whether the swap
is made by the job on the Mac or by another of its containers writing the
share from inside the VM, and a link the job plants resolves in the guest,
never on the Mac.

**Jobs cannot reach each other's containers.** Each job's containers run in
its own VM. The VM has no network card, and vsock, its only channel, has no
path from one guest to another, so containers of different jobs share no
bridge and cannot address each other. Docker networks exist only inside one
VM, so a job cannot join another job's network by naming it. Two findings from
the Docker Desktop backend are fixed by this: containers of different jobs on
Docker Desktop's shared default bridge reached each other by IP, and so did
builds, since the classic builder runs every `RUN` step on that bridge; and
the filter admitted any network whose name the policy allowed, even one a
concurrent job had created.

**Container egress goes through the job's proxy.** Without a network card the
guest has no route out. The one way out is a relay: the guest agent accepts
connections on a guest-only address, `198.18.0.1:3128`, and carries them over
vsock to the helper, which connects them only to that worker's own filtering
proxy on the Mac's loopback. The proxy requires the worker's token, which is
rotated at every worker start and again when the job ends, and applies the
job's own policy: the hosts its `network.allow` grants, loopback only as its
`network.loopback` declares, and the local broker's port, which the proxy
always opens and which the per-worker broker key guards; that key never
enters the VM. On a create whose network is routable (the default bridge, or
a network the job created with `internal: false`), and on every build,
localmost adds `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy` and `https_proxy`
pointing at the relay with the token, and a `NO_PROXY` of `localhost`,
`127.0.0.1` and `::1`, keeping any value the job set itself. Traffic that
ignores those settings - plain TCP, ssh, UDP, lookups of outside names - has
no route and fails at once: it is refused, not filtered. Nothing in the VM
reaches the LAN, and it reaches the Mac's loopback only through the proxy. A
Dockerfile that declares `ARG HTTP_PROXY` records the injected URL, token
included, in the image's history; the token is useless once the job ends.

A container on an `internal: true` network has no default route. It can
still forge one, since `NET_RAW` is in Docker's default capabilities: a frame
sent to its gateway's hardware address and addressed to the relay would be
delivered. So the guest firewall accepts the relay address only on the
bridges of routable networks, which the agent follows from Docker's network
events, and rejects everything else sent to the guest itself. The agent
checks those rules, and that a forged route is rejected, every time a VM
starts, and a VM that fails the check is torn down. Behind the firewall, the
proxy token is the backstop: only routable containers are given it.

**Registry credentials never enter the sandbox or the VM.** A pull is not
forwarded to the daemon. localmost pulls on the Mac: it reads the operator's
`~/.docker/config.json`, credential helpers and `credsStore` itself, takes
credentials to the registry's token exchange there, fetches the image, and
loads it into the VM over the Docker API as an archive. `X-Registry-Auth` and
`X-Registry-Config` are stripped from every forwarded request, and a job's own
is dropped. Credentials are sent only to the registry's own origin and to a
token service that passed the screening below, never on a redirect.
Credential helpers are run only from `/opt/homebrew/bin`, `/usr/local/bin` and
`/Applications/Docker.app/Contents/Resources/bin`, never looked up on
`PATH`. A configured helper that is missing, or fails for any reason but
"credentials not found", fails the pull with a message naming the helper and
the config key, rather than letting it go ahead anonymously.

**What a pull reaches.** The puller speaks only https, to registries on public
addresses: a registry whose name resolves to a loopback, link-local or private
address is refused, as `ProxyServer` refuses one, and so is plain http, so a
LAN, loopback or plain-http registry cannot be pulled from even when the
policy lists it. Registries commonly redirect blob downloads to a CDN, and the
puller follows https redirects, each screened the same way, to any public
host. So granting a registry in `pull.registries` also means that localmost
fetches from wherever that registry redirects, outside the job's
`network.allow`; the approval text for `pull.registries` says so. A layer the
image says must be fetched from a URL of its own (a foreign or
non-distributable layer) is refused. Every digest the registry names is
checked to be `sha256:` and 64 hex characters before it is used for anything,
since store paths are built from it; every blob is checked against its digest
as it streams, and every uncompressed layer against the image config's
`diff_ids`, and a mismatch fails the pull. Byte limits per pull and per job,
a limit on how far a layer may expand when decompressed, and a free-space
floor are enforced while the bytes stream.

**What the per-repository cache exposes.** Pulled images are kept per
repository: a blob store on the Mac, and a data disk built from those
verified blobs by a VM of its own that has no share and no relay and runs no
job code. Each job's VM starts from an APFS clone of that disk, and the clone
is discarded after the job, so no job can change what the next one starts
with, and built images and tags never carry over. Every job of the repository
can use every image in that cache, whatever its own workflow's policy says:
through `docker build` with `FROM <ref>@sha256:…` (the classic builder uses a
local image without pulling, and the filter does not read the Dockerfile),
through `run.images: ['*']` with an image id, or, with root in the VM, by
reading the raw disk. So an image that needed credentials never enters the
cache: after a pull, localmost asks the registry anonymously for the same
manifest digest, and an image the registry will not serve that way is kept
only for the job that pulled it, in its VM's directory, and deleted with the
VM.

**Root in the VM is worth little more than the job.** A kernel exploit from a
container gives root in the VM. The VM holds only this job's share (the
runner's step scripts in `_work/_temp` and its actions in `_work/_actions`
included, which the job can already write), this job's proxy token, this
job's pulls, and its repository's cache of public images. Once it has loaded
its fixed module allowlist, the guest disables module loading and `kexec`
until it powers off, so root there cannot load a kernel module or boot
another kernel.

**The VM's control plane is not the job's.** The helper's sockets are under
`~/.localmost/vm`, which every job's profile denies for reads and writes. The
helper takes ids, not paths; it serves those two sockets and the relay, and
listens on and dials nothing else. Everything the guest or its daemon answers
is treated as hostile: size-capped, checked against its expected shape,
stripped of control characters before it is logged, and never used to choose
a path on the Mac.

**Nothing is left running.** Each helper watches the app's process, and the
pipe the app holds open to it: when localmost exits, crashes or is killed,
every helper stops its VM and exits, and a VM
dies within about two seconds of its helper. The next launch removes the VM
directories left behind. Because the VM has no network card, it never raises
macOS's Local Network prompt.

What this does not contain:

- **A bug in Apple's virtiofs server or device emulation.** The
  Virtualization.framework service runs sandboxed to the one share, but it is
  closed source and has not been fuzzed here.
- **A kernel exploit from a container.** It gives root in the VM, which the
  above bounds but does not prevent.
- **The cache disk's input.** The VM that builds a repository's cache disk
  extracts layers from every public image the repository pulled, from any
  publisher, onto the disk every later job of the repository clones. A flaw
  in `dockerd`'s layer extraction or in the guest's ext4 would therefore reach
  later jobs of the same repository. The disk is rebuilt from blank when the
  guest changes, when it is more than seven days old and after any refresh
  that failed, which limits how long such a flaw persists but does not
  prevent it.
- **Privileged containers**, which are refused for that reason (above).
- **Hard links the job makes inside `_work`** to files it can already write.
  Seatbelt refuses `link()` on a file the job cannot write, so this adds
  nothing.
- **Hostname policy for traffic that ignores the proxy settings.** That
  traffic has no route at all. It fails; it is not filtered.
- **A filter defect.** A request that passes the filter wrongly still runs
  in the job's own VM, never on a daemon of the operator's, and reaches what
  the VM holds (above); one that lets a privileged container through reaches
  the VM's kernel as well.

Nothing but the approved `.localmostrc` grants any of this - there is no
machine-level switch to withhold it - so the approval diff is where that
decision gets made. Every grant under `docker:` is surfaced in the diff with the
same prominence as a change to `level:`. Default is off: a repository that
declares nothing under `docker:` has only the baseline of `/_ping`, `/version`,
`/info` and reads about its own containers, none of which change anything, and
no VM boots for it: until a VM is running, localmost answers those three from
the guest image's manifest and the configured VM size. They would otherwise
describe the daemon's host: its name, data directory, proxy and registry
configuration and labels, so a running VM's `/info` is rewritten to keep only
what clients use to start - `ServerVersion`, `OSType`, `Architecture`,
`OperatingSystem`, `KernelVersion`, `NCPU`, `MemTotal`, `Driver`,
`CgroupVersion` and `SecurityOptions`. The filter's design is in
`docs/superpowers/specs/2026-09-05-docker-isolation-design.md`, and the VM's,
with the evidence for each claim above, in `docs/roadmap/vm-docker-backend.md`.

## Credential Storage

- **Location**: Configuration stored in `~/.localmost/config.yaml`
- **Encryption**: The persisted refresh token is encrypted using Electron's `safeStorage` API
  - Uses macOS Keychain for secure storage
  - Encryption key is managed by the operating system and tied to the user account
  - Encrypted values are stored with an `encrypted:` prefix followed by base64-encoded ciphertext
- **Fail-secure**: Plaintext credentials are rejected; users must re-authenticate if OS encryption is unavailable
- **Non-sensitive data**: Settings like theme, runner count, and repository URLs remain in plaintext for easy user editing
- **Access Control**: The `~/.localmost` directory and all contents are user-only (700 for directories, 600 for files). The app sets `umask(077)` at startup to ensure no group or world access.

### Runner registrations

Each target's runner registrations live in `~/.localmost/runner/proxies/<target>/<n>/`: the runner's settings and the registration's RSA key. GitHub trusts that key to act as the runner: whoever holds it can open a session under the runner's name and receive the jobs routed to it, with their secrets. It therefore never enters a job's sandbox.

- **The broker signs, not the worker.** The local broker makes every call to GitHub as the runner itself, with the registration's key, app-side. The runner's listener only ever talks to the broker, and the broker ignores the token a worker presents. The job's own operations (fetching actions, caches, artifacts, logs) go to GitHub with the token GitHub issues for that one job, not with anything of the runner's.
- **The runner's token goes only to GitHub.** The broker acquires a job, on the runner's token, only from a run service at an https host under `actions.githubusercontent.com`. The job's operations are forwarded there or to GitHub's broker, and nowhere else. A job offered with any other run service is left unacquired.
- **Each worker start gets its own key.** The runner will not start without a key and a token endpoint, so each worker is given a new RSA key and a token endpoint on its own broker address. That endpoint issues a token only for an assertion signed with that key, and stops answering when the worker exits.
- **So a copied key is worth nothing.** A job can read its worker's key, but the key works only at its own worker's endpoint, and the token it gets opens nothing. A job cannot use it to act as the runner, including while localmost is paused or quit. (What a running job can still send upstream through its own worker's broker address is described under Network Policy above.)
- **Keys earlier versions exposed are replaced.** Before this, every job's sandbox held a copy of its runner's registration key, and those registrations are not ephemeral, so a key a job took then would still work. On the first start after upgrading, localmost registers each such runner again under the same name (`config.sh --replace`), which gives it a new key; GitHub stops honouring the old one. A registration that cannot be replaced at that start (offline, signed out) keeps its old key and is tried again at the next start. Removing and re-adding a target replaces its keys too.
- **Registration tokens are not in `ps` for other users.** `config.sh` gets its registration token in its environment (`ACTIONS_RUNNER_INPUT_TOKEN`), not on its command line, which any local user can list. Processes running as you, jobs included, can still read another of your processes' initial environment on macOS; the token is valid for an hour and only registers runners.

## Encryption Export Compliance

This app uses encryption **solely** for secure credential storage via OS-provided APIs:

| Platform | Encryption Provider | Implementation |
|----------|--------------------|-----------------|
| macOS | Apple Keychain Services | Via Electron `safeStorage` |

**No custom cryptographic algorithms are implemented.** The app delegates all encryption to macOS Keychain APIs.

This usage qualifies for:
- **ECCN 5D992**: Mass-market encryption exemption
- **EAR Note 4**: Exemption for authentication and access control
- **Apple App Store**: No additional export compliance documentation required (uses Apple-provided encryption only)

## Electron Security

The application implements Electron security best practices:

- **Context Isolation**: Enabled (`contextIsolation: true`) - renderer cannot access Node.js
- **Node Integration**: Disabled (`nodeIntegration: false`) - renderer runs in browser sandbox
- **Preload Scripts**: Uses `contextBridge.exposeInMainWorld()` for safe IPC
- **Electron Fuses**: Security fuses configured:
  - `RunAsNode`: false - prevents using Electron as Node.js
  - `EnableCookieEncryption`: true
  - `EnableNodeOptionsEnvironmentVariable`: false
  - `EnableNodeCliInspectArguments`: false
  - `EnableEmbeddedAsarIntegrityValidation`: true
  - `OnlyLoadAppFromAsar`: true
- **ASAR Packaging**: Application code is packaged in ASAR archive
- **Single Instance Lock**: Prevents multiple instances from running simultaneously
- **Navigation**: The window may load only its own entry page. Any other navigation, including another `file://` page, is cancelled
- **External Link Handling**: Only `https://github.com` links open, in the system browser; any other URL is refused rather than handed to the OS

## Content Security Policy

The application enforces a strict CSP header for the renderer:
```
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data: https://avatars.githubusercontent.com;
connect-src 'self';
font-src 'self';
frame-src 'none';
object-src 'none'
```

Key security features:
- **No `unsafe-inline`**: All styles are in external CSS files; dynamic styling uses CSS classes and data attributes
- **No `unsafe-eval`**: No use of `eval()`, `new Function()`, or similar dynamic code execution
- **Restricted sources**: Only same-origin resources allowed; `img-src` includes `avatars.githubusercontent.com` for displaying user profile images in the UI
- **No WebSocket directives**: The app uses Electron IPC for all process communication
- **Frame/Object blocking**: Prevents embedding of iframes and plugins

## Runner Binary

- **Source**: Downloads official GitHub Actions runner from `github.com/actions/runner` releases
- **Integrity Verification**: Downloads are verified using SHA256 checksums from GitHub's release API
  - Checksum is fetched from GitHub's official release notes
  - Downloaded tarball hash is computed and compared before extraction
  - Download is rejected if checksums don't match, preventing corrupted or tampered binaries
  - Note: The runner binaries use adhoc code signatures (no verified identity), so we don't verify signatures—the checksum provides equivalent integrity assurance
  - This verification model trusts GitHub's infrastructure, which localmost already relies on for OAuth and API access
- **Integrity record**: As the runner is extracted, localmost records the SHA-256 of every file and the target of every symlink, in `~/.localmost/runner/arc-manifests/`
  - Every worker runs a fresh copy of the installed runner, and registration runs one too. Each copy is checked against the record before it is used, so the check covers exactly what will run
  - A file added, missing or changed stops the start, with a log line naming each difference; nothing runs from that copy. Any difference counts, a `.DS_Store` left by browsing the directory in Finder included. To reinstall, quit localmost, delete `~/.localmost/runner/arc` (all of it: with one version gone, the newest one left would be used) and download the runner again
  - An install from before records were kept gets its record from a fresh download of the same release, checked against the published checksum - never from what is on disk, which may already have been changed
  - A download is extracted aside and swapped in whole, replacing any installed copy of that version, so nothing left in the old directory survives into the new one or its record
  - The record is only as trustworthy as the protection on where it is kept. Jobs cannot write any of `~/.localmost` or the app's Electron data directory except their own sandbox and their target's caches, nor rename either directory or any directory above it, whatever path a repository's policy declares writable: both directories are denied, read and write, after every grant in the job's sandbox profile, the directories above them are denied writes as nodes, and only the job's own sandbox and caches are given back after that, so a policy granting `~` or `~/.localmost` does not reach the runner, its record, or the staging directories downloads use
- **Execution**: Runner binary is spawned as a child process with controlled environment
- **Process Management**: Child processes are managed via Node.js ChildProcess handles
  - Workers are spawned with `detached: true`, so each leads a process group of its own and a stop signals the whole group. They do not end with the app on their own: quitting localmost stops them first, and the next startup sweeps what an app that crashed or was killed left running
  - Stop/cleanup uses direct process handles stored in the instances Map
  - Stale process cleanup on startup never matches processes by name or path. It signals only what it can tie to a spawn of its own, from the records in `~/.localmost/runner/pids`, which no job can write: the processes still holding a spawn's marker file descriptor, found with `lsof`; a worker's process group from its pid file, only while the process at that pid has the start time recorded when it was spawned, so a reused pid is left alone; and, with the developer tools' `python3`, whatever still runs under a sandbox profile carrying the mark of a job that was never swept (see What a job leaves running above)
- **Directory Isolation**: Each runner instance has its own working directory

## Runner Security Model

localmost adds isolation layers that the stock GitHub Actions Runner lacks:

### Sandbox Restrictions

| Resource | Access Level |
|----------|--------------|
| File system (write) | The job's own sandbox directory (workspace and temp), its target's own tool cache, under `moderate`/`permissive` its target's package cache, bare `mktemp` entries in the per-user temp, and what its approved policy declares |
| File system (read) | Essential system paths (`/usr/bin`, `/System/Library`, `/Library/Developer`); under `moderate`/`permissive` also Homebrew, `/usr/local`, Xcode and the package-manager caches; and what its approved policy declares |
| Network | Allowlisted hosts only (GitHub, npm, PyPI, etc.) via HTTP proxy |
| Docker daemon | Through a filtering socket to a Linux VM of the job's own; only declared `pull`/`run`/`build` requests are forwarded |
| Home directory | **Denied** — no access to `~/.ssh`, `~/.aws`, etc. |
| Other applications | **Denied** — no access to `/Applications`, except Xcode (`/Applications/Xcode.app`) under `moderate`/`permissive`, and what its approved policy declares |

### What Remains Accessible

| Resource | Access Level |
|----------|--------------|
| Environment variables | The runner's own, a baseline of the app's (`PATH`, `HOME`, `USER`, locale), and what the repository's `env:` policy allows |
| Process spawning | Can spawn any executable in allowed paths |
| Mach/IPC | System frameworks require this |

### Sandbox Limitations

The sandbox is **not** VM-level isolation. It primarily restricts filesystem writes:

- **Network**: Proxied through an allowlist, but the allowlist is broad (GitHub, npm, PyPI, Docker Hub, etc.). A malicious workflow could exfiltrate data to any allowlisted host.
- **Process spawning**: Allowed for any executable in permitted paths. CI runners genuinely require this capability.
- **Mach/IPC**: Allowed because system frameworks require it. This is a fundamental macOS constraint.
- **Read access**: Broader than write access—runners can read from `/usr/bin`, `/System/Library` and the Command Line Tools, and under `moderate`/`permissive` Xcode, Homebrew and the package-manager caches.

The sandbox reduces attack surface but does not provide full containment. For untrusted code, don't use a self-hosted runner.

### Risk Levels by Repository Type

| Repository Type | Risk Level | Recommendation |
|-----------------|------------|----------------|
| **Private repos you control** | Low | Safe—you're running your own code |
| **Private repos with external contributors** | Medium | Review PRs carefully before running CI |
| **Public repos** | High | **Not recommended**—any PR can run arbitrary code |
| **Forks** | High | Forked repo workflows can be modified maliciously |

### Comparison to GitHub-Hosted Runners

| Feature | GitHub-Hosted | localmost |
|---------|---------------|-----------|
| Fresh environment | New VM each job | New sandbox directory each job |
| Filesystem isolation | VM boundary | sandbox-exec restricts writes |
| Network isolation | VM boundary | Proxy allowlist |
| Credential isolation | No access to host | Home directory denied |

Every job gets a sandbox directory of its own, built fresh at a path no earlier job used, and its writes are confined to that directory and its target's own caches. Workflows cannot modify files elsewhere on your system or exfiltrate data to non-allowlisted hosts.

### User Filter

localmost includes a user filter that restricts which GitHub users' jobs are accepted. Its scope says whose involvement is checked:

| Scope | What is checked |
|-------|-----------------|
| **Everyone** | Nothing: jobs from any user are accepted (default) |
| **Trigger author** | The account that caused the event (`github.actor`), not the author of the code the run executes |
| **Repo contributors** | The trigger author, and every contributor to the repository and author of the commits since |

and who is allowed:

| Allowed users | Description |
|---------------|-------------|
| **Just me** | Only the authenticated user |
| **Allowlist** | Only specific GitHub usernames |

**Trigger author** checks `github.actor`, the account that caused the event, not the author of the code being run. A comment or a re-run by an allowed user runs whatever the commit contains, and a maintainer who updates a fork's pull request from its base branch or pushes a commit to it makes the pull request's code - all of it, whoever wrote it - run as the maintainer. Use **Repo contributors** to gate on who wrote the code: it covers the code as well, and checks the trigger author too, so it refuses at least what **Trigger author** refuses.

Under either filtering scope, a job whose trigger author cannot be read is refused, since it cannot be shown to be anyone allowed. Under **Repo contributors**, an author whose email is linked to no GitHub account counts as one no filter allows, since anyone can write such a commit. That holds for the repository's contributor list, which is read with anonymous contributors included; for the commits on the default branch dated within the day before its head was read, since GitHub serves the contributor list from a cache that can be a few hours old; and for every commit between that head and the job's commit. Each appears in the refusal as `(unattributed <commit, email or name>: no linked GitHub account, ...)`. So a repository with such an author in its history is refused under this scope, and no allowlist entry can admit it; nor, in practice, can one with more than 500 author emails, since GitHub links only the first 500 to accounts and lists the rest as anonymous. One gap remains: the recent-commit walk goes by commit date, which the committer sets, so a commit dated back more than a day and merged within the hours before the baseline was read can be missed, with its author.

The check runs before any worker is started. A refused job never runs: it is dropped, recorded in the job history, and its workflow run is cancelled. If GitHub does not take the cancel, the job's history entry says `cancel failed` with the reason, and so does a notification when job notifications are on, since the run's other jobs can still run elsewhere. A run that has already finished, as when an earlier refusal's cancel ended it, is not a failure. The check runs again when a worker starts its job; a job that fails it there has its worker stopped at once, whether or not the cancel succeeds or there is a run to cancel, and GitHub may then show that job as lost rather than cancelled. That second check needs the repository from the target's name, so it does not run for an organization target; there the check before any worker is started stands alone.

### Recommendations

1. **Only use for private repositories you control**
2. **Review all workflow changes** before they run
3. **Disable "Run workflows from fork pull requests"** in repo settings
4. **Use the user filter** to restrict which users' jobs run locally

For more information on self-hosted runner security, see:
- [GitHub: Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
- [Praetorian: Self-Hosted GitHub Runners Are Backdoors](https://www.praetorian.com/blog/self-hosted-github-runners-are-backdoors/)
- [Synacktiv: GitHub Actions exploitation](https://www.synacktiv.com/en/publications/github-actions-exploitation-self-hosted-runners)

## Heartbeat Mechanism

The runner availability check uses a GitHub Actions variable instead of requiring API tokens in workflows:

- **Repository/Org Variable**: localmost updates a `LOCALMOST_HEARTBEAT` variable with the current timestamp
- **Minimal Data**: Contains only an ISO 8601 timestamp - no secrets or sensitive information
- **No Workflow Tokens**: CI workflows read the variable directly without any authentication
- **Staleness Detection**: Heartbeat older than 90 seconds indicates runner is offline
- **Update Frequency**: Heartbeat is updated every 60 seconds while runners are active
- **Automatic Setup**: Variable is created/updated automatically when the runner starts

This approach simplifies workflows by:
- Allowing workflows to check runner availability without needing API tokens
- Using the same permissions already required for runner registration

## IPC Security

- All IPC communication uses named channels defined in `shared/types.ts`
- Renderer can only invoke explicitly exposed methods via the preload script
- No direct access to Node.js APIs from renderer process
- IPC is answered only from the main window's top frame, showing the app's own page; a message from any other frame or web contents is refused
- Every value the renderer sends is checked for shape before it is used. Target names must be GitHub names, and a target update may change only whether it is enabled
- The renderer reads the app store but cannot write it: store actions it dispatches are ignored, and every change goes through a checked IPC handler
- The settings the renderer reads never include the stored session or its refresh token

### CLI Socket

The `localmost` CLI talks to the app over a unix socket, mode `0600` inside a `0700` directory. There is no application token on top of that: any process running as the same user can connect and pause, resume, or add and remove targets. A job cannot reach the socket, because the sandbox denies it. Requests are capped in size and answered one at a time per connection, and the CLI writes its own files with umask `077`.

## Log Sanitization

Log messages are sanitized before being written to disk or displayed:
- GitHub tokens (`ghp_*`, `gho_*`, `ghu_*`, `ghs_*`, `ghr_*`, and fine-grained `github_pat_*`) are redacted
- A worker's broker key in its `/w/<key>` URL is redacted
- Credentials in a URL (`scheme://user:password@`), including the egress proxy's per-worker token, are redacted
- JWT tokens are redacted
- GitHub registration tokens are redacted
- Encrypted values and bearer tokens are redacted
- Sanitization applies to both the log file and renderer display

What reaches the log file is set by the two log levels in Settings. The
runner's standard output is logged at debug, so it is kept only when both the
runner log level and the localmost log level are Debug; it then writes the
runner's diagnostic trace, job names and runner URLs included, to
`~/.localmost/logs`. At the defaults (Warning and Info) only the runner's error
output is kept. A step's own output is not part of the runner's: it goes to the
job's log on GitHub.

## Code Signing

Code signing is required for distribution to prevent tampering warnings and establish trust.

### macOS Requirements

**Certificates needed:**
- Apple Developer Program membership ($99/year)
- "Developer ID Application" certificate for distribution outside App Store
- "Developer ID Installer" certificate if distributing PKG installers

**Entitlements**: The app and every helper are signed with the hardened runtime and only the exceptions each needs. The app, its main, GPU and renderer helpers and Squirrel's ShipIt carry `com.apple.security.cs.allow-jit` (`packaging/entitlements.plist`); the plugin helper carries `cs.allow-unsigned-executable-memory` and `cs.disable-library-validation`, as Chromium's does (`packaging/entitlements.plugin.plist`); the camera helper in Resources (`is-camera-on`, which only reads CoreMediaIO's is-running-somewhere property of each camera to pause during video calls) carries none (`packaging/entitlements.none.plist`), and so does the `docker` CLI bundled for jobs (`Resources/docker-cli/docker`); the Docker VM helper in Resources (`localmost-vm`) carries only `com.apple.security.virtualization`, with no JIT or library-validation exception (`packaging/entitlements.virtualization.plist`). The Docker VM's guest files (`Resources/guest`) are data the helper hands the VM, not macOS code, and are not signed themselves; the app checks their hashes against the guest manifest once per launch. No device or personal information entitlement - camera, microphone, USB, Bluetooth, printing, location - and not the App Sandbox, under which the app could not run jobs under `sandbox-exec`. @electron/osx-sign reads entitlements only from `optionsForFile`; given none, it signs with its own defaults, which grant the device and location entitlements, and releases through 0.2.0 carried them. The app's Info.plist declares no usage either: Electron's template says why it would use the camera, microphone, audio capture and Bluetooth, and a packager hook (`scripts/remove-usage-descriptions.js`, run just before signing) removes every `NS...UsageDescription` key from the app's and its helpers' Info.plist.

**Forge config for signing and notarization:**
```js
packagerConfig: {
  osxSign: {
    identity: process.env.APPLE_IDENTITY,
    optionsForFile: (filePath) => {
      const inResources = (...p) => filePath.endsWith(path.join('.app', 'Contents', 'Resources', ...p));
      let plist = 'entitlements.plist';
      if (filePath.includes('(Plugin).app')) plist = 'entitlements.plugin.plist';
      else if (inResources('is-camera-on') || inResources('docker-cli', 'docker')) plist = 'entitlements.none.plist';
      else if (inResources('localmost-vm')) plist = 'entitlements.virtualization.plist';
      return { hardenedRuntime: true, entitlements: path.join('packaging', plist) };
    },
    // The guest is data for the VM, not macOS code.
    ignore: (filePath) => filePath.includes('.app/Contents/Resources/guest/'),
    // Unset, @electron/packager takes this as true and only warns when
    // signing fails, so the build would go on to ship unsigned code.
    continueOnError: false,
  },
  osxNotarize: {
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  },
},
```

**CI environment variables:**
- `APPLE_IDENTITY`: Certificate name (e.g., "Developer ID Application: Your Name (TEAM_ID)")
- `APPLE_ID`: Apple ID email for notarization
- `APPLE_APP_SPECIFIC_PASSWORD`: App-specific password (not your Apple ID password)
- `APPLE_TEAM_ID`: 10-character Team ID from Apple Developer account

**Notarization** is required for macOS 10.15+ to avoid Gatekeeper warnings. Apple scans the signed app for malware before issuing a notarization ticket.

## Verifying Integrity

### Verifying the localmost app

The app is code-signed and notarized by Apple. To verify:

```bash
codesign -dv --verbose=2 /Applications/localmost.app
```

Look for:
- `Authority=Developer ID Application: Bright Fulton (8D3BFBJK55)`
- `TeamIdentifier=8D3BFBJK55`

### Verifying the runner binary

Runner binaries can be independently verified against GitHub's published checksums:

1. Find the expected checksum at https://github.com/actions/runner/releases
2. Download the same release and compute its checksum (localmost does not keep the tarball after extracting it):
   ```bash
   curl -LO https://github.com/actions/runner/releases/download/v<version>/actions-runner-osx-arm64-<version>.tar.gz
   shasum -a 256 actions-runner-osx-arm64-<version>.tar.gz
   ```
3. Compare the hashes, then compare the release with what localmost installed:
   ```bash
   mkdir release && tar -xzf actions-runner-osx-arm64-<version>.tar.gz -C release
   diff -r release ~/.localmost/runner/arc/v<version>
   ```

Note: localmost performs the checksum verification automatically during download, and checks every copy of the runner it starts against the files it extracted.
