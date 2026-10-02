# macOS VM Jobs — An Opt-In Isolation Level

A repository can choose to run each of its jobs inside a fresh macOS virtual
machine instead of under seatbelt on the host.

> **Status:** roadmap, design only. Nothing here is built. It builds on the
> [VM Docker backend](vm-docker-backend.md), whose helper, vsock plumbing and
> per-job lifecycle it reuses.

## Problem

Today a job runs as the operator's user under a seatbelt profile. That profile
is an allowlist and has been hardened, but it is still the same kernel, the
same user and the same filesystem as everything else the operator does. Some
repositories deserve more than that: an untrusted contributor's workflow, a
repository whose build runs arbitrary third-party code, a job that needs admin
rights or system extensions the sandbox cannot grant. For these, the only
boundary strong enough is a separate machine.

## Approach

A new isolation level, chosen per repository in the approved `.localmostrc`:

```yaml
isolation: vm        # default: sandbox
```

For such a repository, a claimed job runs in a macOS VM:

1. **Golden images.** localmost keeps one or more golden macOS disk images.
   Each has a pinned macOS version, Xcode and the runner, and each is built
   and updated by localmost itself.
2. **Clone per job.** At the claim, the golden image's disk and auxiliary
   storage are APFS-cloned (a few milliseconds), and the VM boots from the
   clone. The clone is deleted after the job, the same lifecycle as the Linux
   Docker VM.
3. **Save/restore for fast start.** A golden image carries a saved machine
   state (`saveMachineStateTo`/`restoreMachineStateFrom`, macOS 14+) taken
   when it was booted, logged in and idle, before any job data existed. A job
   restores that state instead of cold-booting.
4. **The runner inside the guest.** The guest's runner gets its job over
   vsock from localmost's broker proxy. It never talks to GitHub's broker
   directly and never holds the registration's key. Its egress goes through
   the job's `ProxyServer` over vsock, as the Linux VM's containers do.
5. **Policy grants become shares.** `filesystem.read` entries become
   read-only virtiofs shares into the guest. `filesystem.write` entries are
   never shared read-write from the operator's own directories (see Edge
   cases): each becomes a share of a per-job APFS clone of the directory,
   discarded after the job, or read-only when the grant does not need writes
   to persist. A deny is simply not shared. The workspace is guest-local.
   Artifacts and caches go out through the runner's normal upload paths.
   Every share, not only the workspace, follows the Docker backend's
   unswappable-share rule.
6. **Docker through the sibling Linux VM.** M2 has no nested virtualization,
   and Apple's nested virtualization (macOS 15, M3 or later) is only for Linux
   guests. So a macOS VM job cannot run Docker itself. Its `DOCKER_HOST`
   reaches localmost's filtering socket over vsock. The filter forwards to a
   sibling Linux VM exactly as for a sandboxed job. The job's workspace, which
   lives in the macOS guest, is exposed to that Linux VM through a share the
   macOS guest exports. How to do that is an open question below.

## Constraints

- **Two macOS VMs at a time.** macOS's licence and Virtualization.framework
  allow at most two concurrent macOS guests per host. The pool therefore runs
  at most two `isolation: vm` jobs at once, on top of the ordinary sandboxed
  workers. A third such job waits for a slot, and the scheduler reports it as
  waiting for a VM, not as a failure.
- **Memory and disk.** A useful Xcode guest needs 8–16 GB of RAM, which is
  only returned when it stops, and a golden image of 60–120 GB. Clones are
  copy-on-write. A job that rewrites DerivedData still consumes real space
  until it ends.
- **The same macOS or older.** The guest's macOS version must be supported by
  the host's Virtualization.framework. A restore image newer than the host
  cannot be installed.
- **Save files are host-bound.** A saved state is rejected after some host
  updates and on another Mac (see the SDK header note on
  `restoreMachineStateFromURL:`). localmost falls back to a cold boot and
  re-saves.
- **No nested virtualization on M2.** Docker has to go through the sibling
  Linux VM, above. The simulator inside the guest works; a guest cannot run
  its own VMs.

## Edge cases

- **Writable shares of operator paths.** A read-write share of a path such as
  `~/.npm` would let the guest plant symlinks and FIFOs there, and they appear
  on the Mac as real ones (R23 of the Docker backend's register). The
  operator's own unsandboxed tools then follow them. The same share would also
  carry one job's writes to every later job and to the operator (R14). So a
  writable grant is shared only as a per-job clone (APFS `clonefile` of the
  directory, made before the VM starts and deleted after), or read-only.
  Anything the job must hand back goes through the runner's upload paths.
- **Every share is resolved at `Start()`.** VZ resolves a share's host path
  when the VM starts (R1), so a link planted at any shared path shares
  wherever it points. Each share, workspace or policy grant, is a directory
  localmost creates or clones itself, is denied as a node to anything the job
  runs on the host, is checked by the helper (not a link, not a mount point,
  same device), and is granted in the helper's profile by its real path,
  with the `file-issue-extension` rule scoped to it.
- **Restored state repeats entropy.** Restoring one saved state for every job
  restarts each job from the same kernel RNG and entropy pool, and the same
  in-memory keys of anything that was running. Right after restore, before the
  runner starts, localmost reseeds the guest RNG through the guest agent
  (fresh bytes from the host written to the guest's random device with
  credit, as `RNDADDENTROPY` does), and the golden state is taken with no
  service running that holds keys.

## Image maintenance

- **Build.** `VZMacOSRestoreImage` downloads the IPSW, then
  `VZMacOSInstaller` installs it. On macOS 27 hosts, `VZMacGuestProvisioningOptions`
  creates the user, turns on auto-login and enables Remote Login without
  clicking through Setup Assistant. That API is in the macOS 27 SDK and is
  unavailable on older hosts, which need a scripted Setup Assistant (as
  Tart/Cirrus do) or a manual first boot. localmost then installs Xcode (from
  a `.xip` the operator provides; Xcode cannot be redistributed), the runner,
  and a small guest agent.
- **Update.** The image is rebuilt, not patched in place, when macOS gets a
  security release, Xcode changes, or the runner version moves. The old image
  is kept until no job uses it.
- **Several images.** A policy can name a macOS and Xcode pair, as GitHub's
  `runs-on: macos-15` does. localmost maps the pair to a golden image.
- **Integrity.** A golden image is only ever booted to make a new save state.
  It is never written by a job. The saved state is taken before any secret or
  job input exists in the guest.

## Policy mapping

| `.localmostrc` | In a macOS VM job |
|---|---|
| `network.allow` / `deny` / `loopback` | Enforced by the job's `ProxyServer`. The guest has no NIC and reaches it over vsock. |
| `filesystem.read` / `write` | Read: read-only virtiofs shares. Write: a share of a per-job clone, discarded after the job, or read-only |
| `filesystem.deny` | Not shared (nothing to deny) |
| `docker:` | Filtered socket over vsock, backed by a sibling Linux VM |
| `level:` | Still shapes the proxy's defaults. Seatbelt is not used in the guest. |

## Open questions

- How the sibling Linux VM sees the macOS guest's workspace. One option is an
  NFS or SMB export from the guest, reached over a private vsock tunnel.
  Another is putting the workspace on a host directory that both VMs share,
  which reintroduces a host share and needs the same unswappable-share rules
  as the Docker backend.
- Whether virtio-vsock is available in every macOS guest version localmost
  wants to support, or whether some need a private NIC with a host-only filter.
- Keychain and signing identities for jobs that code-sign. They could be
  imported per job from the operator's approved set, or not supported.
- Whether to support Intel-only tooling inside the guest (Rosetta 2 in a macOS
  guest).
- Caching Xcode DerivedData and package caches across jobs, which reopens
  the per-repository cache questions the Docker backend answered with
  refresh VMs.
