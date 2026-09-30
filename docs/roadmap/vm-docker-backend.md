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
  images and tags never carry over from one job to the next.
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
| `lm-init` | guest PID 1 | Go | Mounts, loads modules, starts and supervises the agent, reaps zombies. |
| `lm-agent` | guest | Go | vsock control (1025), Docker API splice (2375), proxy relay (198.18.0.1:3128 to vsock 3128), mounts the share, firewall, starts `dockerd`, self-test, clock, bind approvals. |
| `lm-runc` | guest `/usr/bin/runc` | Go | Wrapper. On `create` it adds the `lm-bindpin` hook to the bundle's `config.json`, then execs the real `runc`. |
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
by the filter from the guest manifest (`guest/manifest.json`) and the
configured VM size whenever no VM is running for that socket. A job whose
policy has no `docker:` section therefore sees a working daemon that refuses
everything but the baseline, and no VM ever boots for it. Once a VM is ready,
these calls go to it, and `/info` is rewritten as today.

**A pull.** `POST /images/create` is evaluated as today (`pull.registries`,
`run.images`). It is then *not* forwarded. `WorkerDocker.pull` runs on the Mac:

1. Resolve the reference and the registry.
2. Get credentials from the operator's Docker config. A credential helper that
   fails is an error, never an anonymous pull.
3. Fetch the index or manifest, choose the platform (see Rosetta), then fetch
   the config and layers.
4. Check every blob against its descriptor digest as it streams, and each
   uncompressed layer against the config's `diff_ids`.
5. Store the blobs in the repository's image store.
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

**Approved binds.** When the daemon answers a create the filter approved, the
filter sends the agent the binds it approved (`approve-binds`, with the
container id) before it passes the answer to the job. The job cannot start a
container it has not seen created, so the approval is in the guest before any
`runc create` for that container. `lm-bindpin` reads it back from the agent at
start.

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
  no share and no relay and never runs job code. It works on a clone of the
  golden disk attached with `.fsync`. It loads digest-verified images from the
  Mac-side store and removes anything else. On a clean guest shutdown the
  helper `F_FULLFSYNC`s the file, and the clone is renamed over the golden
  disk. A job's disk is never promoted.

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

This is the rule that closes G-A (R1). Every clause below is load-bearing.

1. **Which directory.** The share is `<sandbox>/_work`, the runner's work
   folder. The runner is configured with `--work _work`. It checks out into
   `_work/<repo>/<repo>`, which is `GITHUB_WORKSPACE`. The workspace, and so
   every path a policy's `mounts:` can name, is therefore inside the share. The
   filter socket `<sandbox>/docker.sock`, the job's `_temp`, the runner binaries
   and the credentials are siblings of `_work` and are not shared.
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
   ```

   The contents stay writable. The `<sandbox>` node needs the deny as well,
   because otherwise the job could rename its whole sandbox into a writable
   policy path such as `~/.npm` and put a link in its place. The ancestors of
   `<sandbox>` (`runner/sandbox`, `runner`, `<data>`, and `~` and `/Users` above
   them) are already denied as nodes by the existing app-directory rules.
4. **Pinned by the helper, too.** The helper is given the VM id and the sandbox
   id (`<slot>-<12 hex>`), never a path. It works out the share path itself from
   `<data>`. It checks that the share is a directory and not a link (`lstat`),
   and that `realpath(share) == realpath(<data>/runner/sandbox/<sandboxId>) + "/_work"`.
   It passes VZ that real path. Its own seatbelt profile grants file access and
   `com.apple.virtualization.extension.fuse` extension issuing on that real path
   only. So even if a link were somehow planted, VZ's resolution at `Start()`
   would land outside the helper's grant, and the start would fail with EPERM
   (verified, below). That gives two independent layers.
5. **Identical path in the guest.** The agent mounts the share at the same
   absolute path it has on the Mac. The filter pins each bind source to its
   host real path, and that path means the same thing to `dockerd` in the
   guest. The guest root is read-only, so the agent mounts a tmpfs over the
   share path's top-level directory (normally `/Users`) first. It refuses a
   top-level name that the guest root already has (`/usr`, `/var`, `/etc`, …).
6. **Mount flags.** Tag `work`, `MS_NOSUID | MS_NODEV | MS_NOSYMFOLLOW`. With
   `nosymfollow`, no path lookup through the share follows a symlink. `runc`'s
   bind of a source that is a link, or passes through one, fails with ELOOP.
   `nosuid` also keeps exec of workspace-built binaries working (R11). A child
   bind inherits `nosymfollow`.
7. **The hook's exact behaviour** (`lm-bindpin`, registered by `lm-runc` as a
   `createRuntime` hook on every `runc create`):
   1. Read the OCI state (`id`, `pid`, `bundle`) from stdin, and
      `<bundle>/config.json`.
   2. Ask the agent (`/run/localmost/agent.sock`, root only) for the approved
      binds of container `id`.
   3. Check every mount in `config.json` whose source is at or below the share
      mount path. Its source, destination and read-only flag must equal one
      approved bind *exactly*. Otherwise exit 1, and `runc` fails the start with
      `localmost: bind <src> was not approved for this container`.
   4. Enter the container's mount namespace (`setns` on `/proc/<pid>/ns/mnt`)
      and read `mountinfo`. Take every mount of the `work` virtiofs superblock.
      It must be one of the approved binds, matched by its root within the
      share and its mount point under the container rootfs. Otherwise exit 1.
   5. For each matched mount, call `mount_setattr(AT_FDCWD, mountpoint,
      AT_SYMLINK_NOFOLLOW, {attr_clr: MOUNT_ATTR_NOSYMFOLLOW})`. That clears
      `nosymfollow` and leaves `ro`, `nosuid` and `nodev` as they are.
   6. Exit 0. Mounts that do not come from the share are not touched: `/etc/hosts`,
      `resolv.conf` and named volumes live on the data disk.

   The effect: symlinks *inside* an approved bind work in the container, and
   resolve in the container's own root. The *source* of every bind was resolved
   by `runc` under `nosymfollow`, so it cannot have gone through a link.
   `lm-runc` is installed as `/usr/bin/runc`, with the real `runc` at
   `/usr/libexec/localmost/runc`. That way both runtime names the filter permits
   (`""` and `runc`) pass through the hook, and so does a restart.
8. **Tripwire.** Before the worker starts, localmost writes a random nonce to
   `<sandbox>/_work/.localmost-share`. `configure` returns what the guest reads
   there. If it does not match, the VM is torn down and the job runs without
   Docker. The job can overwrite the file, but doing so only denies itself
   Docker.

## Security properties

Each claim, what it rests on, and its evidence. "V" means verified by
experiment. "V-spike" means verified in this design's spike on 2026-09-30.
"Build" means it must be verified by the work package named.

| # | Claim | Rests on | Evidence |
|---|---|---|---|
| S1 | A job cannot give a container the user's home or any Mac path outside its own `_work` (G-A). | (a) The VM has exactly one read-write share, `_work`, created by localmost (R1). (b) Profile node denies make it unswappable (rule 3). (c) The helper's seatbelt grants only that real path, so a swap resolved at `Start()` fails. (d) A rename after `Start()` fails closed. (e) Symlinks planted on the host resolve in the guest, never on the Mac. (f) The VZ XPC service is itself sandboxed to the shared paths. | (a), (d), (e), (f): V (register §1). (c): V-spike. A share path swapped for a link to a directory outside the helper profile's grant failed `Start()` with EPERM, and an ungranted directory was refused the same way. (b): Build, WP-C sandbox test. |
| S2 | A container cannot reach guest `/`, the guest `docker.sock` or `/proc` by swapping a bind source (R2). | `nosymfollow` on the share, plus `lm-bindpin` clearing it only on approved binds. | V-spike on the shipped kernel (Alpine 6.18.54) with `dockerd` 29.5.3 and `runc` 1.4.3. `create` with a bind, swap the source for a link to `/`, `start` failed. A bind of a planted link to `/Users/...` failed. A child bind inherited `nosymfollow` (inner link: ELOOP). `mount_setattr` clearing only `NOSYMFOLLOW` restored inner links and kept `ro,nosuid,nodev`. The hook itself: Build, WP-A. |
| S3 | Containers of different jobs cannot reach each other, and a job cannot join another job's network. | Separate VMs. No NIC. vsock has no guest-to-guest path. Network names exist only inside one VM. | vsock CID 3 gives ENODEV (R7, V). Live cross-job test: Build, integration stage. |
| S4 | Container egress goes only through the job's proxy, under the job's policy. | No NIC. The relay goes only to that worker's `ProxyServer`, which checks the per-worker token. The guest firewall rejects everything else sent to the guest root namespace from bridges. | No route and no DNS without a NIC (R7, V). V-spike: a default-bridge container reached a listener on `198.18.0.1:3128`. An `internal` network container got "Network unreachable". Relay end to end: Build, WP-A with WP-B. |
| S5 | An `internal` network container reaches nothing outside its network. | No default route, and an INPUT reject from bridges for everything but the relay address. | V-spike: no route to the relay. It *did* reach a `0.0.0.0` listener on its gateway (R8 confirmed), which the INPUT rule closes. That rule: Build, WP-A self-test. |
| S6 | Registry credentials never enter the VM. | Pulls run on the Mac. Only the image archive crosses into the VM. | V-spike: `docker load` of an archive built on the Mac worked, and the image id equalled the config digest. The puller: Build, WP-D. |
| S7 | One job cannot poison another's images. | The cache is per repository. The golden disk is written only by the refresh VM from verified blobs. Job disks are clones and are discarded. There are no tags on the golden disk. | Design (R14). Build, WP-D. |
| S8 | Guest root is worth no more than the job already has. | One VM per job holds only this job's share, this job's proxy token and this job's images. | R3. The residual is the VZ/virtiofs attack surface (R22), below. |
| S9 | The VM control plane is not reachable by any job. | The helper sockets are under `<data>/vm/jobs/`, which every job profile denies. The API takes ids, not paths. | Profile rule (R9, V). Test: Build, WP-C sandbox test. |
| S10 | No Local Network privacy prompt, and no LAN or host-loopback reach from containers. | vsock only. No NIC. Host loopback is reached only through the proxy, under the job's `loopback` policy, the same as the job. | R6/R25. vsock round trip in both directions: V-spike. |
| S11 | A crashed or killed localmost leaves nothing running that keeps reaching anything. | A VM dies within about 2 s of its helper being killed. The startup sweep removes the directories left behind. | R27 (V). Sweep: Build, WP-C. |

What this backend does **not** contain, stated as plainly as `SECURITY.md` must:

- **A bug in Apple's virtiofs server or device emulation** (R22). It runs
  sandboxed to the one share, but it is closed source and has not been fuzzed
  here.
- **A kernel exploit from a container.** It gives guest root, which S8 bounds
  but does not prevent. `privileged` becomes grantable on this backend, because
  it too only reaches guest root. Privileged containers also bypass
  `internal:` and the hook.
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

**Sleep and wake.** On `powerMonitor` `resume`, the running VMs get `set-time`
from the Mac clock (VZ has no Linux time sync; R18), and the pre-warmed spare,
if any, is discarded. VMs are not paused across sleep.

**Low memory.** Each VM is configured with `dockerVm.memoryMiB` (8192 by
default). The memory is committed lazily, and only a stopped VM gives it back
(R4). An admission gate allows at most `dockerVm.maxRunning` VMs (default:
physical RAM divided by 8 GiB, at least 1). A boot beyond that waits in FIFO
order, and the job's docker requests wait with it, up to the boot timeout, then
get 503 "no Docker VM capacity". Under host memory pressure the spare is not
started. A container killed by the guest OOM killer exits 137, which Docker
reports as usual.

**Rosetta absent or broken.** No Rosetta share. arm64 images work. amd64
pulls are refused with the message above, naming the fix. A broken Rosetta
(installed, but the self-test fails) is refused with its own message. The
install prompt is never triggered.

**amd64 image.** Pulled as `linux/amd64` only when there is no arm64 build or
the request asks for it. It runs under Rosetta. `docker run --platform
linux/amd64` of an image that has both is honoured.

**Private registry credentials.** Read on the Mac by the puller (the operator's
`~/.docker/config.json`, credential helpers and `credsStore`) and used for the
registry's token exchange there. They are never forwarded. If the configured
helper is missing (ENOENT) or fails for any reason other than "credentials not
found", the pull fails with an error naming the helper. A helper that reports
"not found" means an anonymous pull, as the docker CLI does.

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

**Pre-warmed spare lifecycle** (`dockerVm.prewarm: true`; off by default).
There is at most one spare. It is booted when an idle worker is spawned for a
target, so its sandbox, and therefore its share, already exists. It uses the
spawn repository's cache disk. At the claim:

- If the claimed job's bound policy has `docker:`, and the claim is for the
  spawn repository, the spare becomes the job's VM.
- Otherwise it is stopped.

The spare is also stopped when its worker is reaped or exits, on wake, and
under memory pressure. A new spare is started when the next idle worker is
spawned. A spare VM holds the share of a sandbox whose job has not started, so
there is nothing in it to leak.

**Startup sweep.** Before the runner pool starts, `VmManager.sweep()` handles
each `<data>/vm/jobs/*`. It reads `helper.pid` and, if that pid is alive and is
a `localmost-vm` started from this app's Resources (the same pid-reuse checks
the runner sweep uses), sends SIGKILL. Then it removes the directory. Leftover
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

## What changes for users

- **No Docker Desktop.** localmost no longer uses or needs Docker Desktop for
  jobs. The job's `docker` is the bundled CLI. The operator's own Docker Desktop,
  if they have one, is untouched and is never used by jobs.
- **macOS 14 or later.** Apple silicon only, as before.
- **`routable` means through the job's proxy.** On the default bridge, and on a
  network declared `internal: false`, containers get `HTTP_PROXY`/`HTTPS_PROXY`
  pointing at the job's proxy. They reach exactly what the job's
  `network.allow` permits, and loopback per the job's `loopback` policy.
  Traffic that ignores the proxy settings has no route: plain TCP to an
  external database, `git` over ssh, UDP, and DNS lookups of outside names. It
  fails fast. The approval text changes from `UNFILTERED_EGRESS` to "egress
  through this job's proxy, subject to its network allowlist".
- **`internal: true`** means no egress at all, which was already the intent.
  Now it is enforced by the guest's routing and firewall.
- **Proxy settings are injected** into routable containers and into builds
  (`--build-arg`). A value the job sets itself is kept. Docker leaves the
  predefined proxy build args out of the image history. Container-to-container
  HTTP by service name should be listed in `NO_PROXY` by the job. The injected
  `NO_PROXY` covers only `localhost`, `127.0.0.1` and `::1`.
- **`privileged` becomes grantable.** The VM is the boundary. It is still a
  distinct, prominent grant in the approval diff.
- **Pulls happen on the Mac** and show Docker's usual progress. The first pull
  of an image by a repository downloads it, later jobs load it from the
  repository's cache disk, and a tag is re-resolved against the registry on
  every pull (a manifest `HEAD`, which Docker Hub does not count against rate
  limits).
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
  artifacts, read-write on the share, and `generic-issue-extension` for class
  `com.apple.virtualization.extension.fuse`. The same profile refused to share
  an ungranted directory, and a granted path that was a link to one (EPERM).
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

Not yet verified, and owned by work packages:

- `lm-bindpin` as a real hook, including its `setns` from Go.
- The firewall INPUT rules and the self-test.
- The relay end to end through `ProxyServer`.
- `docker load` of real registry images with gzip and zstd layers.
- The helper when signed with Developer ID and the hardened runtime and
  launched from the installed app.
- Memory with four concurrent VMs (R5).
- Sleep/wake clock drift and a VM launched by the app using Rosetta. These
  need the owner at the machine.

## Test strategy

- **Unit (CI, `npm test`).** These cover the filter changes: pull
  interception, proxy injection for routable networks only, the order of
  bind approval versus the create answer, synthetic baseline answers, and
  waiting for or timing out on the VM. They also cover the helper and agent
  NDJSON framing and limits, and the `VmManager` state machine against a fake
  helper. For the puller: a local mock registry, token auth, platform choice,
  CDN redirects, digest and `diff_id` mismatches, gzip and zstd, and loud
  credential-helper failure. The rest: `ImageStore`, `CacheDisks` (clone,
  refresh bookkeeping), profile generation (node denies, helper profile), guest
  composition (deterministic cpio/tar, case-clash preservation, lock-file
  verification), zboot unpacking, the `signOptionsForFile` branch, and
  packaging (extraResource, `LSMinimumSystemVersion` 14.0, entitlements).
- **Sandbox tests (real `sandbox-exec`, as `*.sandbox.test.ts` do today).**
  A job can create, write and remove anything under `_work` but cannot rename,
  remove, chmod or replace `_work` or `<sandbox>`. A job cannot connect to
  `<data>/vm/jobs/*/docker.sock`.
- **Swift.** `swift test` for argument and path validation. The helper is
  compiled in `check.yaml`. GitHub-hosted runners have no nested
  virtualization, so the helper cannot boot a VM there (R28).
- **Guest.** `go test` for `lm-bindpin` mountinfo matching, `lm-runc`'s
  `config.json` rewrite and the agent protocol, run on the Mac. `check-config.sh`
  from moby runs against the kernel config at build time.
- **Live VM tests** (self-hosted, against the installed app). The repo's
  **Docker Access** workflow (`docker-localmost`) exercises pull, run and a
  read-only workspace mount through the VM. A new **Docker VM escape**
  workflow runs the **G-A regression suite** as a job: the create, swap, start
  attack with links to `$HOME` and `/`, the swap from inside a container with a
  writable mount followed by a restart, renaming `_work`, cross-job reach
  (two concurrent jobs: joining the other's network by name, reaching its
  container IP), and egress with and without the injected proxy. The
  install-while-idle rule applies: CI's localmost legs run the installed app,
  not the tree.
- **The e2e docker suite** (`test/e2e/docker.spec.ts`, Playwright, local). It
  gains assertions that a VM booted for the docker job and not for a job with
  no `docker:`, that the pull was served on the Mac, and that the VM is gone
  after the job.

## Open questions

- Pulling `FROM` images for the classic builder automatically, for example by
  reading the Dockerfile out of the build context as it streams, or through a
  registry mirror the agent serves from the Mac-side store.
- Whether to use `VZLinuxRosettaCachingOptions` (macOS 14) for faster amd64
  start.
- Corporate TLS inspection and system proxies for the Mac-side puller. Node's
  TLS does not read the Keychain (R17).

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
| R12 | localmost now ships a kernel, `runc` and `dockerd` | Pinned Alpine packages; ships with the app; `autoDownload` on |
| R13 | No CLI without Docker Desktop; credential helper errors become anonymous pulls | Bundled CLI; loud helper failures |
| R14 | Cross-job poisoning through shared writable caches | Per-repository cache written only by a refresh VM from verified blobs |
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
| R28 | Hosted CI has no nested virtualization | Live VM tests self-hosted; helper compiled in `check.yaml` |
| R29 | Published ports would be reachable by other jobs | Still refused by the filter |
