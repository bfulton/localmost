# .localmostrc — Declarative Sandbox Policy

A checked-in file that explicitly declares what network, filesystem and container access a workflow needs.

> **Status:** implemented in 0.3.0. This document describes the design; where the
> shipped behaviour differs it is noted inline.
>
> **Every job runs in a macOS VM.** Every job the runner takes, and every
> `localmost test` run, runs in a fresh macOS VM
> ([macos-vm-jobs.md](macos-vm-jobs.md)) whose only way out is its proxy. The
> policy that applies is its network (`network.allow`, `network.deny` and
> `level`, enforced by the proxy), its `env:`, and its `docker:` - a runner
> job whose policy grants Docker is refused until the Docker relay into the
> VM exists. `filesystem:` grants are not given to any job yet: the runner
> names them in its log when a job starts, and `localmost test` before it
> runs; the grammar stays for VM shares. `network.loopback` and `isolation:`
> are ignored with a warning.

## Problem

Before 0.3.0 the sandbox used a single global allowlist (GitHub, npm, PyPI, etc.).
That was:

1. **Too permissive** — Every repo got access to everything on the allowlist
2. **Not auditable** — No visibility into what a specific project actually needs
3. **Reactive** — You found out about new access requirements when things failed

## Solution

Each repo declares its sandbox policy in a file named `.localmostrc` at its root.
That is the only name read, by the runner at a job's commit and by `localmost test`
and `localmost policy` in a checkout alike: a `.localmostrc.yml` or
`.localmostrc.yaml` is not a policy, and the CLI says so when it finds one. A
`.localmostrc` that `policy init` or `test --updaterc` writes beside one does
not take its grants; rename the file first to keep them.

```yaml
# .localmostrc
version: 1

shared:                          # Applies to all workflows
  network:
    allow:
      - registry.npmjs.org
      - github.com
  filesystem:
    write:
      - ./build/

workflows:                       # Per-workflow additions
  deploy:
    network:
      allow:
        - api.fastlane.tools     # Only deploy needs this
```

**Default sandbox: deny everything.** Only punch holes for what's declared. Each workflow gets shared policy plus its own additions.

## The Workflow

### 1. First run: Discovery mode

```bash
localmost test --updaterc
```

Runs the workflow in a fresh macOS VM with its proxy letting every host
through and recording each, then offers what it recorded. Filesystem access is
not recorded: nothing traces it in the VM yet (guest-side tracing of the paths
a step misses is planned).

```
Discovery Results:
  Network: 3 host(s) discovered
    - registry.npmjs.org
    - github.com
    - api.cocoapods.org
  Filesystem: not recorded - discovery in the macOS VM does not trace filesystem access yet

These will be added to .localmostrc:
  network.allow
    + api.cocoapods.org
```

### 2. Subsequent runs: Enforced mode

```bash
localmost test
```

Strictly enforces `.localmostrc`. New access = hard failure:

```
✗ Network access denied: api.sketchy-cdn.com
  Not in .localmostrc allowlist

  To allow, run: localmost test --updaterc
```

### 3. Background runner: Cached policy + diff review

The app caches `.localmostrc` per repo. When it changes:

```
┌─────────────────────────────────────────────────┐
│  Policy change detected: myorg/mygame           │
│                                                 │
│  + network: api.newservice.com                  │
│  - network: api.oldservice.com (removed)        │
│                                                 │
│  [Allow] [Deny] [View Diff]                     │
└─────────────────────────────────────────────────┘
```

A compromised dependency that tries to exfiltrate data would:
1. Fail immediately (not in allowlist)
2. Require explicit human approval to add

## File Format

### Full schema

```yaml
# .localmostrc
version: 1

# Shared policy — baseline for all workflows
shared:
  network:
    allow:
      - "*.github.com"           # Wildcard subdomain
      - "registry.npmjs.org"     # Exact match
    deny:                        # Wins over allow and the level; the runner's
      - "*.analytics.com"        # own hosts excepted. See "Relationship to
                                 # the policy level" below.

  filesystem:                    # Not given to any job yet: a job's macOS VM
                                 # waits for VM shares, and says it runs without
    read:
      - "~/.cache/pre-commit"
    write:
      - "./build/**"
    deny:
      - "~/.aws/*"               # Explicit paranoia
      - "~/.ssh/id_*"

  # Container work. The job talks to a filtering socket localmost owns, not
  # the daemon; only the actions declared here are forwarded, and anything
  # unlisted is denied. Allowed in shared and per workflow. A runner job whose
  # policy grants any of it is refused until the Docker relay into its macOS
  # VM exists. See "Docker access" below.
  docker:
    pull:
      registries:
        - docker.io              # Pulled on the Mac, from it and wherever it redirects
    run:
      images:
        - "postgres:16"
      mounts:
        - path: ./               # Workspace paths only, resolved through symlinks
          mode: ro               # ro | rw
      network: bridge            # Routable: out through the job's proxy only
    build:
      context: ./
      tags:
        - "myapp:*"              # Names a build may tag; never a run.images one

  env:
    allow:
      - DEVELOPER_DIR
      - FASTLANE_*
    deny:
      - AWS_*
      - GITHUB_TOKEN             # Not inherited from localmost's own environment

# Per-workflow policies — merged with shared
workflows:
  build:
    filesystem:
      write:
        - "./DerivedData/**"

  deploy:
    network:
      allow:
        - "api.fastlane.tools"
    secrets:
      require:
        - APPSTORE_CONNECT_KEY

  integration:
    docker:                      # Composes with shared.docker
      run:
        mounts:
          - path: ./tmp/fixtures
            mode: rw
```

### Wildcards

| Pattern | Matches |
|---------|---------|
| `*.github.com` | Any name ending in `.github.com`, at any depth: `api.github.com`, `a.b.github.com`. Not `github.com` itself, nor `raw.githubusercontent.com` |
| `registry.npmjs.org` | Exact match only |
| `./build/**` | All files under `build/` recursively |
| `~/.ssh/id_*` | `~/.ssh/id_rsa`, `~/.ssh/id_ed25519`, etc. |

A `filesystem.deny` entry names a path no grant may reach, even inside a
granted path. In a deny `*` matches any run of characters within one name,
never a `/`, and may appear in any component: `~/out/sec*/key` covers
`~/out/secA/key` but not `~/out/sec/A/key`, and `**` is no different from `*`.
A deny is absolute, `~`, or starts with `~/`; a relative one is a validation
error. With nothing of the Mac's filesystem in a job's VM yet, a deny has
nothing to refuse; it is approved and shown like the rest, for VM shares.

A job's home is the guest's own, made fresh with its VM; how a grant under
your home reaches it is part of the VM shares design
([macos-vm-jobs.md](macos-vm-jobs.md)).

### Loopback

`network.loopback` once opened ports on the Mac's loopback to a job's
sandbox. A job's macOS VM has a loopback of its own, where a step reaches a
server another step started, and reaches the Mac only through its proxy,
which refuses every loopback port but the broker's. A `.localmostrc` that
still has the key parses with a warning, and the key is dropped: it is
neither approved, shown nor written back.

### Isolation

`isolation:` once listed, in order, the isolation types a repository's jobs
accepted. Every runner job now runs in a macOS VM, so there is nothing to
choose: a `.localmostrc` that still has the key, under `shared:` or a
workflow, parses with a warning, and the key is dropped - it is neither
approved nor shown, and a cached approval that has it reads back without it.

### Per-workflow policies

Policies have two levels: **shared** (applies to all workflows) and **per-workflow** (scoped to a specific workflow file).

```yaml
# .localmostrc
version: 1

# Shared policy — applies to ALL workflows
shared:
  network:
    allow:
      - "*.github.com"
      - "registry.npmjs.org"
  filesystem:
    read:
      - "~/.cache/pre-commit"
    write:
      - "./build/**"

# Per-workflow policies — only apply to specific workflows
workflows:
  # Matches .github/workflows/build.yml
  build:
    network:
      allow:
        - "cdn.cocoapods.org"    # CocoaPods for iOS builds
    filesystem:
      write:
        - "./Pods/**"
        - "./DerivedData/**"

  # Matches .github/workflows/deploy.yml
  deploy:
    network:
      allow:
        - "api.fastlane.tools"   # App Store deployment
        - "itunesconnect.apple.com"
    filesystem:
      read:
        - "~/.fastlane/**"       # Fastlane credentials
    env:
      allow:
        - FASTLANE_*
        - MATCH_*
    secrets:
      require:                   # These secrets MUST be provided
        - APPSTORE_CONNECT_KEY
        - MATCH_PASSWORD

  # Matches .github/workflows/test.yml
  test:
    # No additional permissions — inherits only shared policy
```

**Resolution order:**
1. Start with `shared` policy
2. Merge workflow-specific policy (additive)
3. Explicit `deny` in workflow policy can revoke shared access. A per-workflow
   `network.deny` applies to the job's proxy when the job is claimed. A
   per-workflow `filesystem` section is fixed too late for a worker, which
   starts before the workflow is known: declare paths under `shared:`

**Why this matters:**
- A compromised dependency of the test workflow can't use the deploy
  workflow's grants - which protects against dependencies, not commit authors
  (see Workflow matching)
- Build workflow can't phone home to analytics even if deploy can
- Each workflow gets exactly what it needs, nothing more

**Workflow matching:**
- Keys under `workflows:` match the workflow filename (without `.yml`/`.yaml`),
  taken from `github.workflow_ref`. Where a job arrives without that — an older
  runner service — the workflow's `name:` is used instead, so name a section
  after the file and the two agree
- `build` matches `.github/workflows/build.yml`
- For matrix workflows, all jobs in the workflow share the workflow's policy
- Keys are not a boundary. A `workflows.<name>` section is available to any
  commit that can run a workflow file with that name, including pull requests,
  which can add or change a workflow file like any other; approving a
  per-workflow grant approves it for anyone who can open a PR

**Discovery mode with per-workflow policies:**

```bash
localmost test --updaterc build.yml
```

```
Discovered access for build.yml:
  shared (already allowed):
    ✓ registry.npmjs.org
    ✓ github.com

  workflow-specific (new):
    + network: cdn.cocoapods.org

Add to .localmostrc under workflows.build? [y/n]
```

### Docker access

**Not available to runner jobs yet.** A runner job runs in a macOS VM, and
nothing carries the filtering socket into it until the Docker relay is built:
a job whose approved policy grants its workflow any Docker action is refused
at admission, with a reason naming the missing relay, rather than started in a
VM where its first `docker` command would fail. What follows is the design the
relay will connect to.

`docker:` does not open the daemon socket. Each worker gets a unix socket of its
own, served by localmost outside the sandbox, and `DOCKER_HOST` points the job at
it. A filtering proxy behind that socket parses every Docker API request, checks
it against the approved policy, and forwards only what is permitted to a Linux
VM of the job's own. The VM boots at the first Docker request, beyond
`/_ping`, `/version` and `/info`, of a job whose policy has a `docker:`
section, so a job that never runs `docker` has none (or, with the opt-in
`dockerVm.prewarm`, as a spare when an
idle worker is spawned, stopped at the claim unless that job uses it). It sees
no directory of the Mac but the job's work folder, which holds the checkout,
and Apple's Rosetta runtime for amd64 images, and it is discarded, with every
container, network, volume and built image in it, when the job ends.
localmost never uses the operator's Docker Desktop, Colima or Podman for jobs,
and the job's `docker` is a CLI bundled with the app.

Actions are CLI-shaped, so a policy reads the way a workflow author thinks:

| Action | Covers | Conditions |
|---|---|---|
| `pull` | image pulls | `registries` — the registry each pulled image comes from |
| `run` | container create, start, attach, wait, kill, stop, remove and logs; creating a declared network; inspecting a declared image | `images` — the images a container may be created from, and the only images it may inspect; each entry is an anchored glob where `*` stops at `/`, so a content-addressed tag can be declared as `vk/grader:*` while `vk/*:*` reaches one level under `vk` and no further; a glob must say which tags it covers, since a tagless reference means `:latest` — `vk/*` is refused, `vk/*:*` accepted; `networks` — networks the job may create, each an anchored name glob plus whether it is `internal`; `mounts` — workspace paths a container may bind, each `ro` or `rw`; `network` — the container's network mode |
| `build` | image builds, with the classic builder (jobs run with `DOCKER_BUILDKIT=0`, since a BuildKit build streams over a gRPC session the filter cannot inspect) | `tags` — the names a build may tag its image with (`-t`), each an anchored glob matched as `run.images` entries are (`*` stops at `/`, and a glob must say which tags it covers: `myapp:*`, not `myapp*`); `context` — which directory the workflow builds from, for the reader and the approval diff |

Conditions are checked against the request itself. Mount paths are resolved
through symlinks and must stay inside the job workspace, so `../` traversal and
absolute host paths fail structurally rather than by pattern match, and a
container may write to a mount only where the policy says `rw`.

`build.context` is the exception: it is documentation, not a check. A build
context reaches the daemon as a tar the client already assembled, so there is no
path in the request to test. A local context is confined by the sandbox profile
instead — the job can only read what the profile grants — and the filter refuses
a *remote* context, which would have the daemon fetch it and skip the profile.
Anything not listed is denied: an undeclared image, registry, mount, network
mode or build tag, and every endpoint the proxy does not understand.

`build.tags` is a check. A build's tag replaces any local image of that name,
and a later `docker run` of the name uses it without a pull, so every `-t` a
build carries (`docker build -t a -t b` sends both) must match an entry. Two
kinds of tag are refused whatever `build.tags` says, and the denial offers no
policy line for them:

- a tag with a registry host - a first component, before a `/`, with a `.` or
  `:` in it, an uppercase letter, or that is `localhost`
  (`ghcr.io/o/app`, `localhost:5000/app`, `docker.io/library/app`). The image
  was never fetched from there. Validation refuses such an entry too;
- a tag in a repository `run.images` names, in any case, and with or without
  a tag of its own: under `run.images: ["postgres:16"]` the tags `postgres:16`,
  `postgres`, `Postgres:17` and `library/postgres:16` are all refused. What an
  approver reads as the image the job runs stays that image.

So an image a job builds cannot also be one it runs by name: declaring it in
`run.images` makes the build's tag refused. A build with no tag needs no entry,
and `t` spelled in any other case (`T=`) is refused, since one daemon ignores
it and another reads it as a tag. Validation also refuses an entry outside
the reference grammar, reading each `*` as a letter - an uppercase name
(`MyApp:*`, written `myapp:*`), a space, a non-ASCII character - since it
would be listed for approval and match no tag the daemon accepts. A tagged
build under a policy with no `build` action is denied with a hint that names
its tags as well as the context, so one `--updaterc` pass writes a policy that
permits it.

A small baseline needs no declaration: `/_ping`, `/version`, `/info`, and reads
about the job's own containers. Every client needs them to start, and none
changes anything on the host. `/info` is answered with the fields clients use
(`ServerVersion`, `OSType`, `Architecture`, `OperatingSystem`, `KernelVersion`,
`NCPU`, `MemTotal`, `Driver`, `CgroupVersion`, `SecurityOptions`) and not the
host name, data directory, proxy and registry settings or labels the daemon
would otherwise report.

There is no key at any level for `--pid=host`, `--network=host`, `--device`,
mounting the daemon socket into a container, or the other host-reaching
container settings; what cannot be named cannot be requested. `privileged` is
the one exception, because docker-in-docker and qemu emulation need it. It
exists in the grammar and is rejected at validation, with an error saying why:
a privileged container reaches the Docker VM's kernel, and with it everything
the VM holds, so running the daemon in a VM does not make it safe to grant.

**Networks.** The VM has no network card. A container's only way out is the
job's own proxy, so `routable` - the default bridge, `network: bridge`, or a
network declared with `internal: false` - means *through the job's proxy,
subject to its network allowlist*: a routable container reaches the hosts the
job's `network.allow` grants and
the local broker's port, which the proxy always opens and the broker's
per-worker key guards. localmost injects `HTTP_PROXY`, `HTTPS_PROXY`,
`http_proxy`, `https_proxy` and `NO_PROXY` into every routable container and,
as build args, into every build, keeping any value the job set. Traffic that
ignores those settings - plain TCP to an outside database, `git` over ssh, UDP,
DNS lookups of outside names - has no route and fails at once. The injected
`NO_PROXY` covers only `localhost`, `127.0.0.1` and `::1`, so a job that talks
from one container to another by service name over HTTP adds the name to
`NO_PROXY` itself. `internal: true` means no egress at all.

**Pulls.** A pull happens on the Mac, not in the VM: localmost fetches the
image, checks every digest, and loads it into the job's VM. Registry
credentials never enter the sandbox or the VM. localmost reads the operator's
`~/.docker/config.json` and credential helpers itself, so a private registry
needs only its name under `pull.registries`, and the job never reads that file.
A credential helper named by `credsStore` or `credHelpers` must be in
`/opt/homebrew/bin`, `/usr/local/bin` or Docker.app's bundled `bin`; one that is
missing or fails fails the pull with a message naming the config key, rather
than pulling anonymously. Only public https registries can be pulled from: a
registry that resolves to a LAN, link-local or loopback address, or that serves
plain http, is refused even when listed. A registry commonly redirects its
downloads to a CDN, and localmost follows https redirects to any public host,
so listing a registry under `pull.registries` also grants fetching from
wherever that registry redirects, outside the job's `network.allow`. The
approval text says so.

**Builds.** The builder runs inside the VM, which has no route to a registry, so
it cannot pull a `FROM` image itself. A job pulls its base images with `docker
pull` first, which `pull.registries` must allow, and then builds. A build that
fails because it tried to fetch a base image gets a line in the job log naming
this rule. The filter does not read the Dockerfile, so a `FROM` may name any
image already in the VM, whatever `run.images` says.

`docker:` is allowed in `shared:` and under `workflows:`, and the two compose
additively like the rest of the policy. The socket is bound to the merged policy
when the job is claimed, so a workflow can add an `rw` mount that the shared
policy does not grant. Each denial logs the policy line that would have permitted
the request, and `localmost test --updaterc` turns those into docker policy, once
Docker reaches the VM.

The old levels — `docker: socket | contexts | credentials` — are rejected with an
error naming the actions that replace them, on the same reasoning `docker: true`
was rejected: guessing which grant a coarse level meant is worse than failing in
a key that governs what a container may reach.

There is still no key for arbitrary unix sockets: the only socket a job is
handed is the one localmost serves.

The design, including what the filter does and does not contain, is in
[docs/superpowers/specs/2026-09-05-docker-isolation-design.md](../superpowers/specs/2026-09-05-docker-isolation-design.md),
and the Docker VM behind it in [vm-docker-backend.md](vm-docker-backend.md).

## When a denial does not look like one

**A bind is refused before the address is checked.** A bridge network's
gateway is an interface inside the Linux VM that runs a job's Docker daemon,
so binding it from outside fails with `EADDRNOTAVAIL` (errno 49): a topology
problem, not a policy one. A process outside cannot join a container network
there. The portable arrangement is a container with a foot in both networks -
see `run.networks` above.

**Loopback through the proxy is refused.** A request for a loopback address
sent to a job's proxy, through `HTTP_PROXY` or tunnelled with `CONNECT`, is
answered 403 unless its port is the broker's (the runner reaches the broker
there, and each worker's key to it, not the port, is what guards it).
`localhost`, as a name, is refused on every port. A step reaches its own VM's
loopback directly: `NO_PROXY` keeps `localhost`, `127.0.0.1` and `::1` off
the proxy.

## Why Checked Into Git

**Version controlled:**
- Team members share the same policy
- PR review catches suspicious additions
- History shows when/why access was added

**Auditable:**
```bash
# Find all repos in your org that access unusual domains
grep -r "analytics" *//.localmostrc
```

**Diff-friendly:**
```diff
network:
   allow:
     - registry.npmjs.org
     - github.com
+    - api.newservice.com    # Added for feature X
```

## CLI Commands

| Command | Behavior |
|---------|----------|
| `localmost test` | Run the workflow in a macOS VM, its proxy enforcing `.localmostrc`; ask first if it allows any host |
| `localmost test --updaterc` | Ask first (it reaches any host), record the hosts reached, prompt to update |
| `localmost test --dry-run` | Show the steps that would run, without a VM |
| `localmost policy show` | Display current policy for this repo |
| `localmost policy diff` | Compare local vs cached policy |

## Edge Cases

### No `.localmostrc` exists

```
No .localmostrc found. Run with --updaterc to generate.
Running in permissive mode (not recommended for untrusted code).
```

### Relationship to the policy level

**Shipped behaviour differs from this design.** A `.localmostrc` does not replace
anything; it adds to whatever the configured policy level already allows:

The level is the job's proxy's alone: its macOS VM has a system and a home of
its own, and none of the Mac's filesystem.

- `strict` (the default): runner infrastructure and whatever the repo
  declares. This is closest to the original intent.
- `moderate`: additionally common registries, CDNs and GitHub content hosts.
- `permissive`: no network restrictions.

Under `strict` and `moderate` a host is reached on 443 through `CONNECT` and on
80 for plain HTTP. A network entry that spells a port - `api.example.com:8443`,
`*.example.com:8080`, `[2001:db8::1]:8443` - allows that port and no other; a
bare IPv6 address is all address. An entry is a host, an IP address or
`*.domain`, with an optional port, in the spelling a request's host arrives in
(case is ignored; ASCII, punycode for an international name, no trailing dot);
a URL, a path or surrounding spaces is a validation error rather than an entry
that matches nothing. `localmost test --updaterc` writes a host it saw reached
on another port as `host:port`. An `http://` URL tunnelled through `CONNECT`,
rather than sent as a plain proxied request, needs a `host:80` entry. A literal
loopback address (`127.0.0.1`, `::1`) is reachable at every level only on the
broker's port, since the runner reaches the broker there. `network.deny` entries read the
same way and win over any allow, at every level; only the runner's own hosts on
their scheme's port and the broker's port stay reachable.

One thing is granted regardless of the repo's policy: the hosts the Actions
runner itself needs to register and poll for jobs. That is the runner's own
connection to GitHub rather than anything the job asked for, and the runner
cannot function without it. Because a single proxy serves both, jobs reach those
hosts too.

`env:` governs what a job is given of the environment localmost itself was
launched with, and nothing else. It never affects the variables the runner or
the workflow sets: `GITHUB_TOKEN`, secrets and a step's `env:` reach the job as
usual whatever it says, and neither does it touch what localmost sets for the
runner (the proxy and the runner's own settings). The environment is fixed
when a worker starts, before the workflow is known. `env: allow` therefore
applies from `shared:` only, and every `env: deny`, shared or per workflow,
applies to every job. Without an allow, a runner job is given nothing of the
app's environment beyond `LANG`, `LC_ALL` and `TZ`; the guest sets its own
`HOME`, `PATH`, user and shell. The guest agent takes a name only if a job may
set it: none the agent sets itself, none that changes how the shell starts
(`BASH_ENV`, `ENV`, `ZDOTDIR` and the like), `NODE_OPTIONS` and `NODE_PATH`,
and none beginning `DYLD_`, `LD_`, `DOTNET_`, `COREHOST_`, `COMPlus_`,
`CORECLR_`, `RUNNER_`, `ACTIONS_`, `GITHUB_` or `BASH_FUNC_`; an allow that
names one gives the job nothing. A `localmost test` step is held to the same
rule, except that it is given the `GITHUB_*` and `RUNNER_*` variables a step
reads, which no runner sets there.

A repo's policy only takes effect once approved, in Settings > Job Security or
with `localmost policy approve`, which shows the policy and a stamp, then
`localmost policy approve --stamp <stamp>`, which approves exactly that policy.
An approval is bound to the repository's GitHub id as well as its name, so a
different repository that takes the name is asked about again even with the
same file. Only Settings > Job Security, which shows the id changing, can move
an approval to it; the CLI, which sees a clone with no id, cannot.

### CI vs local differences

Some access may only be needed in CI (deployment credentials) or only locally (debug tools). Use comments to document:

```yaml
network:
  allow:
    - registry.npmjs.org
    - fastlane.tools         # CI only: app store deployment
```

## Security Benefits

1. **Least privilege by default** — `strict` is the default. Each repo declares what it needs beyond the baseline.

2. **Auditable** — The file is in git. You can grep your org for repos that access unusual domains.

3. **Low friction** — `--updaterc` generates the policy for you. No manual authoring.

4. **Supply chain defense** — A malicious package update that phones home gets blocked unless someone explicitly approves the new domain in a PR.

5. **Defense in depth** — Even code that takes root in its VM reaches the network only through the proxy, and only the hosts declared.

## Integration with Workflow Test Mode

See [workflow-test-mode.md](./workflow-test-mode.md) for the local testing CLI design.

The test CLI becomes the policy authoring tool:
- Run your workflow locally
- Let it discover what access it needs
- Review and commit the generated `.localmostrc`

This creates a natural workflow where security policy is generated from actual behavior, not guessed upfront.
