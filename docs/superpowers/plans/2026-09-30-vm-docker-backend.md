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

**Spike code** (not in the repo; reuse freely):
`~/.claude/jobs/676ade47/tmp/vm-design/`. It holds `vzprobe.swift` (a VZ
booter with shares, disks and vsock), `gprobe/` (Go guest probe: mount flags,
`mount_setattr`, vsock), `mkinitrd.py`, `mkbuild.py` and `mkguest.py` (apk
reading in memory, the newc cpio and tar writers, the rootfs composer),
`probe_kernel.py` (zboot unpack), `build-init` and `guest-init`, and
`helper.sb` (the working deny-default helper profile). The earlier risk
experiments are in `~/.claude/jobs/676ade47/tmp/vz-risks/`.

## Global constraints

- macOS 14+, Apple silicon only (CLAUDE.md, owner decision 12).
- Allowlists, never blocklists: modules, profile rules, `/info` fields, env
  injection, bind approvals.
- Fail closed: a VM that failed, a hook that cannot match, or an agent answer
  that fails its schema means no Docker for that job, with a message. It never
  means a fallback daemon (owner decision 3).
- Nothing a job controls is ever a path given to the helper or used by
  Electron main to open a file. Electron writes into `_work` only before the
  worker starts, with `O_CREAT|O_EXCL`.
- TDD. Write the failing test, watch it fail, write the minimal code, watch it
  pass, commit. Run `npm run test:main` for main-process tests, or
  `npx jest --config test/jest.config.js <path>` for one file. Guest code uses
  `go test ./...`, the helper `swift test`.
- Never skip a test on a missing dependency. A test that needs a VM runs in
  the live stage and is not stubbed out of CI.
- Commit messages follow the repo's style and trailer.

## Work packages and how they run in parallel

| WP | Worktree branch | Starts | Needs from others to finish | Merges |
|---|---|---|---|---|
| A — Guest image | `vm/guest` | now | nothing (tests against its own `vzrun`) | 2nd |
| B — Swift helper | `vm/helper` | now | a bootable guest: the spike's, or A's once it exists | 3rd |
| C — Electron integration | `vm/electron` | now | nothing (fake helper, stub puller) | 5th |
| D — Puller and cache | `vm/puller` | now | nothing (mock registry, mock daemon) | 4th |
| E — Remove the Docker Desktop backend | `vm/remove-desktop` | now | C's `docker-backend.ts` rewrite, at merge time | 6th |
| F — Packaging, macOS 14, autoDownload | `vm/packaging` | now | nothing | 1st |
| G — Docs | `vm/docs` | now | final names from A–F, at merge time | 7th |

---

## WP-A: Guest image

**Produces:** `build/guest/{vmlinux,initramfs.cpio.gz,rootfs.erofs,manifest.json,LICENSES.md}`
(§4), the guest programs (§3), `vzrun` (§4.3 step 6), the fake agent (§8).
**Consumes:** §3, §4 and §5.2 only.

**Files**

- Create: `guest/go.mod` (with `toolchain` pinned), `guest/cmd/lm-init/`,
  `guest/cmd/lm-agent/`, `guest/cmd/lm-runc/`, `guest/cmd/lm-bindpin/`,
  `guest/internal/{proto,mountinfo,firewall,share,relay,rosetta,selftest,agenttest}/`
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
- [ ] Go: `mountinfo` parser (fields, escapes). `lm-bindpin` matching: an
  approved bind is matched; an unapproved share mount fails; a `ro` mismatch
  fails; a mount not on the share is ignored. `lm-runc` adds the hook to
  `hooks.createRuntime` and keeps existing hooks. Agent protocol: framing,
  64 KiB cap, unknown op, second `configure`, and `approve-binds` limits.
  Share-path validation (`..`, `//`, a top-level name that exists, over 1024
  bytes).

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
- [ ] Build VM: `mkfs.erofs` flags per §4.3. The build fails if the image
  differs between two runs in the same checkout, which `--verify-reproducible`
  checks and CI's guest job runs.
- [ ] `lm-init`, then `lm-agent` (§3.4 in order: clock, disk, share, Rosetta,
  network, `dockerd`, self-test). Then `lm-runc` and `lm-bindpin`, with
  `setns` through a locked thread and `unshare(CLONE_FS)`.
- [ ] Firewall (§3.6) and self-test using `iproute2` netns.
- [ ] Smoke boot records `baseline` and `docker` into `manifest.json`.

**Acceptance (run on the Mac with `vzrun`, recorded in the PR)**

- [ ] `npm run build:guest` from clean produces all five files. A second run
  is a cache hit. With the cache cleared, the build is byte-identical.
- [ ] Boot to `configure` success within 3 s. `selftest` is all true.
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
  network: unreachable. A gateway `0.0.0.0` listener from an internal network:
  refused. DNS for an external name fails in under 100 ms.
- [ ] `DOCKER_BUILDKIT=0 docker build` of a two-stage Dockerfile whose base
  images were loaded first works.
- [ ] With Rosetta: an x86-64 static binary runs and `rosetta: ok`. Without
  (`lm.rosetta` off): `rosetta: absent`.

---

## WP-B: Swift helper `localmost-vm`

**Produces:** `native/localmost-vm/` (a SwiftPM package), `build/native/localmost-vm`
(§2), and the `build:helper` script.
**Consumes:** §1, §2 and §3.1. It does not interpret the guest's bytes.

**Files**

- Create: `native/localmost-vm/Package.swift` (`platforms: [.macOS(.v14)]`),
  `Sources/localmost-vm/{main.swift,Args.swift,Paths.swift,VMConfig.swift,Sockets.swift,Relay.swift,Control.swift,Errors.swift}`
- Create: `native/localmost-vm/Tests/localmost-vmTests/*.swift`
- Create: `scripts/build-helper.mjs`. Modify: `package.json` (`build:helper`)
- Modify: `.github/workflows/check.yaml`: `swift build` and `swift test`
  (compile only; no VM on hosted runners, R28)

**Tests first (XCTest)**

- [ ] The argument parser accepts exactly §2.1. Every id regex is enforced.
  Unknown flags fail. Mode-specific flags are required or refused.
- [ ] Share validation on temp directories: a directory passes. A symlink at
  `_work`, a symlinked sandbox, `_work` missing, or a realpath outside
  `runner/sandbox` → `E_SHARE`.
- [ ] Guest artifact size checks → `E_GUEST_IMAGE`.
- [ ] NDJSON: a 64 KiB cap, unknown commands, a `stop` answer, and the order of
  `listening`, `started`, `stopped`.
- [ ] Exit-code mapping table.

**Steps**

- [ ] Start from the spike's `vzprobe.swift`. Split out config building
  (§2.2), unix-socket servers that dial `connect(toPort:)` per connection
  (§2.3), the vsock 3128 listener that relays to `127.0.0.1:<proxy-port>`, and
  byte copying with bounded buffers on a dispatch queue per connection. Never
  block the VZ queue (the spike's first listener deadlocked by reading inside
  `shouldAcceptNewConnection`).
- [ ] Rosetta: `availability` check; share only when `.installed` and
  `--rosetta auto`; never `installRosetta…`.
- [ ] Refresh mode: after a `guest` stop, `F_FULLFSYNC` the data disk, then emit
  `synced`.
- [ ] Console to `console.log` with the §2.2 cap.
- [ ] Signals and stop per §2.4.

**Acceptance (on the Mac, under `sandbox-exec` with a profile from WP-C's
`buildHelperProfile`, or the spike's `helper.sb` until C lands)**

- [ ] Boots WP-A's guest (or the spike's) and emits `listening`, then `started`.
  `agent.sock` reaches the guest agent. `docker.sock` answers `/_ping`.
- [ ] Relay: a guest connection to vsock 3128 reaches a test TCP server on
  `127.0.0.1:<port>`. With the profile, a connection to any other port is
  refused by seatbelt.
- [ ] The profile refuses to share an ungranted directory, and a granted path
  that is a link elsewhere (EPERM → `E_VZ_START`). This repeats the spike's
  result under the real helper.
- [ ] SIGKILL of the helper: the VZ XPC process is gone within 3 s.
- [ ] Signed with an Apple Development identity and hardened runtime: still
  boots under the profile.
- [ ] Trace what Rosetta needs under the profile, add exactly that to §2.5,
  and boot with Rosetta.

---

## WP-C: Electron integration (with a fake helper)

**Produces:** everything in §5 except the puller internals: `VmBackend`,
`VmManager`, `HelperClient`, `AgentClient`, `helper-profile.ts`,
`guest-image.ts`, `vm/paths.ts`; the filter and evaluator changes; the
runner-manager, runner-downloader, process-sandbox, config and index wiring;
the fake helper (§8).
**Consumes:** §1–§3 as protocols, and `ImagePuller`/`CacheDisks` as interfaces
(§6.4, §6.5). It uses stubs until WP-D merges.

**Files**

- Create: `src/main/vm/{vm-backend,vm-manager,helper-client,helper-profile,agent-client,guest-image,paths}.ts`
  and a `.test.ts` for each
- Create: `test/fakes/fake-localmost-vm.mjs`
- Rewrite: `src/main/docker/docker-backend.ts` (the interfaces only, §5.1)
- Modify: `src/main/docker/docker-filter-proxy.ts` (+ test),
  `src/main/docker/docker-evaluator.ts` (`approvedBinds`; + test),
  `src/shared/docker-policy.ts` (`PROXIED_EGRESS`, `hasDockerGrants`; + test)
- Modify: `src/main/runner-downloader.ts` (`_work`, `.docker`, `writeShareNonce`; + tests),
  `src/main/process-sandbox.ts` (+ `process-sandbox.test.ts`, `process-sandbox.sandbox.test.ts`),
  `src/main/runner-manager.ts` (+ spawns and lifecycle tests), `src/main/config.ts`,
  `src/main/index.ts`

**Tests first**

- [ ] `helper-profile.test`: exact rules per mode. Paths are escaped. The
  proxy port is interpolated. No rule grants `<data>` outside the VM's own
  directory and cache.
- [ ] `helper-client.test` (fake helper): the event order. A malformed event
  kills the helper. `stop` with and without grace. Exit codes map to
  `VmError.code`. SIGKILL after 5 s.
- [ ] `agent-client.test`: schema validation rejects oversized strings, extra
  types and a wrong `id`. Timeouts per op.
- [ ] `vm-manager.test` (fake helper):
  - admission (`maxRunning`, FIFO, the timeout gives `none`);
  - boot failure at each stage gives the logged reason and no retry;
  - a nonce mismatch tears down;
  - cancelled mid-boot means no leak;
  - a helper crash marks the VM failed;
  - `onResume` sends `set-time` and stops the spare;
  - `sweep()` kills only a live `localmost-vm` from this Resources (the pid-reuse
    check) and removes directories;
  - `shutdownAll()` is bounded.
- [ ] `vm-backend.test`:
  - `bind()` with no docker grants never starts a VM;
  - a grant starts one;
  - repository mismatch keeps the socket closed, as today;
  - `baseline()` comes from the manifest;
  - `containerProxyEnv()` uses the worker's current token URL, rewritten to
    `198.18.0.1:3128`;
  - `release()` is idempotent.
- [ ] `docker-filter-proxy.test` (with a fake `WorkerDocker`):
  - pull interception streams progress and never forwards;
  - `X-Registry-Auth` is dropped;
  - create injects the proxy env only for routable networks and keeps the
    job's values;
  - the create answer is held until `approveBinds` resolves;
  - a failed approval deletes the container and answers 500;
  - `buildargs` are merged;
  - the baseline is synthesised when not running and forwarded when running;
  - the endpoint wait and timeout give 503 with the reason;
  - stop skips removal when `disposable`.
- [ ] `docker-evaluator.test`: `approvedBinds` equals the pinned sources with
  `readOnly` for every allowed create, and is empty when there are no binds.
- [ ] `runner-downloader.test`: `_work` and `.docker` exist in a new sandbox,
  and `mkdir` fails on an existing name. `writeShareNonce` refuses an existing
  file or a symlink.
- [ ] `process-sandbox.test`: the node denies come after the sandbox re-allow,
  and there is a CLI read literal.
- [ ] `process-sandbox.sandbox.test` (real `sandbox-exec`). A job can:
  - create, write and remove anything under `_work`, and `rm -rf _work/x/y`.

  It cannot:
  - `mv _work _w2`, `rm -rf _work`, `chmod 000 _work`, or `ln -s ~ _work`
    after removing it;
  - `mv <sandbox> ~/.npm/x` (with a policy write grant on `~/.npm`);
  - connect to a unix socket under `<data>/vm/jobs/`.
- [ ] `runner-manager` spawns and lifecycle: `forWorker` gets the §5.4
  context. The env has `DOCKER_CONFIG` and the PATH prefix. `stopDockerProxy`
  releases. The spare is used only when the claim is for the spawn repository.

**Steps**

- [ ] Interfaces first (`docker-backend.ts`). Compile everything against them
  with `DesktopBackend` still present, so the evaluator and filter tests keep
  running. WP-E deletes it.
- [ ] Fake helper, then `HelperClient`, `AgentClient` and `VmManager`.
- [ ] Filter changes, one at a time, each behind its test.
- [ ] Wiring in runner-manager and index. `sweep()` runs before the first
  spawn.
- [ ] Log lines exactly as in §5.3 (the e2e suite matches them).

**Acceptance**

- [ ] `npm run test:main`, `npm run lint` and `npm run typecheck` pass.
- [ ] With the fake helper selected by `LOCALMOST_VM_HELPER=<path>` (a test-only
  override that `vm/paths.ts` honours only when `NODE_ENV=test`), a
  runner-manager integration test runs a docker job end to end against a mock
  daemon. The log shows boot at the
  claim, the ready line, and the release at exit.

---

## WP-D: Puller, image store, cache disks, credentials

**Produces:** `src/main/docker/puller/*`, `src/main/vm/cache-disks.ts`, the
`registry-auth.ts` changes, and the mock registry (§6, §8).
**Consumes:** §6 and a Docker API endpoint. The tests use a mock daemon
socket that records `POST /images/load` and tag calls.

**Files**

- Create: `src/main/docker/puller/{registry-client,image-store,docker-archive,image-puller,test-registry}.ts`
  with tests, and `src/main/vm/cache-disks.ts` with a test
- Modify: `src/main/docker/registry-auth.ts` and `registry-auth.test.ts`

**Tests first**

- [ ] `registry-auth.test`:
  - a missing helper binary throws `RegistryAuthError` naming it;
  - a helper exiting 1 with `credentials not found` means anonymous;
  - any other helper failure throws;
  - inline `auths` work unchanged.
- [ ] `registry-client.test` (mock registry):
  - the Bearer token flow;
  - basic creds are sent only to the realm;
  - a redirect to a CDN host is followed and screened;
  - http redirects and more than 5 hops are refused;
  - a name resolving to 127.0.0.1 or 10.x is refused;
  - schema1 is refused;
  - 429 is surfaced with Docker Hub's wording.
- [ ] Platform choice (§6.2): arm64 preferred; amd64 when there is no arm64 or
  it was asked for; Rosetta `absent` or `broken` gives the design's message;
  a single-platform manifest is checked.
- [ ] `image-store.test`:
  - a digest mismatch leaves nothing in place;
  - an interrupted write leaves only `.tmp-*`, cleaned at startup;
  - a read re-verifies;
  - `refs.json` updates atomically;
  - LRU trimming stays within the limit.
- [ ] `docker-archive.test`: the tar layout of §6.4 step 4, uncompressed layers,
  `diff_id` checks for gzip and zstd, and a deterministic byte stream.
- [ ] `image-puller.test` (mock registry and mock daemon):
  - progress lines have Docker's shape;
  - a cache hit in the VM skips the load;
  - a store hit skips the network;
  - a pull by digest must match;
  - a tag is created;
  - an abort stops the transfers.
- [ ] `cache-disks.test` (APFS temp dir):
  - `clonefile` is used, with an inode check that the clone is not the
    original;
  - blank when there is no golden disk;
  - refreshes are serialized and debounced;
  - a failure deletes `.new`;
  - a `dataFormat` mismatch discards;
  - `synced: false` never promotes.

**Acceptance**

- [ ] All unit tests pass in CI.
- [ ] Against the real Docker Hub and GHCR, run manually on the Mac: pull
  `alpine:3` and `node:22-alpine` (gzip), and one image with zstd layers.
  `docker load` them into WP-A's guest through `vzrun`'s `--vsock-unix`; the
  image ids match the config digests.
- [ ] A private GHCR image, with the operator's credentials from the osxkeychain
  helper, pulls. With the helper renamed away, the pull fails naming it.

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
  "Docker Desktop is not running"), and `test/e2e/docker.spec.ts` (the
  "real Docker daemon" precondition becomes "the VM backend is available":
  the guest manifest and helper exist).

**Tests first**

- [ ] `grep -r "DesktopBackend\|resolveDockerEndpoint\|docker-desktop" src test`
  is empty (a jest test that reads the tree, so the removal stays removed).
- [ ] The filter tests pass with a fake `WorkerDocker` only.

**Acceptance**

- [ ] `npm run test:main` and `npm run typecheck` pass after rebasing on WP-C.
  No code path resolves or connects to `/var/run/docker.sock` or `~/.docker/run`.

---

## WP-F: Packaging, signing, macOS 14, autoDownload, bundled CLI

**Files**

- Create: `packaging/entitlements.virtualization.plist` (§7.1),
  `scripts/docker-cli.lock.json`, `scripts/fetch-docker-cli.mjs` (+ test)
- Modify: `forge.config.js` (§7.2), `package.json` (`build:native`,
  `fetch:docker-cli`), `src/main/packaging.test.ts` (§7.4),
  `src/main/auto-updater.ts` and `auto-updater.test.ts` (`autoDownload = true`),
  `README.md` (requirements: macOS 14), `docs/release-checklist.md` (attach the
  guest's GPL sources: the Alpine aports commit and the upstream source tarballs
  for linux, busybox, iptables and e2fsprogs; NOTICE files)

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
  guest manifest, the helper and the CLI (§7.2).
- [ ] The `signOptionsForFile` branch.

**Acceptance**

- [ ] `npm test` passes. A `npm run package` on the Mac (the integration stage
  does this, not the worktree) shows these with `codesign -d --entitlements -`:
  - `Resources/localmost-vm` has only `com.apple.security.virtualization`;
  - `Resources/docker-cli/docker` has none;
  - `Info.plist` has `LSMinimumSystemVersion` `14.0`.

---

## WP-G: Documentation

**Files**

- Modify: `SECURITY.md` "Docker Access". Rewrite what the filter contains now
  that the daemon is a per-job VM:
  - G-A is closed, and on what (design S1–S2);
  - cross-job reach is closed (S3);
  - container egress goes through the proxy (S4–S5);
  - credentials stay on the Mac (S6);
  - what is not contained (the design's list);
  - `privileged` is grantable;
  - remove the "open item" about bind re-resolution;
  - document the two findings present before this change (the default bridge
    and joining a network by name) as fixed.
- Modify: `CHANGELOG.md`: Docker Desktop is no longer used; the VM backend;
  macOS 14; auto-download of updates; the policy meaning of routable.
- Modify: `docs/roadmap/localmostrc.md` and `README.md` policy section:
  `routable` means through the job's proxy, proxy settings are injected,
  base images must be pulled before a build, `privileged` is grantable.
- Modify: `docs/superpowers/specs/2026-09-05-docker-isolation-design.md`:
  a status line pointing at the VM design for stage 2, answering its first open
  question (an embedded Virtualization.framework helper).
- Modify: `docs/roadmap/vm-docker-backend.md`: status and the "not yet
  verified" list, as items become verified in integration.

**Acceptance**

- [ ] Every claim in `SECURITY.md` names the mechanism behind it. Nothing
  claims containment of the virtiofs server or of privileged containers.

---

## Integration and live validation

Run by one person, in this order, on the owner's Mac, while no CI job is
running on the runner (the installed app serves CI's localmost legs, and
reinstalling mid-leg fails the job).

- [ ] **Merge** F → A → B → D → C → E → G into the PR #40 branch. Reconcile any
  contract edits the packages made. Rerun `npm test`, `npm run lint`,
  `npm run typecheck`, `go test ./...` in `guest/`, and `swift test` in
  `native/localmost-vm`.
- [ ] **Build:** `npm run build:native` (guest build reproducible across two
  runs), then `npm run make`. Check the §7.4 `codesign` results on the
  packaged app.
- [ ] **Local e2e:** `npm run test:e2e -- test/e2e/docker.spec.ts` (it packages
  the app first, so the helper, guest and CLI are in its Resources), extended to
  check the following:
  - no VM for a job without `docker:`;
  - a VM boots at the claim for one with `docker:`;
  - the pull line says "on the Mac";
  - the existing mount, network and refusal cases still pass;
  - the VM directory is gone after the job.
- [ ] **Install** the built app while the runner is idle. Relaunch it and check
  that the startup sweep ran (the log line).
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
  3. a container with an rw mount runs `ln -s / /d/x`, then a second container
     binds `tmp/ga/d/x`: refused or fails;
  4. `mv _work` (`$RUNNER_WORKSPACE/..`) fails with "Operation not permitted";
  5. a container `wget`s an allowed host through the injected proxy
     (succeeds), a denied host (403 from the proxy), and a raw TCP connect to
     `1.1.1.1:443` (fails at once);
  6. a container on the internal network cannot reach `198.18.0.1:3128`.
- [ ] **Cross-job, live:** run `vm-escape` twice at once (matrix of two). Each
  leg creates network `lm-xjob`, starts a container that records its IP to an
  artifact, then tries to reach the other leg's IP and to join the other's
  network by name. Both are unreachable or refused.
- [ ] **Rosetta, live:** `docker run --rm --platform linux/amd64 alpine:3 uname -m`
  gives `x86_64`.
- [ ] **At the machine (the owner present):**
  - sleep for 10 minutes mid-job, then wake: the guest clock is corrected
    (`date` in a container);
  - four concurrent docker jobs: record memory, swap and the admission log;
  - with `dockerVm.prewarm: true`: claim latency and the spare's lifecycle.
- [ ] Update the design's "What was verified" list and the README roadmap
  status. Generalize the PR #40 description to cover this work, on the same PR.
