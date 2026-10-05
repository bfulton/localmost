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

- **Everything of your Mac**: Every job the runner takes runs in a macOS VM of its own, booted from an APFS clone of a golden image no job has touched and thrown away with its clone when the job ends ([macos-vm-jobs.md](docs/roadmap/macos-vm-jobs.md)). Inside it the job is the guest's ordinary, non-admin `runner` user. Nothing of the Mac is shared into the VM: not your home, credentials, keychain, preferences, temp directories, loopback services or other processes. What a job writes, caches or leaves running goes with its VM
- **Network exfiltration**: The VM has no network card. Its only ways out are two vsock relays, to the job's own filtering proxy and to the local broker, so the host policy holds even for code that ignores `HTTP_PROXY` and opens a raw socket: it has no route. Under `strict` the reachable set is runner infrastructure plus what the repository declares — not npm, PyPI or other registries
- **Other jobs**: Each job has its own VM, disk clone, machine identity and saved state, and at most two run at once. No disk, share or socket is common to two jobs
- **Environment**: A job is given nothing of the app's environment but `LANG`, `LC_ALL`, `TZ` and what its repository's approved `env: allow` names (`*` matches any run of characters), less what `env: deny` names. The variables localmost sets for the runner - the proxy and the runner's own settings - come after the policy, so no policy can replace them, and the guest agent refuses any name that would change how the loader, the shell or the runner's own code is found (see [localmostrc.md](docs/roadmap/localmostrc.md)). Inside the guest, none of it reaches code that runs as root: the agent starts `launchctl asuser` and its own `exec-as` with a fixed `PATH` alone, and hands the job's environment over in a file of root's that `exec-as` applies only after it has become the job user. Secrets from GitHub reach steps through the job payload as usual; this is about what the host contributes
- **Container work**: Not available yet. A job whose approved policy grants Docker is refused at admission, with a reason naming the missing relay, until the relay that carries the filtering Docker socket into the VM exists. The design it will connect to is under Docker Access below
- **The app's own control plane**: A job cannot reach the approval cache, the settings file or the CLI control socket: nothing of the Mac's filesystem reaches its VM. Without this, a workflow could approve its own policy and the approval gate would mean nothing
- **Credential exposure**: OAuth tokens are encrypted at rest using macOS Keychain, and the runner registration's key never enters a VM (see Runner registrations)

### Policy levels

A repository declares its level in `.localmostrc`:

```yaml
version: 1
level: strict    # strict (default) | moderate | permissive
```

A repository that declares no level runs `strict`. Silence means the tightest
setting, so a policy that says nothing cannot inherit something looser.

The level is the job's proxy's: `strict` grants runner infrastructure plus
declared hosts, `moderate` adds the common package registries, CDNs and GitHub
content hosts, and `permissive` allows every host (see Network Policy below).

A worker's environment is fixed when it starts, so approving a policy retires
that repository's idle workers. If a worker still claims a job after its
approved policy changed - its network, Docker, filesystem grants or env - the
job runs with its network cut back to runner infrastructure, and the worker
is retired afterwards. A job already running is left alone.

The level is part of the policy, so changing it is a policy change: it appears
in the approval diff and takes effect only once approved. A repository cannot
loosen its own policy without the machine owner agreeing to it.

### Filesystem grants, and keys that are ignored

A job's VM - a runner job's or a `localmost test` run's - is given no
filesystem grants yet: the runner names them in its log when a job starts,
and `localmost test` says so before it runs. VM shares of granted paths are
planned ([macos-vm-jobs.md](docs/roadmap/macos-vm-jobs.md), Not built yet).
`isolation:`, which once chose among isolation types, and `network.loopback`,
which once opened ports on the Mac's loopback, are ignored with a warning:
every job runs in a macOS VM, which has a loopback of its own.

### What localmost trusts (does NOT protect against)

- **GitHub's infrastructure**: OAuth, API responses, and runner binary distribution are trusted. If GitHub is compromised, localmost provides no additional protection.
- **Malware on your machine**: If your system is already compromised, localmost cannot protect you.
- **A compromised GitHub account**: If an attacker has access to your GitHub account, they can modify workflows that run on your runner.
- **Allowlisted hosts**: Data can be exfiltrated to any host the active policy allows. Under `strict` that is runner infrastructure plus whatever the repository declares; looser levels allow more. Among the infrastructure hosts allowed at every level, `github.com`, `api.github.com` and `*.blob.core.windows.net` accept writes from any account, so `strict` limits reach, not exfiltration - see Network Policy below.
- **Approved policies**: Once you approve a repository's `.localmostrc`, everything it declares is granted until you approve another. Approval is a judgement about that content, and is bound to it: what you approve is the policy you were shown, level included. A write grant on a place something outside a job later acts on - `~/Library/LaunchAgents` and the other launchd directories, shell rc files, `~/.gitconfig`, `~/Library/Application Support`, the package caches `~/.gradle`, `~/.m2`, `~/.cargo` and `~/.nuget`, `/usr/local/bin`, `/opt/homebrew/bin`, or a parent of any of them, `~` and `/` included - is marked with a warning in the approval screen and `localmost policy show`, for what it would mean once VM shares exist. No job's VM is given a filesystem grant yet.
- **Per-workflow network sections**: A `workflows:` section can narrow or widen *network* access per workflow, because hosts are applied to the proxy when a job is claimed.
- **Per-workflow env sections**: The environment is fixed when the worker starts, for the same reason. `env: allow` is taken from `shared:` only; a per-workflow allow is not applied. `env: deny` is taken from `shared:` and from every workflow, and applied to every job - a per-workflow deny is honoured more widely than written rather than not at all.
- **Per-workflow sections are not a boundary between contributors**: A `workflows.<name>` section is available to any commit that can run a workflow file with that name, including pull requests; approving a per-workflow grant approves it for anyone who can open a PR. The key matches a file name, and a pull request can add or change a workflow file like any other. Per-workflow sections keep a compromised dependency of one workflow from using another's grants, not a commit author.
- **The broker**: A job always reaches the broker's port, through its relay and through its proxy - see Network Policy below. The broker is protected from jobs only by its per-worker key.
- **Processes running as you**: The CLI control socket is guarded only by file permissions (`0600` in a `0700` directory). Any process running as your user can control the app through it - pause, resume, add or remove targets, or borrow a macOS VM as `localmost test` does - as it could by editing `~/.localmost` directly.
- **Apple's Virtualization.framework**: A job runs in a macOS VM, and a Docker job's containers would run in a Linux VM. A bug in Apple's device emulation (virtio disk, graphics, input, entropy, vsock) or virtiofs server, which is closed source and has not been fuzzed here, is not contained by anything localmost adds. That boundary is what a job's isolation rests on.
- **Root in the guest**: A job can become root in its own guest through a macOS flaw. Root there can rewrite the guest agent's answers, which the app treats as untrusted and bounded; it has no network card to bring up, reaches the Mac only through the same two relays, and its VM is discarded at the end of the job.
- **The Mac's resources**: A job VM has 4 CPUs and 6 GiB of memory for its life, and disk until the data volume's free space falls below 10 GiB, when its VM is stopped. Both job VMs share that reserve, so one job's writes can end the other's.

## Network Policy

Job traffic is routed through a local proxy, which decides each connection by
hostname. A runner job's VM has no network card: in the guest the agent
listens on `127.0.0.1:<proxy port>` and `127.0.0.1:<broker port>` and relays
each connection over vsock to the job's proxy and the broker on the Mac's
loopback, and nothing else, so the proxy is the job's only way out. The runner
dials the broker directly at `127.0.0.1`, because its HTTP client sends a
loopback destination around the proxy; what guards the broker is each
worker's key (below), not a closed port. No other loopback port of the Mac is
reachable from a VM.

The proxy holds a request for a loopback address to the same rule, at every
level, `permissive` included: a plain request or a `CONNECT` tunnel to
`127.0.0.1`, `::1` or any other `127/8` address is refused with 403 unless its
port is the broker's. `localhost`, and any other name for this machine, is
refused on every port, the broker's included: only a literal address is
forwarded to loopback. The broker's port stays
open, through the proxy and directly, because the runner reaches the local
broker. What keeps a job from using that port is the broker's own
authentication: each worker talks to it at an address carrying a key of its own
(`http://127.0.0.1:<port>/w/<key>/`), and the broker answers each key only
with its own worker's session and the jobs delivered to that worker. Of what
a worker sends it, the broker forwards upstream on the runner's credentials
only the requests the runner itself sends there: `POST completejob` and
`POST renewjob`, its run-service client's job operations. Everything else the
runner can send to its broker address (opening, polling and deleting a
session, acknowledging a message, acquiring a job, and the worker's token
endpoint) the broker answers itself, and any other method or path is refused
with 403 and a log line naming it, whatever state the worker's session is in.
localmost installs the newest runner
release by default. The list was read from the source of runner 2.336.0, the
version localmost falls back to, which a test holds it to, and checked against
2.337.0, the newest release when it was written. A later release that sends
another request upstream has it refused, failing closed, until the list is
read again from that release's source.
Those two operations must name that worker's job and no other: any request id
one carries must be one delivered to that worker, and its plan and job ids
those of the job details it acquired. An operation is recognised however its
path is spelled, in any case or percent-encoded, and goes upstream under its
own name, not the spelling sent; its body must write each of those ids under
its exact key (`planId`, not `PlanId`): the JSON decoders of .NET and Go read
a key in any case, and Go's reads some other letters as ASCII ones
(`requeſtId` as `requestId`), so a body that spells one otherwise, or has any
key that is not plain ASCII, is refused. A path that decodes to anything but
plain ASCII is refused too, and so is any spelling of a path the broker
answers itself (`/Message`, `/message/`, `/%6dessage`), or another method on
one. The target's upstream session id is put in place of
the session id an operation carries, under `sessionId`, so a query that also
spells it another way (`SessionId`, or with a letter Go reads as an ASCII
one), or has any parameter name that is not plain ASCII, is refused rather
than forwarded: upstream could read that spelling beside or instead of the id
put there. The runner of those versions addresses `completejob` and
`renewjob` to the job's own system connection, which the broker does not
rewrite, so in practice they go to GitHub directly, on the job's own token,
and nothing a worker sends is forwarded upstream at all. That key, not the
closed port, is what keeps a job from acting as another worker, and from
acting as the runner through the operations above.

A repository declares one of three levels in its `.localmostrc` (`level:`; see
Policy levels above), and one that declares none runs `strict`. Settings under
Job Security describes them but does not choose one; a change of level is a
policy change, approved like any other:

- **strict** (default): runner infrastructure, plus whatever the repository's
  `.localmostrc` declares
- **moderate**: also common package registries, and CDNs and GitHub content
  hosts anyone can publish to
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
because the runner reaches the broker at `127.0.0.1` - no others. The broker is guarded by
each worker's key, not by its port. A name that resolves to loopback,
`localhost` included, is refused.

A `network.deny` entry is read the same way and refuses its host at every
level, `permissive` included, whatever the allow list says; an entry with a
port denies that port only. The runner infrastructure hosts on their scheme's
port, and the broker's port on loopback, cannot be denied. Like the allow list, it matches names, not addresses:
at `permissive` a job can still reach the same server by its address or another
name.

A runner job's filesystem is its VM's: the guest's own macOS, the Command
Line Tools and the runner baked into the golden image, and the job's
workspace and temp, all on its disk clone and gone with it. Nothing of the
Mac's filesystem is shared into it, so a policy's `filesystem:` grants give a
runner job nothing yet, and its denies have nothing to deny. A `localmost
test` run's VM is the same. `localmost policy init` starts from a policy that
runs, and `localmost test --updaterc` records the hosts a workflow reaches.

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

`localmost test` runs a checkout's workflow in a fresh macOS VM, cloned from
the same golden image and taken from the same two slots as runner jobs. The
running app boots it when the CLI asks over the control socket, and stops it
and deletes its clone when that connection closes. Without the app, or with
no golden image built, the run stops before any step and names the step to
take. The checkout is treated as untrusted, and so is its `.localmostrc`,
which is as much the checkout's to write as its code:

- **Its policy is asked about, not applied.** Before running, the CLI lists
  every host the checkout's `.localmostrc` allows, and asks. A yes is
  remembered for that checkout's location on disk and exactly those hosts;
  any change is asked again. Without a terminal, only `--yes` runs it.
  Filesystem grants and `docker:` are not given in the VM yet, so they are
  not asked about; the CLI names what the run goes without.
- **The VM is the steps' whole world.** The workspace is a private (`0700`)
  copy of the checkout - an APFS clone of each file where the volume can make
  one, never a hard link - without `.git`, `node_modules` and whatever git
  ignores, the ignore rules read by git itself; with `--staged`, tracked files
  only. It is sent into the guest as a tar and unpacked by the guest's
  non-admin `runner` user, so nothing in it - a link, an owner, a mode - can
  do what that user cannot. Each step runs as that user, in the workspace or
  a `working-directory` under it, with the guest's own home, temp and
  toolchains. A remote action's code is fetched on the Mac and sent in the
  same way, under a directory of its own. Nothing of the Mac is shared in:
  not your home, credentials, keychain, preferences, the app's data or its
  control socket, loopback services or processes.
- **A narrow agent.** The guest agent takes a test run's commands only from
  the host, and only in a fixed shape: two upload destinations (the workspace
  and `actions/<id>`), four programs (bash, sh, zsh and the runner's own
  node), paths only under the workspace or an action's upload, an environment
  of the names a runner job may be given plus `GITHUB_*` and `RUNNER_*`, and
  bounded sizes (512 MiB an upload, 32 KiB a script, 16 KiB of a step's
  outputs). A step's script and `GITHUB_OUTPUT` file sit in a directory of
  root's, so the step can use them but never put a link where the agent
  writes or reads. A VM runs a runner job or a test run, never both, and
  only the connection that sent the workspace can run or signal its steps.
- **Proxy-only network.** The guest has no network card. Its only ways out
  are the helper's two vsock relays: to the run's proxy on the Mac, at the
  same `127.0.0.1` port in the guest, and to a port the CLI holds that closes
  every connection, standing in for the broker a test run has no use for.
  The proxy needs a per-run token, refuses every literal loopback target and
  every name that resolves to an internal or loopback address, and connects
  only to the addresses it screened. It reads the checkout's network policy
  as a runner job's proxy does: a `network.deny` host is refused whatever the
  allow list covers, and an allowed host is reached on 443 through `CONNECT`
  and 80 for plain HTTP, on another port only when an entry spells
  `host:port`. The guest's loopback is its own, so a step reaches a server
  another step started directly.
- **Discovery is asked about every time.** Under `--updaterc` the proxy
  applies no policy and records every host, as `host:port` when reached on
  another port. That lets the checkout's code reach any host with whatever
  the run hands it, so the CLI says so and asks before each run (or takes
  `--yes`). Filesystem access is not recorded in the VM yet.
- **Nothing outlives the run.** At the end of each job the agent kills every
  process group the job's steps started. Ending the run - at its end, on an
  error, or on Ctrl-C, a kill or the terminal closing - closes the agent
  connection, which kills the steps, and releases the VM.
- **Nothing of the steps' runs on the Mac.** The CLI reads only its own copy
  of the checkout, before any step: a local action's metadata, and what it
  sends in. The checkout intercept runs no git, and `actions/cache` restores
  nothing and saves nothing: caches are not kept between runs in the VM yet.

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

**Not available to runner jobs yet.** A runner job runs in a macOS VM, and
nothing carries the filtering socket below into it until the Docker relay is
built. Until then a job whose approved policy grants its workflow any Docker
action is refused at admission, with a reason naming the missing relay; it is
never started without what its policy says it needs. What follows describes
the filtering socket and the Docker VM behind it, which the relay will
connect to, written as they served jobs that ran on the Mac.

A repository may declare `docker:` in its approved `.localmostrc`. The job is
never handed a daemon socket. localmost serves a unix socket of its own inside
the worker's sandbox directory and points `DOCKER_HOST` at it; a filtering proxy
behind that socket parses every Docker API request, checks it against the policy
bound to that worker, and forwards only what passes. The socket is created
denying everything, is bound to the repository's policy when the job is
claimed, and is destroyed with the job. A worker that claims a job for a
repository other than the one its socket is bound to gets no docker access at
all. The profile denies `~/.docker` in full. The job's `docker` is a pinned CLI
bundled with the app, linked in the job's own bin directory first on its
`PATH`, reading an empty configuration
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
- an image, registry, mount or network mode the policy did not declare, and a
  remote build context. A local build context is not checked against
  `build.context`, which is documentation: the context reaches the daemon as a
  tar the client assembled inside its sandbox, so the profile confines it;
- a build tag (`-t`, every one when it repeats) that no `build.tags` glob
  matches, and, whatever `build.tags` says, one that carries a registry host
  (`ghcr.io/o/app`, `localhost:5000/app`, `docker.io/library/app`) or names a
  repository `run.images` declares, in any case and with or without a tag
  (`postgres`, `POSTGRES:17` under `postgres:16`). A build's tag replaces the
  local image of that name, and a later `docker run` of it uses that image
  without a pull, so a build tagged `postgres:16` would have run in place of
  the image the approver read. `t` in another case (`T=`), which moby ignores
  and Podman reads as a tag, is refused. The tag cannot outlive the job: its
  VM, with every image built in it, is discarded when the job ends;
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

**The Docker VM.** By default a VM is booted only for a job whose bound
policy has a `docker:` section, and only at that job's first Docker request
the filter permits beyond the baseline it answers itself; a job that never
makes one has no VM. Job code has run by then, which is why the share is
made, and made unswappable, when the sandbox is built, before any job process
(below). With the opt-in `dockerVm.prewarm`,
one spare is booted when an idle worker is spawned, before any claim; it holds
only that worker's sandbox, whose job has not started, and at the claim it is
stopped unless the job's policy has a `docker:` section and the job is for the
repository the worker was spawned for. A repository's cache disk is built by a
VM of its own that runs no job code (below). When the worker exits, the VM is
stopped and its directory, with its disk, is deleted; its containers,
networks, volumes, built images and tags go with it, so nothing a job created
is left on a daemon and no removal sweep is needed. The guest is localmost's
own, shipped inside the app and updated with it: Alpine's `linux-virt` kernel,
`dockerd`, `containerd` and `runc` on a read-only root, with small localmost
init, agent and hook programs. Each VM is run by a separate helper
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
their contents stay writable. That matters because the job's steps are already
running while the VM boots, and Virtualization.framework resolves the share's
path only when the VM starts. Until then two layers stand between a swapped
`_work` and the VM: those node denies, and the helper. The helper is given
ids, never a path from the job. It derives the share's path itself and checks
that it is a real directory, not a link, on the same device as the sandbox,
and not a mount point, so a DMG, FUSE or SMB mount placed over `_work` makes
it refuse the share. Its profile lets Virtualization.framework's service reach
no directory of yours but that real path: the rule that issues the service its
sandbox extension for the share is scoped to `_work`'s subtree, and is never
broadened (any rule Rosetta's share needs names only Apple's runtime), so if
`_work` had been replaced by a link, its target would lie outside that subtree
and the VM would fail to start. A tripwire detects a failure of both layers:
before the worker starts, localmost writes a random nonce to
`_work/.localmost-share`, which the job's profile lets it neither read nor
replace, and a VM whose guest reads anything else there is torn down, with the
mismatch logged as an error.

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
its own VM. The VM has no network card, and vsock, its only channel besides
its own share, has no path from one guest to another, so containers of
different jobs share no bridge and cannot address each other. Docker networks
exist only inside one VM, so a job cannot join another job's network by naming
it. Two findings from the Docker Desktop backend are fixed by this: containers
of different jobs on Docker Desktop's shared default bridge reached each other
by IP, and so did builds, since the classic builder runs every `RUN` step on
that bridge; and the filter admitted any network whose name the policy
allowed, even one a concurrent job had created.

**Container egress goes through the job's proxy.** Without a network card the
guest has no route out. The one way out is a relay: the guest agent accepts
connections on a guest-only address, `198.18.0.1:3128`, and carries them over
vsock to the helper, which connects them only to that worker's own filtering
proxy on the Mac's loopback. The proxy requires the worker's token, which is
rotated at every worker start and again when the job ends, and applies the
job's own policy: the hosts its `network.allow` grants, and the local
broker's port, which the proxy
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
forwarded to the daemon. localmost pulls on the Mac, anonymously first. Only
when the registry refuses an anonymous request does it read the operator's
`~/.docker/config.json`, credential helpers and `credsStore` itself, once per
registry for the job, and take the credentials to the registry's token
exchange there; a registry that serves the image anonymously never has its
credential helper run. It fetches the image and loads it into the VM over
the Docker API as an archive. `X-Registry-Auth` and
`X-Registry-Config` are stripped from every forwarded request, and a job's own
is dropped. Credentials are sent only to the registry's own origin and to a
token service that passed the screening below, never on a redirect.
Credential helpers are run only from `/opt/homebrew/bin`, `/usr/local/bin` and
`/Applications/Docker.app/Contents/Resources/bin`, never looked up on
`PATH`. When the registry wants credentials, a configured helper that is
missing, or fails for any reason but "credentials not found", fails the pull
with a message naming the helper and the config key, after saying that the
registry refused an anonymous pull (which is also how Docker Hub answers a
repository that does not exist).

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
is discarded after the job, so nothing a job does inside its VM - its
containers, volumes, built images and tags, or its writes to the disk -
carries over. What carries over is only the public images its pulls fetched
and verified on the Mac, which the refresh VM extracts onto the repository's
next disk (see the cache disk's input, below). Every job of the repository
can use every image in that cache, whatever its own workflow's policy says:
through `docker build` with `FROM <ref>@sha256:…` (the classic builder uses a
local image without pulling, and the filter does not read the Dockerfile),
through `run.images: ['*']` with an image id, or, with root in the VM, by
reading the raw disk. So an image that needed credentials never enters the
cache: an image whose pull never needed them is public, and its layers are
fetched anonymously too; one that did is cached only if the registry then
serves its manifest, index and config digests anonymously, and its layers
are again fetched without the credentials. An image the registry will not
serve that way, or one of whose layers it will not, is kept only for the job
that pulled it, in its VM's directory, and deleted with the VM.

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
helper is given ids and localmost's own directories, never a path the job
chose; it serves those two sockets and the relay, and listens on and dials
nothing else. Everything the guest or its daemon answers is treated as
hostile: size-capped, checked against its expected shape, stripped of control
characters before it is logged, and never used to choose a path on the Mac.

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
  The job's workspace is inside its own macOS VM, so a link there can name
  only a file of the guest's, which the job could already reach; this adds
  nothing.
- **Hostname policy for traffic that ignores the proxy settings.** That
  traffic has no route at all. It fails; it is not filtered.
- **A filter defect.** A request that passes the filter wrongly still runs
  in the job's own VM, never on a daemon of the operator's, and reaches what
  the VM holds (above); one that lets a privileged container through reaches
  the VM's kernel as well.

Nothing but the approved `.localmostrc` grants any of this - there is no
machine-level switch to withhold it - so the approval diff is where that
decision gets made. Every grant under `docker:` is surfaced in the diff with
the same prominence as a change to `level:`. Default is off: a repository that
declares nothing under `docker:` has only the baseline of `/_ping`,
`/version`, `/info` and reads about its own containers, none of which change
anything, and no VM boots for its jobs (a pre-warmed spare, if one is enabled,
is stopped at the claim); nor, for a repository that does declare some, does
one boot until its job asks for more than these: until a VM is running,
localmost answers those three from the guest image's manifest. They would
otherwise describe the daemon's host: its name, data directory, proxy and
registry configuration and labels, so a running VM's `/info` is rewritten to
keep only what clients use to start - `ServerVersion`, `OSType`,
`Architecture`, `OperatingSystem`,
`KernelVersion`, `NCPU`, `MemTotal`, `Driver`, `CgroupVersion` and
`SecurityOptions`. The filter's design is in
`docs/superpowers/specs/2026-09-05-docker-isolation-design.md`, and the VM's,
with the evidence for each claim above, in
`docs/roadmap/vm-docker-backend.md`.

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

Each target's runner registrations live in `~/.localmost/runner/proxies/<target>/<n>/`: the runner's settings and the registration's RSA key. GitHub trusts that key to act as the runner: whoever holds it can open a session under the runner's name and receive the jobs routed to it, with their secrets. It therefore never enters a job's VM: the guest is given only the worker's own per-start key and the runner's settings.

- **The broker signs, not the worker.** The local broker makes every call to GitHub as the runner itself, with the registration's key, app-side. The runner's listener only ever talks to the broker, and the broker ignores the token a worker presents. The job's own operations (fetching actions, caches, artifacts, logs) go to GitHub with the token GitHub issues for that one job, not with anything of the runner's.
- **The runner's token goes only to GitHub.** The broker acquires a job, on the runner's token, only from a run service at an https host under `actions.githubusercontent.com`. The two job operations the broker forwards for a worker (`completejob` and `renewjob`) go there or to GitHub's broker, and nowhere else; it forwards no other request. A job offered with any other run service is left unacquired.
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
  - The record is only as trustworthy as the protection on where it is kept. A runner job reaches nothing of `~/.localmost`: no path of the Mac is shared into its VM, nor into a `localmost test` run's
- **Execution**: A job's runner runs in its macOS VM, started by the guest agent as the guest's non-admin `runner` user with `--once` and nothing else; the host never executes the runner for a job. If the guest lacks the host's runner version, the host's checked copy is packed and uploaded, its SHA-256 verified by the agent. Registration runs `config.sh` on the Mac, unsandboxed - it contacts GitHub with your token and runs no workflow code - from a copy checked against the record
- **Process Management**: A worker is the runner in its VM, seen through the guest agent: its output lines and exit come back over vsock, and stopping it sends SIGTERM through the agent and, five seconds later, stops the VM under it. A worker's exit, a reap of one that never took its job, and quitting all stop its VM and delete its disk clone
  - At startup, before any job, every VM directory an earlier run left is removed, and the helper it recorded is killed only if that pid is alive and its executable is this app's macOS VM helper, since a pid may have been reused. Nothing is matched by name. The helper also stops its VM when it sees the app gone
- **Directory Isolation**: Each worker start has a sandbox directory of its own on the Mac, holding the runner files its VM is given, and a disk clone of its own in its VM

## Runner Security Model

localmost adds isolation layers that the stock GitHub Actions Runner lacks:

### Job Isolation

| Resource | Access |
|----------|--------|
| File system | The guest's own, on a disk clone of the golden image made for the job and deleted after it; nothing of the Mac is shared |
| Network | No network card: only the job's proxy (an allowlist) and the broker, over two vsock relays |
| Docker daemon | None yet: a job whose policy grants Docker is refused |
| Home, keychain, preferences | The guest user's own; none of yours |
| Other processes | The guest's own; none of the Mac's, and no other job's |
| Environment variables | The runner's own, the locale and time zone, and what the repository's `env:` policy allows of the app's |
| Privileges | The guest's non-admin `runner` user |

### Isolation Limits

- **Network**: Proxied through an allowlist, but the allowlist is broad under `moderate` (package registries, CDNs) and the runner's own hosts accept writes from any account. A malicious workflow could exfiltrate what it holds - its checkout and its secrets - to any allowed host.
- **The VM boundary**: A job that becomes root in its guest, through a macOS flaw, can still reach the Mac only through Virtualization.framework's devices and the two relays. A flaw in those is not contained by anything localmost adds.
- **Resources**: A job VM takes 4 CPUs and 6 GiB of memory, two at most at a time, and disk until the data volume's free space falls below 10 GiB.

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
| Fresh environment | New VM each job | New macOS VM each job, cloned from a golden image |
| Filesystem isolation | VM boundary | VM boundary; nothing of the Mac shared |
| Network isolation | VM boundary | No network card; proxy allowlist |
| Credential isolation | No access to host | No access to host |

Every job gets a VM of its own, restored from a state no job has touched, and the VM and its disk go when the job ends. Workflows cannot reach files on your Mac or send data to hosts their proxy does not allow.

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

The `localmost` CLI talks to the app over a unix socket, mode `0600` inside a `0700` directory. There is no application token on top of that: any process running as the same user can connect and pause, resume, or add and remove targets. A job cannot reach the socket: nothing of the Mac's filesystem reaches its VM, and a `localmost test` step's sandbox denies it. Requests are capped in size and answered one at a time per connection, and the CLI writes its own files with umask `077`.

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

**Entitlements**: The app and every helper are signed with the hardened runtime and only the exceptions each needs. The app, its main, GPU and renderer helpers and Squirrel's ShipIt carry `com.apple.security.cs.allow-jit` (`packaging/entitlements.plist`); the plugin helper carries `cs.allow-unsigned-executable-memory` and `cs.disable-library-validation`, as Chromium's does (`packaging/entitlements.plugin.plist`); the camera helper in Resources (`is-camera-on`, which only reads CoreMediaIO's is-running-somewhere property of each camera to pause during video calls) carries none (`packaging/entitlements.none.plist`), and so does the `docker` CLI bundled for jobs (`Resources/docker-cli/docker`); the Docker VM helper in Resources (`localmost-vm`) and the macOS VM helper beside it (`localmost-macvm`) carry only `com.apple.security.virtualization`, with no JIT or library-validation exception (`packaging/entitlements.virtualization.plist`), and the macOS VM's guest agent (`localmost-macvm-agent`), which runs only inside the guest, carries none. A job, and each `localmost test` step, runs in a guest, which has neither helper, so neither can start a VM of its own. The Docker VM's guest files (`Resources/guest`) are data the helper hands the VM, not macOS code, and are not signed themselves; they are covered by the app bundle's seal like any other resource, so `codesign --verify` fails if one is changed, and the app also checks their hashes against the guest manifest once per launch. No device or personal information entitlement - camera, microphone, USB, Bluetooth, printing, location - and not the App Sandbox, under which the app could not run its helpers under `sandbox-exec`. @electron/osx-sign reads entitlements only from `optionsForFile`; given none, it signs with its own defaults, which grant the device and location entitlements, and releases through 0.2.0 carried them. The app's Info.plist declares no usage either: Electron's template says why it would use the camera, microphone, audio capture and Bluetooth, and a packager hook (`scripts/remove-usage-descriptions.js`, run just before signing) removes every `NS...UsageDescription` key from the app's and its helpers' Info.plist.

**Forge config for signing and notarization:**
```js
packagerConfig: {
  osxSign: {
    identity: process.env.APPLE_IDENTITY,
    optionsForFile: (filePath) => {
      const inResources = (...p) => filePath.endsWith(path.join('.app', 'Contents', 'Resources', ...p));
      let plist = 'entitlements.plist';
      if (filePath.includes('(Plugin).app')) plist = 'entitlements.plugin.plist';
      else if (inResources('is-camera-on') || inResources('docker-cli', 'docker') || inResources('localmost-macvm-agent')) plist = 'entitlements.none.plist';
      else if (inResources('localmost-vm') || inResources('localmost-macvm')) plist = 'entitlements.virtualization.plist';
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
