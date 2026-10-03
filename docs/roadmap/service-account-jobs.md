# Service-Account Jobs — A User of the Job's Own

A repository can accept running each of its jobs as a hidden user of its own,
`_localmost`, instead of as the operator: the `service-account` isolation type.

> **Status:** roadmap, design only. The isolation grammar and selection are
> built ([localmostrc.md](localmostrc.md), Isolation): a policy may list
> `service-account`, and Settings shows it as not available in this build.
> The helper and the user are not built. This replaces the "dedicated runner
> user" once sketched at the end of [job-environment.md](job-environment.md).

## Problem

A seatbelt job runs as the operator: one uid, one user database entry, one
set of preferences, one keychain, one set of TCC grants, and one per-user
temp directory. The profile is an allowlist and keeps the job out of most of
that, but some of what it shares cannot be closed from inside a profile:

- **The per-user temp directory.** macOS tools put entries in
  `/var/folders/<a>/<b>/T` whatever `TMPDIR` says - a bare `mktemp`, and the
  swift-driver Swift Build runs at its link step - so a seatbelt job is
  granted names of exactly the shapes they generate there (SECURITY.md,
  Shared temp directories). The operator's own tools use the same directory
  and the same names: SwiftPM keeps a manifest executable it is about to run
  in a `TemporaryDirectory.XXXXXX`, so with the Swift Build grant on, a job
  could race to replace one. Seatbelt cannot tell which process made an
  entry, so the grant cannot be kept to the job's own.
- **Lookups by uid.** ssh, cfprefsd and Foundation's home directory find the
  operator's account through the user database, not `HOME`; the floor denies
  what they find, and the job's tools then fail or warn.
- **The keychain and TCC.** They belong to the operator's session.

## Solution

An isolation type in which the job's processes run as `_localmost`, a hidden
user created for localmost:

1. **One-time setup, with an administrator's approval.** Allowing
   `service-account` in Settings > Isolation starts its setup: localmost
   installs a small privileged helper (a launchd daemon registered through
   `SMAppService`, which macOS asks an administrator to approve) and the
   helper creates the `_localmost` user - hidden, a uid below 500, no login
   shell, a home of its own. Nothing else needs an administrator afterwards.
2. **The helper starts the worker.** For each admitted job of this type, the
   app asks the helper to start the job's worker as `_localmost` in a sandbox
   directory that user owns. The helper accepts requests only from the
   signed app (it checks the caller's code signature), does only that and
   the reaping below, and never runs a command the request names: the worker
   it starts is the app's copy of the runner, checked against its integrity
   record as today.
3. **Seatbelt still applies.** The worker still runs under the job's
   seatbelt profile - the proxy as its only way out, the policy's grants -
   but the profile no longer needs any exception in a temp directory shared
   with the operator, and the operator's files are closed to the job by file
   permissions as well, beneath the profile.

What the job gets:

- **Its own `/var/folders` temp.** The per-user temp directory is per uid, so
  `_localmost`'s is not the operator's. A bare `mktemp` and Swift Build's
  link step make their entries there, where no tool of the operator's looks.
  The shared-temp exceptions - bare `mktemp`'s names and
  `jobEnvironment.swiftBuildLinkTemp` - are not needed and not granted: a
  plain `swift build` links, and nothing the operator runs is exposed.
- **Its own preferences**, served by cfprefsd for its own uid; none of the
  operator's.
- **None of the operator's keychain.** Signing identities would have to be
  provisioned into `_localmost`'s own keychain; that is an open question.
- **TCC fails closed.** `_localmost` has no grants, and no session in which a
  prompt could be shown, so anything that needs one is refused, not asked.

## Headless only

`_localmost` has no Aqua session, so its processes cannot reach the window
server. Anything that needs one fails: Electron apps and their tests, the iOS
Simulator, UI tests (XCUITest), Safari and WebDriver. A repository whose jobs
need a GUI lists `seatbelt` or `macos-vm` - the macOS VM has a window server
of its own ([macos-vm-jobs.md](macos-vm-jobs.md)) - and never
`service-account` alone. A workflow that needs it for some jobs only can
list it per workflow:

```yaml
shared:
  isolation: [service-account, seatbelt]
workflows:
  ui-tests:
    isolation: [macos-vm, seatbelt]
```

## Key design decisions

- **A helper, not sudo or setuid.** The app never holds root. The helper's
  interface is the smallest that works: start a worker for a sandbox, signal
  a worker's processes, remove a sandbox. Each checks that the path is one of
  localmost's sandboxes and the caller is the signed app.
- **Selected, not defaulted.** Like every type it is used only when the
  repository lists it (or declares nothing, which is `any`) and the operator
  has allowed it; until it is set up it is not available, and a repository
  that accepts only `service-account` is refused, never run under seatbelt.
- **Seatbelt kept underneath.** A second uid separates files and the temp
  directory; it does not confine the network. The profile still does.

## Edge cases

- **Files owned by another uid.** The workspace, its artifacts and caches are
  `_localmost`'s. The app collects artifacts through the runner's upload
  paths as today; anything the app must remove after the job, it asks the
  helper to remove.
- **Reaping.** The app cannot signal another uid's processes; the helper
  reaps a finished job's survivors by the same marker the app uses today.
- **Process listings.** `ps` still shows every user's processes, command
  lines included, so a job can still read the operator's; but the paths on
  them are in the operator's temp directory, which `_localmost` cannot write.
- **Package caches across jobs.** A cache kept across a target's jobs is
  `_localmost`'s, and is not shared with the operator's own tools - which was
  already the rule for seatbelt jobs.
- **Xcode.** Xcode and its licence are system-wide and work for any user;
  `xcode-select` likewise. A first launch of Xcode-related tools as a new
  user may install components into its home.

## Open questions

- Signing identities: imported per job from an approved set, or not
  supported.
- Whether to keep one `_localmost` user for every job, or one per concurrent
  worker, so that two jobs do not share a temp directory either.
- How the helper is updated with the app, and removed when the type is
  turned off.
