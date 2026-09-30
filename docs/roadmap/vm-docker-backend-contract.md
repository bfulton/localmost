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
| `sandboxId` | `^[0-9]{1,2}-[0-9a-f]{12}$` | `buildSandbox` (already this shape) | The basename of the worker's sandbox directory. |
| `vmId` | `^[0-9]{1,2}-[0-9a-f]{12}$` | `VmManager` (`<slot>-<randomBytes(6) hex>`) | One VM. It is never reused. |
| `repoKey` | `^[0-9a-f]{16}$` | `repoKeyOf(repository)`: first 16 hex of `sha256(lowercase("owner/name"))` | Per-repository store and cache. |
| `<data>` | absolute | `getAppDataDir()` | Normally `~/.localmost`. |
| `<resources>` | absolute | `process.resourcesPath`, or `build/` in development | Where the helper, guest and CLI are found. |

```
<data>/runner/sandbox/<sandboxId>/            made by buildSandbox (existing)
<data>/runner/sandbox/<sandboxId>/_work/      THE SHARE: made by buildSandbox, before any process runs there
<data>/runner/sandbox/<sandboxId>/_work/.localmost-share   32 hex nonce, written O_CREAT|O_EXCL before the worker starts
<data>/runner/sandbox/<sandboxId>/docker.sock the filter socket (existing)
<data>/vm/                                    mode 0700; `tmutil addexclusion` when created
<data>/vm/jobs/<vmId>/                        mode 0700, made by VmManager
    helper.sb  data.img  helper.pid  console.log  docker.sock  agent.sock
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
`<resources>/localmost-vm` and runs exactly one VM per process.

### 2.1 Invocation

Electron main spawns it through `/usr/bin/sandbox-exec -f <data>/vm/jobs/<vmId>/helper.sb`
with an empty environment, except `PATH=/usr/bin:/bin` and `TMPDIR=<data>/vm/jobs/<vmId>`.

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
  `realpath(S) == S`, and that `S` starts with `realpath(<data>/runner/sandbox) + "/"`.
  If any check fails: `E_SHARE`.
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
| `started` | `VZVirtualMachine.start` succeeded | `pid`, `rosetta`: `installed`, `notInstalled`, `notSupported` or `off`, and `startMs` (milliseconds since exec) |
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
(allow process-exec (literal "<resources>/localmost-vm"))
(allow file-read*
  (literal "<resources>/localmost-vm")
  (subpath "<resources>/guest"))
(allow file-read* file-write* (subpath "<data>/vm/jobs/<vmId>"))
;; job mode:
(allow file-read* file-write* (subpath "<S>"))
(allow generic-issue-extension (extension-class "com.apple.virtualization.extension.fuse"))
(allow network-outbound (remote ip "localhost:<proxy-port>"))
;; refresh mode, instead of the three rules above:
(allow file-read* file-write* (subpath "<data>/vm/cache/<repoKey>"))
;; both modes: the helper's own unix sockets
(allow network-bind network-inbound (subpath "<data>/vm/jobs/<vmId>"))
```

*Verified:* a VZ host under this shape of profile boots a guest. A share
outside the `(subpath "<S>")` grant, or a granted path that is a link to
somewhere outside it, fails `start` with EPERM. That second failure is the
second layer of the share rule. Rosetta may need its own read or extension
rule. WP-B adds exactly what `sandbox-exec` tracing shows and nothing more.

## 3. The guest

### 3.1 vsock ports

| Port | Direction | Listener | Purpose |
|---|---|---|---|
| 1025 | host → guest | `lm-agent` | Control protocol (§3.4) |
| 2375 | host → guest | `lm-agent`, copying to `/run/docker.sock` | Docker Engine API |
| 3128 | guest → host | helper, copying to `127.0.0.1:<proxy-port>` | Proxy relay (job mode only) |

Every vsock port is reachable by all code in the VM, including privileged
containers (R8). None of them grants more than the job already has.

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
     `kernel.dmesg_restrict=1`, `kernel.panic_on_oops=1`.
   - Mount the data disk (§3.5), bring up `lo`, start `lm-agent` and restart it
     if it exits.
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
| `configure` | `vmId`, `mode`, `timeUnixMs`, `share`: `{ "tag": "work", "mountPath": <S>, "nonceFile": ".localmost-share" }` (job), `rosetta`: bool, `relay`: `{ "address": "198.18.0.1", "port": 3128, "vsockPort": 3128 }` (job) | `docker`: `{ version, apiVersion, minApiVersion }`, `disk`: `formatted`, `existing` or `corrupt`, `nonce` (≤ 64 chars, job), `rosetta`: `ok`, `absent` or `broken`, `selftest`: `{ rules, internalNoRelay, gatewayRejected, bridgeReachesRelay }`, each a bool | 60 s |
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
   bytes both ways. In refresh mode there is no `lm0` and no relay, but the
   rules still apply.
6. Start `dockerd --config-file /etc/docker/daemon.json`. Wait up to 30 s for
   `GET /_ping` on `/run/docker.sock` (`E_DOCKERD`, with the last 20 log lines).
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
iptables -N LOCALMOST-INPUT
iptables -A LOCALMOST-INPUT -i lo -j ACCEPT
iptables -A LOCALMOST-INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A LOCALMOST-INPUT -d 198.18.0.1/32 -p tcp --dport 3128 -j ACCEPT
iptables -A LOCALMOST-INPUT -p tcp -j REJECT --reject-with tcp-reset
iptables -A LOCALMOST-INPUT -j REJECT --reject-with icmp-port-unreachable
iptables -I INPUT 1 -j LOCALMOST-INPUT
```

REJECT, not DROP, so that a DNS lookup or a direct connection fails at once
instead of timing out. *Verified:* with no listener on `198.18.0.1:53`,
`dockerd`'s own registry lookup failed immediately.

Self-test, using `iproute2` network namespaces, after `dockerd` is up:

- `rules`: `iptables -S LOCALMOST-INPUT` equals the list above, and `INPUT`
  starts with the jump.
- `internalNoRelay`: a namespace on a scratch bridge with no default route
  cannot connect to `198.18.0.1:3128` (ENETUNREACH).
- `gatewayRejected`: the same namespace, connecting to a listener the agent
  opens on `0.0.0.0` at the scratch bridge's gateway address, gets a reset or
  unreachable, never a connection.
- `bridgeReachesRelay`: with a default route through that gateway, it connects
  to `198.18.0.1:3128`.

The scratch bridge and namespace are removed afterwards. *Verified behaviour
that motivates this:* in the spike, a container on an `internal` network could
not reach `198.18.0.1`, but did reach a `0.0.0.0` listener on its gateway (R8).

### 3.7 `lm-runc` and `lm-bindpin`

- `lm-runc` (`/usr/bin/runc`) looks at the subcommand in its arguments. If it
  is `create` or `run`, it reads `--bundle <dir>` (default: the current
  directory) and adds
  `{"path":"/usr/libexec/localmost/lm-bindpin","args":["lm-bindpin"],"timeout":10}`
  to `hooks.createRuntime` in `<dir>/config.json`. Hooks already there are
  kept. The file is written back through a temporary file and a rename. Then,
  for every subcommand, it runs `execve("/usr/libexec/localmost/runc", argv)`.
- `lm-bindpin` follows the steps in [the design's rule 7](vm-docker-backend.md#the-share-layout-rule).
  It enters the mount namespace from Go by locking its OS thread and calling
  `unshare(CLONE_FS)` and then `setns`. Its failure message on stderr, which
  `runc` passes through to the job, is
  `localmost: bind <source> -> <destination> was not approved for this container`.
  *Verified primitive:* `mount_setattr(…, {attr_clr: MOUNT_ATTR_NOSYMFOLLOW})`
  on a child bind of a `nosymfollow` virtiofs mount clears only that flag and
  keeps `ro,nosuid,nodev`.

### 3.8 Refresh mode

`lm.mode=refresh`, no share, no Rosetta, no relay. Electron loads the images
listed in the repository's `refs.json` through `docker.sock` (§6.5). It removes
every image that is not in that list, and every tag. Then it sends `shutdown`.
The helper `F_FULLFSYNC`s the disk and reports `stopped` with `synced: true`.

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

It runs on macOS 14+ on Apple silicon, with no Docker and no root. It needs
Node, Go (for the `guest/` module) and Xcode's `swiftc`. Its output is cached
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
| `src/main/docker/docker-backend.ts` | rewritten | The `DockerBackend` and `WorkerDocker` interfaces (below). `DesktopBackend` is deleted. |
| `src/main/vm/vm-backend.ts` | new | `VmBackend implements DockerBackend`: `name = 'vm'`, `supportsPrivileged = true`, `disposable = true`. `workspaceMountRoot` is the same as today's. |
| `src/main/vm/vm-manager.ts` | new | Admission gate, boot, readiness, stop, `sweep()`, `onResume()`, `shutdownAll()`, the spare. |
| `src/main/vm/helper-client.ts` | new | Spawn through `sandbox-exec`, NDJSON framing, the events and commands of §2.4, exit mapping. |
| `src/main/vm/helper-profile.ts` | new | `buildHelperProfile()` (§2.5). |
| `src/main/vm/agent-client.ts` | new | §3.4 over `agent.sock`, with schema validation of every answer. |
| `src/main/vm/guest-image.ts` | new | Locate `<resources>/guest`, read `manifest.json`, check the artifact hashes once per launch. |
| `src/main/vm/cache-disks.ts` | new | §6.5. |
| `src/main/vm/paths.ts` | new | Every path in §1, and `repoKeyOf()`. |
| `src/main/docker/puller/registry-client.ts` | new | Registry v2 client: token auth, manifests, blobs, redirects, screened DNS. |
| `src/main/docker/puller/image-store.ts` | new | The per-repository blob store and `refs.json`. |
| `src/main/docker/puller/docker-archive.ts` | new | The `docker save`-shaped tar stream for `POST /images/load`. |
| `src/main/docker/puller/image-puller.ts` | new | `ImagePuller` (§6.4). |
| `src/main/docker/registry-auth.ts` | changed | Throws `RegistryAuthError` when a configured helper is missing or fails other than "not found". |
| `src/main/docker/docker-filter-proxy.ts` | changed | §5.3. |
| `src/main/docker/docker-evaluator.ts` | changed | Returns `approvedBinds` (the pinned sources) on an allowed create. |
| `src/shared/docker-policy.ts` | changed | `UNFILTERED_EGRESS` becomes `PROXIED_EGRESS` = `egress through this job's proxy, subject to its network allowlist`. `hasDockerGrants(policy)` is exported. |
| `src/shared/docker-access.ts` and its tests | deleted | Only `DesktopBackend` used `resolveDockerEndpoint`. |
| `src/main/runner-downloader.ts` | changed | `buildSandbox` makes `<sandbox>/_work` (§1). `writeShareNonce(sandboxDir): string` writes the nonce with `wx`. |
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
  /** At the claim, with the bound policy. Boots a VM only if hasDockerGrants(policy). */
  bind(repository: string, policy: DockerPolicy): void;
  /** When the worker is spawned and dockerVm.prewarm is on. */
  prewarm(): void;
  /** The VM's docker.sock once ready. Waits while it boots, up to timeoutMs. */
  endpoint(timeoutMs: number): Promise<EndpointState>;
  /** A VM is ready right now: the baseline is forwarded, not synthesised. */
  running(): boolean;
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
// src/main/vm/vm-manager.ts
export interface VmRequest {
  mode: 'job' | 'refresh';
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
  /** Resolves on configure success; rejects with VmError { stage, code, message }. */
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
```

### 5.2 Guest module set

The roots are `virtiofs`, `vmw_vsock_virtio_transport`, `virtio_blk`,
`virtio-rng`, `ext4`, `erofs`, `overlay`, `br_netfilter`, `veth`, `dummy`,
`nf_tables`, `nft_compat`, `nft_chain_nat`, `xt_addrtype`, `xt_conntrack`,
`xt_MASQUERADE`, `xt_nat`, `xt_mark`, `ipt_REJECT`, `iptable_filter`,
`iptable_nat` and `binfmt_misc`. The build takes their closure through
`modules.dep`, and `manifest.modules` records the final list. WP-A adds a root
only when `dockerd` or `check-config.sh` shows it is needed. It is an
allowlist.

### 5.3 Filter changes (`DockerFilterProxy`)

- **Options.** `backend: DockerBackend` stays. Add `worker: WorkerDocker`.
  Remove `attachRegistryAuth`.
- **`bind()`** calls `worker.bind()` after recording the policy.
- **Endpoint.** Every use of `backend.resolveEndpoint()` becomes
  `await worker.endpoint(bootTimeoutMs)`. If it answers `none`, the request
  gets 503 with the reason, and the first such answer is also logged at warn.
- **Baseline.** When `!worker.running()`, `/_ping`, `/version` and `/info` are
  answered from `worker.baseline()`. `/version`'s `ApiVersion` is capped at the
  filter's `maxApiVersion`. Otherwise they are forwarded, and `/info` is
  rewritten as today.
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
  3. On a 201, parse `Id` (64 hex) and `await worker.approveBinds(Id, verdict.approvedBinds)`.
     Only then send the answer to the job.
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
| Job env | Keep `DOCKER_HOST` and `DOCKER_BUILDKIT=0`. Add `DOCKER_CONFIG=<sandbox>/.docker`, an empty directory made by `buildSandbox`, so the CLI reads no operator config. Prepend `<resources>/docker-cli` to `PATH`. |
| Profile | `spawnSandboxed(…, { shareDir: <sandbox>/_work, dockerCli: <resources>/docker-cli/docker })` |
| `bindDockerSocket` (the claim) | Unchanged. `socket.bind()` now boots the VM through `worker.bind()`. |
| `stopDockerProxy` (worker exit, reap, app stop) | Unchanged. `socket.stop()` now releases the VM. |
| App start (`index.ts`) | `await vmManager.sweep()` before the pool's first spawn. |
| App quit | `await vmManager.shutdownAll()`: every helper is stopped with `graceMs: 0` and awaited, 10 s at most. |
| `powerMonitor` `resume` | `vmManager.onResume()`: `set-time` to every ready VM; the spare is stopped. |
| Resource monitor pressure | `vmManager.onMemoryPressure(level)`: no spare at `warn`+; new boots are queued at `critical`. |

### 5.5 Job profile additions (`process-sandbox.ts`)

After `(allow file-read* file-write* (subpath "<sandbox>"))` and the docker
socket rules:

```scheme
;; The Docker VM's share and the sandbox around it, as nodes: the job cannot
;; rename, replace, chmod or relink either (VZ resolves the share at start).
(deny file-write* (literal "<sandbox>/_work") (literal "<sandbox>"))
;; The bundled docker CLI, and nothing else of the app bundle.
(allow file-read* (literal "<resources>/docker-cli/docker") (literal "<resources>/docker-cli"))
```

`<data>/vm` needs no rule. It is inside `<data>`, which is already denied in full.

### 5.6 Configuration (`config.yaml`)

```yaml
dockerVm:
  prewarm: false        # boot one spare VM for the next spawned worker (memory for latency)
  cpus: 4               # per VM; default min(4, physical cores)
  memoryMiB: 8192       # per VM; committed lazily, returned only when the VM stops
  maxRunning: 0         # 0 = auto: max(1, floor(physical RAM GiB / 8))
  dataDiskGiB: 64       # sparse apparent size of a new data disk
  bootTimeoutSec: 60    # how long a docker request waits for the job's VM
  cacheLimitGiB: 20     # per repository: golden disk and image store, LRU at refresh
```

All of these are optional. Out-of-range values are clamped and logged. No
setting enables a fallback daemon.

## 6. Puller and cache

### 6.1 Registry client

It uses Node `https` with the `lookup` screening that `ProxyServer` already
applies (`egress-screen.ts`), so a registry name that resolves to a loopback,
link-local or private address is refused. `docker.io` maps to
`registry-1.docker.io`, with `library/` for single-name images. It follows
redirects (CDN blob hosts) only to `https:` URLs, at most 5 hops, and screens
each hop. Auth: the `WWW-Authenticate: Bearer realm=…,service=…,scope=…` token
exchange, using basic credentials from `resolveRegistryAuth` when there are
any. The `Accept` header lists OCI index and manifest types and Docker
manifest-list and schema2 types. Schema1 is refused.

### 6.2 Platform choice

For an index, choose `linux/arm64` (any variant, `v8` first). If there is none,
or the request asks for `linux/amd64`, choose `linux/amd64`. If that choice
needs Rosetta and the VM's Rosetta is not `ok`, fail with the design's message.
A single-platform manifest is used as it is. Its config's `architecture` must
be `arm64` or `amd64`, and the same Rosetta rule applies.

### 6.3 Verification and store

Each blob is streamed to `blobs/sha256/.tmp-<random>` while its SHA-256 is
computed. It is renamed into place only if the digest matches the descriptor.
Each layer is decompressed (gzip, or zstd through Node's `zlib.zstdDecompress`), and
its uncompressed SHA-256 must equal the config's `diff_ids[i]`. `refs.json`
maps `<registry>/<path>:<tag>` and `@<digest>` to
`{ manifestDigest, configDigest, platform, lastPulled }`. Reading a blob
checks its digest again. A blob that fails is deleted and fetched again. The
store and the golden disk share `cacheLimitGiB`. When they exceed it, the least
recently pulled references are dropped at the next refresh.

### 6.4 `ImagePuller`

```ts
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

1. Resolve the tag with a manifest `HEAD`, then `GET` if needed.
2. If `GET /images/<registry>/<path>@<manifestDigest>/json` on the VM answers
   200, skip to step 5 (`source: 'vm'`, a cache-disk hit).
3. Fetch any blobs that are missing from the store (`source: 'registry'`, or
   `'store'` if all were present).
4. `POST /images/load` a tar holding `oci-layout`, `index.json` (annotation
   `io.containerd.image.name` = `<registry>/<path>@<manifestDigest>`),
   `manifest.json` (`RepoTags: null`), `blobs/sha256/<config>` and the
   *uncompressed* layer tars. *Verified:* a Mac-built archive of this shape
   loaded, and the image id equalled the config digest.
5. `POST /images/<configDigest>/tag?repo=<registry>/<path>&tag=<tag>`.
6. `cacheDisks.notePulled(repoKey, manifestDigest)`.

### 6.5 `CacheDisks`

```ts
export interface CacheDisks {
  /** A clone of the golden disk (clonefile), or a new sparse file when there is none. */
  prepareJobDisk(repoKey: string, dest: string, sizeGiB: number): Promise<'clone' | 'blank'>;
  notePulled(repoKey: string, manifestDigest: string): void;
  /** Debounced 60 s, one at a time per repository, skipped on battery or memory pressure. */
  scheduleRefresh(repoKey: string): void;
  discard(repoKey: string, reason: 'corrupt' | 'dataFormat' | 'limit'): Promise<void>;
}
```

A refresh does four things:

1. Clone `data.img` to `data.img.new`, or make a new one.
2. Start a refresh-mode VM on it. Load, through `docker.sock`, every reference
   in `refs.json` that is within the limit, streaming each archive from the store.
3. `DELETE` every image that is not a digest reference from that list, and
   `shutdown`.
4. On `stopped` with `synced: true`, rename `data.img.new` over `data.img` and
   update `meta.json` (`dataFormat`, digests). On any failure, delete
   `data.img.new`.

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
const VM_HELPER = path.join(__dirname, 'build', 'native', 'localmost-vm');
const GUEST_DIR = path.join(__dirname, 'build', 'guest');          // -> Resources/guest/
const DOCKER_CLI_DIR = path.join(__dirname, 'build', 'docker-cli'); // -> Resources/docker-cli/docker

packagerConfig.extraResource.push(VM_HELPER, GUEST_DIR, DOCKER_CLI_DIR);
packagerConfig.extendInfo = { LSMinimumSystemVersion: '14.0' };

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
build if `build/guest/manifest.json`'s hashes do not match its files, or if the
helper or CLI is missing. A build never ships without its VM.

### 7.3 Build scripts

- `build:helper`: `swift build -c release --arch arm64 --package-path native/localmost-vm`,
  copied to `build/native/localmost-vm`, then ad-hoc signed with
  `entitlements.virtualization.plist` so that development runs work. osx-sign
  re-signs it when there is an identity.
- `fetch:docker-cli`: `scripts/docker-cli.lock.json` =
  `{ "version": "29.8.1", "url": "https://download.docker.com/mac/static/stable/aarch64/docker-29.8.1.tgz", "sha256": "5a8f5604d7673202b2af925229d15eb4bbb86f7f542e4ac8cd7aa3f14cfa0f8b", "member": "docker/docker" }`
  is fetched, checked, and extracted to `build/docker-cli/docker`. *Verified:*
  hash, member, and that it is a thin arm64 Mach-O that is linker-signed ad hoc.
- Development runs find `<resources>` at `build/` (`build/native`, `build/guest`,
  `build/docker-cli`) through `getVmResourcesDir()` in `src/main/vm/paths.ts`.
  `LOCALMOST_VM_HELPER` replaces the helper path only when
  `NODE_ENV === 'test'`, so that tests can run the fake helper (§8). A packaged
  app ignores it.

### 7.4 Packaging tests (`src/main/packaging.test.ts`)

- `extraResource` includes the helper, `build/guest` and `build/docker-cli`.
- `signOptionsForFile` gives the virtualization plist to `Resources/localmost-vm`
  and to nothing else, and gives `none` to `Resources/docker-cli/docker`.
- `entitlements.virtualization.plist` has exactly one key.
- `extendInfo.LSMinimumSystemVersion === '14.0'`, and the usage-description
  test's plist fixture says `14.0`.
- The "ships no entitlements file the signing does not use" test still passes.

## 8. Fakes for parallel work

- **Fake helper** (`test/fakes/fake-localmost-vm.mjs`, owned by WP-C). It takes
  the §2.1 argument line and applies the same checks. It emits the §2.4 events.
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
