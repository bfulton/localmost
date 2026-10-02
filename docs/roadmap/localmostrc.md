# .localmostrc — Declarative Sandbox Policy

A checked-in file that explicitly declares what network, filesystem and container access a workflow needs.

> **Status:** implemented in 0.3.0. This document describes the design; where the
> shipped behaviour differs it is noted inline.

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

Runs the workflow with reads allowed and every access logged. Writes outside
the workspace and temp are refused rather than made - a denial is logged too,
so the path is still offered - and the app's own data and the developer's
credentials stay closed, since no policy can grant them:

```
Discovered access:
  network:
    + registry.npmjs.org (npm install)
    + github.com (actions/checkout)
    + api.cocoapods.org (pod install)    ← new

  filesystem:
    + read: /opt/homebrew/bin
    + write: ./Pods/                      ← new

Write to .localmostrc? [y/n]
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
    deny:                        # For runner jobs, wins over allow and the
      - "*.analytics.com"        # level; the runner's own hosts excepted. See
                                 # "Relationship to the policy level" below.
    loopback: [5432]             # Loopback ports the job may connect to; true
                                 # for all. shared: only. See "Loopback" below.

  filesystem:
    read:                        # Never a credential: ~/.ssh (known_hosts
                                 # included), ~/.aws and the rest stay denied
                                 # whatever is declared - see SECURITY.md
      - "~/.gitconfig"
                                 # Xcode is not on the strict floor
      - "/Applications/Xcode.app"
    write:
      - "./build/**"
    deny:
      - "~/.aws/*"               # Explicit paranoia
      - "~/.ssh/id_*"

  # Container work. The job talks to a filtering socket localmost owns, not
  # the daemon; only the actions declared here are forwarded, and anything
  # unlisted is denied. Allowed in shared and per workflow. See "Docker
  # access" below.
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

  env:
    allow:
      - DEVELOPER_DIR
      - HOME
      - PATH
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

A `filesystem.deny` entry refuses reads and writes of that path and everything
beneath it, even inside a granted path. In a deny `*` matches any run of
characters within one name, never a `/`, and may appear in any component:
`~/out/sec*/key` covers `~/out/secA/key` but not `~/out/sec/A/key`, and `**` is
no different from `*` (to deny everything beneath a directory, deny the
directory). That is a deny's `*`; what `*` and `**` mean in `filesystem.read`
and `filesystem.write` is unchanged. Each entry is denied as written and by its real path,
so a deny of `/tmp/x`, `/etc/...` or a path through a symlink of your own covers
where it leads. For a `*` entry the real path is taken up to the directory
before the first `*`; a symlink past it, or a matched file that is itself a
symlink, is not followed. The directories above a deny cannot be created,
renamed or removed by the job, since renaming one would carry the denied path
out from under it. For a `*` entry that includes every directory a wildcard
stands for: under a deny of `~/out/sec*/key` the job cannot rename `~/out/secA`,
nor create, rename or move in anything directly in `~/out` whose name matches
`sec*`, while it still writes inside `~/out/secA` and creates other names in
`~/out`. A wildcard high in a path closes that many more names: under
`~/*/key`, nothing can be created, renamed or removed directly in your home.
Nor can a job clone a directory: clonefile(2) copies the whole tree beneath a
directory in one call without checking each file, so a clone of `~/out` would
carry `~/out/secA/key` into the job's sandbox under a name no deny covers. A
file still clones, and `cp -c -R` copies a tree file by file, less what is
denied.
The real path is looked up as far as it can be: a directory the app cannot look
into, a symlink loop, or a folder macOS asks permission for (Desktop, Documents,
Downloads, `~/Library`, `/Volumes`) ends the lookup there, and the rest is
denied as written. A deny is absolute, `~`, or starts with `~/`; a relative one
is a validation error, since the sandbox never matches it.

### Loopback

A job's sandbox connects directly to two loopback ports by default: its own
egress proxy, and the broker's, which the runner dials directly. Anything else
listening on the Mac's loopback - a debugger on 9229, a browser's
remote-debugging port, a development database, another job's server - is
closed to the job's own sockets, and its proxy will not forward to it either
(below). A repository whose jobs need loopback opts in under
`shared.network`:

```yaml
shared:
  network:
    loopback: true               # every loopback port
    # loopback: [5432, 6379]     # or only these
```

`true` is what a test suite that binds an ephemeral `127.0.0.1` port and
connects to it needs, since its port is not known in advance. A list names fixed
ports only: the sandbox profile language has no port ranges. Each entry is an
integer from 1 to 65535, with no repeats. The sandbox profile is fixed when the
worker starts, before the workflow is known, so `loopback` is valid in `shared:`
only; under `workflows:` it is a validation error. The broker's port is open
whatever the policy says: the runner dials the broker directly, and each
worker's key, not the port, is what guards it.

The grant appears in the approval card and `localmost policy show` with a note
that the job can reach local services on those ports, and it is part of the
approval diff and stamp like every other key. It governs the job's direct
connections and its proxy alike: through the proxy a literal loopback address
reaches the declared ports and the broker's, and nothing else - see
SECURITY.md, Network Policy.

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
      - "~/.gitconfig"
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
   `network.deny` applies to runner jobs; a per-workflow `filesystem` section,
   `deny` included, applies only in `localmost test`, because a runner job's
   filesystem is fixed when its worker starts, before the workflow is known.
   Deny a path for runner jobs under `shared:`

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
    + filesystem write: ./Pods/**

Add to .localmostrc under workflows.build? [y/n]
```

### Docker access

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
| `build` | image builds, with the classic builder (jobs run with `DOCKER_BUILDKIT=0`, since a BuildKit build streams over a gRPC session the filter cannot inspect) | `context` — which directory the workflow builds from, for the reader and the approval diff |

Conditions are checked against the request itself. Mount paths are resolved
through symlinks and must stay inside the job workspace, so `../` traversal and
absolute host paths fail structurally rather than by pattern match, and a
container may write to a mount only where the policy says `rw`.

`build.context` is the exception: it is documentation, not a check. A build
context reaches the daemon as a tar the client already assembled, so there is no
path in the request to test. A local context is confined by the sandbox profile
instead — the job can only read what the profile grants — and the filter refuses
a *remote* context, which would have the daemon fetch it and skip the profile.
Anything not listed is denied: an undeclared image, registry, mount or network
mode, and every endpoint the proxy does not understand.

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
job's `network.allow` grants, loopback as its `network.loopback` declares, and
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
this rule.

`docker:` is allowed in `shared:` and under `workflows:`, and the two compose
additively like the rest of the policy. The socket is bound to the merged policy
when the job is claimed, so a workflow can add an `rw` mount that the shared
policy does not grant. Each denial logs the policy line that would have permitted
the request, and `localmost test --updaterc` writes docker policy from those the
same way it writes network and filesystem policy.

The old levels — `docker: socket | contexts | credentials` — are rejected with an
error naming the actions that replace them, on the same reasoning `docker: true`
was rejected: guessing which grant a coarse level meant is worse than failing in
a key that governs what a container may reach.

There is still no key for arbitrary unix sockets. `localmost test --updaterc`
reports sockets a run reached, but writes no socket declaration; the only socket
a job is handed is the one localmost serves.

The design, including what the filter does and does not contain, is in
[docs/superpowers/specs/2026-09-05-docker-isolation-design.md](../superpowers/specs/2026-09-05-docker-isolation-design.md),
and the Docker VM behind it in [vm-docker-backend.md](vm-docker-backend.md).

## When a denial does not look like one

The sandbox returns the kernel's own error for a refused operation, and a tool
that was reaching for something indirectly reports the symptom rather than the
cause. Two that have cost real time:

**git dies naming a dylib, not a permission.** `/usr/bin/git` shims through
`xcrun`, which loads `libxcrun` from the *active* developer directory. Where
that is Xcode (`xcode-select -p` says `/Applications/Xcode.app/...`) and the
policy does not grant it, git fails on a missing library. A repository that
does not otherwise need Xcode can point at the Command Line Tools instead -
`DEVELOPER_DIR=/Library/Developer/CommandLineTools`, which needs no policy
change since `/Library/Developer` is already on the read floor. That belongs in
the repository's workflow: which toolchain a job wants is the repository's
choice, not the runner's, and a job that really does need Xcode should declare
`/Applications/Xcode.app` and keep it.

git also treats an unreadable `~/.gitconfig` as fatal rather than as "no
configuration", so a job may want to skip the user and system config anyway -
which makes a run independent of whose machine it happened on.

**A bind is refused before the address is checked.** The seatbelt profile
permits binding localhost, and a denied bind returns `EPERM` (errno 1) whatever
else was wrong with it. So `Operation not permitted` on an address that does
not exist on this host looks like a policy problem when it is a topology one.
localmost runs each job's Docker daemon in a Linux VM of its own: a bridge
network's gateway is an interface *inside* that VM, and binding it from the
host fails with `EADDRNOTAVAIL` (errno 49) with no sandbox involved at all. A
host process cannot join a container network there. The portable arrangement
is a container with a foot in both networks - see `run.networks` above.

**Connecting to loopback is refused unless declared.** A job may bind
localhost, but it connects directly only to its worker's own proxy there, the
broker's port, and the loopback ports `shared.network.loopback` declares: a
list of fixed ports, or `true` for all of them (a test suite that binds an
ephemeral port and talks to it needs `true`, since seatbelt matches single
ports, never ranges). A direct connect to anything else on loopback - a
database, a debugger on 9229 - fails with `EPERM` on the connect, not on the
bind; a `localmost test` step's connect to the broker's port fails whatever is
declared. The proxy applies the same rule to a request for a loopback address,
sent through `HTTP_PROXY` or tunnelled with `CONNECT`: it answers 403 unless
the port is declared, or is the broker's - the runner reaches the broker at
that port, and each worker's key to it, not the port, is what guards it. Only a
literal address gets that far: `localhost`, as a name, is refused through the
proxy on every port.

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
| `localmost test` | Enforce `.localmostrc`, fail on violations; ask first if it grants more than the workspace |
| `localmost test --updaterc` | Ask first (it reads widely and reaches any host), record reads and writes (writes outside the workspace refused), prompt to update |
| `localmost test --dry-run` | Show what *would* be accessed without running |
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

- `strict` (the default): runner infrastructure, a read-only OS baseline, and
  whatever the repo declares. This is closest to the original intent.
- `moderate`: additionally GitHub Actions infrastructure, common registries and
  tool caches.
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
broker's port, since the runner reaches the broker there,
and on the ports `network.loopback` declares. `network.deny` entries read the
same way and win over any allow, at every level; only the runner's own hosts on
their scheme's port and the broker's port stay reachable.

One thing is granted regardless of the repo's policy: the hosts the Actions
runner itself needs to register and poll for jobs. That is the runner's own
connection to GitHub rather than anything the job asked for, and the runner
cannot function without it. Because a single proxy serves both, jobs reach those
hosts too. A runner job's filesystem likewise starts from a fixed floor the
policy does not list - the operating system, `/Library/Developer` (the Command
Line Tools, not Xcode) and its own caches - see SECURITY.md.

`env:` governs what a job inherits from the environment localmost itself was
launched with, and nothing else. It never affects the variables the runner or
the workflow sets: `GITHUB_TOKEN`, secrets and a step's `env:` reach the job as
usual whatever it says, and neither does it touch what localmost sets for the
runner (the proxy, `TMPDIR`, `DOCKER_HOST`, the caches). The environment, like
the filesystem, is fixed when a worker starts, before the workflow is known.
`env: allow` therefore applies from `shared:` only, and every `env: deny`,
shared or per workflow, applies to every job. Without an allow, a job inherits
nothing from the app's environment beyond `PATH`, `HOME`, `USER`, `LOGNAME`,
`SHELL`, `LANG`, `LC_*`, `TERM`, `TZ` and `__CF_USER_TEXT_ENCODING`.

**Loopback.** Without `network: loopback` a job reaches nothing on this Mac's
loopback interface but its own proxy and the broker, directly and through the
proxy.
`loopback: true` grants every port -
what a test suite that starts servers on ephemeral ports needs - and a list
grants those ports alone; the sandbox matches single ports, not ranges.
Loopback is written into the sandbox profile, so like the filesystem it is
accepted under `shared:` only, and a per-workflow one is a validation error.
Local databases, debuggers and dev servers mostly trust whoever connects, so
the approval screen and `localmost policy show` mark the grant with a warning,
and a change to it is a policy change like any other.

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

5. **Defense in depth** — Even if code escapes the sandbox, it can only access declared resources.

## Integration with Workflow Test Mode

See [workflow-test-mode.md](./workflow-test-mode.md) for the local testing CLI design.

The test CLI becomes the policy authoring tool:
- Run your workflow locally
- Let it discover what access it needs
- Review and commit the generated `.localmostrc`

This creates a natural workflow where security policy is generated from actual behavior, not guessed upfront.
