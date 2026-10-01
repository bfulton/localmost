# VM Docker Backend — One Linux VM per Job

Each job that uses Docker gets its own small Linux VM, booted by localmost and
discarded when the job ends. The filtering socket forwards approved requests to
a `dockerd` inside that VM instead of to Docker Desktop.

> **Status:** in progress. This is stage 2 of
> [Docker Isolation — Owning the Socket, Then the Daemon](../superpowers/specs/2026-09-05-docker-isolation-design.md).
> The interfaces the pieces are built against are in
> [vm-docker-backend-contract.md](vm-docker-backend-contract.md), and the work
> is split into packages in
> [the implementation plan](../superpowers/plans/2026-09-30-vm-docker-backend.md).
> The evidence is the VZ risk register (R1–R29, cited by number below) and a
> design spike run on 2026-09-30 (see [What was verified](#what-was-verified)).
> The owner has decided the three questions review raised, each as
> recommended (see [Decisions for the owner](#decisions-for-the-owner)).

## Problem

The filter (stage 1) decides what a container is created with. The daemon
behind it is still the operator's Docker Desktop, and three things escape the
filter because of that.

### G-A: a bind is resolved again after the filter checked it

Docker Desktop shares all of `/Users` into its VM. The filter resolves a bind
source through symlinks, checks that it is inside the workspace, and sends the
daemon the resolved path. But the daemon resolves that path again when the
container starts, on a filesystem that reaches the user's whole home:

1. The job creates a container with an approved bind, `-v $GITHUB_WORKSPACE/data:/data`.
2. It replaces `data` with a symlink to `/Users/<user>`.
3. It starts the container. The container's `/data` is the user's home, read-write.

A container that has a writable workspace mount can plant the same symlink from
inside and restart itself. `SECURITY.md` lists this as an open item. It cannot
be closed in the filter, because the filter is not there when the daemon
resolves the path. The only fix is a daemon that cannot see the home directory
at all.

### Jobs reach each other's containers

Two findings from the same investigation, both present today:

- Containers of different jobs on Docker Desktop's default bridge reach each
  other by IP. The classic builder runs every `RUN` step on that bridge, so
  builds do too.
- The filter admits any network whose *name* equals `policy.run.network`, even
  one the job did not create (`docker-evaluator.ts`, the `NetworkMode` and
  `EndpointsConfig` checks). A job can join another concurrent job's network by
  naming it.

### Container egress is not the job's egress

Container traffic leaves through Docker Desktop's network. The policy's host
allowlist never sees it, and it reaches the Mac's loopback services through
`host.docker.internal`. The policy text says so (`UNFILTERED_EGRESS` in
`docker-policy.ts`). That is honest, but it means a `docker:` grant quietly
switches off the network policy for everything run in a container.

### Why Docker Desktop's share causes all three

Docker Desktop runs one long-lived VM for everything the user does. It shares
`/Users` so that `docker run -v ~/src:/src` works anywhere, and all containers,
from every job and from the operator, share its bridge. Every one of the
problems above comes from that one design choice.

## Solution

Move the daemon into a VM that localmost owns. The VM belongs to one job, and
the only host directory it can see is that job's own work folder.

```
 job (seatbelt)                Electron main                 localmost-vm helper          Linux guest (per job)
 ─────────────                 ─────────────                 ───────────────────          ─────────────────────
 docker CLI ──unix──▶ <sandbox>/docker.sock
                        DockerFilterProxy ──unix──▶ <data>/vm/jobs/<vm>/docker.sock ──vsock:2375──▶ lm-agent ─▶ dockerd
                        (policy check)               (splice)                                            │
                        VmBackend ─────────unix──▶ <data>/vm/jobs/<vm>/agent.sock ──vsock:1025──▶ lm-agent (control)
                        ImagePuller ─(docker load over the same docker.sock)                             │
                                                                                                   containers
 ProxyServer (per worker) ◀──TCP 127.0.0.1── helper ◀──vsock:3128── lm-agent relay ◀── 198.18.0.1:3128 ◀┘
```

- **One VM per job.** Booted when a job whose bound policy has a `docker:`
  section is claimed. Stopped and deleted when the worker exits.
- **One share.** The VM sees one host directory, the job's `<sandbox>/_work`.
  localmost creates that directory before the worker starts, and the job cannot
  rename or replace it. It is mounted in the guest at the same absolute path,
  `nosymfollow` and `nosuid`, and a runtime hook turns symlink-following back on
  only for binds the filter approved.
- **No network card.** The VM has no NIC. Containers reach the network only
  through a relay to the job's own egress proxy, which keeps its per-worker
  token check. The network allowlist applies to container traffic the same way
  it applies to the job.
- **Pulls happen on the Mac.** localmost fetches images, checks every digest,
  and loads them into the VM over the Docker API. Registry credentials never
  enter the VM.
- **A cache per repository.** Pulled images that passed the digest check are
  kept in a per-repository data disk. Each job gets an APFS clone of it. Built
  images and tags never carry over from one job to the next. Every job of the
  repository can use everything in that cache, whatever its own workflow's
  policy says, so an image that needed the operator's registry credentials is
  kept out of it (see [Decisions for the owner](#decisions-for-the-owner)).
- **localmost's own guest.** A small Alpine-based guest ships inside the app:
  kernel, `dockerd`, `containerd`, `runc`, a read-only root, and small
  localmost init, agent and hook programs. It is updated with the app.
- **A small signed helper.** A Swift binary with only the
  `com.apple.security.virtualization` entitlement runs each VM under a seatbelt
  profile made for that VM. Electron main talks to it by slot and VM id and
  never passes it a path that came from a job.

## The owner's decisions, and why

These were settled before this design and are not open questions.

| # | Decision | Why |
|---|---|---|
| 1 | One Linux VM per job, discarded after the job. No shared long-lived VM. | A long-lived VM re-points existing binds when its share is switched, and its VZ sandbox keeps every folder it ever shared (R3). VZ never returns guest memory, so stopping the VM is the only way to reclaim it (R4). Guest root in a shared VM would reach every concurrent job. |
| 2 | Boot at claim, and only for jobs whose bound policy has a `docker:` section. Answer the client's baseline `/_ping`, `/version` and `/info` without booting. A pre-warmed spare VM is a config option, off by default. | Most jobs never use Docker. An idle VM costs about 388 MB and every running one adds memory pressure (R5). On the spike guest `dockerd` answered 0.32 s after the guest kernel started, so booting at claim costs little. |
| 3 | No Docker Desktop fallback. Remove the Docker Desktop backend. | Two backends with different path semantics means two things to test, and the fallback would be the one with G-A open (R19). |
| 4 | No NIC. Containers reach the network only through a relay to the job's `ProxyServer`. "Routable" means "through the job's proxy". A filtering userspace network stack goes on the roadmap backlog. | NAT gives unfiltered egress to the internet, the LAN and host services (R6). vsock-only fails closed (R7). A userspace stack that enforces hostnames is a project of its own (R26, [vm-network-stack.md](vm-network-stack.md)). |
| 5 | Pulls happen on the Mac: localmost pulls, verifies digests and loads into the VM. Registry credentials never enter the VM. `pull.registries` stays enforced where it is today. | Pulling inside the VM puts `X-Registry-Auth` in guest memory, which contradicts `SECURITY.md` (R17). |
| 6 | Image cache per repository, holding only pulled images verified by digest. Built images and tags never persist across jobs. | Anything shared and writable across jobs is a poisoning path (R14). Cold stores cost 2.5–13 s per image (R15). |
| 7 | localmost's own small Alpine-based guest, shipped inside the app and updated with it. Apple's `container` project is rejected. | Alpine's security team triages kernel CVEs for us (R12). Apple's project needs macOS 26, has no Docker Engine API, and installs with an admin `.pkg`. |
| 8 | A small Swift helper signed with only `com.apple.security.virtualization`, under its own seatbelt profile. Electron main talks to it by slot id, never by paths from the job. | A VM control API that accepts paths reopens G-A. The helper must not be a job-reachable socket (R9). |
| 9 | Binds in the guest: the share is mounted `nosymfollow` (and `nosuid`), and an OCI runtime hook re-enables symlink-following only on approved binds. | Without it, create, swap, start gives any job guest root (R2). |
| 10 | amd64 images run under Rosetta for Linux only (`VZLinuxRosettaDirectoryShare`, binfmt flags `CF`). If Rosetta is not installed, refuse amd64 with a clear error and never trigger the install prompt. No qemu. The Mac-side puller fetches amd64 when an image has no arm64 build or the job asks for amd64. | Rosetta is already what Docker Desktop uses (R20). qemu would add a GPL userland to maintain. |
| 11 | Bundle a pinned `docker` CLI on the job's PATH. A failing or missing credential helper is loud, never silently anonymous. | Without Docker Desktop there is no CLI at all, and today's `registry-auth.ts` turns every helper error into an anonymous pull (R13). |
| 12 | Minimum macOS raised from 12 to 14. | Save/restore, Rosetta caching options and a mature VZ stack. Lima found Intel kernel-boot bugs fixed only in 13.5 (R19). |
| 13 | The auto-updater downloads updates automatically (`autoDownload` on). | The guest now carries a kernel, `runc` and `dockerd`. Their fixes must reach users (R12). |
| 14 | All of it on PR #40. The owner is the only user. Intel is already dropped. | |

## Architecture

### Components

| Component | Where | Language | Role |
|---|---|---|---|
| `DockerFilterProxy` | Electron main, one per worker | TS | Unchanged in role: checks each request against the bound policy. Now forwards to the job's VM. It also intercepts pulls, injects proxy settings, and reports approved binds. |
| `VmBackend` | Electron main | TS | Replaces `DockerBackend`/`DesktopBackend`. Hands each worker a `WorkerDocker` tied to that worker's VM. |
| `VmManager` | Electron main | TS | VM lifecycle: admission, boot, readiness, stop, startup sweep, sleep/wake, the pre-warmed spare. |
| `HelperClient`, `AgentClient` | Electron main | TS | Talk to the helper over stdio and to the guest agent over the helper's `agent.sock`. |
| `ImagePuller`, `ImageStore` | Electron main | TS | Registry client on the Mac, a per-repository blob store verified by digest, and building the archive for `docker load`. |
| `CacheDisks` | Electron main | TS | The per-repository data disk: cloning it per job and refreshing it in a VM of its own. |
| `localmost-vm` | `Contents/Resources/localmost-vm` | Swift | Runs one VM. It validates its arguments, configures VZ, exposes two unix sockets, relays vsock 3128 to the job's proxy, and stops the VM on request. |
| Guest kernel + initramfs | `Contents/Resources/guest/` | – | Alpine `linux-virt`, unpacked from EFI zboot. The initramfs mounts the erofs root and hands over to `lm-init`. |
| `rootfs.erofs` | `Contents/Resources/guest/` | – | Read-only root: Alpine packages plus `lm-init`, `lm-agent`, `lm-runc`, `lm-bindpin`. |
| `lm-init` | guest PID 1 | Go | Mounts, loads the module allowlist and then disables module loading, starts the agent (and powers off if it exits), reaps zombies. |
| `lm-agent` | guest | Go | vsock control (1025), Docker API splice (2375), proxy relay (198.18.0.1:3128 to vsock 3128), mounts the share, firewall, starts `dockerd`, self-test, clock, bind approvals. |
| `lm-runc` | guest `/usr/bin/runc` | Go | Wrapper. On `create`, `run` and `restore` it adds the `lm-bindpin` hook to the bundle's `config.json`, then execs the real `runc`. |
| `lm-bindpin` | guest | Go | OCI `createRuntime` hook. Every share-backed mount must be an approved bind. It clears `nosymfollow` on those binds only. |
| bundled `docker` CLI | `Contents/Resources/docker-cli/docker` | – | Pinned static macOS arm64 CLI, first on the job's PATH. |

### Data flow

**A Docker API call.** The job's CLI connects to `<sandbox>/docker.sock` (as
today). The filter evaluates the request. If the VM is not ready yet, the
filter waits for it, up to the boot timeout. It then opens a connection to
`<data>/vm/jobs/<vmId>/docker.sock`. The helper accepts that connection and
dials the guest on vsock port 2375. `lm-agent` accepts it and connects to
`/run/docker.sock`. The helper and agent only copy bytes; neither parses the
Docker protocol. Upgraded connections (attach, exec) work the same way.

**The baseline, before any VM.** `/_ping`, `/version` and `/info` are answered
by the filter from the guest manifest (`guest/manifest.json`, contract §5.3)
whenever no VM is running for that socket. A job whose
policy has no `docker:` section therefore sees a working daemon that refuses
everything but the baseline, and no VM ever boots for it. Once a VM is ready,
these calls go to it, and `/info` is rewritten as today.

**A pull.** `POST /images/create` is evaluated as today (`pull.registries`,
`run.images`). It is then *not* forwarded. `WorkerDocker.pull` runs on the Mac:

1. Resolve the reference and the registry.
2. Get credentials from the operator's Docker config. A credential helper that
   fails is an error, never an anonymous pull.
3. Fetch the index or manifest, choose the platform (see Rosetta), then fetch
   the config and layers. Every digest the registry names is checked against
   `^sha256:[0-9a-f]{64}$` before it is used for anything, because store paths
   are built from it (contract §6.3).
4. Check every blob against its descriptor digest as it streams, and each
   uncompressed layer against the config's `diff_ids`. Byte limits per pull,
   per job and per layer, and a free-space floor, are enforced while the
   bytes stream.
5. Store the blobs in the repository's image store. An image the registry
   would not serve anonymously goes to a store private to this job instead
   (see [Decisions for the owner](#decisions-for-the-owner)).
6. Build a `docker save`-shaped archive (OCI `index.json` plus `manifest.json`,
   uncompressed layers) and `POST /images/load` it through the VM's
   `docker.sock`.
7. Tag the loaded image with the name the job asked for.

The job's CLI sees Docker's usual pull progress stream. `dockerd` in the VM
never contacts a registry. It has no route to one, and its resolver is
refused by the guest firewall at once.

**A container's egress.** On a create whose network is routable, the filter
adds `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy` =
`http://localmost:<token>@198.18.0.1:3128` and a `NO_PROXY` to the container's
environment. A build gets the same values as build args. `198.18.0.1` is a
dummy interface in the guest's root network namespace. `lm-agent` accepts
there, dials vsock 3128 on the host, and the helper connects that to
`127.0.0.1:<the worker's proxy port>`. `ProxyServer` checks the token and the
policy as it does for the job itself. Nothing else leaves the VM.

The token is the worker's proxy token, which runner-manager rotates at every
worker start and again when the job ends (`rotateAuthToken` in
`startInstance`, in the failed-start path and in `finalizeInstance`). A VM
that outlives its job for a moment, or a relay connection still open when the
slot is reused, therefore holds a token the proxy no longer accepts.

**Approved binds.** When the daemon answers a create the filter approved, the
filter sends the agent the binds it approved (`approve-binds`, with the
container id) before it passes the answer to the job, and records the
container as the job's own only after the approval has landed. That ordering
is not what makes this safe: a job can start a container by the `--name` it
chose before it has seen the create answer, and the start may reach the daemon
before the approval reaches the agent. Recording ownership only after the
approval makes the filter refuse such an early start, but the argument does
not rest on that. It rests on `lm-bindpin` failing closed: a container whose
share-backed mounts have no approval in the agent does not start.

**Teardown.** When the worker exits, the socket stops and `WorkerDocker.release()`
stops the VM. The helper exits and the VM directory, with its disk clone, is
deleted. There is no per-container removal sweep, because the whole daemon is
discarded. If the job pulled images that are not yet in the repository's cache
disk, a cache refresh is scheduled.

### Host layout

Everything lives under the app data directory (`<data>`, normally
`~/.localmost`). The job's profile denies all of it, for reads and writes,
before anything else is granted.

```
<data>/vm/                         Time Machine exclusion set when created
  jobs/<vmId>/                     one per running VM; vmId = <slot>-<12 hex>
    docker.sock  agent.sock        served by the helper (R9: never in a job-writable dir)
    data.img                       APFS clone of the repo's cache disk, or a new sparse file
    helper.sb                      the helper's seatbelt profile for this VM
    helper.pid  console.log        pid (for the startup sweep); guest console, capped
  images/<repoKey>/                per repository: blobs/sha256/<hex>, refs.json
  cache/<repoKey>/data.img         per repository: golden data disk, digest-verified images only
  cache/<repoKey>/meta.json        guest dataFormat, digests held, last refresh
```

`repoKey` is the first 16 hex characters of the SHA-256 of the lower-cased
`owner/name`.

### Disks and sync modes

- **Root**: `rootfs.erofs` from the app bundle, attached read-only. VZ
  enforces `readOnly` on the host (register §1, verified).
- **Data**: a raw sparse file (64 GiB apparent size) holding `/var/lib/docker`.
  For a job, it is an APFS clone of `cache/<repoKey>/data.img` (clone cost about
  4 ms, R15), or a new sparse file that the guest formats (ext4) on first boot.
  It is attached with `VZDiskImageSynchronizationMode.none`. The clone is
  thrown away after the job, and `.full` would make each guest fsync cost
  about 5.5 ms instead of about 0.1 ms (R16).
- **Cache refresh**: the golden disk is written only by a *refresh VM*. It has
  no share and no relay and never runs job code. Usually it works on a clone
  of the golden disk attached with `.fsync`, and loads only the images the
  golden disk does not hold yet. It loads digest-verified images from the
  Mac-side store and removes anything else. On a clean guest shutdown the
  helper `F_FULLFSYNC`s the file, and the clone is renamed over the golden
  disk. A job's disk is never promoted.
- **Rebuilt from blank.** The refresh VM is the one place where untrusted
  input (layers from any publisher the repository pulled from) is written
  into state that outlives a job. A flaw in `dockerd`'s layer extraction or in
  ext4 would otherwise persist, and build up, across incremental refreshes. So
  a refresh starts from a blank disk instead of a clone when the guest
  version changed since the golden disk was made, when the golden disk is
  more than 7 days old, and after any refresh that failed. It then reloads
  every reference within the limit. That costs reload time, not downloads:
  the blobs are already in the Mac-side store.

### Rosetta

When `VZLinuxRosettaDirectoryShare.availability` is `.installed`, the helper
adds the Rosetta share (tag `rosetta`). The agent mounts it at `/run/rosetta`
and registers it with binfmt flags `CF` (`F` alone gives EINVAL; R20, verified).
The agent then runs an x86-64 static test binary and reports `rosetta: ok`, or
`broken` if it fails. When Rosetta is `.notInstalled` or `.notSupported`, there
is no share and the agent reports `absent`. localmost never calls
`installRosettaWithCompletionHandler`, which prompts the user.

The puller chooses `linux/arm64` when the image has it. It chooses `linux/amd64`
when the image has no arm64 build or the request asked for `platform=linux/amd64`.
If amd64 is chosen and this VM's Rosetta is not `ok`, it refuses the pull and
explains:

> image `x` has no arm64 build, and amd64 images need Rosetta for Linux, which is
> not installed on this Mac (install it with `softwareupdate --install-rosetta`)

## The share layout rule

This is the rule that closes G-A (R1). The layers that stop a swapped share
are clauses 3 (the job cannot swap it) and 4 (the helper's profile refuses
anything but the real directory). Clause 8 detects a failure of both. Clauses
6 and 7 are what stop a swap of a bind source inside the share.

**Job code can run before the VM starts.** The VM boots asynchronously at the
claim, and it can wait in the admission queue for up to `bootTimeoutSec`. The
job's steps are running all that time, so the share must already be safe
before `Start()`. Before `Start()`, only clause 3 (the job profile's node
denies) and clause 4 (the helper's profile, and its checks) protect it.

1. **Which directory.** The share is `<sandbox>/_work`, the runner's work
   folder. The runner is configured with `--work _work`. It checks out into
   `_work/<repo>/<repo>`, which is `GITHUB_WORKSPACE`. The workspace, and so
   every path a policy's `mounts:` can name, is therefore inside the share.
   The runner also keeps its own working state under its work folder, so this
   is inside the share too: `_work/_temp` (the step scripts, the file-command
   files such as `GITHUB_ENV` and `GITHUB_OUTPUT`, and `_github_workflow/event.json`),
   `_work/_actions` (the downloaded actions) and `_work/_tool` (the tool
   cache). The job can write all of these already, so sharing them grants no
   new access (S8 holds). A policy's `mounts:` cannot name them, because they
   lie outside `GITHUB_WORKSPACE`, which is the mount root. Guest root can
   reach them, though, so anything that gives a container guest root (a kernel
   exploit, or `privileged` if it is ever granted) can rewrite the scripts of
   later steps. The approval text for `privileged` must say so. The filter
   socket `<sandbox>/docker.sock`, localmost's `<sandbox>/_temp` (the job's
   `TMPDIR`), `<sandbox>/.docker`, the runner binaries and the credentials are
   siblings of `_work` and are not shared.
2. **Created by localmost, before any process runs in the sandbox.**
   `buildSandbox` makes `<sandbox>/_work` itself, with a plain `mkdir` that fails
   if the name exists, right after making the sandbox directory. Today the runner
   creates it. The sandbox directory is new for every spawn, so the share is too.
3. **Unswappable by the job.** The runner profile gains, after the rule that
   re-allows the sandbox subtree (seatbelt takes the last matching rule):

   ```scheme
   ;; The Docker VM's share, and the sandbox around it, as nodes: the job
   ;; cannot rename, replace, chmod or relink either. VZ resolves the share's
   ;; path when the VM starts, so a link here would share wherever it points.
   (deny file-write* (literal "<sandbox>/_work") (literal "<sandbox>"))
   ;; The share's tripwire (clause 8): the job can neither read the nonce nor
   ;; replace it, so a match proves VZ shared the directory localmost made.
   (deny file-read* file-write* (literal "<sandbox>/_work/.localmost-share"))
   ```

   The contents stay writable. All three denies are new in the runner job's
   profile (`process-sandbox.ts`), which today re-allows the whole sandbox
   subtree, node included. The `localmost test` step profile already has the
   same kind of rule for its workspace (`src/shared/sandbox-profile.ts`: "not
   the workspace directory itself: the app writes into it unsandboxed"). The
   `<sandbox>` node needs the deny as well, because otherwise the job could
   rename its whole sandbox into a writable policy path such as `~/.npm` and
   put a link in its place. The ancestors of `<sandbox>` (`runner/sandbox`,
   `runner`, `<data>`, and `~` and `/Users` above them) are already denied as
   nodes by the existing app-directory rules.

   A review probe under `sandbox-exec` (in the spike directory,
   `review-case/` and `review-probe/nodedeny.sh`) showed that these denies hold against
   `mv`, `rm -rf` and `chmod` of `_work`, against `mv` of `<sandbox>`, against
   case variants of the names (`mv _WORK`, `mv ../SB` on the case-insensitive
   volume), and against `renamex_np(RENAME_SWAP)`. `mkdir -p` of an existing
   `_work` still works. The side effects are listed under Edge cases.
4. **Pinned by the helper, too.** The helper is given the VM id and the sandbox
   id (`<slot>-<12 hex>`), never a path. It works out the share path itself from
   `<data>`. It checks that the share is a directory and not a link (`lstat`),
   and that `realpath(share) == realpath(<data>/runner/sandbox/<sandboxId>) + "/_work"`.
   It also checks that nothing is mounted over the share or its sandbox:
   `st_dev` of the share must equal `st_dev` of `<sandbox>`, `st_dev` of
   `<sandbox>` must equal that of `<data>/runner/sandbox`, and the share must
   not be a mount point. (A mount over `<sandbox>` itself passes the first
   check and the mount-point check, since the share is then on the mounted
   filesystem and is not its root.) Seatbelt's path rules do not see a mount placed over a directory
   (`hdiutil attach -mountpoint`, a macFUSE bindfs, `mount_smbfs`), and the
   helper's grant is by path, so without this check it would share whatever
   the mount shows. A DMG the job made holds only what the job could write
   anyway, but a bindfs or SMB loopback of `$HOME` would not. It passes VZ the
   real path. Its own seatbelt profile grants file access, and the issuing of
   sandbox extensions, on that real path only:

   ```scheme
   (allow file-issue-extension
     (require-all
       (extension-class "com.apple.app-sandbox.read-write" "com.apple.app-sandbox.read")
       (subpath "<S>")))
   ```

   This `file-issue-extension` rule is the mechanism of the second layer.
   VZ's XPC service reaches the share only through a sandbox extension that
   the helper issues for the path VZ resolved at `Start()`. If a link were
   somehow planted, the resolved path would lie outside `<S>`, the helper could
   not issue the extension, and the start would fail with EPERM (verified,
   below). Without the rule, the VM starts but every read of the share in the
   guest fails. The rule must never be broadened beyond `(subpath "<S>")`.
5. **Identical path in the guest.** The agent mounts the share at the same
   absolute path it has on the Mac. The filter pins each bind source to its
   host real path, and that path means the same thing to `dockerd` in the
   guest. The guest root is read-only, so the agent mounts a tmpfs over the
   share path's top-level directory first. That directory must be one of an
   allowlist of empty mount roots the root ships: `/Users` (normally),
   `/Volumes` (a home on another volume) and `/private` (the Mac's temporary
   directories). Every other top-level name is refused, so the tmpfs never
   hides a directory the guest uses (`/usr`, `/var`, `/etc`, …), and
   `<data>` must lie under one of the three (contract §1).
6. **Mount flags.** Tag `work`, `MS_NOSUID | MS_NODEV | MS_NOSYMFOLLOW`. With
   `nosymfollow`, no path lookup through the share follows a symlink. `runc`'s
   bind of a source that is a link, or passes through one, fails with ELOOP.
   `nosuid` also keeps exec of workspace-built binaries working (R11). A child
   bind inherits `nosymfollow`.
7. **The hook's exact behaviour** (`lm-bindpin`, registered by `lm-runc` as a
   `createRuntime` hook on every `runc create`, `run` and `restore`):
   1. Read the OCI state (`id`, `pid`, `bundle`) from stdin, and
      `<bundle>/config.json`.
   2. Ask the agent (`/run/localmost/agent.sock`, root only) for the approved
      binds of container `id`. If the agent cannot be reached, or answers
      anything but a valid list, and `config.json` has any mount whose source
      is at or below the share, exit 1.
   3. Check every mount in `config.json` whose source is at or below the share
      mount path. After normalising both sides (contract §3.7), its source,
      destination and read-only flag must equal one approved bind. Otherwise
      exit 1, and `runc` fails the start with
      `localmost: bind <src> -> <dst> was not approved for this container`.
   4. Enter the container's mount namespace (`setns` on `/proc/<pid>/ns/mnt`)
      and read `mountinfo`. Take every mount of the `work` virtiofs superblock,
      and record its **mount id** (the first `mountinfo` field). Each must be
      one of the approved binds, matched by its root within the share, its
      mount point under the container rootfs and its read-only flag. And
      every approval that step 3 matched must be one of these mounts: an
      approved source that `runc` resolved off the share (a link swapped in
      that `nosymfollow` somehow did not stop) is not a share mount at all,
      and is refused. Otherwise exit 1.
   5. Open each matched mount by its mount id, never by a path lookup alone.
      The parent directories of a mount point lie in the container's rootfs and
      in approved binds, and the job on the Mac can change those binds while
      the hook runs, so a path could be redirected to a different mount. For
      each mount: open the container rootfs as a directory fd; from it, open
      the mount point with `openat2(…, RESOLVE_NO_SYMLINKS |
      RESOLVE_NO_MAGICLINKS | RESOLVE_BENEATH, O_PATH)`, or with `open_tree`
      under the same resolution; check with `statx(STATX_MNT_ID)` that the fd
      is the mount with the recorded id. Any mismatch or error exits 1.
   6. Only after **every** mount has passed steps 3 to 5, clear the flag on
      each through its fd: `mount_setattr(fd, "", AT_EMPTY_PATH,
      {attr_clr: MOUNT_ATTR_NOSYMFOLLOW})`. That clears `nosymfollow` and
      leaves `ro`, `nosuid` and `nodev` as they are. An error here exits 1,
      and `runc` tears the container down.
   7. Exit 0. Mounts that do not come from the share are not touched: `/etc/hosts`,
      `resolv.conf` and named volumes live on the data disk.

   Any error at all exits 1 whenever a share-backed mount is present. The
   hook never exits 0 without having checked every such mount.

   The effect: symlinks *inside* an approved bind work in the container, and
   resolve in the container's own root. The *source* of every bind was resolved
   by `runc` under `nosymfollow`, so it cannot have gone through a link.
   `lm-runc` is installed as `/usr/bin/runc`, with the real `runc` at
   `/usr/libexec/localmost/runc`. That way both runtime names the filter permits
   (`""` and `runc`) pass through the hook, and so does a restart. The filter's
   endpoint allowlist has no checkpoint endpoints, so `runc restore` is not
   reachable today. `lm-runc` handles it anyway, so that adding checkpoints
   later cannot skip the hook.
8. **Tripwire.** Before the worker starts, localmost writes a random nonce to
   `<sandbox>/_work/.localmost-share`. The job profile denies the job both
   reading and writing that file (clause 3), so the job cannot copy the
   nonce and cannot replace it. `configure` returns what the guest reads there.
   If it does not match, the VM is torn down and the job's Docker requests get
   503. A match is a real attestation that VZ shared the directory localmost
   made. A mismatch means clauses 3 and 4 both failed, so it is logged at
   error, not warn.

## Security properties

Each claim, what it rests on, and its evidence. "V" means verified by
experiment. "V-spike" means verified in this design's spike on 2026-09-30.
"Build" means it must be verified by the work package named.

| # | Claim | Rests on | Evidence |
|---|---|---|---|
| S1 | A job cannot give a container the user's home or any Mac path outside its own `_work` (G-A). | (a) The VM has exactly one read-write share, `_work`, created by localmost (R1). (b) Profile node denies make it unswappable (rule 3); job code may run before `Start()`, and until then (b) and (c) are the only layers. (c) The helper checks the share (not a link, not a mount point, same device as the sandbox, and the sandbox the same device as `runner/sandbox`), and its profile's `file-issue-extension` rule, scoped to `(subpath "<S>")`, lets VZ's service reach only that real path, so a swap resolved at `Start()` fails. (d) A rename after `Start()` fails closed. (e) Symlinks planted on the host resolve in the guest, never on the Mac: Apple's virtiofs server does not follow a link on the Mac side, and this is the only layer when the guest still holds a directory's inode from before the swap (below). (f) The VZ XPC service is itself sandboxed to the shared paths. (g) The nonce tripwire detects a failure of both (b) and (c). | (a), (d), (e), (f): V (register §1). (e) again, V, WP-A acceptance: when the source directory is replaced by a link on the Mac after the guest last looked it up, the guest's virtiofs dentry is stale, `--mount` and a restart bind the old directory's inode, and the container starts. `mountinfo` shows the bind at the old root; the directory lists as empty and reading a file in it fails with ENOENT or ELOOP ("Symbolic link loop"). Neither `nosymfollow` nor `lm-bindpin` sees a link here (the guest never resolves one), so what stops the link's target being served is the Mac-side server, which resolves the stale inode by its path and refuses to follow the link. It is Apple's code, not localmost's, and a change in it would reopen this path; the acceptance checks it on every run. (c): V-spike, with the scoped `file-issue-extension` rule present. A share path swapped for a link outside the grant failed `Start()` with EPERM, and an ungranted directory was refused the same way. A review probe confirmed that without that rule the VM starts but the guest cannot read the share, so the EPERM comes from that rule. The mount-point check: Build, WP-B. (b), (g): Build, WP-C sandbox test. |
| S2 | A container cannot reach guest `/`, the guest `docker.sock` or `/proc` by swapping a bind source (R2). | `nosymfollow` on the share, plus `lm-bindpin`, which clears it only on approved binds and refuses an approved bind that is not a share mount. When the swap is made on the Mac after the guest looked the source up, a third layer is what holds: see S1(e). | V-spike on the shipped kernel (Alpine 6.18.54) with `dockerd` 29.5.3 and `runc` 1.4.3. `create` with a bind, swap the source for a link to `/`, `start` failed. A bind of a planted link to `/Users/...` failed. A child bind inherited `nosymfollow` (inner link: ELOOP). `mount_setattr` clearing only `NOSYMFOLLOW` restored inner links and kept `ro,nosuid,nodev`. V, WP-A acceptance, for links to `/`, `/run` and `/var/lib/docker` each: `-v` then swap, and a container that plants the link through an rw bind and restarts, never start: dockerd's `stat` hits ELOOP under `nosymfollow`, and its `mkdir` of the source then fails EEXIST. `--mount` then swap, and start then swap then restart, do start, on a stale mount (see S1(e)). With `nosymfollow` removed from the share on purpose, `lm-bindpin` refused the ones that never start (a link to `/` because `/` carries the share as a submount; `/run` and `/var/lib/docker` because they are not share mounts). Without both, `/run` and `/var/lib/docker` reached the container, which the acceptance's G-A checks detect. |
| S3 | Containers of different jobs cannot reach each other, and a job cannot join another job's network. | Separate VMs. No NIC. vsock has no guest-to-guest path. Network names exist only inside one VM. | vsock CID 3 gives ENODEV (R7, V). Live cross-job test: Build, integration stage. |
| S4 | Container egress goes only through the job's proxy, under the job's policy. | No NIC. The relay goes only to that worker's `ProxyServer`, which checks the per-worker token. The guest firewall rejects everything else sent to the guest root namespace from bridges. | No route and no DNS without a NIC (R7, V). V-spike: a default-bridge container reached a listener on `198.18.0.1:3128`. An `internal` network container got "Network unreachable". Relay end to end: Build, WP-A with WP-B. |
| S5 | An `internal` network container reaches nothing outside its network. | No default route. The guest's INPUT chain accepts the relay address only from the bridges of routable networks, which the agent tracks from Docker's network events, and rejects everything else. A container can forge the route away: `NET_RAW` is in Docker's default capabilities, so it can send a frame to its gateway's MAC addressed to `198.18.0.1`, and Linux's weak-host model would deliver it to `lm0`. The interface match is what stops that. The backstop is the proxy token, which is injected only into routable containers. | V-spike: no route to the relay, and it *did* reach a `0.0.0.0` listener on its gateway (R8 confirmed). The spike tested routing only, not forged frames. The interface-scoped rule and the forged-route probe: Build, WP-A self-test and live test 6. |
| S6 | Registry credentials never enter the VM. | Pulls run on the Mac. Only the image archive crosses into the VM. | V-spike: `docker load` of an archive built on the Mac worked, and the image id equalled the config digest. The puller: Build, WP-D. |
| S7 | One job cannot poison another's images. It *can* use every image in its repository's cache, including images its own workflow's policy never allowed. | The cache is per repository. The golden disk is written only by the refresh VM from verified blobs, and is rebuilt from blank on a schedule. Job disks are clones and are discarded. There are no tags on the golden disk. What the cache exposes: any job of the repository can run a cached image through `docker build` with `FROM <ref>@sha256:…` (the classic builder uses a local image without pulling, and the filter does not read the Dockerfile), through `run.images: ['*']` with an image id, or, with guest root, by reading `/dev/vdb`. So an image that the registry would not serve anonymously never enters the shared store or the golden disk (owner decision 1, below). | Design (R14). Build, WP-D. The residual in the refresh VM is listed below. |
| S8 | Guest root is worth no more than the job already has, plus the public images in its repository's cache. | One VM per job holds only this job's share (including the runner's `_work/_temp` and `_work/_actions`, which the job can already write), this job's proxy token, this job's pulls, and its repository's cache of public images. Guest root cannot load a kernel module or kexec a new kernel: after loading its module allowlist, `lm-init` sets `kernel.modules_disabled=1` and `kernel.kexec_load_disabled=1` (the kernel has `MODULE_SIG` but not `MODULE_SIG_FORCE`, so without this any module would load). | R3. The residual is the VZ/virtiofs attack surface (R22), and a guest kernel exploit, below. |
| S9 | The VM control plane is not reachable by any job, and a job cannot start a VM of its own. | The helper sockets are under `<data>/vm/jobs/`, which every job profile denies. The API takes ids, not paths. The job profile denies `process-exec` of `<helper>` by literal (contract §5.5): seatbelt execs a Mach-O the profile cannot read, so the bundle's read deny alone would let a job run the entitled helper and boot VMs outside `maxRunning`. | Profile rule (R9, V). WP-C review probe: a binary the job profile could not read still ran; with the exec deny, the path, a case variant, a link and a `..` spelling were all refused. Test: Build, WP-C sandbox test (constructed with a compiled stand-in at the helper path; ambient against the packaged helper). |
| S10 | No Local Network privacy prompt, and no LAN or host-loopback reach from containers beyond what the job has. | vsock only. No NIC. Host loopback is reached only through the proxy, under the job's `loopback` policy, the same as the job. That includes the local broker's port, which `ProxyServer` always opens as infrastructure (`proxy-server.ts`, `port === this.brokerPort`). It is guarded by the per-worker broker key, which lives outside `_work` and never enters the VM. | R6/R25. vsock round trip in both directions: V-spike. |
| S11 | A crashed or killed localmost leaves nothing running that keeps reaching anything. | The helper watches its parent: EOF on stdin, or the exit of the parent pid it recorded at start (kqueue `EVFILT_PROC`/`NOTE_EXIT`), is `stop` with `graceMs: 0`. A VM dies within about 2 s of its helper exiting or being killed. The startup sweep removes the directories left behind. | Helper death: R27 (V). Parent death: Build, WP-B (SIGKILL of the parent, helper and VZ XPC process gone within 3 s). Sweep: Build, WP-C. |

What this backend does **not** contain, stated as plainly as `SECURITY.md` must:

- **A bug in Apple's virtiofs server or device emulation** (R22). It runs
  sandboxed to the one share, but it is closed source and has not been fuzzed
  here.
- **A kernel exploit from a container.** It gives guest root, which S8 bounds
  but does not prevent. `privileged` stays refused on this backend (owner
  decision 2, see [Decisions for the owner](#decisions-for-the-owner)): it
  would turn such an exploit into a one-liner, and it also bypasses
  `internal:` and the hook.
- **The refresh VM's input.** The refresh VM extracts layers from every public
  image the repository pulled, from any publisher, onto the golden disk that
  every later job of the repository clones. A flaw in `dockerd`'s layer
  extraction or in the guest's ext4 would therefore reach later jobs of the
  same repository. The golden disk is rebuilt from blank on a schedule and
  after every guest update (Disks and sync modes), which limits how long such
  a flaw persists but does not prevent it. This sits next to R22.
- **Hard links the job itself makes** inside `_work` to files it can already
  write (R23). Seatbelt refuses `link()` on a file the job cannot write, so this
  adds nothing.
- **Hostname policy for traffic that ignores `HTTP_PROXY`.** That traffic has no
  route at all. It fails, it is not filtered. See the network stack backlog item.

## Edge cases

**VM boot failure** (helper exits non-zero, VZ start error, agent silent for
30 s, `configure` fails, firewall self-test fails, nonce mismatch). The VM is
torn down, and the job log gets a warning that names the stage and the error
code. The socket answers every non-baseline request with 503 and that reason,
so the job's docker steps fail with a message rather than hanging. There is no
automatic retry: a VM that failed once for a job is not tried again for that
job.

**Job cancelled mid-boot.** The worker exits, and `release()` sends the helper
`stop` and then SIGTERM. If it has not exited within 5 s, it gets SIGKILL, and
VZ kills the VM within about 2 s. The boot promise rejects. Requests waiting on
it get 503 while the socket closes. The VM directory is removed after the
helper exits.

**Helper crash.** The VM dies with it. `VmManager` sees the exit and marks the
VM failed. The socket then answers 503, "the job's Docker VM stopped
unexpectedly". The VM is never restarted silently, because its containers and
images are gone. The job continues and its docker steps fail.

**Agent exit.** The agent holds state that cannot be rebuilt: the bind
approvals, the relay, the `configure` result and the `dockerd` it started. So
`lm-init` does not restart it. An agent exit powers the guest off, the helper
reports `stopped` with reason `guest`, and `VmManager` marks the VM failed
with the same 503 as a helper crash.

**Electron crash.** Each helper watches its parent (S11). When Electron main
dies, by a crash or SIGKILL, every helper stops its VM at once and exits. The
next launch's sweep removes the directories.

**Guest text in the job log.** Everything the guest supplies that reaches a
log (the `E_DOCKERD` log lines, agent error messages, console excerpts) is
treated as hostile: control characters and ANSI escapes are stripped, and
each string is capped, before it is logged.

**Sleep and wake.** On `powerMonitor` `resume`, the running VMs get `set-time`
from the Mac clock (VZ has no Linux time sync; R18), and the pre-warmed spare,
if any, is discarded. VMs are not paused across sleep.

**Low memory.** Each VM is configured with `dockerVm.memoryMiB` (8192 by
default). The memory is committed lazily, and only a stopped VM gives it back
(R4). An admission gate allows at most `dockerVm.maxRunning` VMs (default:
physical RAM divided by 8 GiB, at least 1). Refresh VMs go through the same
gate at the lowest priority. A boot beyond that waits in FIFO order, and the
job's docker requests wait with it, up to the boot timeout, then get 503 "no
Docker VM capacity". Host memory pressure is read by a new monitor in
`src/main/resource-monitor/` that polls `kern.memorystatus_vm_pressure_level`
(1 normal, 2 warn, 4 critical). At warn the spare is not started and
refreshes wait; at critical new boots are queued. A container killed by the
guest OOM killer exits 137, which Docker reports as usual.

**Low disk.** A job's pulls land on the Mac first and then in the VM's data
disk, both of which grow on the Mac's disk. Docker Desktop capped all of this
with one fixed VM disk; here the caps are explicit (contract §5.6, §6.3): a
byte limit per pull and per job enforced while blobs stream, a limit on how
far a layer may expand when decompressed, and a free-space floor under which
a boot or a pull is refused. A new data disk's apparent size is the smaller
of `dockerVm.dataDiskGiB` and the free space above the floor that no other
running VM has already been promised. While VMs run, `VmManager` watches free
space; below half the floor it stops the VM whose disk grew most, with the
reason "host disk nearly full". `cacheLimitGiB` still trims the cache at
refresh.

**Rosetta absent or broken.** No Rosetta share. arm64 images work. amd64
pulls are refused with the message above, naming the fix. A broken Rosetta
(installed, but the self-test fails) is refused with its own message. The
install prompt is never triggered.

**amd64 image.** Pulled as `linux/amd64` only when there is no arm64 build or
the request asks for it. It runs under Rosetta. `docker run --platform
linux/amd64` of an image that has both is honoured.

**Private registry credentials.** Read on the Mac by the puller (the operator's
`~/.docker/config.json`, credential helpers and `credsStore`) and used for the
registry's token exchange there. They are never forwarded. Credential helpers
are looked up only in a fixed list of directories (`/opt/homebrew/bin`,
`/usr/local/bin`, `/Applications/Docker.app/Contents/Resources/bin`), not on
`PATH`, because an app launched from Finder has `PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
and they run asynchronously, off the main thread's critical path. If the
configured helper is missing or fails for any reason other than "credentials
not found", the pull fails with an error that names the helper and the config
key to change:

> the Docker credential helper `docker-credential-desktop` (from `credsStore`
> in ~/.docker/config.json) was not found in /opt/homebrew/bin, /usr/local/bin
> or /Applications/Docker.app/Contents/Resources/bin; install it, or remove
> `credsStore` from ~/.docker/config.json

A helper that reports "not found" means an anonymous pull, as the docker CLI
does.

**Registries on the LAN, loopback or plain HTTP.** The puller screens every
registry address as `ProxyServer` does, refusing loopback, link-local and
private addresses, and it speaks only https. A registry listed in
`pull.registries` that is on the LAN, on the Mac itself, or served over plain
http, which Docker Desktop could pull from, is refused:

> registry `nas.local:5000` resolves to a private address (192.168.1.20);
> localmost pulls only from public https registries

A future policy key could allow a named private registry, with its own
approval text. It is not part of this design.

**Registry redirects.** A registry commonly redirects blob downloads to a CDN.
The puller follows https redirects, screened, to any public host, so granting
a registry in `pull.registries` also means Electron fetches from wherever that
registry redirects. That is outside the job's `network.allow`, and the policy
approval text for `pull.registries` says so. No credentials go to a redirect
target.

**Digest mismatch.** A blob whose SHA-256 does not match its descriptor, or a
layer whose uncompressed SHA-256 does not match the config's `diff_ids`, is
discarded before it is stored. The pull fails, naming the registry, the
reference and both digests. A transient network error is retried once. A
mismatch is not retried. A pull by digest (`name@sha256:…`) also requires the
manifest's digest to equal it.

**Cache disk corruption.** Job disks are clones and are discarded, so they
cannot corrupt the cache. If the agent cannot mount a golden disk (the ext4
mount fails or `e2fsck -n` finds errors), `configure` reports `disk: corrupt`.
localmost then deletes that repository's golden disk and reboots the job's VM
on a blank disk. The next refresh rebuilds the cache from the Mac-side store.
A golden disk whose `meta.json` `dataFormat` differs from the guest manifest's
(a `dockerd` storage change) is discarded, not migrated.

**Concurrent jobs.** Each has its own VM, share, disk clone and relay. Two jobs
of the same repository clone the same golden disk, which is read-only to them.
Refreshes of one repository are serialized and coalesced.

**Repeated binds.** runner-manager applies a job's policy more than once: at
the acquire (`onJobAcquired`), again at the "Running job" line, and possibly
against a previous spawn's socket that is still stopping. `WorkerDocker.bind()`
is therefore idempotent (contract §5.1): only the first bind with grants
boots, and a bind on a socket that is stopping never boots.

**Pre-warmed spare lifecycle** (`dockerVm.prewarm: true`; off by default).
There is at most one spare. It is booted when an idle worker is spawned for a
target, so its sandbox, and therefore its share, already exists. It uses the
spawn repository's cache disk. At the claim:

- If the claimed job's bound policy has `docker:`, and the claim is for the
  spawn repository, the spare becomes the job's VM.
- Otherwise it is stopped, including when the claim is for another
  repository and the worker's socket stays closed.

The spare is also stopped when its worker is reaped or exits, on wake, under
memory pressure, and when a job's boot finds the admission gate full: the job
takes the spare's slot. An idle worker spawned while a spare lives gets none.
A new spare is started when the next idle worker is spawned after it is gone
or claimed. A spare VM holds the share of a sandbox whose job has not started, so
there is nothing in it to leak.

**Startup sweep.** Before the runner pool starts, `VmManager.sweep()` handles
each `<data>/vm/jobs/*`. It reads `helper.pid` and, if that pid is alive and is
a process whose executable is this app's `helperPath()` (contract §1 and §5.1:
the text vnode as lsof names it, not the argv[0] a process gives itself),
sends SIGKILL. Then it removes the directory. Leftover
`cache/*/data.img.new` refresh clones are removed too. A VM can never outlive
the app for more than one launch.

**Build base images.** The classic builder pulls a `FROM` image that is not
present from inside the VM, which has no route. That fails at once with a DNS
refusal. A job must `docker pull` its base images first, and the pull is
checked against `pull.registries`. When a build fails that way, the filter adds
a line to the job log that names this rule. Pulling for the builder
automatically is an open question.

**Container jobs and service containers.** The runner's `jobs.<id>.container`
mounts `_temp`, `externals` and the Docker socket. The filter refuses those, as
it does today.

**The share root itself.** An `rm -rf "$GITHUB_WORKSPACE"` works, because the
checkout is a subdirectory of the share. Only `_work` itself is fixed (R24).

**Side effects of the node denies.** Because `_work` and `<sandbox>` are
denied as nodes, operations on those nodes themselves fail even when they
would change nothing that matters. In the review probe: `rsync -a src/ _work/`
exits 23 (it sets the times and mode of `_work`), `tar -x` of an archive with
a `.` entry into `_work` exits 1, and `touch _work` and `xattr -w` on `_work`
fail with EPERM. `mkdir -p _work/...` and writes inside `_work` work. A job
that copies into `_work` as a whole should copy into a subdirectory.
Workflows do not normally do this; the runner writes inside `_work`, not to
it.

**Mounts over the share.** A job that mounts something over `_work` before
the VM starts (a DMG, a FUSE filesystem, an SMB share) makes the helper
refuse the share with `E_SHARE`, and the job has no Docker.

## What changes for users

- **No Docker Desktop.** localmost no longer uses or needs Docker Desktop for
  jobs. The job's `docker` is the bundled CLI. The operator's own Docker Desktop,
  if they have one, is untouched and is never used by jobs.
- **macOS 14 or later.** Apple silicon only, as before.
- **`routable` means through the job's proxy.** On the default bridge, and on a
  network declared `internal: false`, containers get `HTTP_PROXY`/`HTTPS_PROXY`
  pointing at the job's proxy. They reach exactly what the job's
  `network.allow` permits, and loopback per the job's `loopback` policy, plus
  the local broker's port, which the job's proxy always opens and which its
  per-worker key guards.
  Traffic that ignores the proxy settings has no route: plain TCP to an
  external database, `git` over ssh, UDP, and DNS lookups of outside names. It
  fails fast. The approval text changes from `UNFILTERED_EGRESS` to "egress
  through this job's proxy, subject to its network allowlist".
- **`internal: true`** means no egress at all, which was already the intent.
  Now it is enforced by the guest's routing and an interface-scoped firewall,
  with the proxy token as the backstop.
- **Proxy settings are injected** into routable containers and into builds
  (`--build-arg`). A value the job sets itself is kept. Docker leaves the
  predefined proxy build args out of `docker history` unless the Dockerfile
  declares them with `ARG` ([Dockerfile reference, "Predefined ARGs"](https://docs.docker.com/reference/dockerfile/#predefined-args)).
  A Dockerfile that declares `ARG HTTP_PROXY` records the injected URL,
  token included, in the image's history. The token is rotated when the job
  ends, so it is useless afterwards, but the job log should not print
  `docker history` of such an image. Container-to-container
  HTTP by service name should be listed in `NO_PROXY` by the job. The injected
  `NO_PROXY` covers only `localhost`, `127.0.0.1` and `::1`.
- **`privileged` stays refused**, as today (owner decision 2, see
  [Decisions for the owner](#decisions-for-the-owner)).
- **Pulls happen on the Mac** and show Docker's usual progress. The first pull
  of an image by a repository downloads it, later jobs load it from the
  repository's cache disk, and a tag is re-resolved against the registry on
  every pull with a manifest `HEAD`. Docker's documentation says a `HEAD`
  request is not counted against Docker Hub's pull limit
  ([Docker Hub usage and limits](https://docs.docker.com/docker-hub/usage/pulls/));
  WP-D's live acceptance checks the `ratelimit-remaining` header before and
  after one to confirm it.
- **Private images are pulled every job.** An image the registry would not
  serve anonymously is kept only for the job that pulled it, never in the
  repository's cache (owner decision 1).
- **Credential helpers must be where localmost looks.** A `credsStore` or
  `credHelpers` entry in `~/.docker/config.json` names a helper that must be
  in `/opt/homebrew/bin`, `/usr/local/bin` or Docker.app's bundled `bin`. An
  operator who removes Docker Desktop while its `credsStore: desktop` is still
  configured sees every pull fail, public images included, with a message
  naming the key, until the config is edited.
- **No LAN, loopback or plain-http registries** (see Edge cases).
- **Build base images must be pulled first** (see Edge cases).
- **Bind ownership** follows virtiofs: `chown` inside a container on a
  workspace bind does not persist (R21). Data directories belong on volumes,
  which live on the VM's disk.
- **Disk.** A cache disk per repository that uses Docker, under
  `~/.localmost/vm/cache`, excluded from Time Machine and capped (default 20
  GiB per repository, least recently used images dropped at refresh).

## What was verified

In the design spike (2026-09-30, macOS 26.6.2, M2), against Alpine v3.24
packages pinned in the contract:

- The Alpine `linux-virt` 6.18.54 kernel config and modules include
  `virtiofs`, `fuse`, `vsock` with the virtio transport, `overlay`,
  `nf_tables`, `nft_compat`, `br_netfilter`, `bridge`, `veth`, `binfmt_misc`,
  `erofs` (with LZ4/ZSTD), `ext4`, `dummy`, `virtio_blk` and `virtio-rng`. The
  kernel uses 4K pages, has `MODULE_SIG` but not `MODULE_SIG_FORCE`, and ships
  gzip modules. All of these loaded in the guest.
- The EFI zboot `vmlinuz-virt` unpacks on macOS with a 20-line script: magic
  `zimg` at offset 4, the payload offset and size at 8 and 12, `gzip` at 24. The
  result has the arm64 `ARMd` magic, and VZ booted it.
- A newc cpio initramfs can be written on macOS with no tools but the
  language's own gzip. It is byte-for-byte reproducible.
- The read-only root can be built without Docker: the apk data tars are
  composed into one tarball in memory, and a build VM running the pinned
  kernel runs `mkfs.erofs --tar=f` (erofs-utils 1.9.1). The image mounted, the
  binaries in it ran, and two builds were byte-identical. Extracting apks onto
  the Mac's case-insensitive APFS would silently merge 13 name pairs in
  `linux-virt` and `iptables` alone (`xt_DSCP.ko`/`xt_dscp.ko`,
  `libxt_MARK.so`/`libxt_mark.so`, …), so the build must never do that. `mke2fs` formats the data disk inside the guest.
- vsock in both directions: a host listener (`VZVirtioSocketListener`) and a
  host dial (`connect(toPort:)`), with a static Go agent. Boot to agent was
  0.35 s, and the guest finished at 0.8 s.
- A VZ host process under a **deny-default** seatbelt profile booted the guest.
  It needed `(import "system.sb")`, reads of its own binary and the guest
  artifacts, read-write on the share, `generic-issue-extension` for class
  `com.apple.virtualization.extension.fuse`, and `file-issue-extension` for
  the `com.apple.app-sandbox.read-write` and `.read` classes scoped to
  `(subpath <share>)`. The same profile refused to share an ungranted
  directory, and a granted path that was a link to one (EPERM). A review probe
  with the same inputs but without the `file-issue-extension` rule booted, but
  every read of the share in the guest failed with "Operation not permitted";
  with the rule, the share worked. That probe also attached a read-write data
  disk in a granted directory without any extension rule and started. The
  spike never attached the erofs root under the profile, so disks under the
  profile remain unverified until WP-B.
- `dockerd` 29.5.3 (API 1.54) with `containerd` 2.3.6, `runc` 1.4.3, overlay2,
  cgroup v2 and **iptables on** started from the erofs root on the ext4 data
  disk and answered 0.2 s after it was started (0.32 s after the guest kernel
  started). It also ran containers, loaded a Mac-built archive, and
  failed the bind-swap attacks described in S2.
- Exec of a binary from the share mounted `nosuid` worked on this kernel (R11).
- `VZDiskImageSynchronizationMode` (`.full`, `.fsync`, `.none`, macOS 12),
  `VZLinuxRosettaDirectoryShare.availability` (`.notSupported`,
  `.notInstalled`, `.installed`, macOS 13) and the Rosetta caching options
  (macOS 14) are in the SDK headers. Availability reported `installed` on the
  spike machine.
- The pinned static `docker` CLI (29.8.1, macOS arm64) is a Mach-O that is
  linker-signed ad hoc. It will be re-signed with the app.
- By WP-A's acceptance (`scripts/guest/acceptance.js`, the built guest under
  `vzrun`, outside any job): `lm-bindpin` as a real hook, with its `setns`
  from Go, the mount-id checks through `openat2`/`statx` and `mount_setattr`,
  and against real `dockerd` and `runc` (S2); the firewall INPUT rules, the
  relay chain following Docker's network events, a bound connect and a raw
  SYN from a real internal network, and the self-test (S5); the relay both
  ways through `vzrun`, including bytes delivered while a connection stays
  open; and Docker's embedded DNS by name on a user-defined network. That
  last one failed until `xt_tcpudp` was in the module allowlist (contract
  §5.2): the spike's `Resolver Start failed` came from the missing `udp`
  match, not from `xt_nat`.

- At integration (2026-09-30, this Mac, outside any job, the merged tree):
  the guest built twice byte-identical (`build:guest --verify-reproducible`,
  and identical to WP-A's own build); the helper built with `build:helper`
  (ad hoc, hardened runtime, only the virtualization entitlement). Through
  `DefaultVmManager`, `VmBackend` and a real filter socket, driven by the
  bundled CLI, with the helper under the profile `buildHelperProfile`
  writes: two job VMs booted at the claim (the erofs root and the data disk
  under the profile, Rosetta `ok`); the Mac-side puller pulled `alpine:3`
  (arm64) and `amd64/alpine:3`, which ran as `x86_64` under Rosetta, as did
  `--platform linux/amd64 alpine:3`; a pull by digest then ran and inspected
  by that digest; an approved `:ro` workspace bind read, refused writes and
  kept `nosuid`. G-A: a host-side swap of `-v` sources to links to a victim
  directory, `/`, `/run` and `/var/run` between create and start, a
  container accomplice's swap to the same, and a container's own planted
  link on its second start were all refused; the `--mount` form and a start,
  swap, restart started on a stale, empty mount (S1(e)) and showed nothing
  of the victim. A default-bridge container reached a stand-in
  `ProxyServer` through the relay with the worker's token injected, and
  nothing else: not the Mac's LAN address, not another port on the relay
  address or the gateway, no DNS (refused at once); an internal-network
  container got no proxy settings and could not reach the relay. Two
  concurrent VMs gave their containers the same address, and neither could
  reach the other's server; one could not inspect or join the other's
  network by id. SIGKILL of a helper, and of the process standing in for
  Electron main, each took the helper and its VZ process down within
  30 ms; the next manager's sweep removed what the killed process left.
  Teardown left no VM directory, helper, socket, disk or VZ process. With
  `CacheDisks` wired as `index.ts` wires it, a job's public pull scheduled a
  refresh at release; the refresh VM (slot 0, refresh mode) loaded the image
  from the Mac's store into a blank disk, powered off with `synced: true`,
  and the disk was promoted; the next job's VM was cloned from it and its
  pull of the same image reported it already in the VM.

Not yet verified, and owned by work packages:
- `docker load` of a real registry image with zstd layers, and a private
  GHCR image with the operator's osxkeychain credentials (the owner).
- The helper when signed with Developer ID and the hardened runtime and
  launched from the installed app; the §7.4 `codesign` checks on a signed
  `npm run package` (integration ran it unsigned only: the layout,
  `LSMinimumSystemVersion` 14.0 and the prePackage checks passed).
- The golden cache disk and its refresh VM in the installed app, on battery
  and under memory pressure.
- Memory with four concurrent VMs (R5).
- Sleep/wake clock drift. This needs the owner at the machine.

## Test strategy

- **Unit (CI, `npm test`).** These cover the filter changes: pull
  interception, proxy injection for routable networks only, the order of
  bind approval versus the create answer, synthetic baseline answers, and
  waiting for or timing out on the VM. They also cover the helper and agent
  NDJSON framing and limits, and the `VmManager` state machine against a fake
  helper. For the puller: a local mock registry, token auth, platform choice,
  CDN redirects (no credentials on any redirect hop), realm screening, refused
  foreign layers, digest and `diff_id` mismatches, digests shaped like path
  traversal, byte limits, gzip and zstd, and loud credential-helper failure.
  For the filter: oversized daemon answers are refused without buffering
  them. The rest: `ImageStore`, `CacheDisks` (clone,
  refresh bookkeeping), profile generation (node denies, helper profile), guest
  composition (deterministic cpio/tar, case-clash preservation, lock-file
  verification), zboot unpacking, the `signOptionsForFile` branch, and
  packaging (extraResource, `LSMinimumSystemVersion` 14.0, entitlements).
- **Sandbox tests (real `sandbox-exec`, as `*.sandbox.test.ts` do today).**
  They follow the repo's three modes: off macOS (an explicit assertion that
  the platform is not darwin), constructed (the test builds the profile and
  runs under `sandbox-exec`), and ambient (inside a localmost job, where
  seatbelt refuses a nested profile, so the test asserts against the job's
  own profile instead). Every new assertion is written in both the
  constructed and the ambient form. A job can create, write and remove
  anything under `_work` but cannot rename, remove, chmod or replace `_work`
  or `<sandbox>`, including by case variants of the names and by
  `renamex_np(RENAME_SWAP)`. It cannot read or replace `_work/.localmost-share`.
  It cannot connect to `<data>/vm/jobs/*/docker.sock`. The helper's own
  profile is exercised the same way, in `helper-profile.sandbox.test.ts`;
  unit tests run the fake helper directly, without `sandbox-exec`.
- **Swift and Go in CI.** A dedicated `macos-latest` (arm64, GitHub-hosted)
  job, in `ci.yaml`, runs `swift build` and `swift test` for
  `native/localmost-vm`, and `go test ./...` and `GOOS=linux go vet ./...` for
  `guest/`. The ubuntu leg also runs the guest's `go test ./...` natively.
  Linux-only syscall code is behind `//go:build linux`, and the pure logic
  (mountinfo parsing, bind matching, the protocol) is tested on any OS.
  `check.yaml` is the reusable runner-selection workflow and runs no builds;
  it is not changed. GitHub-hosted runners have no nested virtualization, so
  no CI job boots a VM (R28).
- **Guest builds happen only on the owner's Mac, outside any job.** The
  self-hosted leg runs inside a localmost job's seatbelt profile, which grants
  no `file-issue-extension`, so VZ shares cannot work there either. The guest
  build, `--verify-reproducible` and the smoke boot run on the owner's Mac,
  outside any job, as a step of `docs/release-checklist.md`.
- **Guest.** `go test` for `lm-bindpin` mountinfo matching, `lm-runc`'s
  `config.json` rewrite and the agent protocol. `check-config.sh` from moby
  runs against the kernel config at build time.
- **Live VM tests** (self-hosted, against the installed app). The repo's
  **Docker Access** workflow (`docker-localmost`) exercises pull, run and a
  read-only workspace mount through the VM. A new **Docker VM escape**
  workflow runs the **G-A regression suite** as a job: the create, swap, start
  attack with links to `$HOME` and `/`; a container with a writable mount
  that swaps another container's bind source before that container starts,
  and swaps its own and restarts; renaming `_work`; cross-job reach (two
  concurrent jobs, each serving its own random nonce, that must never fetch
  the other's, and joining the other's network by name); egress with and
  without the injected proxy; and a forged-route probe from an internal
  network. Its `.localmostrc` section must be approved by the owner before it
  can run. The install-while-idle rule applies: CI's localmost legs run the
  installed app, not the tree.
- **The e2e docker suite** (`test/e2e/docker.spec.ts`, Playwright). It builds
  the filter in-process; it never packages or launches the app. On the Mac,
  outside a job, it builds `VmBackend` and `VmManager` against the
  resources in `build/` (the helper, the guest and the CLI, which must have
  been built). It gains assertions that a VM booted for the docker job and not
  for a job with no `docker:`, that the pull was served on the Mac, and that
  the VM is gone after the job. What its Linux leg runs is an owner decision
  (below).

## Decisions for the owner

These came out of review and go beyond the fourteen decisions. The owner
chose the recommendation in each case, and the design is written against it.

1. **What the per-repository cache may hold.** The golden disk and the
   Mac-side store are shared by every workflow of a repository. Any job of the
   repository can use any image in them, whatever its own workflow's policy
   says (S7). If a broader workflow pulled a private image with the
   operator's credentials, a narrower one could use it. The options:
   - **(a) Recommended: keep images that needed credentials out of the shared
     cache.** After a pull, the puller asks the registry anonymously for the
     same manifest digest (a token exchange and a `GET` whose bytes must hash
     to it; contract §6.3 has the rule in full). If the registry
     serves it, the image is public and is cached. If not, its blobs go to a
     store private to the job (`<data>/vm/jobs/<vmId>/blobs`) and are deleted
     with the VM. Private images are then downloaded every job, and public
     images keep their cache hits across policy edits.
   - (b) Key the cache by (repository, hash of the effective docker policy).
     Every workflow with a different policy, and every policy edit, then gets
     a cold cache.

   Under either option, public cached images remain usable by any job of the
   repository through `FROM`, image ids and guest root; the design accepts
   that and says so in S7.

   **Decided: (a).** Images that needed registry credentials never enter the
   shared store or the golden disk; they are kept for the job that pulled
   them.
2. **`privileged`.** The original spec's stage 2 made it grantable on a VM
   backend. It is not one of the fourteen decisions, and a privileged
   container turns a guest kernel exploit into a one-liner against R22's
   surface. It gets every capability, including `CAP_SYS_MODULE` (which
   `modules_disabled` now blunts), the raw data disk with the repository's
   cached images, the whole `_work` (including the runner's step scripts and
   the checkout's `.git` credentials), every vsock port and the relay token.
   That is the guest kernel, not only guest root.
   **Recommended: keep it refused for now**, and decide after decision 1. If
   it is granted later, `docker-policy.ts` validation changes, and the
   approval text lists exactly what it exposes.

   **Decided: it stays refused.**
3. **The Linux leg of the e2e docker spec.** `ci.yaml` runs
   `test/e2e/docker.spec.ts` on every leg, including the `ubuntu-latest`
   fallback, where no VM can run. Today, outside a job, it serves the filter
   over the runner's native `dockerd` through `DesktopBackend`, which this
   design deletes. **Recommended:** a test-only `WorkerDocker` under `test/`
   that forwards to a native `dockerd`, used only by the e2e spec when not on
   macOS. It never lives in `src/` and can never be chosen by the app, so
   decision 3 (one backend) holds for the product, and the filter keeps its
   real-CLI, real-daemon coverage on Linux. The alternative is to run the
   spec on macOS only, which loses that coverage.

   **Decided: the test-only forwarder under `test/`.**

## Open questions

- Pulling `FROM` images for the classic builder automatically, for example by
  reading the Dockerfile out of the build context as it streams, or through a
  registry mirror the agent serves from the Mac-side store.
- Whether to use `VZLinuxRosettaCachingOptions` (macOS 14) for faster amd64
  start.
- Corporate TLS inspection and system proxies for the Mac-side puller. Node's
  TLS does not read the Keychain (R17).
- A periodic update check. `autoDownload` fetches an update as soon as a
  check finds it, but the app checks only once at launch and when the user
  clicks Check; `updateSettings.checkIntervalHours` (default 24) is saved by
  the settings page and read nowhere in main. A runner left up for weeks gets
  a guest fix (R12) only after a restart. The check belongs beside the launch
  check in `src/main/index.ts`, and should re-read `autoCheck` each time.

## Appendix: the risk register, in one line each

The register came out of the investigation before this design (escape,
experiment, compatibility, performance, network and operations, each with a
skeptic). It is summarised here so that the R-numbers above can be read
without it.

| # | Risk | How this design answers it |
|---|---|---|
| R1 | VZ follows a link at the share path when the share takes effect (`Start()`) | Share rule 1–4: a directory localmost makes, node denies, and a helper profile pinned to its real path |
| R2 | Bind sources are re-resolved in the guest at container start | `nosymfollow` plus `lm-bindpin` (share rule 6–7) |
| R3 | A shared long-lived VM re-points binds and keeps old shares' sandbox access | One VM per job |
| R4 | VZ never returns guest memory while running | One VM per job; stopping is the reclaim |
| R5 | N VMs can overcommit the host | Boot only for `docker:` jobs; admission gate; lazy memory |
| R6 | VZ NAT gives unfiltered internet, LAN and host-service egress | No NIC |
| R7 | vsock-only breaks traffic that ignores the proxy | Accepted and documented; the network stack is on the backlog |
| R8 | vsock ignores netns; `internal` containers reach gateway listeners | Every vsock port grants only what the job has; INPUT reject; agents never on `0.0.0.0` |
| R9 | A host control socket in a job-writable directory, or a path-taking API | Sockets under `<data>/vm`; ids, not paths; a separate sandboxed helper |
| R10 | Guest kernel and firewall correctness | Alpine `linux-virt` (verified module set); `check-config.sh`; firewall self-test |
| R11 | Exec from virtiofs fails on some kernels | `nosuid`; verified on the shipped kernel |
| R12 | localmost now ships a kernel, `runc` and `dockerd` | Pinned Alpine packages; ships with the app; `autoDownload` on. The app checks for updates only at launch and on request, so a long-running runner needs a periodic check too (see Open questions) |
| R13 | No CLI without Docker Desktop; credential helper errors become anonymous pulls | Bundled CLI; loud helper failures |
| R14 | Cross-job poisoning through shared writable caches | Per-repository cache written only by a refresh VM from verified blobs, rebuilt from blank on a schedule; images that needed credentials kept out (owner decision 1 above) |
| R15 | Cold image stores on every job | Per-repository golden disk cloned per job |
| R16 | Full disk sync makes guest fsync slow | `.none` for job clones, `.fsync` plus `F_FULLFSYNC` for refresh |
| R17 | Pulls in the VM put credentials in the guest; CDN hosts; lost system CAs | Pulls on the Mac; CA/proxy support is an open question |
| R18 | macOS updates can break VZ; the guest clock stops in sleep | Self-test at boot; `set-time` on wake |
| R19 | Platform floor and two backends | macOS 14, arm64, one backend |
| R20 | amd64 needs Rosetta binfmt `CF` | Rosetta only; refuse amd64 without it; never prompt |
| R21 | `chown` on virtiofs does not persist | Documented; data directories on volumes |
| R22 | Bugs in Apple's closed virtiofs server | One share, per-job VM, the VZ service's own sandbox; stated as not contained |
| R23 | Host or guest hard links and FIFOs cross the share | Seatbelt refuses `link()` on files the job cannot write; host consumers use no-follow |
| R24 | Replacing the share root breaks binds | The checkout is a subdirectory; the root is fixed |
| R25 | A Local Network privacy prompt | vsock only |
| R26 | Stock gvproxy maps the host's loopback and dials anything | Not used; see the network stack backlog item |
| R27 | Signing, size, disk growth, crash cleanup, licences | Helper entitlement branch; Time Machine exclusion; startup sweep; GPL sources with releases |
| R28 | Hosted CI has no nested virtualization | Live VM tests self-hosted; helper and guest code compiled and unit-tested in a `macos-latest` CI job; guest builds on the owner's Mac |
| R29 | Published ports would be reachable by other jobs | Still refused by the filter |
