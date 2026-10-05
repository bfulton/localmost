# macOS VM Jobs

Every job the runner takes runs inside a fresh macOS virtual machine, and the
VM is thrown away when the job ends.

> **Status:** wired: the runner pool hands every job to this backend, and
> takes no job until a golden image is ready, and `localmost test` borrows a
> VM from it for each run ([A test run](#a-test-run)). Unit tested
> throughout; not yet run end to end on a Mac. What was run live, and what the
> owner runs to finish it, is under [Live validation](#live-validation).

## Problem

A job used to run as the operator's user under a seatbelt profile. That
profile was an allowlist and had been hardened, but it was the same kernel,
the same user and the same filesystem as everything else the operator does,
and every grant a build needed - toolchains in the home directory, the
per-user temp directory, Xcode's preferences - was a hole in it. The only
boundary strong enough for an untrusted contributor's workflow, or a build
that runs arbitrary third-party code, is a separate machine; and once jobs
have one, there is no reason to keep the other.

## What a job gets

Each job runs in a macOS VM of its own, booted from an APFS clone of a golden
image that no job has ever touched, and thrown away with its clone when the
job ends. Inside it the job is the guest's ordinary, non-admin `runner` user.
The VM has no network card and no share of any host directory. Its only ways
out are two vsock relays: one to the job's own `ProxyServer`, one to the local
broker. The runner inside reaches the broker with the per-worker key the host
issued, and never holds the registration's key.

So, against a job:

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
  and the shared-temp exceptions a seatbelt job needed (bare `mktemp`'s names,
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

`index.ts` creates the mode with `createMacVmMode()` at app start, gives the
runner manager its backend, registers the IPC with the mode's image manager,
and calls `start()` (the sweep, then the image check). `MacVmSetup` is the
macOS VM section of Settings.

### The backend interface

`types.ts` declares what the runner manager calls:

```ts
interface IsolationBackend {
  readonly type: 'macos-vm';
  available(): { ok: true } | { ok: false; reason: string };
  prepare(job, signal?): Promise<void>;      // the VM up, the agent prepared
  spawnWorker(job, argv, env): Promise<WorkerHandle>;   // argv is ['--once']
  signal(job, sig): Promise<void>;          // SIGTERM, SIGINT, SIGKILL
  release(job): Promise<void>;              // the VM stopped, its clone gone
}
```

A `WorkerHandle` emits `stdout`/`stderr` lines and one `exit`, and holds its
events until the turn after it is made, so a caller that attaches listeners
once `spawnWorker` resolves sees the first line too.

### The runner manager

`runner-manager.ts` runs every worker this way. For a job admission let
through, it builds the worker's sandbox directory, writes its `.runner`
(pointed at the broker with the worker's key) and its per-start
`.credentials`, starts its proxy with the job's policy, and then calls
`prepare` and `spawnWorker(job, ['--once'], env)`. The runner's output lines
and its exit drive the slot as they always did. Stopping a worker sends
SIGTERM through the agent and, five seconds later, releases the VM under it;
a worker's exit, a reap of one that never took its job, and `stop()` all
release its VM and then remove its sandbox. A stop while `prepare` still
waits for a slot or a boot aborts it.

- **Two at most.** The pool runs `min(runner count, concurrentVmLimit)`
  workers: two, or one on a Mac whose memory fits only one VM. Its capacity
  check also leaves out a VM the golden image's build or save-state, or a
  `localmost test` run, holds, and a slot the image has no saved state for,
  so the broker does not acquire a job that would only wait for a VM. A job
  that still finds none free (a race with a save-state) waits at most
  `SLOT_WAIT_MS`, a minute, for one and then fails rather than hang.
- **No image, no jobs.** While `available()` says no, the pool's capacity
  check refuses, so the broker leaves jobs with GitHub; the runner's status is
  offline with the reason, logged once. The heartbeat is stopped and cleared
  meanwhile, so a workflow that picks self-hosted by `LOCALMOST_HEARTBEAT`
  sends its job elsewhere rather than queueing it here; a runner that starts
  without an image starts no heartbeat. A change of the image's status
  refreshes both: the heartbeat starts again once a job can get a VM, unless
  the runner is paused.
- **The policy.** The level and hosts go to the job's proxy, as before. The
  environment is the locale, the time zone and what the approved `env:`
  allows of the app's, then the runner's settings and the proxy. Filesystem
  grants and `network.loopback` are not provided: the runner names them in
  the log when the job starts. A policy that grants Docker is refused at
  admission until the Docker relay exists. The drift stamp is taken over the
  whole approved policy - network, Docker, filesystem grants and env - so a
  worker started before its workflow was known matches its claim unless the
  approved policy changed in between.
- **Registration** (`config.sh`) runs on the host, unsandboxed: it runs no
  workflow code, from a copy checked against the release.

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

**Jobs cannot run it.** A job runs in a guest, which has neither the helper
nor any way to the host's processes. (A process that could exec the helper on
the host could install a macOS VM of its own, and the provisioning boot has a
NAT network card - a way out past any proxy.)

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
  following a link, at most 16 KiB) and its environment, each name held to
  `jobEnvNameAllowed`: the runner's own settings (proxy variables, locale,
  time zone, runner debug flags), and any other plain name the approved env
  policy passed, but none the agent sets, none that changes how the shell
  starts, and none with the loader's, .NET's, the runner's, Actions' or
  GitHub's prefixes. The agent holds the job to the same rule. It starts the
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

## A test run

`localmost test` runs a workflow's steps in a VM from the same backend, so a
local run meets the guest a job meets and nothing of the Mac. It has no runner:
the CLI parses the workflow and drives each step itself.

- **The VM is the app's.** The CLI asks the running app over its control
  socket (`test-vm`, with the run's proxy port and a closed port standing in
  for the broker). The app takes a slot and prepares a VM as for a job
  (`prepareTestRun`), answers with the VM's `agent.sock`, and releases the VM
  when that connection closes - at the run's end, on an error, or when the
  CLI dies. The two-VM limit, the disk reserve and the sweep hold as for jobs.
- **The CLI drives the agent.** It dials `agent.sock` itself, on a second
  connection, and sends `put` with the host's copy of the checkout as a tar
  (at most 512 MiB) into `/Users/runner/work/workspace`, a remote action's code
  the same way into `actions/<16 hex>` when a step first uses it, and `step`
  for each step: `bash`, `sh` or `zsh` with its script, or the runner's own
  node with an entry point, a `cwd` in the workspace and the step's
  environment. The agent unpacks each upload as `runner` (`mkdir` and `tar`
  through `exec-as`), runs each step as `runner` in its login session, streams
  its output, and ends it with an `exit` that carries what it wrote to
  `GITHUB_OUTPUT` (at most 16 KiB). After each job the CLI sends `KILL`, which
  reaches every process group the job's steps started.
- **The broker relay leads nowhere.** The helper's `run` takes two ports; a
  test run needs only its proxy, so the CLI passes a port it holds that
  closes every connection, rather than a free one some other process could
  take, or the app's broker.

**Decision: the CLI, not the app, runs the steps.** The workflow parser,
expressions, secrets and masking already live in the CLI, and the agent's
`step` is generic enough to serve them. The app lends the VM and nothing
more, so a test run cannot change what the app does for jobs.

**Decision: a narrow `step`, not a shell.** The agent takes four programs and
paths under the test root only, an environment of the names a job may be
given plus `GITHUB_*` and `RUNNER_*`, and bounded sizes. A step's script and
output file sit in a directory of root's (`/var/db/localmost/run`), created
without following anything at the name, so the step can use them but never
put a link where the agent writes or reads. A boot runs a job or a test run,
never both, and only the connection that sent the workspace can run or signal
steps; closing it kills them.

**Edge cases.** No app running, or no image ready: the run stops before any
step with a message naming the setup step. A step whose script and
environment would not fit one 64 KiB command is refused by the CLI. A step's
`GITHUB_OUTPUT` over 16 KiB is dropped with a line saying so. Workflow env the
guest sets itself or that could change how a step starts (`PATH`, `HOME`,
`NODE_OPTIONS`, `DYLD_*`) is not passed, and the run says which once. Caches
are a miss and save nothing, and `--updaterc` records hosts only: filesystem
discovery is to come as guest-side tracing.

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
tool that ignores the environment's proxy gets no route - it fails closed.

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

`MacVmSetup.tsx` is the macOS VM section of Settings, where the Isolation
section was. It shows, by state: why this Mac cannot run macOS VMs; before an
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
  That is the policy's to bound.
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
  `filesystem.read`/`write` grants give it nothing; the runner names them in
  the log when the job starts. Read-only virtiofs shares
  of granted paths, and writable grants as per-job APFS clones, are the next
  step if repositories need them; every share would follow the Docker
  backend's unswappable-share rules (resolved at `Start()`, created by
  localmost, denied as a node to the job, checked by the helper).
- **Docker.** M2 has no nested virtualization, and Apple's (macOS 15, M3 or
  later) is for Linux guests only, so a macOS guest cannot run Docker. The
  route is a third vsock relay from a socket in the guest to the worker's
  filtering socket, which already exists in its sandbox, and a workspace the
  host shares with both VMs. Until then a job whose policy grants Docker is
  refused at admission, with a reason naming the missing relay.
- **Filesystem discovery for `localmost test`**, as guest-side tracing of
  the paths a step misses; `--updaterc` records hosts only until then.
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

On macOS 27 (headless) or macOS 26 (guided), with about 58 GB free (the
build's own check: the restore image, an image estimate and a reserve):

1. `npm run build:macvm`, then run the dev app.
2. Settings, macOS VM: **Build the golden image**. Expect catalog, download (18-20 GB), verify,
   install (minutes), then on macOS 27 provision, setup, save-state and check
   with no window; on macOS 26 the page stops at the guided setup: press
   **Open the setup window**, follow the six steps with the values shown, and
   leave the window. Expect it to close on its own after the Command Line
   Tools install, and the page to show the image ready with two slots.
3. In the app's data directory (`<data>` below),
   `ls -l <data>/macos-vm/images/<id>/ <data>/macos-vm/images/<id>/slot1`
   shows `disk.img`, `aux.img`, `config.json` and per slot `state.vzvmsave`;
   `du -sh` that directory to record the image's real size, and note the
   install's time from the app's log.
4. A repository with no `.localmostrc`, or an approved one without
   `docker:`, and a workflow that runs `id; sw_vers; xcode-select -p; curl -sI
   https://github.com; curl -s --noproxy '*' https://github.com || echo
   no-route; ls /Volumes`. Expect: uid of `runner` and not in `admin`, the
   guest's macOS, `/Library/Developer/CommandLineTools`, a 200 through the
   proxy, `no-route` without it, and no host volume.
5. Two such jobs at once both run, each in its own slot (the app's log names
   slots 1 and 2); a third waits until one ends.
6. After the jobs, `<data>/macos-vm/vms/` is empty and `pgrep -fl
   localmost-macvm` finds nothing.
7. `localmost test -v` in a checkout whose workflow runs `id; pwd; git
   ls-remote https://github.com/bfulton/localmost HEAD; echo n=1 >>
   "$GITHUB_OUTPUT"` and a node action (`actions/github-script`, say).
   Expect `runner`, `/Users/runner/work/workspace`, the ref through the
   proxy (git sending the proxy's credentials up front), the node action
   running on the runner's node, and the VM gone after the run. Ctrl-C during
   a long step ends it and the VM; with the image removed, the run names the
   setup step.
