# VM Docker Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan. Each work package runs in its own worktree against the contract. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Docker Desktop backend with one localmost-owned Linux VM
per Docker-using job, so that G-A (bind re-resolution into the user's home)
and cross-job container reach are closed, and container egress goes through
the job's own proxy.

**Design:** [docs/roadmap/vm-docker-backend.md](../../roadmap/vm-docker-backend.md).
**Contract:** [docs/roadmap/vm-docker-backend-contract.md](../../roadmap/vm-docker-backend-contract.md),
cited below as §n. Every interface a package produces or consumes is defined
there. A package that needs to change the contract changes that file in its
own branch and says so in its summary. The integration stage reconciles the
changes.

**Owner decisions still open** (the design's "Decisions for the owner"): what
the per-repository cache may hold, `privileged`, and what the e2e docker
spec's Linux leg runs. This plan follows the recommendation for each. If the
owner chooses otherwise, the affected steps are marked *(decision 1)*,
*(decision 2)* or *(decision 3)*.

**Spike code** (not in the repo; reuse freely):
`~/.claude/jobs/676ade47/tmp/vm-design/`. It holds `vzprobe.swift` (a VZ
booter with shares, disks and vsock), `gprobe/` (Go guest probe: mount flags,
`mount_setattr`, vsock), `mkinitrd.py`, `mkbuild.py` and `mkguest.py` (apk
reading in memory, the newc cpio and tar writers, the rootfs composer),
`probe_kernel.py` (zboot unpack), `build-init` and `guest-init`, and
`helper.sb` (the working deny-default helper profile, including the scoped
`file-issue-extension` rule the share needs). The review probes are in
`review-probe/` (the profile with and without that rule) and `review-case/`
(the node denies against case variants and `RENAME_SWAP`). The earlier risk
experiments are in `~/.claude/jobs/676ade47/tmp/vz-risks/`.

## Global constraints

- macOS 14+, Apple silicon only (CLAUDE.md, owner decision 12).
- Allowlists, never blocklists: modules, profile rules, `/info` fields, env
  injection, bind approvals, the files in `Resources/guest`.
- Fail closed: a VM that failed, a hook that cannot match, or an agent answer
  that fails its schema means no Docker for that job, with a message. It never
  means a fallback daemon (owner decision 3).
- Nothing a job controls is ever a path given to the helper or used by
  Electron main to open a file. Electron writes into `_work` only before the
  worker starts, with `O_CREAT|O_EXCL`. Every digest from a registry or the VM
  is validated before it becomes part of a path (§6.3).
- Every answer from the guest or from `dockerd` is hostile input: bounded,
  schema-checked, and stripped of control characters before it is logged.
- TDD. Write the failing test, watch it fail, write the minimal code, watch it
  pass, commit. Run `npm run test:main` for main-process tests, or
  `npx jest --config test/jest.config.js <path>` for one file. Guest code uses
  `go test ./...`, the helper `swift test`.
- Never skip a test on a missing dependency. A test that needs a VM runs in
  the live stage and is not stubbed out of CI.
- **The repo's CI legs.** `ci.yaml`'s build job runs on the runner that
  `check.yaml` selects: the owner's self-hosted runner, inside a localmost job
  (seatbelt refuses a nested profile there), or the `ubuntu-latest` fallback
  (no `sandbox-exec`, no APFS, no Swift with Virtualization). Every new test
  must pass on both. Concretely:
  - Unit tests never go through `sandbox-exec`. `HelperClient` takes an
    injected spawn function; the fake helper runs directly.
  - Real `sandbox-exec` checks live only in `*.sandbox.test.ts` files, which
    follow the existing three modes: off macOS (an explicit assertion that the
    platform is not darwin, not a skip), constructed (build the profile and
    run under `sandbox-exec`), and ambient (inside a localmost job, assert
    against the job's own profile). Each new sandbox assertion is written in
    both the constructed and the ambient form.
  - `clonefile` assertions run on darwin; elsewhere the test asserts the
    documented non-darwin behaviour (a plain copy), as the repo already does
    for platform-specific code.
- Commit messages follow the repo's style and trailer.

## Work packages and how they run in parallel

| WP | Worktree branch | Starts | Needs from others to finish | Merges |
|---|---|---|---|---|
| 0 — Contract types | `vm/types` | now | nothing | 1st |
| F — Packaging, macOS 14, autoDownload | `vm/packaging` | after 0 | nothing | 2nd |
| A — Guest image | `vm/guest` | now | nothing (tests against its own `vzrun`) | 3rd |
| B — Swift helper | `vm/helper` | now | a bootable guest: the spike's, or A's once it exists | 4th |
| D — Puller and cache | `vm/puller` | after 0 | nothing (mock registry, mock daemon, fake `StartRefreshVm`) | 5th |
| C — Electron integration | `vm/electron` | after 0 | nothing (fake helper, stub puller) | 6th |
| E — Remove the Docker Desktop backend | `vm/remove-desktop` | after C's interfaces | C, at merge time | 7th |
| G — Docs | `vm/docs` | now | final names from A–F, at merge time | 8th |

**WP-0 exists so the others compile against each other.** D needs
`PullRequest` and `DockerProgress` (from `docker-backend.ts`) and
`repoKeyOf()` and the store paths (from `vm/paths.ts`); C consumes
`ImagePuller` and `CacheDisks`; `CacheDisks` must start a refresh VM. So WP-0
lands the shared declarations first, and the cycle between C and D is broken
by injecting a `StartRefreshVm` function into `CacheDisks` (§6.5) instead of
importing `VmManager`.

**Files more than one package touches, and who wins:**

| File | Packages | Rule |
|---|---|---|
| `package.json` | 0, A, B, D, F | Each adds only its own scripts or dependency lines. D owns `engines` and `@types/node`. F owns `build:native`. Conflicts are resolved by taking both sides. |
| `src/main/index.ts` | C, E | C adds the VM wiring; E only deletes `DesktopBackend` and `resolveRegistryAuth` wiring. E rebases on C. |
| `src/main/docker/docker-filter-proxy.test.ts` | C, E | C rewrites fixtures to a fake `WorkerDocker`; E deletes what is left of `DesktopBackend` fixtures. E rebases on C. |
| `src/main/docker/docker-backend.ts` | 0, C, E | 0 writes the new interfaces beside `DesktopBackend`; C adapts `DesktopBackend` to them; E deletes it. |
| `.github/workflows/ci.yaml` | B, D | B adds the `native` job; D pins `setup-node`. |
| `test/e2e/docker.spec.ts` | C, E | C moves the spec to the new filter options (a `WorkerDocker`) and the pull log line. E builds the Mac mode on `VmBackend` and adds the VM assertions there (moved from C, which has no helper or guest to boot: no VM without `docker:`, a boot at the claim, the pull line saying "on the Mac", the VM's directory gone afterwards), and replaces the Linux path *(decision 3)*. E rebases on C. |
| the contract | any | Changed in the package's own branch and reconciled at integration. |

---

## WP-0: Contract types

**Produces:** the declarations every other package compiles against, with no
behaviour.

**Files**

- Modify: `src/main/docker/docker-backend.ts`: add `DockerBackend` (new
  shape), `WorkerContext`, `WorkerDocker`, `EndpointState`, `ApprovedBind`,
  `DockerProgress` and `PullRequest` (§5.1), as interfaces only. The old
  interface is renamed `LegacyDockerBackend` so that `DesktopBackend` still
  compiles until C adapts it.
- Create: `src/main/vm/paths.ts` (every §1 path, `repoKeyOf()`,
  `helperPath()`, `dockerCliPath()`, `getVmResourcesDir()`, and
  `blobPath(storeRoot, hex)` with its checks) and `paths.test.ts`.
- Create: `src/main/vm/types.ts`: `VmRequest`, `VmState`, `VmHandle`,
  `VmManager`, `AgentClient`, `ImagePuller`, `CacheDisks` and
  `StartRefreshVm` (§5.1, §6.4, §6.5), declarations only.

**Tests first**

- [ ] `paths.test`: `repoKeyOf` is 16 hex of the lower-cased name's SHA-256;
  the id regexes (§1, slot 0 for refresh); `blobPath` refuses non-hex,
  wrong-length and traversal-shaped input and never returns a path outside
  its root; `helperPath()` is `build/localmost-vm` unpackaged.

**Acceptance**

- [ ] `npm run typecheck` and `npm run test:main` pass with no behaviour
  change.

---

## WP-A: Guest image

**Produces:** `build/guest/{vmlinux,initramfs.cpio.gz,rootfs.erofs,manifest.json,LICENSES.md}`
(§4), the guest programs (§3), `vzrun` (§4.3 step 6), the fake agent (§8).
**Consumes:** §3, §4 and §5.2 only.

**Files**

- Create: `guest/go.mod` (with `toolchain` pinned), `guest/cmd/lm-init/`,
  `guest/cmd/lm-agent/`, `guest/cmd/lm-runc/`, `guest/cmd/lm-bindpin/`,
  `guest/internal/{proto,mountinfo,firewall,share,relay,rosetta,selftest,agenttest}/`.
  Linux-only syscall code (`setns`, `openat2`, `mount_setattr`, netlink,
  vsock) is in `*_linux.go` files behind `//go:build linux`; parsing,
  matching and the protocol are portable and tested on any OS.
- Create: `guest/internal/mountinfo/testdata/binds.json` (the shared bind
  normalisation vectors, §3.7) and `guest/internal/firewall/testdata/localmost-input.txt`
  (the verbatim `iptables -S` capture, §3.6)
- Create: `scripts/guest/{fetch.mjs,apk.mjs,tar.mjs,cpio.mjs,unzboot.mjs,compose.mjs,build-guest.mjs,vzrun.swift,build-init,packages.lock.json,check-config.sh}`,
  `scripts/guest/keys/*.rsa.pub`
- Create: `scripts/guest/*.test.mjs` (jest) and `guest/**/*_test.go`
- Modify: `package.json` (`build:guest` script), `.gitignore` (`build/guest*`)

**Tests first**

- [ ] `cpio.test`: known entries produce a byte-exact newc archive. A second
  run is identical. Symlinks and directories are encoded. The trailer is
  present.
- [ ] `tar.test`: uid/gid 0 and mtime 0; sorted; PAX for long names; symlinks.
- [ ] `apk.test`: a fixture apk made of three gzip members yields only
  data-tar entries. Names that differ only in case are both kept
  (`xt_DSCP.ko`, `xt_dscp.ko`).
- [ ] `unzboot.test`: a fixture PE with `zimg`, offsets and gzip payload unpacks.
  A wrong magic, a non-gzip compression name, or a missing `ARMd` is an error.
- [ ] `fetch.test`: a lock hash mismatch fails, and nothing is written.
- [ ] `compose.test`: the module closure from a fixture `modules.dep`. `.ko.gz`
  becomes `.ko` in the payload and in `modules.dep`. The root has `/var/run -> ../run`
  and `/usr/bin/runc` = `lm-runc`.
- [ ] Go (portable): the `mountinfo` parser (fields, escapes, mount ids). Bind
  matching against `binds.json`: an approved bind is matched; trailing `/` and
  `//` in destinations normalise; a `ro` mismatch fails (`ro` read from
  `options`); an unapproved share mount fails; one approval cannot cover two
  mounts; a mount not on the share is ignored. `lm-runc` adds the hook to
  `hooks.createRuntime` for `create`, `run` and `restore`, keeps existing
  hooks, and leaves other subcommands alone. Agent protocol: framing, 64 KiB
  cap, unknown op, second `configure`, `approve-binds` limits. Share-path
  validation (`..`, `//`, a top-level name that exists, over 1024 bytes).
- [ ] Go (`linux`, run in the guest by the acceptance harness): the hook exits
  1 when the agent is unreachable and a share mount is present; clears no
  flag if any mount fails; refuses a mount whose `statx` mount id differs
  from the recorded one.

**Steps**

- [ ] Port the spike's Python composition to Node modules. Keep everything
  in memory, never extracted to disk (case-insensitive APFS).
- [ ] `fetch.mjs --update-lock`: resolve the closure from `APKINDEX` and
  verify the index signature with the checked-in keys. The first lock uses the
  §4.2 versions.
- [ ] `vzrun.swift`: kernel, initrd, cmdline, `--share tag=path:ro|rw`,
  `--disk path:ro|rw:none|fsync|full`, and `--vsock-unix port:path` in both
  directions (for a guest→host port, listen with VZ and connect to the unix
  path; for host→guest, bind the unix path). Ad-hoc signed with the
  entitlement at build time.
- [ ] Build VM: `mkfs.erofs` flags per §4.3. `--verify-reproducible` builds
  twice in the same checkout and fails if the images differ. It runs on the
  owner's Mac, outside any job (no CI job can boot a VM, §4.3), and is a step
  of `docs/release-checklist.md`.
- [ ] `lm-init` (module allowlist, then `modules_disabled` and
  `kexec_load_disabled`; power off on agent exit), then `lm-agent` (§3.4 in
  order: clock, disk, share, Rosetta, network, `dockerd`, self-test; vsock
  peer CID 2 only). Then `lm-runc` and `lm-bindpin`, with `setns` through a
  locked thread and `unshare(CLONE_FS)`, and the fd-based mount handling of
  the design's rule 7.
- [ ] Firewall (§3.6) with `LOCALMOST-RELAY` driven by Docker network events,
  and the self-test using `iproute2` netns. Capture `iptables -S
  LOCALMOST-INPUT` from the pinned package into the testdata golden file.
- [ ] Smoke boot records `baseline` and `docker` into `manifest.json`, and
  saves the forwarded `/_ping`, `/version` and `/info` answers as the fixture
  WP-C's baseline test compares against.

**Acceptance (run on the Mac with `vzrun`, outside any job, recorded in the PR)**

- [ ] `npm run build:guest` from clean produces all five files. A second run
  is a cache hit. With the cache cleared, the build is byte-identical.
- [ ] Boot to `configure` success within 3 s. `selftest` is all true,
  including `internalForgedRejected`.
- [ ] `kernel.modules_disabled` reads 1 after `configure`, and every scenario
  below passes with it set; `dmesg` shows no failed module request.
- [ ] With the share of a scratch `_work`: `docker load` of a fixture image;
  `docker run -v <share>/ws:/w:ro img cat /w/f` works; an inner symlink in an
  approved bind resolves; exec of a binary from the share works, including
  through a `:ro` bind (R11); `nosuid` is kept after `runc`'s ro remount (read
  `mountinfo` inside the container).
- [ ] **G-A in the guest, against real `dockerd` and `runc`:** create with an
  approved bind, swap the source for a link to `/`, `/run` and
  `/var/lib/docker`, then start and restart. Every start fails with the
  `lm-bindpin` or ELOOP message. A container with an rw bind that plants a
  link and restarts fails the same way.
- [ ] A bind that was not approved (the container was created with no
  `approve-binds`) fails to start with the `lm-bindpin` message.
- [ ] Default bridge: TCP to `198.18.0.1:3128` reaches the relay. An internal
  network: unreachable, and a raw-socket SYN to `198.18.0.1:3128` sent to the
  gateway's MAC (a static probe run in the container, with Docker's default
  `NET_RAW`) gets a reset, never a SYN-ACK. A gateway `0.0.0.0` listener from
  an internal network: refused. A new routable network reaches the relay once
  its create event is handled; a destroyed one's rule is gone. DNS for an
  external name fails in under 100 ms.
- [ ] **Embedded DNS on a user-defined network:** `docker network create n`,
  `docker run -d --network n --name db alpine sleep 60`, then `docker run
  --rm --network n alpine nslookup db` resolves, and the `dockerd` log has no
  `Resolver Start failed`. The spike saw that line for an internal network
  with no `xt_nat` loaded.
- [ ] `DOCKER_BUILDKIT=0 docker build` of a two-stage Dockerfile whose base
  images were loaded first works.
- [ ] With Rosetta: an x86-64 static binary runs and `rosetta: ok`. Without
  (`lm.rosetta` off): `rosetta: absent`.
- [ ] Killing `lm-agent` in the guest powers the VM off.

---

## WP-B: Swift helper `localmost-vm`

**Produces:** `native/localmost-vm/` (a SwiftPM package), `build/localmost-vm`
(§2, §7.3), and the `build:helper` script.
**Consumes:** §1, §2 and §3.1. It does not interpret the guest's bytes.

**Files**

- Create: `native/localmost-vm/Package.swift` (`platforms: [.macOS(.v14)]`),
  `Sources/localmost-vm/{main.swift,Args.swift,Paths.swift,VMConfig.swift,Sockets.swift,Relay.swift,Control.swift,Parent.swift,Errors.swift}`
- Create: `native/localmost-vm/Tests/localmost-vmTests/*.swift`
- Create: `scripts/build-helper.mjs`. Modify: `package.json` (`build:helper`)
- Modify: `.github/workflows/ci.yaml`: a new `native` job on `macos-latest`
  (arm64, GitHub-hosted), independent of the runner selection, that runs
  `swift build` and `swift test` for `native/localmost-vm`, and
  `go test ./...` and `GOOS=linux go vet ./...` for `guest/`. The `build`
  job's ubuntu leg also runs `go test ./...` in `guest/` natively. No job
  boots a VM (R28). `check.yaml` is the reusable runner-selection workflow and
  is not changed.

**Tests first (XCTest)**

- [ ] The argument parser accepts exactly §2.1. Every id regex is enforced
  (slot 0 only with `--mode refresh`). Unknown flags fail. Mode-specific flags
  are required or refused.
- [ ] Share validation on temp directories: a directory passes. A symlink at
  `_work`, a symlinked sandbox, `_work` missing, a realpath outside
  `runner/sandbox`, or `_work` on a different `st_dev` from the sandbox (a
  mounted DMG made with `hdiutil create`/`attach -nobrowse -mountpoint`,
  which needs no prompt) → `E_SHARE`.
- [ ] Guest artifact size checks → `E_GUEST_IMAGE`.
- [ ] NDJSON: a 64 KiB cap, unknown commands, a `stop` answer, and the order of
  `listening`, `started`, `stopped`. `started.pid` is the helper's own pid.
- [ ] Parent watch: with a child process standing in as parent, its exit
  triggers the stop path; EOF on stdin does too.
- [ ] Exit-code mapping table.

**Steps**

- [ ] Start from the spike's `vzprobe.swift`. Split out config building
  (§2.2), unix-socket servers that dial `connect(toPort:)` per connection
  (§2.3), the vsock 3128 listener that relays to `127.0.0.1:<proxy-port>`, and
  byte copying with bounded buffers on a dispatch queue per connection. Never
  block the VZ queue (the spike's first listener deadlocked by reading inside
  `shouldAcceptNewConnection`).
- [ ] Parent watch (§2.4): kqueue `EVFILT_PROC`/`NOTE_EXIT` on the recorded
  ppid, and stdin EOF, both leading to `stop` with `graceMs: 0`.
- [ ] Rosetta: `availability` check; share only when `.installed` and
  `--rosetta auto`; never `installRosetta…`.
- [ ] Refresh mode: after a `guest` stop, `F_FULLFSYNC` the data disk, then emit
  `synced`.
- [ ] Console to `console.log` with the §2.2 cap.
- [ ] Signals and stop per §2.4.

**Acceptance (on the Mac, outside any job, under `sandbox-exec` with a
profile from WP-C's `buildHelperProfile`, or the spike's `helper.sb` until C
lands)**

- [ ] Boots WP-A's guest (or the spike's) and emits `listening`, then `started`.
  `agent.sock` reaches the guest agent. `docker.sock` answers `/_ping`. The
  erofs root and the data disk attach under the profile (the spike never
  attached disks under it).
- [ ] The share works under the §2.5 profile: a file in a granted real
  directory is readable in the guest. Without the `file-issue-extension`
  rule, it is not (reproduces the review probe).
- [ ] The profile refuses to share an ungranted directory, and a granted path
  that is a link elsewhere (EPERM → `E_VZ_START`). This repeats the spike's
  result under the real helper.
- [ ] A DMG mounted over `_work` → `E_SHARE` before `start`.
- [ ] Relay: a guest connection to vsock 3128 reaches a test TCP server on
  `127.0.0.1:<port>`. With the profile, a connection to any other port is
  refused by seatbelt.
- [ ] SIGKILL of the helper: the VZ XPC process is gone within 3 s.
- [ ] SIGKILL of the helper's **parent**: the helper and the VZ XPC process
  are gone within 3 s.
- [ ] Signed with an Apple Development identity and hardened runtime: still
  boots under the profile.
- [ ] Trace what Rosetta needs under the profile, add exactly that to §2.5
  (never a broader `file-issue-extension`), and boot with Rosetta.

---

## WP-C: Electron integration (with a fake helper)

**Produces:** everything in §5 except the puller internals: `VmBackend`,
`VmManager`, `HelperClient`, `AgentClient`, `helper-profile.ts`,
`guest-image.ts`, the memory-pressure monitor; the filter and evaluator
changes; the runner-manager, runner-downloader, process-sandbox, config and
index wiring; the fake helper (§8).
**Consumes:** WP-0's declarations, §1–§3 as protocols, and
`ImagePuller`/`CacheDisks` as interfaces (§6.4, §6.5). It uses stubs until
WP-D merges.

**Files**

- Create: `src/main/vm/{vm-backend,vm-manager,helper-client,helper-profile,agent-client,guest-image}.ts`
  and a `.test.ts` for each; `src/main/vm/helper-client.sandbox.test.ts` and
  `src/main/vm/helper-profile.sandbox.test.ts` (three modes)
- Create: `src/main/resource-monitor/memory-pressure-monitor.ts` (+ test)
- Create: `test/fakes/fake-localmost-vm.mjs`
- Modify: `src/main/docker/docker-backend.ts` (adapt `DesktopBackend` to the
  WP-0 interfaces with a thin `forWorker` that keeps today's behaviour, so the
  filter, evaluator and e2e tests keep running until WP-E deletes it)
- Modify: `src/main/docker/docker-filter-proxy.ts` (+ test),
  `src/main/docker/docker-evaluator.ts` (destinations, `approvedBinds`; + test),
  `src/shared/docker-policy.ts` (`PROXIED_EGRESS`, `hasDockerGrants`, the
  `pull.registries` redirect wording, the `privileged` refusal text; + test)
- Modify: `src/main/runner-downloader.ts` (`_work`, `.docker`, `writeShareNonce`; + tests),
  `src/main/process-sandbox.ts` (+ `process-sandbox.test.ts`, `process-sandbox.sandbox.test.ts`),
  `src/main/runner-manager.ts` (+ spawns and lifecycle tests), `src/main/config.ts`,
  `src/main/index.ts`

**Tests first**

- [ ] `helper-profile.test`: exact rules per mode. Job mode has the
  `file-issue-extension` rule scoped to exactly `(subpath "<S>")` and both
  extension classes, and no other `file-issue-extension`; refresh mode has
  none, and its only disk grant is the literal `data.img.new`. Paths are
  escaped. The proxy port is interpolated. `process-exec` names
  `helperPath()`. No rule grants `<data>` outside the VM's own directory and
  that one file.
- [ ] `helper-profile.sandbox.test` (three modes; constructed on the Mac): a
  share outside the grant and a granted path that is a link both fail
  `Start()`, and a granted real directory is readable in the guest. The VM
  part needs a guest and a helper, so it runs in the live stage and in the
  owner's local run; the profile-only part (seatbelt denies of paths outside
  the grant) runs in every mode.
- [ ] `helper-client.test` (fake helper through the injected spawn): the event
  order. A malformed event kills the helper. `stop` with and without grace.
  Exit codes map to `VmError.code`. SIGKILL after 5 s. Closing stdin makes the
  fake exit.
- [ ] `agent-client.test`: schema validation rejects oversized strings, extra
  types and a wrong `id`. Timeouts per op. Control characters in guest strings
  are stripped before logging.
- [ ] `vm-manager.test` (fake helper):
  - admission (`maxRunning`, FIFO, refresh last, the timeout gives `none`);
  - boot failure at each stage gives the logged reason and no retry;
  - a nonce mismatch tears down and logs at error;
  - cancelled mid-boot means no leak;
  - a helper crash, and an agent exit (`stopped` reason `guest`), mark the VM
    failed;
  - `onResume` sends `set-time` and stops the spare;
  - `onMemoryPressure`: no spare or refresh at `warn`, boots queue at `critical`;
  - disk: a boot below the free-space floor is refused; the apparent size is
    reduced by headroom promised to running VMs;
  - `sweep()` kills only a live process at `helperPath()` (the pid-reuse
    check) and removes directories;
  - `shutdownAll()` is bounded.
- [ ] `memory-pressure-monitor.test`: 1/2/4 map to the three levels, an
  unknown value is `warn`, a failing `sysctl` is logged once and treated as
  `normal`, and only changes are reported.
- [ ] `vm-backend.test`:
  - `bind()` with no docker grants never starts a VM;
  - a grant starts one;
  - **a double bind** (the same repository and policy twice) starts one VM;
  - a later bind with a changed policy replaces the policy and does not boot;
  - a later bind without grants leaves the running VM alone;
  - **a bind after `release()` has started** boots nothing;
  - a bind for another repository stops the VM and boots nothing;
  - the spare is adopted only for its spawn repository, and stopped otherwise;
  - `baseline()` comes from the manifest;
  - `containerProxyEnv()` uses the worker's current token URL, rewritten to
    `198.18.0.1:3128`;
  - `release()` is idempotent.
- [ ] `docker-filter-proxy.test` (with a fake `WorkerDocker`):
  - pull interception streams progress and never forwards;
  - `X-Registry-Auth` and `X-Registry-Config` are dropped on every request,
    `/build` included; `POST /auth` and the checkpoint endpoints are refused;
  - create injects the proxy env only for routable networks and keeps the
    job's values;
  - the create answer is held until `approveBinds` resolves, and the
    container is recorded as owned only after it; a start by name before then
    is refused;
  - a failed approval deletes the container and answers 500;
  - **an oversized create answer** (and network-create and inspect answers)
    from the mock daemon is refused with 502 without buffering past
    `MAX_JSON_BODY_BYTES`;
  - `buildargs` are merged;
  - the baseline is synthesised when not running, with exactly the §5.3
    headers and fields (`Builder-Version: 1`), and matches WP-A's recorded
    forwarded answers field by field; it is forwarded when running;
  - the endpoint wait and timeout give 503 with the reason;
  - stop skips removal when `disposable`.
- [ ] `docker-evaluator.test`: `approvedBinds` equals the pinned sources,
  normalised destinations (trailing `/`, `//`) and `readOnly` for every
  allowed create, and is empty when there are no binds. A relative
  destination and a duplicate destination are refused. The same vectors as
  `guest/internal/mountinfo/testdata/binds.json`.
- [ ] `docker-policy.test`: `privileged: true` is still refused, with the new
  text *(decision 2)*; the `pull.registries` approval text mentions redirects.
- [ ] `runner-downloader.test`: `_work` and `.docker` exist in a new sandbox,
  and `mkdir` fails on an existing name. `writeShareNonce` refuses an existing
  file or a symlink.
- [ ] `process-sandbox.test`: the three denies (the `_work` and `<sandbox>`
  nodes, and the nonce file) come after the sandbox re-allow, and there is a
  CLI read literal at `dockerCliPath()`.
- [ ] `process-sandbox.sandbox.test` (real `sandbox-exec`; constructed and
  ambient forms of each). A job can:
  - create, write and remove anything under `_work`, `rm -rf _work/x/y`, and
    `mkdir -p _work/a`.

  It cannot:
  - `mv _work _w2`, `rm -rf _work`, `chmod 000 _work`, or `ln -s ~ _work`
    after removing it;
  - `mv _WORK _w2`, or `mv` the sandbox by a case variant of its name;
  - `renamex_np(RENAME_SWAP)` `_work` with a sibling directory, or the
    sandbox with another directory;
  - `mv <sandbox> ~/.npm/x` (with a policy write grant on `~/.npm`);
  - read or replace `_work/.localmost-share`;
  - connect to a unix socket under `<data>/vm/jobs/`.
- [ ] `runner-manager` spawns and lifecycle: `forWorker` gets the §5.4
  context. The env has `DOCKER_CONFIG` and the PATH prefix. `stopDockerProxy`
  releases. The repeated `applyPolicyForTarget` calls of one job start one VM.
  The spare is used only when the claim is for the spawn repository.

**Steps**

- [ ] Adapt `DesktopBackend` to the WP-0 interfaces, so that everything keeps
  compiling and the existing filter, evaluator and e2e tests keep running.
  WP-E deletes it.
- [ ] Fake helper, then `HelperClient` (injected spawn), `AgentClient` and
  `VmManager`.
- [ ] Filter changes, one at a time, each behind its test.
- [ ] Wiring in runner-manager and index. `sweep()` runs before the first
  spawn. `CacheDisks` gets a `StartRefreshVm` that calls `vmManager.start`.
- [ ] Log lines exactly as in §5.3 (the e2e suite matches them).

**Acceptance**

- [ ] `npm run test:main`, `npm run lint` and `npm run typecheck` pass, on the
  Mac outside a job and on Linux.
- [ ] With the fake helper selected by `LOCALMOST_VM_HELPER=<path>` (honoured
  only when `!app.isPackaged`), a runner-manager integration test runs a
  docker job end to end against a mock daemon, with the fake spawned directly.
  The log shows boot at the claim, the ready line, and the release at exit.

---

## WP-D: Puller, image store, cache disks, credentials

**Produces:** `src/main/docker/puller/*`, `src/main/vm/cache-disks.ts`, the
`registry-auth.ts` changes, and the mock registry (§6, §8).
**Consumes:** WP-0's declarations, §6, and a Docker API endpoint. The tests
use a mock daemon socket that records `POST /images/load` and tag calls, and
a fake `StartRefreshVm`.

**Files**

- Create: `src/main/docker/puller/{registry-client,image-store,docker-archive,image-puller,test-registry}.ts`
  with tests, and `src/main/vm/cache-disks.ts` with a test
- Modify: `src/main/docker/registry-auth.ts` and `registry-auth.test.ts`
- Modify: `package.json` (`engines.node` to `>=22.15.0`, for
  `zlib.zstdDecompress`; `@types/node` to `^22.15.0`, which declares it),
  `.github/workflows/ci.yaml` (`setup-node` `node-version: '>=22.15.0 <23'`,
  and its comment). Electron 43's own Node is 24.18, which has zstd; the
  bump is for jest and the toolcache.

**Tests first**

- [ ] `registry-auth.test`:
  - a helper is looked up only in the three directories, never on `PATH`
    (a helper placed only on `PATH` is "not found");
  - a missing helper throws `RegistryAuthError` naming it and the config key
    (`credsStore` or `credHelpers.<registry>`);
  - a helper exiting 1 with `credentials not found` means anonymous;
  - any other helper failure throws;
  - the helper runs through async `execFile`, never `execFileSync`;
  - inline `auths` work unchanged.
- [ ] `registry-client.test` (mock registry):
  - the Bearer token flow;
  - `Authorization` goes only to the registry origin: a redirect hop, same
    origin or not, carries none, and no cookies;
  - basic credentials go only to an https realm that passed screening; an
    `http:` realm, a realm on 127.0.0.1 or 10.x, and a redirect of the token
    request all fail without sending them;
  - a redirect to a CDN host is followed and screened;
  - http redirects and more than 5 hops are refused;
  - a name resolving to 127.0.0.1 or 10.x is refused, and so is an `http:`
    registry;
  - a descriptor with `urls`, and the foreign and non-distributable layer
    media types, are refused before any fetch;
  - traversal-shaped (`sha256:../../x`), wrong-length, uppercase and
    `sha512:` digests are refused in every position: descriptor, index entry,
    `diff_ids`, `Docker-Content-Digest`, and the requested reference;
  - a manifest whose `Docker-Content-Digest` disagrees with its bytes is
    identified by its bytes;
  - schema1 is refused;
  - 429 is surfaced with Docker Hub's wording.
- [ ] Platform choice (§6.2): arm64 preferred; amd64 when there is no arm64 or
  it was asked for; Rosetta `absent` or `broken` gives the design's message;
  a single-platform manifest is checked.
- [ ] Limits (§6.3): a pull past `pullMaxGiB`, a job past `jobPullMaxGiB`, a
  blob streaming past its declared `size`, a layer expanding past the ratio
  (a small gzip bomb fixture), and free space below `minFreeGiB` (an injected
  `statfs`) each fail with the message naming the key, and leave no blob.
- [ ] `image-store.test`:
  - a digest mismatch leaves nothing in place;
  - `blobPath` is the only way a path is built, and a hand-edited `refs.json`
    holding a traversal-shaped digest is refused on read;
  - an interrupted write leaves only `.tmp-*`, cleaned at startup;
  - a read re-verifies;
  - `refs.json` updates atomically;
  - LRU trimming stays within the limit.
- [ ] `docker-archive.test`: the tar layout of §6.4 step 4, uncompressed layers,
  `diff_id` checks for gzip and zstd (the zstd fixture is compressed in the
  test with `zlib.zstdCompressSync`), and a deterministic byte stream.
- [ ] `image-puller.test` (mock registry and mock daemon):
  - progress lines have Docker's shape;
  - a cache hit in the VM (`GET /images/sha256:<config>/json` answers 200
    with that `Id`) skips the load and reports `source: 'vm'`;
  - a store hit skips the network;
  - a pull by digest must match the hash of the fetched bytes;
  - a tag is created on `sha256:<config>`;
  - an image the mock registry refuses anonymously goes to the job's own
    store and is not noted for the cache; a public one is *(decision 1)*;
  - oversized load, tag and inspect answers from the mock daemon are refused;
  - an abort stops the transfers.
- [ ] `cache-disks.test` (temp dir; `clonefile` assertions on darwin, the
  documented plain-copy behaviour elsewhere, never a skip):
  - on darwin, `clonefile` is used, with an inode check that the clone is not
    the original;
  - blank when there is no golden disk;
  - refreshes are serialized and debounced, and start through the injected
    `StartRefreshVm` with slot 0;
  - incremental loads only config digests missing from `meta.json`; a guest
    version change, a golden disk last built from blank over 7 days ago, and
    a previous failure each make it full (blank);
  - a failure deletes `.new` and marks the next refresh full;
  - a `dataFormat` mismatch discards;
  - `synced: false` never promotes.

**Acceptance**

- [ ] All unit tests pass in CI, on both legs.
- [ ] Against the real Docker Hub and GHCR, run manually on the Mac: pull
  `alpine:3` and `node:22-alpine` (gzip), and one image with zstd layers.
  There is no zstd image the design has verified yet: WP-D builds one
  (`docker buildx build --output type=image,compression=zstd,force-compression=true`
  of a one-line Dockerfile), pushes it to the owner's GHCR, and records its
  name and manifest digest in `test/fixtures/zstd-image.json` for later
  runs. `docker load` them into WP-A's guest through `vzrun`'s
  `--vsock-unix`; the image ids match the config digests.
- [ ] A second pull of `alpine:3` in a VM cloned from a refreshed golden disk
  reports `source: 'vm'`.
- [ ] A Docker Hub manifest `HEAD` leaves `ratelimit-remaining` unchanged
  (the design's citation).
- [ ] A private GHCR image, with the operator's credentials from the osxkeychain
  helper, pulls, lands in the job's own store, and is absent from
  `images/<repoKey>`. With the helper renamed away, the pull fails naming it
  and the config key.

---

## WP-E: Remove the Docker Desktop backend

**Files**

- Delete: `DesktopBackend` from `src/main/docker/docker-backend.ts` and its
  tests; `src/shared/docker-access.ts`, `docker-access.test.ts`,
  `docker-access.sandbox.test.ts`.
- Modify: `src/main/index.ts` (no `DesktopBackend`, no `resolveRegistryAuth`
  wiring into the filter), `src/main/docker/docker-filter-proxy.test.ts`
  (fixtures that built a `DesktopBackend`),
  `.github/actions/docker-access/action.yml` (the error text no longer says
  "Docker Desktop is not running").
- Modify: `test/e2e/docker.spec.ts`. It builds `DockerFilterProxy`
  in-process and never uses the packaged app. It has three modes today
  (inside a job; outside a job over a native daemon; and the precondition
  that a daemon exists). After this package:
  - **inside a localmost job:** unchanged; it drives the socket the runner
    serves.
  - **on the Mac, outside a job:** it builds `VmBackend` and `VmManager`
    against the resources in `build/` (`build/localmost-vm`, `build/guest`,
    `build/docker-cli`), which must exist; the precondition is that they do,
    with a message naming `npm run build:native`. This mode carries the VM
    assertions (moved here from WP-C, which cannot boot a VM): a job whose
    policy has no `docker:` boots no VM; a job with one boots at the claim;
    the pull line says "on the Mac"; the VM's directory is gone afterwards.
  - **off macOS** *(decision 3, recommended option)*: it uses
    `test/e2e/support/native-worker-docker.ts`, a test-only `WorkerDocker`
    that forwards to the runner's native `dockerd`, with pulls forwarded
    rather than done on the Mac. It lives under `test/`, is imported only by
    this spec, and can never be chosen by the app. A jest test asserts that
    nothing under `src/` imports it.

**Tests first**

- [ ] `grep -r "DesktopBackend\|resolveDockerEndpoint\|docker-desktop" src test`
  is empty (a jest test that reads the tree, so the removal stays removed).
- [ ] The filter tests pass with a fake `WorkerDocker` only.
- [ ] No module under `src/` imports `test/e2e/support/native-worker-docker`.

**Acceptance**

- [ ] `npm run test:main` and `npm run typecheck` pass after rebasing on WP-C.
  No code path in `src/` resolves or connects to `/var/run/docker.sock` or
  `~/.docker/run`.
- [ ] `npx playwright test test/e2e/docker.spec.ts --config test/playwright.config.ts`
  passes on the ubuntu leg with the native forwarder *(decision 3)*.

---

## WP-F: Packaging, signing, macOS 14, autoDownload, bundled CLI

**Files**

- Create: `packaging/entitlements.virtualization.plist` (§7.1),
  `scripts/docker-cli.lock.json`, `scripts/fetch-docker-cli.mjs` (+ test)
- Modify: `forge.config.js` (§7.2: `extraResource`, `LSMinimumSystemVersion`,
  `signOptionsForFile`, `ignoreGuest` in `osxSign`, the `GUEST_FILES`
  allowlist in `prePackage`), `package.json` (`build:native`,
  `fetch:docker-cli`), `src/main/packaging.test.ts` (§7.4),
  `src/main/auto-updater.ts` and `auto-updater.test.ts` (`autoDownload = true`),
  `README.md` (requirements: macOS 14), `docs/release-checklist.md`:
  - build the guest on the owner's Mac, outside any job: `npm run
    build:guest -- --verify-reproducible`, then the smoke boot; no CI job can
    do this;
  - attach the guest's GPL sources: the Alpine aports commit and the upstream
    source tarballs for linux, busybox, iptables and e2fsprogs; NOTICE files.

**Tests first**

- [ ] §7.4 packaging assertions.
- [ ] `auto-updater.test`: `autoDownload` is true and `autoInstallOnAppQuit` is
  still true.
- [ ] `fetch-docker-cli.test`: a hash mismatch fails and writes nothing; the
  member is extracted, and so is nothing else.

**Steps**

- [ ] `extendInfo.LSMinimumSystemVersion = '14.0'`. Also update the
  usage-description fixture.
- [ ] `hooks.generateAssets` runs `build:native`. `hooks.prePackage` checks the
  guest directory against `GUEST_FILES`, the guest manifest, the helper and
  the CLI (§7.2).
- [ ] The `signOptionsForFile` branch, and `ignoreGuest`.

**Acceptance**

- [ ] `npm test` passes. A `npm run package` on the Mac (the integration stage
  does this, not the worktree) shows these with `codesign -d --entitlements -`:
  - `Resources/localmost-vm` has only `com.apple.security.virtualization`;
  - `Resources/docker-cli/docker` has none;
  - `Resources/guest/*` carry no signature xattrs (`xattr -l`);
  - `Info.plist` has `LSMinimumSystemVersion` `14.0`.

---

## WP-G: Documentation

**Files**

- Modify: `SECURITY.md` "Docker Access". Rewrite what the filter contains now
  that the daemon is a per-job VM:
  - G-A is closed, and on what (design S1–S2), including that job code may
    run before the VM starts and which two layers cover that;
  - cross-job reach is closed (S3);
  - container egress goes through the proxy (S4–S5), with the proxy token as
    the backstop for `internal` networks;
  - credentials stay on the Mac (S6), and granting a registry in
    `pull.registries` also means Electron fetches from wherever it redirects;
  - what the per-repository cache exposes (S7) *(decision 1)*;
  - what is not contained (the design's list, including the refresh VM's
    input);
  - `privileged` stays refused *(decision 2)*;
  - remove the "open item" about bind re-resolution;
  - document the two findings present before this change (the default bridge
    and joining a network by name) as fixed.
- Modify: `CHANGELOG.md`: Docker Desktop is no longer used; the VM backend;
  macOS 14; auto-download of updates; the policy meaning of routable; no LAN,
  loopback or plain-http registries; credential helpers looked up in fixed
  directories.
- Modify: `docs/roadmap/localmostrc.md` and `README.md` policy section:
  `routable` means through the job's proxy, proxy settings are injected,
  base images must be pulled before a build, `pull.registries` includes the
  registry's redirects.
- Modify: `docs/superpowers/specs/2026-09-05-docker-isolation-design.md`:
  a status line pointing at the VM design for stage 2, answering its first open
  question (an embedded Virtualization.framework helper).
- Modify: `docs/roadmap/vm-docker-backend.md`: status and the "not yet
  verified" list, as items become verified in integration.

**Acceptance**

- [ ] Every claim in `SECURITY.md` names the mechanism behind it. Nothing
  claims containment of the virtiofs server, of the refresh VM's input, or of
  privileged containers.

---

## Integration and live validation

Run by one person, in this order, on the owner's Mac, outside any localmost
job, while no CI job is running on the runner (the installed app serves CI's
localmost legs, and reinstalling mid-leg fails the job).

- [ ] **Merge** 0 → F → A → B → D → C → E → G into the PR #40 branch.
  Reconcile any contract edits the packages made. Rerun `npm test`,
  `npm run lint`, `npm run typecheck`, `go test ./...` in `guest/`, and
  `swift test` in `native/localmost-vm`.
- [ ] **Build:** `npm run build:native`, with `build:guest --verify-reproducible`
  (byte-identical across two runs), then `npm run make`. Check the §7.4
  `codesign` results on the packaged app.
- [ ] **Local e2e:** `npx playwright test test/e2e/docker.spec.ts --config
  test/playwright.config.ts` on the Mac, outside a job. It builds the filter
  in-process over `VmBackend`/`VmManager` and the resources in `build/`; it
  does not package or launch the app. It is extended to check:
  - no VM for a job without `docker:`;
  - a VM boots at the claim for one with `docker:`;
  - the pull line says "on the Mac";
  - the existing mount, network and refusal cases still pass;
  - the VM directory is gone after the job.
- [ ] **Install** the built app while the runner is idle. Relaunch it and check
  that the startup sweep ran (the log line).
- [ ] **Approve the new `.localmostrc` section.** The `vm-escape` workflow
  below needs a `workflows: vm-escape:` section in `.localmostrc`. localmost
  runs a job only under an approved policy, so the owner approves that
  section in the app before the workflow can run.
- [ ] **CI Docker Access workflow:** push, then watch the `docker-localmost`
  job. It must pass with the pull, the run and the read-only workspace mount
  through the VM. `docker-linux` must still pass. Watch the checks and
  comments until they are green; do not make the owner relay status.
- [ ] **G-A regression, live:** add `.github/workflows/vm-escape.yaml`
  (`runs-on: self-hosted`), with a `workflows: vm-escape:` section in
  `.localmostrc` granting `alpine:3`, an rw mount of `./tmp/ga`, and one
  routable and one internal network. The job asserts each of these:
  1. create `-v $PWD/tmp/ga/d:/d`, `rm -rf tmp/ga/d && ln -s "$HOME" tmp/ga/d`,
     then `docker start -a`: the start fails, and the output never lists the
     home directory;
  2. the same with `ln -s /`;
  3. a swap from inside a container, which the filter on the Mac cannot see:
     create C2 with a bind of `tmp/ga/d` (not started). Run C1 with rw on
     `tmp/ga`; inside it, replace `d` with a link to `/`, then to `/run`,
     then to the path `$HOME` has on the Mac. After each, `docker start C2`
     must fail with the `lm-bindpin` or ELOOP message. Then its own source:
     C3 binds `tmp/ga` rw at `/ga` and `tmp/ga/e` at `/e`; inside, it
     replaces `/ga/e` with a link to `/` and exits. `docker start C3` again
     (the filter allows no `docker restart` and no restart policy, so a
     second start is how a container restarts) must fail the same way;
  4. `mv _work` (`$RUNNER_WORKSPACE/..`) fails with "Operation not permitted",
     and `cat _work/.localmost-share` fails too;
  5. a container `wget`s an allowed host through the injected proxy
     (succeeds), a denied host (403 from the proxy), and a raw TCP connect to
     `1.1.1.1:443` (fails at once);
  6. a container on the internal network cannot reach `198.18.0.1:3128`,
     neither by a TCP connect nor by a raw-socket SYN sent to its gateway's
     MAC (a static probe, `test/fixtures/rawsyn`, built for linux/arm64 and
     loaded as a scratch image).
- [ ] **Cross-job, live:** run `vm-escape` twice at once (a matrix of two).
  Both VMs run identical Docker networks, so their containers likely hold the
  same addresses (`172.17.0.2`, …); reaching "the other leg's IP" would reach
  the leg's own container. Instead, each leg:
  - starts a container that serves a nonce unique to the leg (the run
    attempt plus the leg name), and records its IP, port and nonce, and the
    id from `docker network inspect lm-xjob`, to an artifact;
  - waits for the other leg's artifact, then connects to the other leg's
    recorded IP and port from a container on its own networks, and asserts
    that it never receives the other leg's nonce (it may receive its own, or
    nothing);
  - asserts that the other leg's network id is not a network it can inspect,
    and that `docker run --network <other leg's network id>` is refused;
  - creates `lm-xjob` by the same name and checks that its id differs from
    the other leg's.
- [ ] **Rosetta, live:** `docker run --rm --platform linux/amd64 alpine:3 uname -m`
  gives `x86_64`.
- [ ] **At the machine (the owner present):**
  - sleep for 10 minutes mid-job, then wake: the guest clock is corrected
    (`date` in a container, within 2 s of the Mac's);
  - four concurrent docker jobs, each running `docker run alpine:3 sh -c
    'dd if=/dev/zero of=/tmp/x bs=1M count=2048; sleep 60'`: passes when swap
    used (`sysctl vm.swapusage`) grows by less than 1 GiB and memory pressure
    stays below `critical`, *or* when the admission log shows the VMs past
    `maxRunning` queued rather than started; fails if a VM starts past
    `maxRunning` or the pressure level reaches `critical` with all four
    running;
  - with `dockerVm.prewarm: true`: claim latency and the spare's lifecycle.
- [ ] Update the design's "What was verified" list and the README roadmap
  status. Generalize the PR #40 description to cover this work, on the same PR.
