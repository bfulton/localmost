# macOS VM Jobs - An Opt-In Isolation Level

A repository can choose to run each of its jobs inside a fresh macOS virtual
machine instead of under seatbelt on the host:

```yaml
isolation: [macos-vm]        # an ordered list; the default is seatbelt
```

> **Status:** built as a self-contained mode behind the isolation backend
> interface, with unit tests throughout; not yet wired into job selection
> (the `isolation:` key, the host's `isolation.allowed` setting and the
> refusal when nothing matches live on their own branch), and not yet run end
> to end on a Mac. What was run live, and what the owner runs to finish it,
> is under [Live validation](#live-validation).

## Problem

Today a job runs as the operator's user under a seatbelt profile. That
profile is an allowlist and has been hardened, but it is the same kernel, the
same user and the same filesystem as everything else the operator does. Some
repositories deserve more: an untrusted contributor's workflow, a build that
runs arbitrary third-party code, a job that needs admin rights in its own
machine. For these the only boundary strong enough is a separate machine.

## What a job gets

Each job runs in a macOS VM of its own, booted from an APFS clone of a golden
image that no job has ever touched, and thrown away with its clone when the
job ends. Inside it the job is the guest's ordinary, non-admin `runner` user.
The VM has no network card and no share of any host directory. Its only ways
out are two vsock relays: one to the job's own `ProxyServer`, one to the local
broker. The runner inside reaches the broker with the per-worker key the host
issued, exactly as a sandboxed worker does, and never holds the registration's
key.

So, against a job in this mode:

- **The operator's data** is not in the guest. Nothing of the host is shared
  into it, and the guest cannot reach the host's filesystem, its loopback
  services or its LAN: it has no route to anything but the two relays.
- **Root on the Mac** is not reachable from the guest except through a flaw
  in Virtualization.framework's devices. Root in the guest is not root on the
  Mac, and the job is not root in the guest.
- **Other jobs** each have their own VM, disk clone, machine identity and
  saved state. No disk, share or socket is common to two jobs.
- **Egress** goes through the job's proxy or nowhere. A tool that ignores
  `HTTPS_PROXY` has no route; it fails rather than going around the filter.
- **A desktop and a temp of its own.** The guest has its own window server,
  so jobs that need a GUI - Electron, the Simulator, UI tests, Safari - run,
  and the shared-temp exceptions a seatbelt job needs (bare `mktemp`'s names,
  Swift Build's link temp in the user's per-user temp directory) do not
  exist: the guest's temp is its own.

What a job can still do is listed under [What a job can still do](#what-a-job-can-still-do).

## The pieces

```
Electron main                          localmost-macvm (helper)          macOS guest
src/main/isolation/macos-vm/           one process per command,          localmost-macvm-agent
  index.ts      the mode, put together   under a profile per command       root LaunchDaemon
  golden-image  build, check, sweep    install / provision / save-state    vsock 1025, host only
  backend       one VM per job         run: clone, restore, vsock relays   relays 127.0.0.1 ->
  slots         the two-VM queue                                             host vsock 3128/8787
  helper-client spawn + NDJSON         <data>/macos-vm/slots/<n>.lock     runner as `runner`
  agent-client  the agent's protocol     (flock: two VMs at most)
  bootstrap     the one-time setup over SSH
src/renderer/components/MacVmSetup.tsx the setup page component
src/main/ipc-handlers/macos-vm.ts      its IPC, trusted-ipc guarded
```

The wiring step creates the mode with `createMacVmMode()` at app start, calls
`start()` (the sweep and the image check) before the pool takes jobs,
registers the IPC with the mode's image manager, mounts `MacVmSetup` in
Settings, and hands the backend the jobs whose isolation is `macos-vm`.

### The backend interface

`types.ts` declares what every isolation mode is meant to share, for the
wiring step to hoist:

```ts
interface IsolationBackend {
  readonly type: 'seatbelt' | 'service-account' | 'macos-vm';
  available(): { ok: true } | { ok: false; reason: string };
  prepare(job, signal?): Promise<void>;      // the VM up, the agent prepared
  spawnWorker(job, argv, env): Promise<WorkerHandle>;   // argv is ['--once']
  signal(job, sig): Promise<void>;          // SIGTERM, SIGINT, SIGKILL
  release(job): Promise<void>;              // the VM stopped, its clone gone
}
```

A `WorkerHandle` emits `stdout`/`stderr` lines and one `exit`, like the child
process the seatbelt path has, and holds its events until the turn after it
is made, so a caller that attaches listeners once `spawnWorker` resolves sees
the first line too.

## The helper

`native/localmost-macvm` builds two programs: the helper, signed with only
`com.apple.security.virtualization`, and the guest agent, signed with no
entitlement.

**Decision: a sibling package, not a mode of `native/localmost-vm`.** That
helper's contract is a Linux guest booted from artifacts in Resources, with a
share and a docker socket. This one installs macOS from an IPSW, keeps a
golden image and its saved states, opens a window for the guided setup, and
builds a guest agent from the same sources. Folding them together would make
each helper's review depend on the other's code. The relay, framing and
parent-watch code is copied from the Linux helper rather than shared, for
the same reason.

The helper is one short-lived process per command, speaking NDJSON on stdio
and ending with exactly one `end` event:

| Command | What it does |
|---|---|
| `version` | Its version, the contract's and the agent's, and whether it was built with macOS 27's guest provisioning |
| `catalog` | `VZMacOSRestoreImage.fetchLatestSupported`: the build, its URL, minimum CPUs and memory |
| `inspect --ipsw` | What a downloaded restore image holds, and whether this Mac supports it |
| `install` | `VZMacOSInstaller` into a new image directory: sparse disk, aux storage, `config.json` last |
| `provision --display none\|window` | The first boot: headless with guest provisioning, or in the guided window |
| `save-state --slot` | Boots the slot's clone with the slot's identity, waits for the agent's ready hello, pauses and saves |
| `run` | A job VM: clones, restore or cold boot, `agent.sock`, the two vsock relays |
| `check` | The image as the helper sees it: its files, its config, each slot's state stamp |

**Every path is derived, never given.** The helper takes `--data-dir` and ids
of a fixed form (`[0-9a-f]{12}` for an image, `[12]-[0-9a-f]{12}` for a VM,
`1|2` for a slot); every directory is opened with `O_NOFOLLOW` and its real
path read back with `F_GETPATH`. Electron makes the directories before it
spawns the helper; the helper makes none and follows no link to them. The
restore image must be a regular file directly in `<data>/macos-vm/ipsw/`.

**No secret on a command line.** The provisioning account arrives on stdin.
The helper's arguments are visible to every process of the user.

**Profiles.** Electron writes a deny-default seatbelt profile for each
command (`helper-profile.ts`) granting the helper binary and exactly the files
that command touches: the restore image read-only for `inspect` and
`install`; the image directory for `install`, `provision` and `save-state`;
the golden image read-only and the VM's own directory for `run`, with
exactly two loopback ports, the job's proxy and the broker. Any command that
boots a VM also gets IOSurface's user client and a listing of the helper's
own directory, found live: VZ hands the helper the guest display's frames as
IOSurfaces even headless, and without these the helper crashed as the
installer's display came up. The guided window additionally gets what AppKit
needs to draw.

**Parent death.** The helper watches its parent with kqueue and treats EOF
on stdin as the parent gone; either stops the VM with no grace. VZ runs the
VM in its own XPC process, which does not die with Electron, so nothing else
would stop it. It refuses to start as an orphan.

**Jobs cannot run it.** A seatbelt job that could exec the helper could
install a macOS VM of its own, and the provisioning boot has a NAT network
card - a way out past the job's proxy. The job profile denies its exec by
path, beside the Docker VM helper's deny; the seatbelt test shows it refused
by path, a case variant, a link and a copy.

## Restore image

`catalog` asks VZ for the latest restore image this Mac supports. Electron
downloads it (`restore-image.ts`) from the one URL the catalog named, which
must be on `updates.cdn-apple.com`, into `<data>/macos-vm/ipsw/<build>.ipsw`:
every byte to a `.partial` file opened without following a link, resumed with
a `Range` request where a previous attempt stopped, renamed into place only
once complete.

**Decision: SHA-1 when Apple publishes it, otherwise TLS and the installer.**
VZ names no checksum. Apple's IPSW catalog (`mesu.apple.com`) lists the
latest release with its `FirmwareSHA1`, but not older ones: a macOS 27 host
is offered the latest and gets checked; this macOS 26.6.2 host is offered
26.6.2 (25G83, 18.4 GiB), which the catalog no longer lists. The checksum is
used whenever the catalog lists exactly the URL VZ named; otherwise the
download rests on TLS to Apple's host and on `VZMacOSInstaller`, which
verifies the Apple-signed firmware in the image before installing any of it.
Then `inspect` reads the file back and must report the build the catalog
named.

The restore image is kept until an image is ready, so a failed build retried
does not download 18 GB again, and removed once one is. Before downloading,
the free space must cover the image's remaining bytes plus the image estimate
and a reserve (below).

## The golden image

`golden-image.ts` builds it in phases the setup page shows:

1. **catalog** and **download**, above, and **verify** (`inspect`).
2. **install** into `images/<id>/`: a 100 GiB sparse `disk.img`, `aux.img`,
   and `config.json` holding the hardware model, **two** machine identifiers
   (one per slot, below), a MAC address for the provisioning boot, the
   build and the minimum shape. `config.json` is written last, so an image
   without it never finished. The disk is sparse: it costs what macOS, the
   tools and the runner write, not 100 GiB.
3. **provision**: the first boot (below) - headless on macOS 27, the guided
   setup before that.
4. **setup**, over SSH while that boot runs (below).
5. **save-state** for each slot (below).
6. **check**, and only then does `current.json` name the image.

A failed or cancelled build leaves no image. At start the manager removes
every image directory `current.json` does not name, checks the current one,
and if the Mac has a newer macOS build than a slot's state was saved on,
saves that slot again (VZ refuses a state across host updates). Once the Mac
runs a newer macOS **major** than the image was built on, the page
recommends a rebuild.

**Decision: the operator rebuilds; nothing rebuilds on its own.** A rebuild
downloads ~18 GB and, before macOS 27, needs the operator at the guided
window. Doing it unasked at a host update would surprise them with both.
The old image keeps working until they do (VZ runs older guests), and is
removed only when no job VM runs on it.

**Integrity.** The golden disk is booted only by `provision`. Every later
boot, save-state included, runs from a clone. No job input ever reaches the
golden image, and each slot's state is taken before any exists in the guest.

### Accounts

Two guest accounts, with separate roles:

- **`localmost-admin`**, an administrator, exists only so the one-time setup
  can run as root over SSH. Its password is random, made by Electron, held
  only in the image's 0700 bootstrap directory while the setup runs, and at
  the end of the setup replaced by another random password that nobody
  keeps. The account remains, unusable.
- **`runner`**, an ordinary account, logged in automatically, is who every
  job runs as. Its password is random and kept only in the guest's
  `/etc/kcpassword`, which auto-login needs and only root can read.

**Decision: a non-admin job user and a separate admin used once.** The job
user being non-admin is what keeps the job from changing the guest's
network configuration, the agent, the runner or its LaunchDaemon, all of
which are root's. An admin is still needed to install those, so it is
created for that alone and its password discarded.

### Provisioning: macOS 27 and later

On a macOS 27 host, with a helper built with the macOS 27 SDK (Xcode 27,
Swift 6.4), `provision --display none` starts the first boot with
`VZMacGuestProvisioningOptions` inside `VZMacOSVirtualMachineStartOptions`:
it creates `localmost-admin`, skips Setup Assistant, leaves auto-login off
(the setup makes `runner` the one logged in) and turns Remote Login on.
macOS 27's `fetchLatestSupported` gives a macOS 27 guest, which that API
needs. Nothing is shown and nothing is asked of the operator.

A helper built with an older Xcode leaves the API out (`#if compiler(>=6.4)`),
says so in `version`, and refuses `--display none`; the setup page then
offers the guided setup.

### Provisioning: the guided setup before macOS 27

On macOS 26 the API does not exist. The page shows the account's values and
the steps (`guidedSetupSteps`), and a button that opens the VM's display
(`VZVirtualMachineView`) in a window: the helper's `provision --display
window`. The operator clicks through Setup Assistant once - no Apple
Account, the account exactly as shown, Remote Login on in System Settings -
and leaves the window open. localmost takes it from there, and the window
closes when the guest shuts down.

**Decision: a window the operator opens, never one opened for them.** The
build pauses at `needs-guided-setup` until the operator presses the button,
so no window appears unasked.

**Decision: guided rather than scripted Setup Assistant.** Tart and Cirrus
script Setup Assistant by typing keystrokes at the VM's display. That breaks
with each macOS release's screens and would be tested only against the
releases someone had time to try. Six steps, once per image, by a person who
can see the screen, is the more dependable choice until macOS 27 makes it
unnecessary.

### The one-time setup

While the provisioning boot runs with Remote Login on, `bootstrap.ts` finds
the guest's address from bootpd's lease for the image's MAC address (it must
be a private IPv4 address), copies the agent and the host's runner into the
administrator's home over SSH, and runs `sudo localmost-macvm-agent setup`
with its inputs as one JSON object on stdin. The agent's plan
(`MacVMAgentCore/Setup.swift`, readable and tested on the host):

1. create `runner`, not an administrator; its home
2. its password into `/etc/kcpassword`; auto-login as `runner`
3. no sleep; Setup Assistant's first-login screens marked as seen
4. the runner into `/usr/local/localmost/runner/<version>`, root's
5. the Xcode Command Line Tools, the newest `softwareupdate` offers
6. the agent into `/usr/local/libexec/localmost`, root's, and its
   LaunchDaemon; the setup's marker
7. the administrator's password replaced by one nobody keeps
8. Remote Login disabled from the next boot, sshd booted out, and the guest
   shut down

The administrator's password reaches ssh only through `SSH_ASKPASS`, a script
in the 0700 bootstrap directory printing a 0600 file beside it, and sudo reads
it from stdin. ssh reads no configuration of the operator's (`-F /dev/null`),
offers no key or agent of theirs, and keeps the guest's host key in the
bootstrap directory: the guest is new, so its first key is taken and any
other refused. Both files are removed when the setup ends. Inside the
guest, `sysadminctl` takes passwords only as arguments, so the job user's
and the administrator's are briefly on a guest command line; at that point
the guest runs nothing of a job's, the job user has never logged in, and the
administrator's password is discarded minutes later.

**Decision: SSH during provisioning, not a shared directory.** Remote Login
is something both provisioning paths can turn on: the API does it on macOS
27, and it is one of the guided steps before that. A provisioning-time
virtiofs share would need the operator to mount it and run an installer by
hand before macOS 27, and gives a host directory to a guest whose image every
job will start from. The provisioning boot is the only one with a network
card, and Remote Login is off again before any later boot.

### Toolchains

The golden image gets the Command Line Tools from `softwareupdate` during
the setup, and the runner. **Full Xcode is a later, optional step**, not
built: Xcode cannot be redistributed, so it would come from a `.xip` the
operator provides; a recent Xcode is roughly 3 GB to download and over 10 GB
installed, plus several GB for each simulator runtime. On this Mac (64 GB free at the
start, 41 GB now) that is the difference between an image that fits twice
and one that does not.

## Slots and machine identity

**At most two macOS VMs at a time,** the macOS licence's limit and VZ's.
Two layers enforce it:

- `slots.ts`, Electron's queue, shared by job VMs and the build alike: first
  come, first served, a job waiting for a slot rather than failing, never more
  at once than the Mac's limit - two, or one when its memory fits only one
  (each job VM is 4 CPUs and 6 GiB; the host keeps 4 GiB). A 16 GB Mac runs
  two.
- the helper's flock on `slots/<1|2>.lock`, held for the life of every
  command that boots a VM. Even if Electron's count were wrong, a third
  helper is refused (`E_SLOT`).

**Decision: one machine identifier per slot.** Two VMs running at once with
one machine identifier is undefined behaviour in the guest
(`VZMacPlatformConfiguration.h`). A golden image therefore holds two
identifiers, and a VM presents the one of the slot whose lock it holds -
install, provision, save-state and run alike - so the lock that limits the
Mac to two macOS VMs also keeps any two from sharing an identity. A third
concurrent VM is impossible, so two identifiers are enough.

A saved state goes with the memory of one boot over one disk, so each slot
has its own: `save-state` clones the golden disk and aux storage into
`<image>/slot<n>/`, boots that clone with the slot's identity, waits for the
agent to say it is ready, and saves beside it with a stamp naming the slot,
the host build, the helper version and the VM's shape. A job may run only in
a slot with a saved state, since a slot without one has an identity no boot
has proved.

## A job

`backend.ts`, per job:

- **prepare**: a slot from the queue; at least 10 GiB free on the data
  volume; the VM directory; the helper's `run` under its profile, which
  clones the slot's disk and aux storage into the VM directory (APFS
  `clonefile`, milliseconds) and restores the slot's state, or boots a clone
  cold when the state no longer fits (another host build, shape or helper);
  the agent's hello, which must say `ready` (its setup finished and no job
  has reached this boot); then `prepare`: the host's time, 64 bytes of fresh
  entropy, and the two loopback ports to relay.
- **spawnWorker**: `--once` and nothing else. If the guest lacks the host's
  runner version, the host's runner is packed and uploaded (sha256-checked,
  at most 512 MiB) so the guest always runs the same version as the host's
  arc. Then the job: the worker's three runner files (`.runner`,
  `.credentials`, `.credentials_rsaparams`, each a regular file read without
  following a link, at most 16 KiB) and an allowlisted environment (proxy
  variables, locale, time zone, runner debug flags). The agent starts the
  runner as `runner` in that user's login session, through `launchctl
  asuser` and its own `exec-as`, which drops root and checks it cannot get
  it back.
- **signal**: TERM, INT or KILL to that runner, through the agent.
- **release**: the helper stopped with no grace (VZ pulls the plug: the guest
  is the job's), the VM directory and its clones removed, the slot freed.

**Decision: restore, not cold boot, at each job.** A restore puts the job
at a logged-in desktop in seconds; a cold boot of macOS and an auto-login
take a minute or more. The cold boot remains the fallback whenever a state
does not fit, so a host update slows jobs down until the states are re-saved
at the next start, but never stops them.

**Restored state repeats entropy.** Every job of a slot starts from the same
memory, so the same kernel RNG state and the same in-memory keys of anything
running. The agent therefore credits the host's fresh entropy to the guest's
random device and sets the clock before the runner starts, and the state is
taken with no job input and no service holding keys.

**One job per boot, ever.** The agent allows one `prepare` and one job per
boot. A VM is the job's and is thrown away after it. A connection that closes
while the job runs kills the job, since nobody is left to read it, and a VM
or agent lost mid-job ends the worker with SIGKILL.

**The workspace stays in the VM.** There is no host share by default; the
checkout, build products and caches live on the clone and go with it.
Artifacts and caches leave through the runner's own upload paths, through
the proxy, like any other egress.

**Disk.** A job's clone shares the golden image's blocks and grows only by
what the job writes, but its length is 100 GiB. Below 10 GiB free on the
data volume no VM starts, and every five seconds a running job's VM is
checked and, below it, stopped (the job ends with SIGKILL). An unreadable
volume counts as full.

**The sweep.** Before any job, every VM directory left by an earlier run is
removed, and its recorded helper killed only if that pid is alive and its
executable is this app's helper (a pid may have been reused). Leftover
profiles go too.

## Network

**Decision: no network card at all, and vsock relays.** The save-state and
job VMs have no network device. The helper listens on two host-side vsock
ports, 3128 and 8787, and relays each connection to one loopback port of the
host: the job's proxy and the broker. In the guest, the agent listens on
`127.0.0.1:<proxy port>` and `127.0.0.1:<broker port>` and relays to those
vsock ports, so the worker's `HTTPS_PROXY` and broker URL work unchanged.
This is the Linux Docker VM's pattern.

The alternative was guest NAT with pf in the guest, configured by the agent
as root, plus the system proxy settings. It was rejected because every rule
of it is software inside the guest: a kernel flaw, a privilege escalation, or
a pf rule wrong for one macOS release would put the job on the operator's
LAN. With no card there is nothing to configure, nothing a guest root could
re-enable, and nothing to keep in step with macOS. System proxy settings are
not set: with no network service there is nothing to attach them to, and a
tool that ignores the environment's proxy gets no route - it fails closed,
as it does under seatbelt.

vsock in macOS guests: `VZVirtioSocketDevice` is supported for macOS guests
(Tart's guest agent uses it), and the agent's listener accepts only
connections from the host's CID, so nothing inside the guest can reach the
agent's control port.

## Availability

`available()` says yes only when (`host.ts`, `backend.ts`):

- the Mac has Apple silicon (VZ runs macOS guests nowhere else);
- it runs macOS 14 or later (save and restore, which every job start uses);
- its memory fits one job VM beyond the host's 4 GiB;
- this build of localmost has the helper;
- a golden image is ready: built, checked, with at least one slot's state.

Otherwise it gives the reason (no image yet - build one in Settings; still
being built; the image's own failure). The two-VM limit is not a refusal: a
third job waits for a slot.

## Setup UI and IPC

`MacVmSetup.tsx` is a self-contained component the wiring step mounts in
Settings. It shows, by state: why this Mac cannot run macOS VMs; before an
image exists, what the build does, whether it needs the operator (the guided
setup before macOS 27) and the disk it needs against what is free, refusing
a build the disk cannot hold; during a build, its phase, progress and Cancel;
at the guided setup, the values to type, the steps and the button that opens
the window; once ready, the image's macOS, its size on disk, whether one or
two jobs can run at once, the rebuild recommendation after a host major
update, and Rebuild and a confirmed Remove, held while a job VM runs.

It talks only through the preload's `macosVm` group. The handlers
(`ipc-handlers/macos-vm.ts`) answer only the app's own window, through
`trusted-ipc` like every handler, take no argument from the renderer - the
manager keeps one image, so nothing the renderer sends is a path or an id -
and return a refusal as a failed `Result`.

## Packaging

`npm run build:macvm` builds both programs for release on arm64 into
`build/`, signed ad hoc as `build:helper` signs the Docker VM helper;
`build:native` runs it, so packaging builds it. The prePackage check refuses
a build whose helper or agent is missing, a link, not executable, or not a
thin arm64 executable. The packager copies both into `Resources`; osx-sign
gives `localmost-macvm` `com.apple.security.virtualization` and nothing else,
by exact name in the app's own Resources, and the agent none. The packaging
tests hold all of this, and that nothing else of the app gets that
entitlement. CI's native job builds and runs the package's XCTests on a
hosted Apple silicon runner; nothing there boots macOS.

## What a job can still do

- **Use its egress.** Anything the job's proxy allows, it can reach, and
  through it exfiltrate what the job holds - its checkout and its secrets.
  That is the policy's to bound, as for a sandboxed job.
- **Talk to the broker as its worker.** It holds its worker's key, which
  works only at its own worker's broker endpoint, as on the host.
- **Become root in its guest** through a macOS flaw. Root in the guest can
  rewrite the agent's answers, but Electron treats every agent line as
  untrusted and bounded, and the VM is discarded at the end. Root in the
  guest has no network card to bring up and reaches the host only through
  the same two relays.
- **Attack Virtualization.framework** through the devices the VM has: a
  virtio disk, the Mac graphics device, a keyboard and trackpad, entropy and
  vsock. That is the boundary this mode rests on.
- **Use the Mac's resources.** 4 CPUs and 6 GiB of memory for the job's life,
  and disk up to the reserve, after which its VM is stopped. Both job VMs
  share the reserve, so one job's writes can end the other's.
- **Hold its slot until its job's timeout.** One job per boot keeps it from
  doing more than that.

## Edge cases

- **Another app's macOS VMs.** VZ's two-guest limit is per Mac. A VM of
  another app's (UTM, Tart) makes a start fail with `E_VZ_START`; the job
  fails with that message rather than waiting.
- **A host update between builds.** The slot states are re-saved at the next
  start; until then each job cold boots.
- **A restore image newer than the host.** `fetchLatestSupported` offers only
  what the host supports, and `inspect` refuses an unsupported image.
- **The provisioning boot never gets a lease.** The setup gives up after its
  timeout and the build fails, leaving no image; the restore image is kept.
- **The operator closes the guided window early.** The provisioning VM stops,
  and the build fails unless the setup reported done.
- **Cancelling a job while it waits for a slot** leaves the queue and starts
  nothing.
- **Electron killed mid-job.** The helper sees its parent gone and stops the
  VM; the next start's sweep removes the clone.

## Not built yet

- **Policy filesystem grants.** A macOS VM job sees nothing of the host, so
  `filesystem.read`/`write` grants give it nothing. Read-only virtiofs shares
  of granted paths, and writable grants as per-job APFS clones, are the next
  step if repositories need them; every share would follow the Docker
  backend's unswappable-share rules (resolved at `Start()`, created by
  localmost, denied as a node to the job, checked by the helper).
- **Docker.** M2 has no nested virtualization, and Apple's (macOS 15, M3 or
  later) is for Linux guests only, so a macOS guest cannot run Docker. The
  route would be the filtering socket over vsock to a sibling Linux VM, with
  the open question of how that VM sees the macOS guest's workspace.
- **Full Xcode**, above, and several images keyed by macOS and Xcode version
  as GitHub's `runs-on: macos-15` is.
- **Signing identities** in the guest; **Rosetta** in a macOS guest; caches
  across jobs, which reopen the per-repository cache questions the Docker
  backend answered with refresh VMs.

## Live validation

### Run on this Mac (M2, 16 GB, macOS 26.6.2)

Headless only, within a 25 GB free-disk floor:

- `catalog`, sandboxed under its generated profile, returns macOS 26.6.2
  (25G83) at `updates.cdn-apple.com`, minimum 2 CPUs and 4 GiB. The IPSW is
  19,772,231,540 bytes (18.4 GiB), served with `Accept-Ranges: bytes`, so the
  resumed download works against it. Apple's IPSW catalog does not list it,
  so this host's image gets no SHA-1 check, as designed.
- The IPSW was downloaded, and `install` ran headless into a sparse disk:
  unsandboxed it reached 68% before a free-disk watchdog stopped it, as other
  work on the Mac and the growing image took the volume under the floor.
- Under the generated install profile the helper crashed as the installer's
  display came up, until IOSurface's user client and a listing of the
  helper's directory were granted; with those, the sandboxed install ran to
  24% and was stopped on purpose.
- The IPSW and the partial images were deleted. A complete install, the
  first boot, the install's time and final disk use, and two clones booting
  at once were not reached: by then the volume had 41 GB free, under the
  45 GB this work required before downloading the IPSW again. The
  machine-identifier question is settled by the SDK's documentation instead
  (one identifier per running VM, above), not by a live boot.

### For the owner

On macOS 27 (headless) or macOS 26 (guided), after the wiring step mounts
the setup component, with 45 GB free:

1. `npm run build:macvm`, then run the dev app.
2. Settings, macOS VM: **Build the golden image**. Expect catalog, download (18-20 GB), verify,
   install (minutes), then on macOS 27 provision, setup, save-state and check
   with no window; on macOS 26 the page stops at the guided setup: press
   **Open the setup window**, follow the six steps with the values shown, and
   leave the window. Expect it to close on its own after the Command Line
   Tools install, and the page to show the image ready with two slots.
3. In the data directory the wiring step gives the mode (`<data>` below),
   `ls -l <data>/macos-vm/images/<id>/ <data>/macos-vm/images/<id>/slot1`
   shows `disk.img`, `aux.img`, `config.json` and per slot `state.vzvmsave`;
   `du -sh` that directory to record the image's real size, and note the
   install's time from the app's log.
4. A repository with `isolation: [macos-vm]` in an approved `.localmostrc`
   and a workflow that runs `id; sw_vers; xcode-select -p; curl -sI
   https://github.com; curl -s --noproxy '*' https://github.com || echo
   no-route; ls /Volumes`. Expect: uid of `runner` and not in `admin`, the
   guest's macOS, `/Library/Developer/CommandLineTools`, a 200 through the
   proxy, `no-route` without it, and no host volume.
5. Two such jobs at once both run, each in its own slot (the app's log names
   slots 1 and 2); a third waits until one ends.
6. After the jobs, `<data>/macos-vm/vms/` is empty and `pgrep -fl
   localmost-macvm` finds nothing.
