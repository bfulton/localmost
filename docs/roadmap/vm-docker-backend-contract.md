# VM Docker Backend — Interface Contract

The interfaces between the pieces of the [VM Docker backend](vm-docker-backend.md).
Four groups can build against this at the same time: the guest image, the Swift
helper, the Electron integration, and the puller and cache. Each group tests
against fakes of the others that behave as described here.

**Contract version 1.** A change to anything in this file goes in the same PR
as this file's update, and the version stamps below (`"v":1`, `schema`,
`agentProtocol`) move with it. Where a value is marked *verified*, the design
spike on 2026-09-30 ran it. Everything else is specified here, not yet tested.

## 1. Identifiers and host paths

| Name | Form | Made by | Meaning |
|---|---|---|---|
| `slot` | integer 1–99 | runner-manager | The worker's instance number. |
| `sandboxId` | `^(?:0\|[1-9][0-9]?)-[0-9a-f]{12}$` | `buildSandbox` (already this shape) | The basename of the worker's sandbox directory. The slot has no leading zero, as nothing writes one. |
| `vmId` | `^(?:0\|[1-9][0-9]?)-[0-9a-f]{12}$` | `VmManager` (`<slot>-<randomBytes(6) hex>`) | One VM. It is never reused. A refresh VM has no worker and uses slot `0` (`0-<12 hex>`). No leading zero, so nothing but `0-` reads as the refresh slot. |
| digest | `^sha256:[0-9a-f]{64}$` | a registry, or the VM | Every digest from outside Electron is checked against this before any use (§6.3). |
| `repoKey` | `^[0-9a-f]{16}$` | `repoKeyOf(repository)`: first 16 hex of `sha256(lowercase("owner/name"))` | Per-repository store and cache. |
| `<data>` | absolute | `getAppDataDir()` | Normally `~/.localmost`. |
| `<resources>` | absolute | `process.resourcesPath`, or the checkout's `build/` in development | Where the guest is found (`<resources>/guest`). Electron's app path is the checkout under `electron .` but `build/dist` under `electron build/dist/main.js` (the e2e launch); `getVmResourcesDir()` gives the same `build/` for both. |
| `<helper>` | absolute | `helperPath()` in `vm/paths.ts` | `<resources>/localmost-vm` when packaged; `build/localmost-vm` in development (`build:helper` copies it there). The one path used by the spawn, the helper profile and the sweep. |
| `<docker-cli>` | absolute | `dockerCliPath()` in `vm/paths.ts` | `<resources>/docker-cli/docker`; `build/docker-cli/docker` in development. |

```
<data>/runner/sandbox/<sandboxId>/            made by buildSandbox (existing)
<data>/runner/sandbox/<sandboxId>/_work/      THE SHARE: made by buildSandbox, before any process runs there
<data>/runner/sandbox/<sandboxId>/_work/.localmost-share   32 hex nonce, written O_CREAT|O_EXCL before the worker starts
<data>/runner/sandbox/<sandboxId>/docker.sock the filter socket (existing)
<data>/runner/sandbox/<sandboxId>/.docker/     empty DOCKER_CONFIG for the job's CLI, made by buildSandbox (not shared)
<data>/vm/                                    mode 0700; `tmutil addexclusion` when created
<data>/vm/jobs/<vmId>/                        mode 0700, made by VmManager
    helper.sb  data.img  helper.pid  console.log  docker.sock  agent.sock
    blobs/sha256/<64 hex>                     images that needed credentials: this job only, deleted with the VM
<data>/vm/images/<repoKey>/blobs/sha256/<64 hex>
<data>/vm/images/<repoKey>/refs.json
<data>/vm/cache/<repoKey>/data.img            golden data disk
<data>/vm/cache/<repoKey>/data.img.new        a refresh in progress (swept at startup)
<data>/vm/cache/<repoKey>/meta.json
```

The longest socket path, `<data>/vm/jobs/<vmId>/docker.sock`, is `<data>` plus 36
bytes, well under the 103-byte limit for any `<data>` the sandbox already
accepts. Every path above is inside `<data>`,
which every job profile denies for reads and writes (VZ-RISKS R9).

## 2. The helper: `localmost-vm`

A Swift command-line program built for `arm64-apple-macos14`. It lives at
`<helper>` (§1) and runs exactly one VM per process.

### 2.1 Invocation

Electron main spawns `<helper>` through `/usr/bin/sandbox-exec -f <data>/vm/jobs/<vmId>/helper.sb`
with an empty environment, except `PATH=/usr/bin:/bin` and `TMPDIR=<data>/vm/jobs/<vmId>`.
`HelperClient` takes the spawn function as an injected dependency; unit tests
pass one that runs the fake helper (§8) directly, without `sandbox-exec`. The
real `sandbox-exec` wrapping is tested only in `helper-client.sandbox.test.ts`,
which follows the repo's three-mode pattern.

```
localmost-vm run
  --vm-id <vmId>
  --mode job|refresh
  --data-dir <abs path>          # <data>; the helper realpaths it once
  --resources <abs path>         # <resources>; the helper reads guest/ from here
  --sandbox-id <sandboxId>       # job mode only
  --repo-key <repoKey>           # refresh mode only
  --proxy-port <1..65535>        # job mode only: the worker's ProxyServer port on 127.0.0.1
  --cpus <1..64>
  --memory-mib <1024..65536>
  --rosetta auto|off
localmost-vm version             # prints {"helper":"<semver>","contract":1} and exits 0
```

The helper derives every path it uses from these arguments. Nothing on its
command line is a path the job chose.

- Share (job mode): `S = realpath(<data>/runner/sandbox/<sandboxId>) + "/_work"`.
  It requires that `lstat(S)` is a directory and not a link, that
  `realpath(S) == S`, that `S` starts with `realpath(<data>/runner/sandbox) + "/"`,
  that `st_dev(S) == st_dev(<sandbox>)`, and that `S` is not a mount point
  (`statfs(S).f_mntonname != S`). The last two refuse a DMG, FUSE or SMB
  mount placed over `_work`, which seatbelt's path rules do not see. The
  helper runs the checks right before `start`, and Electron runs the same
  checks before the spawn. If any check fails: `E_SHARE`.
- Data disk: `<data>/vm/jobs/<vmId>/data.img` in job mode, or
  `<data>/vm/cache/<repoKey>/data.img.new` in refresh mode. Electron prepares it
  (clone or new sparse file) before the spawn. If it is missing: `E_DISK`.
- Guest: `<resources>/guest/{vmlinux,initramfs.cpio.gz,rootfs.erofs}`. The
  helper checks each file's size against `manifest.json` (Electron checks the
  hashes, §5.4). On a mismatch: `E_GUEST_IMAGE`.

### 2.2 The VM it builds

| VZ setting | Value |
|---|---|
| Boot loader | `VZLinuxBootLoader(kernelURL: vmlinux)`, `initialRamdiskURL: initramfs.cpio.gz` |
| Command line | `console=hvc0 rdinit=/init ro quiet panic=-1 ipv6.disable=1 lm.mode=<mode>` |
| CPUs, memory | `--cpus`, `--memory-mib` |
| Serial | virtio console to `<data>/vm/jobs/<vmId>/console.log`, truncated to its last 1 MiB when it exceeds 2 MiB |
| Storage | `vda`: `rootfs.erofs`, `readOnly: true`, sync `.full`. `vdb`: data disk, `readOnly: false`, cache `.automatic`, sync `.none` (job) or `.fsync` (refresh) |
| Directory sharing | job mode: exactly one `VZVirtioFileSystemDeviceConfiguration(tag: "work")`, `VZSingleDirectoryShare(VZSharedDirectory(url: S, readOnly: false))`. Plus, when `--rosetta auto` and `VZLinuxRosettaDirectoryShare.availability == .installed`, tag `"rosetta"`. Refresh mode: no shares. |
| Network | **none**. `networkDevices` is empty. |
| Socket | one `VZVirtioSocketDeviceConfiguration` |
| Entropy | `VZVirtioEntropyDeviceConfiguration` |
| Balloon, graphics, audio, USB, keyboard, pointing | none |

### 2.3 Sockets and vsock

| Endpoint | Created by | On connect |
|---|---|---|
| `<data>/vm/jobs/<vmId>/docker.sock` (unix, 0600) | helper, before `start` | `socketDevice.connect(toPort: 2375)`, then copy bytes both ways until either side closes. If the dial fails, close the unix connection at once. |
| `<data>/vm/jobs/<vmId>/agent.sock` (unix, 0600) | helper, before `start` | The same, to guest port **1025**. |
| vsock **3128**, host side (`setSocketListener(forPort: 3128)`) | helper, after `start`, job mode only | Connect TCP `127.0.0.1:<proxy-port>`, then copy bytes both ways. If the connect fails, close the vsock connection. |

These three are all there is. The helper listens on no other vsock port and
dials no other address. It never parses the bytes it copies. Limits: 64
concurrent connections per unix socket, 256 relay connections, and a 1 MiB
buffer per direction.

Verified: a host vsock listener, a host dial to a guest port, and a static Go
guest agent on both ends.

### 2.4 Control protocol (stdio)

Framing: UTF-8 JSON, one object per line (`\n`), 64 KiB at most per line. Each
object carries `"v":1`. Commands arrive on stdin and events leave on stdout.
stderr carries free-form log lines of the form `<level> <message>`, where level
is one of `debug`, `info`, `warn`, `error`. Electron logs them under the VM id.
A line on stdout that is not a valid event makes Electron kill the helper.

**Events (helper → Electron)**

| Event | When | Fields |
|---|---|---|
| `listening` | Both unix sockets bound, before `start` | `dockerSocket`, `agentSocket` |
| `started` | `VZVirtualMachine.start` succeeded | `pid` (the helper's own pid; the VZ XPC process is not observable), `rosetta`: `installed`, `notInstalled`, `notSupported` or `off`, and `startMs` (milliseconds since exec) |
| `stopped` | The VM stopped. The helper exits right after. | `reason`: `guest` (guest powered off), `requested` or `error`; `code`, `message` when `error`; `synced`: true once `F_FULLFSYNC` of the data disk succeeded after a `guest` stop in refresh mode |

**Commands (Electron → helper)**. Each has an integer `id` and is answered
with `{"v":1,"id":<id>,"ok":true}` or with
`{"v":1,"id":<id>,"ok":false,"code":"…","message":"…"}`.

| Command | Fields | Effect |
|---|---|---|
| `stop` | `graceMs` (0–60000) | If `graceMs > 0`: `requestStop()`, then wait for the guest to stop, up to `graceMs`. Then `stop()`, which forces it. `stopped` follows. |
| `ping` | – | Answers with `"state": "starting"`, `"running"` or `"stopping"`. |

**Signals.** SIGTERM or SIGINT is `stop` with `graceMs: 0`, then exit. SIGKILL
leaves the VM to VZ, which stops it within about 2 s (R27, verified).

**Parent death.** At start the helper records `getppid()` and watches it with
kqueue `EVFILT_PROC`/`NOTE_EXIT`. If that process exits, or stdin reaches EOF,
the helper acts as on `stop` with `graceMs: 0`, then exits. If `getppid()` is
already 1 at start, it exits with `E_ARGS`. This is what makes a crash or
SIGKILL of Electron main stop every VM.

**Exit codes and error codes**

| Exit | `code` | Meaning |
|---|---|---|
| 0 | – | Stopped cleanly (`guest` or `requested`) |
| 64 | `E_ARGS` | Bad or missing argument |
| 65 | `E_SHARE` | The share failed a §2.1 check |
| 66 | `E_GUEST_IMAGE` | A guest artifact is missing or the wrong size |
| 67 | `E_DISK` | The data disk is missing or cannot be attached |
| 68 | `E_VZ_CONFIG` | `validate()` failed |
| 69 | `E_VZ_START` | `start` failed. This includes EPERM from the helper's own sandbox. |
| 70 | `E_SOCKET` | A unix socket could not be bound |
| 71 | `E_GUEST_ERROR` | `didStopWithError` |
| 72 | `E_SYNC` | `F_FULLFSYNC` failed after a refresh |

### 2.5 The helper's seatbelt profile

Electron writes `helper.sb` for each VM from `buildHelperProfile(opts)` in
`src/main/vm/helper-profile.ts`. Every interpolated path is a real path and is
escaped as the job profile escapes its paths.

```scheme
(version 1)
(deny default)
(import "system.sb")
(allow process-exec (literal "<helper>"))
(allow file-read*
  (literal "<helper>")
  (subpath "<resources>/guest"))
(allow file-read* file-write* (subpath "<data>/vm/jobs/<vmId>"))
;; job mode:
(allow file-read* file-write* (subpath "<S>"))
;; The second layer of the share rule. VZ's service reaches the share only
;; through an extension the helper issues for the path it resolved at start.
;; Scoped to <S> and never broadened: a link planted at <S> resolves outside
;; it, so no extension is issued and start fails with EPERM.
(allow file-issue-extension
  (require-all
    (extension-class "com.apple.app-sandbox.read-write" "com.apple.app-sandbox.read")
    (subpath "<S>")))
(allow generic-issue-extension (extension-class "com.apple.virtualization.extension.fuse"))
(allow network-outbound (remote ip "localhost:<proxy-port>"))
;; refresh mode, instead of the job-mode rules above: its one disk, and no
;; share, so no extension rule at all.
(allow file-read* file-write* (literal "<data>/vm/cache/<repoKey>/data.img.new"))
;; both modes: the helper's own unix sockets
(allow network-bind network-inbound (subpath "<data>/vm/jobs/<vmId>"))
```

A refresh VM's helper directory is `<data>/vm/jobs/0-<12 hex>`, so its
sockets, console and pid file are covered by the jobs rule. Electron, not the
helper, writes `meta.json` and renames `data.img.new`.

*Verified (spike):* a VZ host under a deny-default profile with the job-mode
rules above, including the scoped `file-issue-extension` rule, boots a guest
and the guest reads the share. A share outside the `(subpath "<S>")` grant, or
a granted path that is a link to somewhere outside it, fails `start` with
EPERM. *Verified (review probe):* the same profile *without* the
`file-issue-extension` rule starts the VM and vsock works, but every read of
the share in the guest fails with "Operation not permitted". So that rule is
what the EPERM rests on, and a profile without it gives a VM whose share does
not work. A read-write data disk in a granted directory attached without any
extension rule. *Not verified:* the erofs root disk under the profile, which
the spike never attached; WP-B confirms it. Rosetta may need its own read or
extension rule; WP-B adds exactly what `sandbox-exec` tracing shows and
nothing more, and never a broader `file-issue-extension`.

## 3. The guest

### 3.1 vsock ports

| Port | Direction | Listener | Purpose |
|---|---|---|---|
| 1025 | host → guest | `lm-agent` | Control protocol (§3.4) |
| 2375 | host → guest | `lm-agent`, copying to `/run/docker.sock` | Docker Engine API |
| 3128 | guest → host | helper, copying to `127.0.0.1:<proxy-port>` | Proxy relay (job mode only) |

The guest-side listeners on 1025 and 2375 accept a connection only when its
peer CID is 2 (the host), and close any other at once. Without
`vsock_loopback` (not in the module allowlist, and module loading is disabled
after boot) no other peer exists, but the check keeps a guest process from
reaching unfiltered `dockerd` or `approve-binds` if one ever did.

Port 3128 on the host is reachable by all code in the VM, including guest
root (R8). It grants nothing without the job's proxy token.

### 3.2 Boot sequence

1. **initramfs `/init`** (busybox): mount devtmpfs. `insmod` `virtio_blk.ko` and
   `erofs.ko`. Mount `/dev/vda` read-only as erofs on `/newroot`. Move `/dev`.
   `switch_root /newroot /sbin/lm-init`. If the root does not mount, print to
   hvc0 and `poweroff -f`. *Verified.*
2. **`lm-init`** (PID 1):
   - Mount `proc`, `sysfs`, `cgroup2` on `/sys/fs/cgroup`, and tmpfs on
     `/run`, `/tmp`, `/var/log` and `/var/tmp`.
   - `modprobe` the module set from §5.2.
   - Set sysctls: `net.ipv4.ip_forward=1`, `net.bridge.bridge-nf-call-iptables=1`,
     `kernel.dmesg_restrict=1`, `kernel.panic_on_oops=1`. Then, last, and
     after every module is loaded: `kernel.kexec_load_disabled=1` and
     `kernel.modules_disabled=1`. Both are one-way until reboot. The kernel
     has `MODULE_SIG` without `MODULE_SIG_FORCE`, so without this guest root
     could load any module. Anything that needs a module later (Docker loads
     some on demand) must be in the §5.2 allowlist; WP-A's acceptance runs
     every Docker feature the filter permits with loading disabled.
   - Mount the data disk (§3.5), bring up `lo`, and start `lm-agent`. If the
     agent exits, for any reason, `lm-init` syncs and powers off. It never
     restarts it: the agent's state (bind approvals, the relay, the
     `configure` result, the `dockerd` it started) cannot be rebuilt, and
     `configure` is accepted only once. The helper then reports `stopped`
     with reason `guest`, and `VmManager` marks the VM failed.
   - Reap zombies. Power off when the agent asks.
3. **`lm-agent`**: listen on vsock 1025 and 2375, and on `/run/localmost/agent.sock`
   (0600, root). Wait for `configure`.

### 3.3 In-guest layout

```
/sbin/lm-init
/usr/libexec/localmost/lm-agent
/usr/libexec/localmost/lm-bindpin
/usr/libexec/localmost/runc              the real runc (Alpine runc package, moved)
/usr/bin/runc                            lm-runc, the wrapper
/usr/libexec/localmost/x86_64-selftest   static x86-64 busybox (Alpine x86_64 busybox-static), for the Rosetta self-test
/etc/docker/daemon.json                  below
/etc/resolv.conf                         "nameserver 198.18.0.1"
/var/run -> ../run
/var/lib/docker                          data disk (ext4, label lmdata)
/var/lib/containerd                      bind of /var/lib/docker/.containerd
/run/docker.sock  /run/localmost/agent.sock  /run/rosetta (virtiofs "rosetta")
<share mount path>                       virtiofs "work", under a tmpfs on its top-level directory
```

`/etc/docker/daemon.json`, exactly:

```json
{
  "hosts": ["unix:///run/docker.sock"],
  "storage-driver": "overlay2",
  "features": { "containerd-snapshotter": false },
  "iptables": true,
  "ip6tables": false,
  "ipv6": false,
  "userland-proxy": false,
  "live-restore": false,
  "dns": ["198.18.0.1"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "2" }
}
```

The classic graph-driver store is chosen because jobs are pinned to the classic
builder (`DOCKER_BUILDKIT=0`). WP-A confirms that `docker build` with
`DOCKER_BUILDKIT=0` works against it. *Verified:* `dockerd` 29.5.3 starts with
this configuration (without `dns` and the log options), iptables on, overlay2,
and cgroup v2.

### 3.4 Agent protocol (vsock 1025)

Framing and limits are the same as §2.4. Requests look like
`{"v":1,"id":<int>,"op":"…",…}`. The answer is `{"v":1,"id":…,"ok":true,…}` or
`{"v":1,"id":…,"ok":false,"code":"…","message":"…"}`. Requests on one
connection are handled in order. Electron keeps one connection and treats every
answer as hostile input: it validates the schema, bounds every string, and never
uses an answer to choose a host path.

| op | Request fields | Answer fields | Timeout |
|---|---|---|---|
| `hello` | – | `agent` (semver), `guestVersion`, `kernel`, `agentProtocol`: 1 | 5 s |
| `configure` | `vmId`, `mode`, `timeUnixMs`, `share`: `{ "tag": "work", "mountPath": <S>, "nonceFile": ".localmost-share" }` (job), `rosetta`: bool, `relay`: `{ "address": "198.18.0.1", "port": 3128, "vsockPort": 3128 }` (job) | `docker`: `{ version, apiVersion, minApiVersion }`, `disk`: `formatted`, `existing` or `corrupt`, `nonce` (≤ 64 chars, job), `rosetta`: `ok`, `absent` or `broken`, `selftest`: `{ rules, internalNoRelay, internalForgedRejected, gatewayRejected, bridgeReachesRelay }`, each a bool | 60 s |
| `approve-binds` | `container` (64 hex), `binds`: up to 64 × `{ source, destination, readOnly }` | – | 10 s |
| `set-time` | `unixMs` | – | 10 s |
| `status` | – | `dockerd`: `running` or `exited`, `uptimeMs` | 10 s |
| `shutdown` | – | – (the answer comes first, then the agent stops `dockerd` with SIGTERM and waits up to 15 s, syncs, unmounts the data disk, and powers off) | 10 s |

`configure` is accepted once. A second one answers `E_CONFIGURED`. `configure`
does these steps in order and stops at the first failure, answering with its
code:

1. Set the clock from `timeUnixMs`.
2. Data disk. If `/dev/vdb` has no ext4 superblock, run `mke2fs -t ext4 -F -q -L lmdata`
   (`formatted`). Otherwise run `e2fsck -n`; if it finds errors, answer
   `disk: corrupt` with `ok: false` and code `E_DISK`. Mount it on
   `/var/lib/docker`.
3. Share (job mode). `mountPath` must be absolute and normalised (no `.`, `..`,
   `//` or NUL), at most 1024 bytes, and its top-level component must not exist
   in the root (`E_SHARE_PATH`). Mount a tmpfs on `/<top>`, `mkdir -p`, then
   `mount("work", mountPath, "virtiofs", MS_NOSUID|MS_NODEV|MS_NOSYMFOLLOW)`
   (`E_SHARE_MOUNT`). Read `nonceFile` with `O_NOFOLLOW`, capped at 64 bytes.
4. Rosetta (when `rosetta`). Mount virtiofs `rosetta` on `/run/rosetta`, mount
   `binfmt_misc`, and write this to `register`:
   `:rosetta:M::\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x3e\x00:\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:/run/rosetta/rosetta:CF`.
   Run `/usr/libexec/localmost/x86_64-selftest true`. The result is `ok` or
   `broken`; with `rosetta: false` it is `absent`. This step never fails
   `configure`.
5. Network (job mode). Create a dummy interface `lm0` with `198.18.0.1/32`,
   bring it up, and apply the rules in §3.6. Start the relay: TCP listen on
   `198.18.0.1:3128`, and for each connection dial vsock CID 2 port 3128 and copy
   bytes both ways. Subscribe to Docker's network events once `dockerd` is up
   (step 6) and keep `LOCALMOST-RELAY` in step with them (§3.6). In refresh
   mode there is no `lm0` and no relay, but the rules still apply.
6. Start `dockerd --config-file /etc/docker/daemon.json`. Wait up to 30 s for
   `GET /_ping` on `/run/docker.sock` (`E_DOCKERD`, with the last 20 log lines,
   each at most 512 bytes). Electron strips control characters and ANSI
   escapes from these lines, and from every other string the guest supplies,
   before it logs them.
7. Self-test (job mode, §3.6). Any `false` fails with `E_SELFTEST`.

Guest-local op on `/run/localmost/agent.sock`, used only by `lm-bindpin`:
`{"v":1,"id":1,"op":"binds-for","container":"<id>"}` answers
`{"v":1,"id":1,"ok":true,"binds":[…]|null}`.

Agent error codes: `E_PROTO`, `E_UNKNOWN_OP`, `E_CONFIGURED`, `E_NOT_CONFIGURED`,
`E_DISK`, `E_SHARE_PATH`, `E_SHARE_MOUNT`, `E_DOCKERD`, `E_SELFTEST`, `E_BINDS`.

### 3.5 Disks in the guest

`/dev/vda` is the erofs root, read-only. `/dev/vdb` is the data disk: ext4,
label `lmdata`, mounted on `/var/lib/docker`, with `.containerd/` bound onto
`/var/lib/containerd`. *Verified:* `mke2fs` in the guest, and `dockerd` on it.

### 3.6 Firewall and self-test

Applied with `iptables` (the nft backend) before `dockerd` starts:

```
iptables -N LOCALMOST-RELAY
iptables -N LOCALMOST-INPUT
iptables -A LOCALMOST-INPUT -i lo -j ACCEPT
iptables -A LOCALMOST-INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A LOCALMOST-INPUT -d 198.18.0.1/32 -p tcp --dport 3128 -j LOCALMOST-RELAY
iptables -A LOCALMOST-INPUT -p tcp -j REJECT --reject-with tcp-reset
iptables -A LOCALMOST-INPUT -j REJECT --reject-with icmp-port-unreachable
iptables -I INPUT 1 -j LOCALMOST-INPUT
```

`LOCALMOST-RELAY` accepts the relay address only from the bridges of routable
networks. It starts with `-A LOCALMOST-RELAY -i docker0 -j ACCEPT` (the
default bridge). The agent follows Docker's network events: on `create` of a
bridge network that is not `internal`, it appends `-i br-<first 12 of id>
-j ACCEPT`; on `destroy`, it deletes that rule. A packet that falls through
`LOCALMOST-RELAY` returns to `LOCALMOST-INPUT` and is rejected. Until the
event is handled, a new routable network cannot reach the relay, which fails
closed.

Why the interface match matters: the relay address is on `lm0`, and Linux
accepts a packet for any local address on any interface (the weak-host
model). `NET_RAW` is in Docker's default capabilities, so a container on an
`internal` network can send a frame to its gateway's MAC with destination
`198.18.0.1`, whatever its routing table says. Matching on the destination
alone would accept it. The backstop behind this rule is the proxy token,
which is injected only into routable containers. The filter does not also
drop `NET_RAW` for internal containers: the interface match is enough, and
dropping it would break `ping` inside internal networks.

REJECT, not DROP, so that a DNS lookup or a direct connection fails at once
instead of timing out. *Verified:* with no listener on `198.18.0.1:53`,
`dockerd`'s own registry lookup failed immediately.

Self-test, using `iproute2` network namespaces, after `dockerd` is up:

- `rules`: `iptables -S LOCALMOST-INPUT` equals, line for line, the golden
  output in `guest/internal/firewall/testdata/localmost-input.txt`, and
  `INPUT` starts with the jump. `iptables -S` prints rules in canonical form,
  not as they were written. The expected form for iptables-nft 1.8 is below;
  WP-A replaces it with the verbatim capture from the pinned `iptables`
  package and checks the file in:

  ```
  -N LOCALMOST-INPUT
  -A LOCALMOST-INPUT -i lo -j ACCEPT
  -A LOCALMOST-INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  -A LOCALMOST-INPUT -d 198.18.0.1/32 -p tcp -m tcp --dport 3128 -j LOCALMOST-RELAY
  -A LOCALMOST-INPUT -p tcp -j REJECT --reject-with tcp-reset
  -A LOCALMOST-INPUT -j REJECT --reject-with icmp-port-unreachable
  ```
- `internalNoRelay`: a namespace on a scratch bridge that is not in
  `LOCALMOST-RELAY`, with no default route, cannot connect to
  `198.18.0.1:3128` (ENETUNREACH).
- `internalForgedRejected`: the same namespace, given a host route to
  `198.18.0.1` through its gateway (which delivers the same packet a raw
  socket would), gets a reset, never a connection.
- `gatewayRejected`: the same namespace, connecting to a listener the agent
  opens on `0.0.0.0` at the scratch bridge's gateway address, gets a reset or
  unreachable, never a connection.
- `bridgeReachesRelay`: after the scratch bridge is added to
  `LOCALMOST-RELAY`, with a default route through that gateway, it connects to
  `198.18.0.1:3128`.

The scratch bridge, its relay rule and the namespace are removed afterwards.
*Verified behaviour that motivates this:* in the spike, a container on an
`internal` network could not reach `198.18.0.1`, but did reach a `0.0.0.0`
listener on its gateway (R8). The spike did not test forged frames.

### 3.7 `lm-runc` and `lm-bindpin`

- `lm-runc` (`/usr/bin/runc`) looks at the subcommand in its arguments. If it
  is `create`, `run` or `restore`, it reads `--bundle <dir>` (default: the current
  directory) and adds
  `{"path":"/usr/libexec/localmost/lm-bindpin","args":["lm-bindpin"],"timeout":10}`
  to `hooks.createRuntime` in `<dir>/config.json`. Hooks already there are
  kept. The file is written back through a temporary file and a rename. Then,
  for every subcommand, it runs `execve("/usr/libexec/localmost/runc", argv)`.
- `lm-bindpin` follows the steps in [the design's rule 7](vm-docker-backend.md#the-share-layout-rule).
  It enters the mount namespace from Go by locking its OS thread and calling
  `unshare(CLONE_FS)` and then `setns`. It identifies each share-backed mount
  by its mount id from `mountinfo`, reaches it only through `openat2` with
  `RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_BENEATH` from an fd on
  the container rootfs (or `open_tree` under the same resolution), checks the
  fd's mount id with `statx(STATX_MNT_ID)`, and clears the flag with
  `mount_setattr(fd, "", AT_EMPTY_PATH, …)`, only after every mount has
  passed every check. Any error, including an agent that cannot be reached,
  exits 1 when a share-backed mount is present. Its failure message on
  stderr, which `runc` passes through to the job, is
  `localmost: bind <source> -> <destination> was not approved for this container`.
  *Verified primitive:* `mount_setattr(…, {attr_clr: MOUNT_ATTR_NOSYMFOLLOW})`
  on a child bind of a `nosymfollow` virtiofs mount clears only that flag and
  keeps `ro,nosuid,nodev`.

**Bind matching.** An `ApprovedBind` and a mount in `config.json` are compared
after the same normalisation, done once in TypeScript (the evaluator) and once
in Go (the hook), with shared test vectors in
`guest/internal/mountinfo/testdata/binds.json`:

- `source`: the pinned host real path, exactly as the filter forwarded it in
  the create body. It is absolute and already clean; it is compared byte for
  byte, never re-cleaned or resolved.
- `destination`: `path.posix.normalize`, then any trailing `/` removed (except
  for `/` itself). The evaluator now parses destinations out of `Binds` and
  `Mounts` (today its `MountRequest` has only `source` and `mode`), and
  refuses a relative destination. `dockerd` cleans destinations the same way
  (`/data/` becomes `/data`).
- `readOnly`: in the evaluator, from the bind's `ro` mode or `Mounts[].ReadOnly`;
  in `config.json`, true exactly when the mount's `options` contain `ro`.
- One approval list per container. Each mount must match one approval; each
  approval may be used by at most one mount. The same source approved twice
  with different destinations or modes is two approvals, each matched on
  all three fields. Two binds to the same destination are refused by the
  evaluator, as `dockerd` refuses them.

### 3.8 Refresh mode

`lm.mode=refresh`, no share, no Rosetta, no relay. Its `vmId` uses slot `0`.
Electron loads, through `docker.sock`, only the images in the repository's
`refs.json` whose config digests are not already in `meta.json` (or all of
them when the refresh starts from a blank disk, §6.5). It removes every image
that is not in that list, and every tag. Then it sends `shutdown`. The helper
`F_FULLFSYNC`s the disk and reports `stopped` with `synced: true`.

## 4. Guest image: artifacts and build

### 4.1 In the app bundle

```
localmost.app/Contents/Resources/guest/
  vmlinux             raw arm64 Image, unpacked from Alpine's EFI zboot vmlinuz (~36 MB)
  initramfs.cpio.gz   busybox-static, virtio_blk.ko, erofs.ko, /init (~0.8 MB)
  rootfs.erofs        the read-only root, lz4hc (~90–130 MB)
  manifest.json       below
  LICENSES.md         each package's license field, the Alpine aports commit, and the source offer
```

`manifest.json` (`schema: 1`):

```json
{
  "schema": 1,
  "guestVersion": "2026.10.0",
  "dataFormat": 1,
  "agentProtocol": 1,
  "alpine": { "branch": "v3.24", "release": "3.24.2" },
  "kernel": { "package": "linux-virt-6.18.54-r0", "release": "6.18.54-0-virt" },
  "docker": { "engine": "29.5.3", "apiVersion": "1.54", "minApiVersion": "1.24", "containerd": "2.3.6", "runc": "1.4.3" },
  "artifacts": {
    "vmlinux": { "sha256": "…", "size": 0 },
    "initramfs.cpio.gz": { "sha256": "…", "size": 0 },
    "rootfs.erofs": { "sha256": "…", "size": 0 }
  },
  "modules": ["virtiofs", "…"],
  "packages": [{ "name": "…", "version": "…", "repo": "main", "sha256": "…", "license": "…" }],
  "baseline": {
    "ServerVersion": "29.5.3", "OSType": "linux", "Architecture": "aarch64",
    "OperatingSystem": "localmost guest (Alpine Linux v3.24)", "KernelVersion": "6.18.54-0-virt",
    "Driver": "overlay2", "CgroupVersion": "2", "SecurityOptions": ["name=seccomp,profile=builtin", "name=cgroupns"]
  }
}
```

`baseline` is recorded by the build's smoke boot (§4.3, step 7) from the real
daemon's `/info`, restricted to the filter's `/info` allowlist. The filter
answers a VM-less `/info` from it, and `/version` from `docker`.

### 4.2 Pinned inputs

`scripts/guest/packages.lock.json` lists each package as `name`, `version`,
`repo`, `arch`, `sha256` and `size`, fetched from
`https://dl-cdn.alpinelinux.org/alpine/v3.24/<repo>/aarch64/<name>-<version>.apk`.
The first lock uses the versions the spike ran (sha256 of the `.apk` file):

| Package | Version | sha256 |
|---|---|---|
| linux-virt | 6.18.54-r0 | `9a4a6fa042b60b70f453dded99762810516b35793c64d776d75986b0b110b6e0` |
| docker-engine | 29.5.3-r1 | `03aa8eedb196b41b6fe70663f910c71b2620ce68fa1eee6d6e4517daf1bf734c` |
| containerd | 2.3.6-r0 | `ecab78ddbe9851666f0a83b677a845ff029c282d810e37eb871cd99bf16b66d6` |
| runc | 1.4.3-r1 | `79dff71ca3b63ce2516b803f0405beb403ecdbd324028bca2d3d57b7f17283ef` |
| tini-static | 0.19.0-r3 | `1cab1e98b70661fb92f53309f2dd7c2526c615eca9a1f57badc86b66f90607bc` |
| iptables | 1.8.13-r0 | `9d22aef2e74346e9d537f6dc964786ab14b35580e3ccc0e4001dc3a725e8fe77` |
| nftables | 1.1.6-r1 | `e350dc0ae7667486f925a6719add6df562055799baf0e402077ef2b11839ac9e` |
| busybox-static | 1.37.0-r31 | `965777e06b94bf11981d5f4ecdfcd577879f4b0dda544294d1dd3f72b217bc75` |
| e2fsprogs | 1.47.4-r0 | `52fd401e79ce6b0ff7648733ba4de3135083cd0132543534e72106e7ea767a00` |
| erofs-utils (build VM only) | 1.9.1-r0 | `327e99ccadd7523bd00018e87f437b7f7a27eb6dbd2b5f9cdf0d3e794061136f` |
| musl | 1.2.6-r2 | `5e9674b7f41152fe2119093b5cb4c13eaaadb19c2d5422b2d7267913e663ee6e` |

The dependency closure (`libseccomp`, `libmnl`, `libnftnl`, `libxtables`,
`libcrypto3`, `lz4-libs`, `zlib`, `libuuid`, `libblkid`, `libcom_err`,
`e2fsprogs-libs`, `libeconf`, `ca-certificates`, and so on) is resolved from
`APKINDEX` by `fetch.mjs --update-lock` and pinned the same way. `iproute2` is
added for the self-test. The x86-64 self-test binary comes from the x86_64
`busybox-static` of the same release.

`--update-lock` verifies the `APKINDEX.tar.gz` signature with Alpine's public
keys, which are checked in under `scripts/guest/keys/`. A normal build checks
only the file hashes. The Go toolchain is pinned by `toolchain` in `guest/go.mod`.

### 4.3 Build: `npm run build:guest` → `build/guest/`

It runs on macOS 14+ on Apple silicon, with no Docker and no root, and
outside any localmost job: a job's seatbelt profile grants no
`file-issue-extension`, so VZ shares cannot work inside one, and hosted CI
runners have no nested virtualization (R28). In practice it runs on the
owner's Mac, as a step of `docs/release-checklist.md`. It needs Node, Go (for
the `guest/` module) and Xcode's `swiftc`. Its output is cached
under a hash of the lock file, `guest/`, `scripts/guest/` and the kernel config
check.

1. `fetch.mjs`: download to `build/guest-cache/apks/` and check each sha256.
2. `unzboot.mjs`: read `vmlinuz-virt` from the linux-virt apk *in memory*. The
   PE file has magic `zimg` at offset 4, the payload offset (u32 LE) at 8, the
   size at 12, and the compression name at 24 (it must be `gzip`). Gunzip the
   payload and check for the arm64 magic `ARMd` at 0x38. Write `vmlinux`.
   *Verified.*
3. `check-config.sh` (pinned from moby v29.5.3 `contrib/`) against the apk's
   `config-*`. The build fails on a missing "generally necessary" item.
4. `go build` for `lm-init`, `lm-agent`, `lm-runc` and `lm-bindpin` with
   `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w -buildid='`.
   *Verified:* a static Go guest binary built this way ran in the guest.
5. `compose.mjs`: from the apk *data tars read in memory* and never extracted
   onto the Mac's filesystem, build `rootfs.tar`. The Mac's volume is
   case-insensitive and would merge files: *verified*, 13 name pairs in
   `linux-virt` and `iptables` alone. The tar holds:
   - the packages;
   - the module closure (§5.2), stored uncompressed, with `modules.dep` and its
     siblings rewritten from `.ko.gz` to `.ko`;
   - the localmost binaries, `daemon.json` and `resolv.conf`;
   - the `/var/run` link and the empty directories.

   Every entry has uid and gid 0, mtime 0, and sorted order. `compose.mjs` also
   writes `initramfs.cpio.gz` (newc, sorted, mtime 0, gzip mtime 0) and the
   build VM's own initramfs: busybox-static, the erofs-utils and e2fsprogs
   closure, the virtiofs, virtio_blk, erofs, loop and ext4 modules, and
   `build-init`. *Verified:* both newc archives are reproducible.
6. **Build VM.** `build/guest-tools/vzrun` is compiled from
   `scripts/guest/vzrun.swift` with `swiftc -O` and ad-hoc signed with
   `entitlements.virtualization.plist`. It boots `vmlinux` plus the build
   initramfs, with the directory holding `rootfs.tar` shared read-only as tag
   `share` and an output directory as tag `out`. The guest runs
   `mkfs.erofs -zlz4hc --all-root -T0 -U 00000000-0000-0000-0000-000000000001 --tar=f /out/rootfs.erofs /in/rootfs.tar`,
   then powers off. *Verified:* 0.3 s for a small root and 5.3 s for the full
   one. The image mounted and its binaries ran. Two builds were byte-identical.
7. **Smoke boot.** `vzrun` boots the result with a scratch data disk in refresh
   mode. It checks `hello` and `configure`, and records `baseline` and `docker`
   from the daemon. With `--vsock-unix 1025:<path>` and `--vsock-unix
   2375:<path>`, `vzrun` exposes guest ports as unix sockets, like the helper
   does. It is also the development harness for the guest.
8. Write `manifest.json` with the sha256 and size of each artifact, and write
   `LICENSES.md`.

## 5. Electron side

### 5.1 Modules and their boundaries

| File | Status | Owns |
|---|---|---|
| `src/main/docker/docker-backend.ts` | rewritten | The `DockerBackend` and `WorkerDocker` interfaces (below). `DesktopBackend` is deleted. Until then it implements `LegacyDockerBackend`, the stage 1 interface under a new name, which goes with it. |
| `src/main/vm/vm-backend.ts` | new | `VmBackend implements DockerBackend`: `name = 'vm'`, `supportsPrivileged = false` (privileged stays refused, owner decision 2), `disposable = true`. `workspaceMountRoot` is the same as today's. |
| `src/main/vm/vm-manager.ts` | new | Admission gate, boot, readiness, stop, `sweep()`, `onResume()`, `shutdownAll()`, the spare. |
| `src/main/vm/helper-client.ts` | new | Spawn through `sandbox-exec`, NDJSON framing, the events and commands of §2.4, exit mapping. |
| `src/main/vm/helper-profile.ts` | new | `buildHelperProfile()` (§2.5). |
| `src/main/vm/agent-client.ts` | new | §3.4 over `agent.sock`, with schema validation of every answer. |
| `src/main/vm/guest-image.ts` | new | Locate `<resources>/guest`, read `manifest.json`, check the artifact hashes once per launch. |
| `src/main/vm/cache-disks.ts` | new | §6.5. |
| `src/main/vm/types.ts` | new | Declarations only: `VmRequest`, `VmState`, `VmHandle`, `VmError`, `VmManager` (below), `AgentClient` (§3.4, below), `ImagePuller` (§6.4), `CacheDisks` and `StartRefreshVm` (§6.5). The implementations import them from here, so that no two of them import each other. |
| `src/main/vm/paths.ts` | new | Every path in §1, each built only from an id checked against its §1 form (a malformed one throws): `vmDir()`, `vmJobFiles()`, `imageStoreDir()`, `refsJsonPath()`, `cacheFiles()`, `sandboxDirOf()` and `sandboxFiles()`, which take `<data>` as an argument, already realpathed by the caller (`sandboxFiles(<data>, sandboxId)` is built on `sandboxDirOf()`, never from a directory the caller hands over, because the share is what the helper profile grants). Also the §1 regexes, `repoKeyOf()`, `newVmId(slot)`, `vmIdSlot()`, `digestHex()` (§6.3), `blobPath()` (§6.3, with its second layer `placeBlob()` exported only for its test), `getVmResourcesDir()` (§1), `guestDir()`, `helperPath()` (with the `LOCALMOST_VM_HELPER` rule of §7.3) and `dockerCliPath()`. |
| `src/main/resource-monitor/memory-pressure-monitor.ts` | new | Polls `sysctl -n kern.memorystatus_vm_pressure_level` every 5 s with async `execFile` (1 → `normal`, 2 → `warn`, 4 → `critical`; anything else → `warn`), and calls `vmManager.onMemoryPressure(level)` on a change. |
| `src/main/docker/puller/registry-client.ts` | new | Registry v2 client: token auth, manifests, blobs, redirects, screened DNS. |
| `src/main/docker/puller/image-store.ts` | new | The per-repository blob store and `refs.json`. |
| `src/main/docker/puller/docker-archive.ts` | new | The `docker save`-shaped tar stream for `POST /images/load`. |
| `src/main/docker/puller/image-puller.ts` | new | `ImagePuller` (§6.4). |
| `src/main/docker/registry-auth.ts` | changed | Adds `resolveRegistryCredentials(registry): Promise<RegistryCredentials \| undefined>` for the puller, where `RegistryCredentials` is `{ kind: 'basic', username, password }` or `{ kind: 'identity-token', token }`. The sync `resolveRegistryAuth` (the X-Registry-Auth header `DesktopBackend`'s filter attaches) keeps its behaviour so `index.ts` compiles unchanged; WP-E deletes it with its wiring and its tests. The new function is async. It looks helpers up only in `/opt/homebrew/bin`, `/usr/local/bin` and `/Applications/Docker.app/Contents/Resources/bin`, never `PATH`, and runs them with async `execFile` (10 s timeout). Throws `RegistryAuthError` when a configured helper is missing or fails other than "not found", with the design's message naming the helper and the config key (`credsStore` or `credHelpers.<registry>`). |
| `src/main/docker/docker-filter-proxy.ts` | changed | §5.3. |
| `src/main/docker/docker-evaluator.ts` | changed | Parses and normalises bind destinations from `Binds` and `Mounts` (§3.7 "Bind matching"; today `MountRequest` has only `source` and `mode`), refuses a relative or duplicate destination, and returns `approvedBinds` on an allowed create. |
| `src/shared/docker-policy.ts` | changed | `UNFILTERED_EGRESS` becomes `PROXIED_EGRESS` = `egress through this job's proxy, subject to its network allowlist`. `hasDockerGrants(policy)` is exported. The approval text for `pull.registries` adds `and fetching from wherever that registry redirects (any public https host)`. The `privileged: true` refusal no longer says "this build does not have a managed VM backend"; it says `privileged containers are not granted: they reach the Docker VM's kernel`. |
| `src/shared/docker-access.ts` and its tests | deleted | Only `DesktopBackend` used `resolveDockerEndpoint`. |
| `src/main/runner-downloader.ts` | changed | `buildSandbox` makes `<sandbox>/_work` and `<sandbox>/.docker` (§1). `writeShareNonce(sandboxDir): string` writes the nonce with `wx`. |
| `src/main/process-sandbox.ts` | changed | The `shareDir` and `dockerCli` options (§5.5). |
| `src/main/runner-manager.ts` | changed | §5.4. |
| `src/main/config.ts` | changed | `dockerVm` (§5.6). |
| `src/main/index.ts` | changed | Build `VmBackend` and `VmManager`. `sweep()` before the pool starts, `shutdownAll()` on quit, `onResume()` on `powerMonitor` `resume`. |
| `src/main/auto-updater.ts` | changed | `autoDownload = true`. |

```ts
// src/main/docker/docker-backend.ts
export interface DockerBackend {
  readonly name: string;
  readonly supportsPrivileged: boolean;
  /** True when the daemon is thrown away with the worker, so no removal sweep is needed. */
  readonly disposable: boolean;
  workspaceMountRoot(sandboxDir: string, repository?: string): string;
  forWorker(ctx: WorkerContext): WorkerDocker;
}

export interface WorkerContext {
  slot: number;
  /** As buildSandbox made it. The backend realpaths it once, at construction. */
  sandboxDir: string;
  sandboxId: string;
  /** Written by writeShareNonce before the worker started. */
  shareNonce: string;
  /** The repository the worker was spawned for, if any (for the spare). */
  spawnRepository?: string;
  /** The worker's ProxyServer, read when needed: its port and its token-bearing URL. */
  proxy(): { port: number; url: string };
  log(entry: { level: 'debug' | 'info' | 'warn'; message: string }): void;
}

export type EndpointState = { kind: 'ready'; socketPath: string } | { kind: 'none'; reason: string };

/** Normalised as in §3.7 "Bind matching": source byte-exact, destination cleaned. */
export interface ApprovedBind { source: string; destination: string; readOnly: boolean }

export interface DockerProgress {
  status?: string; id?: string; progress?: string;
  progressDetail?: { current?: number; total?: number };
  error?: string; errorDetail?: { message: string };
}

export interface PullRequest {
  registry: string;             // e.g. docker.io
  repositoryPath: string;       // e.g. library/alpine
  tag?: string; digest?: string;
  platform?: string;            // the request's ?platform=, if any
}

export interface WorkerDocker {
  /**
   * At the claim, with the bound policy. Idempotent: runner-manager calls it
   * at least twice per job (onJobAcquired, then the "Running job" line), and
   * possibly on a previous spawn's socket that is still stopping.
   *  - The first bind with hasDockerGrants(policy), while no VM exists and
   *    release() has not been called: adopts the spare if it was booted for
   *    this repository, otherwise stops the spare and boots a VM.
   *  - Any later bind for the same repository: replaces the policy only and
   *    never boots.
   *  - A later bind without grants: replaces the policy (the filter then
   *    refuses everything but the baseline) and leaves a running VM alone.
   *  - A bind for a different repository than the VM was booted for: stops
   *    the VM and never boots another; the socket stays closed, as today.
   *  - Any bind after release() has started: records nothing, boots nothing.
   */
  bind(repository: string, policy: DockerPolicy): void;
  /** When the worker is spawned and dockerVm.prewarm is on. */
  prewarm(): void;
  /** The VM's docker.sock once ready. Waits while it boots, up to timeoutMs. */
  endpoint(timeoutMs: number): Promise<EndpointState>;
  /** A VM is ready right now: the baseline is forwarded, not synthesised. */
  running(): boolean;
  /** The synthesised answers of §5.3 "Baseline". */
  baseline(path: '/_ping' | '/version' | '/info'): { status: number; headers: Record<string, string>; body: unknown };
  pull(req: PullRequest, onProgress: (p: DockerProgress) => void, signal: AbortSignal): Promise<void>;
  approveBinds(containerId: string, binds: ApprovedBind[]): Promise<void>;
  /** HTTP(S)_PROXY, http(s)_proxy and NO_PROXY for routable containers and builds; {} when no VM. */
  containerProxyEnv(): Record<string, string>;
  /** Worker exit: stop the VM, delete its directory, schedule a cache refresh. Idempotent. */
  release(): Promise<void>;
}
```

```ts
// src/main/vm/types.ts (VmManager is implemented in vm-manager.ts)
export interface VmRequest {
  mode: 'job' | 'refresh';
  /** 1–99 for a job; 0 for a refresh. Refreshes queue behind every job boot at the admission gate. */
  slot: number;
  sandboxId?: string; shareRealPath?: string; shareNonce?: string;   // job
  repository: string; repoKey: string;
  proxyPort?: number;                                                // job
}
export type VmState = 'queued' | 'booting' | 'ready' | 'stopping' | 'stopped' | 'failed';
export interface VmHandle {
  readonly vmId: string;
  readonly dockerSocketPath: string;
  state(): VmState;
  /** Resolves on configure success; rejects with a VmError. */
  ready(): Promise<{ docker: { version: string; apiVersion: string }; rosetta: 'ok' | 'absent' | 'broken'; bootMs: number }>;
  agent(): AgentClient;
  stop(reason: string): Promise<void>;
}
export interface VmManager {
  sweep(): Promise<void>;
  start(req: VmRequest): VmHandle;       // admission-gated; never blocks the caller
  onResume(): void;
  onMemoryPressure(level: 'normal' | 'warn' | 'critical'): void;
  shutdownAll(): Promise<void>;
}
/** An Error naming where the VM failed; `code` is a §2.4 or §3.4 code, or VmManager's own. */
export interface VmError extends Error {
  stage: 'admission' | 'disk' | 'helper' | 'agent' | 'configure' | 'nonce' | 'running';
  code: string;
}
```

```ts
// src/main/vm/types.ts: §3.4 over agent.sock. Every answer is schema-checked
// and bounded before it is returned; a refusal rejects with the agent's code.
export interface AgentClient {
  hello(): Promise<{ agent: string; guestVersion: string; kernel: string; agentProtocol: 1 }>;
  configure(req: AgentConfigureRequest): Promise<AgentConfigureResult>;   // the §3.4 fields
  approveBinds(container: string, binds: ApprovedBind[]): Promise<void>;
  setTime(unixMs: number): Promise<void>;
  status(): Promise<{ dockerd: 'running' | 'exited'; uptimeMs: number }>;
  shutdown(): Promise<void>;
  close(): void;
}
```

### 5.2 Guest module set

The roots are `virtiofs`, `vmw_vsock_virtio_transport`, `virtio_blk`,
`virtio-rng`, `ext4`, `erofs`, `overlay`, `br_netfilter`, `veth`, `dummy`,
`nf_tables`, `nft_compat`, `nft_chain_nat`, `xt_addrtype`, `xt_conntrack`,
`xt_MASQUERADE`, `xt_nat`, `xt_mark`, `ipt_REJECT`, `iptable_filter`,
`iptable_nat` and `binfmt_misc`. The build takes their closure through
`modules.dep`, and `manifest.modules` records the final list. WP-A adds a root
only when `dockerd` or `check-config.sh` shows it is needed. It is an
allowlist. Because `lm-init` sets `kernel.modules_disabled=1` once these are
loaded (§3.2), anything `dockerd` or `iptables` would load on demand must be
in the list: WP-A's acceptance exercises every Docker feature the filter
permits (bridge and internal networks, embedded DNS, published-port refusal,
builds) with loading disabled, and adds a root for each `modprobe` failure in
`dmesg`.

### 5.3 Filter changes (`DockerFilterProxy`)

- **Options.** `backend: DockerBackend` stays. Add `worker: WorkerDocker`.
  Remove `attachRegistryAuth`.
- **`bind()`** calls `worker.bind()` after recording the policy.
- **Endpoint.** Every use of `backend.resolveEndpoint()` becomes
  `await worker.endpoint(bootTimeoutMs)`. If it answers `none`, the request
  gets 503 with the reason, and the first such answer is also logged at warn.
- **Baseline.** When `!worker.running()`, `/_ping`, `/version` and `/info` are
  answered from `worker.baseline()`. Otherwise they are forwarded, and `/info`
  is rewritten as today. The synthesised answers, from the guest manifest
  (§4.1), with `<api>` = `min(manifest.docker.apiVersion, maxApiVersion)`, the
  same clamping the forwarded path applies:
  - `GET` and `HEAD /_ping`: `200`, body `OK` (empty for `HEAD`), headers
    `Api-Version: <api>`, `Ostype: linux`, `Docker-Experimental: false`,
    `Builder-Version: 1`, `Cache-Control: no-cache, no-store, must-revalidate`,
    `Pragma: no-cache`, `Content-Type: text/plain; charset=utf-8`. Never
    `Builder-Version: 2`, which would steer the CLI to BuildKit.
  - `GET /version`: `200`, `application/json`, the same `Api-Version`,
    `Ostype` and `Docker-Experimental` headers, and exactly these body
    fields: `Version` = `docker.engine`, `ApiVersion` = `<api>`,
    `MinAPIVersion` = `docker.minApiVersion`, `Os` = `linux`, `Arch` =
    `arm64`, `KernelVersion` = `baseline.KernelVersion`, `Experimental` =
    `false`, and `Components: [{ "Name": "Engine", "Version": docker.engine }]`.
    No `GitCommit`, `GoVersion` or `BuildTime`.
  - `GET /info`: `200`, `application/json`, `manifest.baseline` exactly, plus
    the counts the filter's rewrite sets to zero today.

  A filter test compares each synthesised answer, field by field, with the
  forwarded and rewritten answer from a VM booted from the same manifest (a
  recorded fixture from WP-A's smoke boot).
- **Daemon answers are hostile input.** With guest root (a kernel bug, or
  `privileged` if it is ever granted), `dockerd`'s answers are the job's to
  choose, and Electron main is shared by every job. Every daemon answer the
  filter or the puller buffers to parse is capped at `MAX_JSON_BODY_BYTES`
  (1 MiB), as `/info` already is: the create answer (`relayCreate`), the
  network-create answer, the inspect answers, the puller's `/images/…/json`
  probe, and the load and tag answers. Over the cap, the connection is
  destroyed and the job gets 502 `the Docker VM sent an oversized answer`.
  Streams that are not parsed (logs, attach, the load progress) are piped,
  never buffered. Parsed answers are schema-checked like agent answers.
- **Credentials of any kind never enter the VM.** `X-Registry-Auth` and
  `X-Registry-Config` are stripped from every forwarded request, `/build`
  included (`forwardedHeaders` already does this; a test keeps it). `POST
  /auth` is not in the endpoint allowlist and stays refused, and so do the
  checkpoint endpoints (a test asserts both).
- **Pull.** An allowed `POST /images/create` with `fromImage` is never
  forwarded. The filter answers `200 application/json` and streams
  `worker.pull()` progress, one JSON object per line. A failure after the
  headers is sent as `{"errorDetail":{"message":…},"error":…}`. A job's own
  `X-Registry-Auth` header is dropped.
- **Create.** On an allowed create:
  1. If the network is routable (the default bridge, `bridge`, or a network the
     job created with `internal: false`), merge `worker.containerProxyEnv()`
     into `Config.Env`, keeping any variable the job already set.
  2. Forward the request.
  3. On a 201, parse `Id` (64 hex) from an answer capped at
     `MAX_JSON_BODY_BYTES` and `await worker.approveBinds(Id, verdict.approvedBinds)`.
     Only then record the container (id and name) as the job's own, and send
     the answer to the job. A start by name that arrives earlier (the job
     chose the name, so it need not wait for the answer) is refused by the
     filter, because the container is not yet the job's own. The security
     argument still rests on `lm-bindpin` failing closed, not on this
     ordering.
  4. If the approval fails, `DELETE /containers/<Id>?force=1` and answer 500:
     `could not register the approved binds with the job's Docker VM`.
- **Build.** Merge `worker.containerProxyEnv()` into the `buildargs` query
  (URL-encoded JSON), keeping the job's values. On a build failure whose stream
  names a registry host lookup, log the base-image rule once.
- **Stop.** Skip `removeOwned()` when `backend.disposable`, then call
  `await worker.release()`.
- **Log lines** that the e2e suite matches:
  - `pulled <ref> (<manifest digest>, <platform>) on the Mac; loaded into VM <vmId>`
  - `... ; already in VM <vmId>`
  - `forwarded <METHOD> <path>` (unchanged)
  - `denied …` / `refused …` (unchanged)

### 5.4 runner-manager lifecycle hooks

| When | Call |
|---|---|
| `startInstance`, after `buildSandbox` | `shareNonce = writeShareNonce(sandboxDir)`, stored on the instance. |
| `startDockerProxy` | `new DockerFilterProxy({ backend, worker: backend.forWorker({ slot, sandboxDir, sandboxId, shareNonce, spawnRepository, proxy, log }), … })`. Then, if `config.dockerVm.prewarm`, `worker.prewarm()`. |
| Job env | Keep `DOCKER_HOST` and `DOCKER_BUILDKIT=0`. Add `DOCKER_CONFIG=<sandbox>/.docker`, an empty directory made by `buildSandbox`, so the CLI reads no operator config. Prepend `dirname(<docker-cli>)` to `PATH`. |
| Profile | `spawnSandboxed(…, { shareDir: <sandbox>/_work, dockerCli: <docker-cli> })` |
| `bindDockerSocket` (the claim) | Unchanged. `socket.bind()` now calls `worker.bind()`, which boots only on the first bind with grants (§5.1). It is reached from `onJobAcquired` → `applyPolicyForTarget` and again from `applyRepoPolicy` at the "Running job" line; `startInstance` can also reach a previous spawn's socket while its un-awaited `stopDockerProxy` is still running. vm-backend tests cover a double bind and a bind while stopping. |
| `stopDockerProxy` (worker exit, reap, app stop) | Unchanged. `socket.stop()` now releases the VM. |
| App start (`index.ts`) | `await vmManager.sweep()` before the pool's first spawn. |
| App quit | `await vmManager.shutdownAll()`: every helper is stopped with `graceMs: 0` and awaited, 10 s at most. |
| `powerMonitor` `resume` | `vmManager.onResume()`: `set-time` to every ready VM; the spare is stopped. |
| Memory pressure (`memory-pressure-monitor.ts`, §5.1) | `vmManager.onMemoryPressure(level)`: at `warn`+, no spare and no refresh starts; at `critical`, new boots are queued. |

### 5.5 Job profile additions (`process-sandbox.ts`)

After `(allow file-read* file-write* (subpath "<sandbox>"))` and the docker
socket rules:

```scheme
;; The Docker VM's share and the sandbox around it, as nodes: the job cannot
;; rename, replace, chmod or relink either (VZ resolves the share at start).
(deny file-write* (literal "<sandbox>/_work") (literal "<sandbox>"))
;; The share's tripwire nonce: neither readable nor writable by the job, so a
;; match in the guest proves VZ shared the directory localmost made.
(deny file-read* file-write* (literal "<sandbox>/_work/.localmost-share"))
;; The bundled docker CLI, and nothing else of the app bundle.
(allow file-read* (literal "<docker-cli>") (literal "<dirname of docker-cli>"))
```

All three denies are new in `process-sandbox.ts`, which today re-allows the
whole sandbox subtree, its own node included. (The `localmost test` profile
in `src/shared/sandbox-profile.ts` already denies its workspace node the
same way.) The sandbox test checks them in the constructed and ambient modes,
including `mv _WORK x`, `mv ../<SANDBOX in other case> x` and
`renamex_np(RENAME_SWAP)`.

`<data>/vm` needs no rule. It is inside `<data>`, which is already denied in full.

### 5.6 Configuration (`config.yaml`)

```yaml
dockerVm:
  prewarm: false        # boot one spare VM for the next spawned worker (memory for latency)
  cpus: 4               # per VM; default min(4, physical cores)
  memoryMiB: 8192       # per VM; committed lazily, returned only when the VM stops
  maxRunning: 0         # 0 = auto: max(1, floor(physical RAM GiB / 8))
  dataDiskGiB: 64       # most a VM's data disk may be; less when free space is short (below)
  bootTimeoutSec: 60    # how long a docker request waits for the job's VM
  cacheLimitGiB: 20     # per repository: golden disk and image store, LRU at refresh
  pullMaxGiB: 10        # compressed bytes one pull may fetch
  jobPullMaxGiB: 30     # compressed bytes all of one job's pulls may fetch
  minFreeGiB: 20        # free space on <data>'s volume under which boots and pulls are refused
```

A new data disk's apparent size is `min(dataDiskGiB, free − minFreeGiB −
headroom already promised to running VMs)`, where a running VM's promised
headroom is its apparent size minus what it has allocated. Below 8 GiB the
boot is refused with 503 `not enough free disk for a Docker VM`. `VmManager`
checks free space every 10 s while VMs run; under `minFreeGiB / 2` it stops the
VM whose disk grew most, with the reason `host disk nearly full`.

All of these are optional. Out-of-range values are clamped and logged. No
setting enables a fallback daemon.

## 6. Puller and cache

### 6.1 Registry client

It uses Node `https` with the `lookup` screening that `ProxyServer` already
applies (`egress-screen.ts`), so a registry name that resolves to a loopback,
link-local or private address is refused, and so is plain `http:` (the
design's "Registries on the LAN, loopback or plain HTTP"). `docker.io` maps to
`registry-1.docker.io`, with `library/` for single-name images. The
`Accept` header lists OCI index and manifest types and Docker manifest-list
and schema2 types. Schema1 is refused. Auth is the
`WWW-Authenticate: Bearer realm=…,service=…,scope=…` token exchange, using
basic credentials from `resolveRegistryCredentials` when there are any, under the
rules below.

**Redirects.** Followed (CDN blob hosts) only to `https:` URLs, at most 5
hops, each hop screened. Electron main follows them, so any registry in
`pull.registries` can send Electron to any public https host, outside the
job's `network.allow`; the approval text and `SECURITY.md` say so.

**Where credentials go.**

- The registry's origin is the scheme, host and port of its API endpoint
  (`https://registry-1.docker.io` for `docker.io`). An `Authorization` header,
  bearer or basic, is sent only on a request to that origin that is not a
  redirect hop. Every redirect hop is sent with no `Authorization` and no
  cookies, whatever its origin.
- The token realm comes from the registry's `WWW-Authenticate` challenge, so
  the registry chooses it. It must be `https:`, and its host must pass the
  same screening. Otherwise the pull fails (`the registry's token service
  <realm> is not a public https URL`). Basic credentials from
  `resolveRegistryCredentials` are sent only to a realm that passed, only in the
  token request, and never on a redirect of it.
- The bearer token from the realm is sent only to the registry's origin.

**Foreign and non-distributable layers.** A descriptor with a `urls` field, or
with media type `application/vnd.docker.image.rootfs.foreign.diff.tar.gzip`
or `application/vnd.oci.image.layer.nondistributable.*`, is refused before
anything is fetched (`image layer <digest> must be fetched from a URL the
image names, which localmost does not do`). Electron never fetches a URL an
image names.

### 6.2 Platform choice

For an index, choose `linux/arm64` (any variant, `v8` first). If there is none,
or the request asks for `linux/amd64`, choose `linux/amd64`. If that choice
needs Rosetta and the VM's Rosetta is not `ok`, fail with the design's message.
A single-platform manifest is used as it is. Its config's `architecture` must
be `arm64` or `amd64`, and the same Rosetta rule applies.

### 6.3 Verification and store

**Digests are validated before any use.** The registry, and anyone who can
publish an image on an allowed registry such as docker.io, chooses every
digest the puller sees: manifest, config, layer and index-entry descriptor
digests, the config's `diff_ids`, a pull-by-digest reference, and the
`Docker-Content-Digest` header. Store paths are built from digests, and a
failed blob is deleted, so an unchecked digest such as `sha256:../../..`
would give Electron main, running with the user's full rights, a path
traversal read and delete. So:

- Every digest from a registry, from the VM (image ids in `/images/…/json`
  and load answers) or from `refs.json` must match `^sha256:[0-9a-f]{64}$`
  before it is used for anything. Any other algorithm (`sha512:` included) or
  form is refused: `the registry sent a malformed digest for <ref>`.
- Store paths are built only from the validated 64-hex part, by one function
  (`blobPath(storeRoot, hex)`) that re-checks the hex and asserts the result
  is a direct child of `<storeRoot>/blobs/sha256` named exactly `<hex>`. "Under
  the store root" would not be enough: a per-job store's root is the VM's
  directory, beside `helper.sb` and `data.img`.
- A manifest is identified by the SHA-256 of the raw bytes fetched, never by
  `Docker-Content-Digest`. The header is at most a hint for the `HEAD`
  comparison in §6.4 step 1; a manifest that is used is always hashed, and a
  pull by digest requires that hash to equal the requested digest.
- The image-store and registry-client tests include traversal-shaped and
  wrong-algorithm digests in every position above.

**Size limits, enforced while bytes stream.** Compressed bytes fetched by one
pull are capped at `pullMaxGiB`, and by all of a job's pulls at
`jobPullMaxGiB`. A descriptor whose declared `size` exceeds what is left is
refused before the fetch, and a blob that streams past its declared `size`
is cut off and refused. A layer's decompressed bytes may not exceed 64 MiB
plus 100 times its compressed size, nor `pullMaxGiB` × 4. Before a pull, and
every 256 MiB during it, free space on `<data>`'s volume must stay above
`minFreeGiB`. Each limit fails the pull with a message naming the limit and
the config key.

**Store.** Each blob is streamed to `blobs/sha256/.tmp-<random>` while its
SHA-256 is computed. It is renamed into place only if the digest matches the
descriptor. Each layer is decompressed (gzip, or zstd through Node's
`zlib.zstdDecompress`, which needs Node 22.15 or later; Electron 43's Node is
24.18), and its uncompressed SHA-256 must equal the config's validated
`diff_ids[i]`. `refs.json` maps `<registry>/<path>:<tag>` and `@<digest>` to
`{ manifestDigest, configDigest, platform, lastPulled }`, and every value read
back from it is validated as above. Reading a blob checks its digest again. A
blob that fails is deleted, by its validated path, and fetched again. The
store and the golden disk share `cacheLimitGiB`. When they exceed it, the
least recently pulled references are dropped at the next refresh.

**Which store.** After the blobs verify, the puller asks the registry
anonymously for the same manifest digest (a token exchange with no
credentials, then a `HEAD`). If the registry serves it, the image is public:
its blobs go to `<data>/vm/images/<repoKey>` and it becomes eligible for the
golden disk. If not, its blobs go to `<data>/vm/jobs/<vmId>/blobs` and are
deleted with the VM, and `notePulled` is not called. (This is option (a) of
the design's owner decision 1; option (b) would key the store by policy hash
instead.)

### 6.4 `ImagePuller`

```ts
// src/main/vm/types.ts
export interface ImagePuller {
  pull(opts: {
    repository: string;                      // owner/name: the cache key
    request: PullRequest;
    rosetta: 'ok' | 'absent' | 'broken';
    dockerSocketPath: string;                // the VM's
    onProgress(p: DockerProgress): void;
    signal: AbortSignal;
  }): Promise<{ manifestDigest: string; configDigest: string; platform: string; source: 'registry' | 'store' | 'vm' }>;
}
```

The steps:

1. Resolve the tag with a manifest `HEAD`. If `Docker-Content-Digest`
   (validated) equals the manifest digest `refs.json` holds for this tag and
   platform, and that manifest is in the store (re-hashed on read), use it.
   Otherwise `GET` the manifest (or the index, then the chosen platform's
   manifest) and hash the raw bytes (§6.3). Parse the config descriptor.
2. `GET /images/sha256:<configDigest>/json` on the VM, with the answer capped
   (§5.3). If it answers 200 and its `Id` equals `sha256:<configDigest>`, skip
   to step 5 (`source: 'vm'`, a cache-disk hit). The image id equals the
   config digest (*verified*), so this works for an image loaded with
   `RepoTags: null`, for which the classic store records no repo digest. A
   check by `<name>@<manifestDigest>` would never hit.
3. Fetch any blobs that are missing from the store (`source: 'registry'`, or
   `'store'` if all were present).
4. `POST /images/load` a tar holding `oci-layout`, `index.json` (annotation
   `io.containerd.image.name` = `<registry>/<path>@<manifestDigest>`),
   `manifest.json` (`RepoTags: null`), `blobs/sha256/<config>` and the
   *uncompressed* layer tars. *Verified:* a Mac-built archive of this shape
   loaded, and the image id equalled the config digest.
5. `POST /images/sha256:<configDigest>/tag?repo=<registry>/<path>&tag=<tag>`.
6. For a public image only (§6.3 "Which store"): `cacheDisks.notePulled(repoKey, configDigest)`.

The load and tag answers are capped and schema-checked like every daemon
answer (§5.3).

### 6.5 `CacheDisks`

```ts
// src/main/vm/types.ts
export interface CacheDisks {
  /** A clone of the golden disk (clonefile), or a new sparse file when there is none. */
  prepareJobDisk(repoKey: string, dest: string, sizeGiB: number): Promise<'clone' | 'blank'>;
  notePulled(repoKey: string, configDigest: string): void;
  /** Debounced 60 s, one at a time per repository, skipped on battery or memory pressure. */
  scheduleRefresh(repoKey: string): void;
  discard(repoKey: string, reason: 'corrupt' | 'dataFormat' | 'limit'): Promise<void>;
}

/** Injected into CacheDisks, so that it does not import VmManager (WP-D builds against a fake). */
export type StartRefreshVm = (req: { repository: string; repoKey: string }) => VmHandle;
```

`CacheDisks` is constructed with a `StartRefreshVm` function. `index.ts`
passes one that calls `vmManager.start({ mode: 'refresh', slot: 0, … })`.

A refresh does four things:

1. Choose incremental or full. It is **full** (a new blank `data.img.new`)
   when there is no golden disk, when `meta.json`'s `guestVersion` differs
   from the manifest's, when the golden disk was last built from blank more
   than 7 days ago, or when the previous refresh of this repository failed.
   Otherwise it is **incremental**: clone `data.img` to `data.img.new`.
2. Start a refresh-mode VM on it through `StartRefreshVm` (slot 0, the
   admission gate's lowest priority). Load, through `docker.sock`, every
   public reference in `refs.json` within the limit whose config digest is
   not already in `meta.json` (incremental), or every one (full), streaming
   each archive from the store.
3. `DELETE` every image whose id is not a config digest from that list, and
   `shutdown`.
4. On `stopped` with `synced: true`, rename `data.img.new` over `data.img` and
   update `meta.json` (`dataFormat`, `guestVersion`, the config digests held,
   when it was last built from blank, the last refresh). On any failure,
   delete `data.img.new` and record the failure, so that the next refresh is
   full.

## 7. Signing and packaging

### 7.1 Entitlements

`packaging/entitlements.virtualization.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!--
    The VM helper in Resources, localmost-vm: it runs one Linux VM per job
    through Virtualization.framework, under a seatbelt profile of its own.
    Only this. No JIT, no library-validation exemption.
  -->
  <key>com.apple.security.virtualization</key>
  <true/>
</dict>
</plist>
```

### 7.2 `forge.config.js`

```js
const VM_HELPER = path.join(__dirname, 'build', 'localmost-vm');   // -> Resources/localmost-vm
const GUEST_DIR = path.join(__dirname, 'build', 'guest');          // -> Resources/guest/
const DOCKER_CLI_DIR = path.join(__dirname, 'build', 'docker-cli'); // -> Resources/docker-cli/docker
// Exactly what Resources/guest may hold; prePackage fails on anything else.
const GUEST_FILES = ['LICENSES.md', 'initramfs.cpio.gz', 'manifest.json', 'rootfs.erofs', 'vmlinux'];

packagerConfig.extraResource.push(VM_HELPER, GUEST_DIR, DOCKER_CLI_DIR);
packagerConfig.extendInfo = { LSMinimumSystemVersion: '14.0' };
// Passed as osxSign's `ignore` inside the existing `if (shouldSign)` block.
// The guest is data for the VM, not macOS code. Without this, osx-sign signs
// every file isbinaryfile flags (vmlinux, the initramfs, the erofs root) and
// gives each an xattr signature carrying the app's entitlements.
const ignoreGuest = (filePath) =>
  filePath.includes(path.join('.app', 'Contents', 'Resources', 'guest') + path.sep);

function signOptionsForFile(filePath) {
  let plist = 'entitlements.plist';
  const inResources = (...p) => filePath.endsWith(path.join('.app', 'Contents', 'Resources', ...p));
  if (filePath.includes('(Plugin).app')) {
    plist = 'entitlements.plugin.plist';
  } else if (inResources(path.basename(CAMERA_HELPER)) || inResources('docker-cli', 'docker')) {
    plist = 'entitlements.none.plist';
  } else if (inResources('localmost-vm')) {
    plist = 'entitlements.virtualization.plist';
  }
  return { hardenedRuntime: true, entitlements: path.join(__dirname, 'packaging', plist) };
}
```

`hooks.generateAssets` runs `npm run build:native`, which is `build:helper`,
`build:guest` and `fetch:docker-cli`, each cached. `hooks.prePackage` fails the
build if `build/guest` holds anything but exactly `GUEST_FILES`, if
`build/guest/manifest.json`'s hashes do not match its files, or if the
helper or CLI is missing. A build never ships without its VM.

### 7.3 Build scripts

- `build:helper`: `swift build -c release --arch arm64 --package-path native/localmost-vm`,
  copied to `build/localmost-vm` (so that development and packaged builds
  both find it at `<resources>/localmost-vm`), then ad-hoc signed with
  `entitlements.virtualization.plist` so that development runs work. osx-sign
  re-signs it when there is an identity.
- `fetch:docker-cli`: `scripts/docker-cli.lock.json` =
  `{ "version": "29.8.1", "url": "https://download.docker.com/mac/static/stable/aarch64/docker-29.8.1.tgz", "sha256": "5a8f5604d7673202b2af925229d15eb4bbb86f7f542e4ac8cd7aa3f14cfa0f8b", "member": "docker/docker" }`
  is fetched, checked, and extracted to `build/docker-cli/docker`. *Verified:*
  hash, member, and that it is a thin arm64 Mach-O that is linker-signed ad hoc.
- Development runs find `<resources>` at the checkout's `build/`
  (`build/localmost-vm`, `build/guest`, `build/docker-cli`), whether Electron
  was launched on the checkout or on `build/dist/main.js` (§1), through
  `getVmResourcesDir()`,
  `helperPath()` and `dockerCliPath()` in `src/main/vm/paths.ts`. The helper
  profile, the spawn and the sweep all use `helperPath()`.
  `LOCALMOST_VM_HELPER` replaces the helper path only when `!app.isPackaged`
  (not on `NODE_ENV`, which a packaged app's environment could set), so that
  tests and development can run the fake helper (§8). A packaged app ignores
  it, and a test asserts that.

### 7.4 Packaging tests (`src/main/packaging.test.ts`)

- `extraResource` includes the helper, `build/guest` and `build/docker-cli`.
- `ignoreGuest` (osxSign's `ignore`) matches `Resources/guest/vmlinux` and nothing outside
  `Resources/guest/`; `prePackage` refuses a `build/guest` with a sixth file.
- `signOptionsForFile` gives the virtualization plist to `Resources/localmost-vm`
  and to nothing else, and gives `none` to `Resources/docker-cli/docker`.
- `entitlements.virtualization.plist` has exactly one key.
- `extendInfo.LSMinimumSystemVersion === '14.0'`, and the usage-description
  test's plist fixture says `14.0`.
- The "ships no entitlements file the signing does not use" test still passes.

## 8. Fakes for parallel work

- **Fake helper** (`test/fakes/fake-localmost-vm.mjs`, owned by WP-C). Unit
  tests run it directly through `HelperClient`'s injected spawn function,
  never through `sandbox-exec` (which fails nested inside a job, does not
  exist on Linux, and whose helper profile would not let it exec `node`). It
  takes the §2.1 argument line and applies the same checks. It emits the §2.4
  events, and exits when its stdin closes, as the real helper does.
  It binds `docker.sock` and `agent.sock`, connects `docker.sock` to
  `FAKE_DOCKERD_SOCKET` (a mock daemon the test runs), and answers agent ops
  from `FAKE_AGENT_SCRIPT`, a JSON map from op to answer or delay. A
  `stop` or SIGTERM exits with the scripted code.
- **Fake agent** (`guest/internal/agenttest`, owned by WP-A). An in-process Go
  implementation of §3.4 that WP-B can run on the Mac behind a unix socket to
  check its splicing.
- **Mock registry** (`src/main/docker/puller/test-registry.ts`, owned by WP-D).
  An HTTP server with `/v2/`, token auth, manifests, blobs and a redirect host,
  plus switches for digest corruption.
