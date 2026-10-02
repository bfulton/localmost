# Job Environment — a Home, a Temp Directory and Tools of the Job's Own

What localmost puts in a runner job's environment beyond what the runner
itself needs: a home directory of the job's own, a directory of its own in the
per-user temp directory, a bin directory with the bundled docker CLI and shims
for `swift` and `xcodebuild`, and `JAVA_TOOL_OPTIONS`. Each convenience can be
turned off on its own in `config.yaml`.

> **Status:** implemented in 0.3.0, from the owner's decisions of 2026-10-01
> (items 9, 10, 11a, 11b, 12 and 13 of the open-items walkthrough). The
> dedicated runner user at the end is a future design item.

## Problem

The sandbox (SECURITY.md) decides what a job may touch. Several things a job
ordinarily does failed inside it, at every level, not because the policy
refused them but because the tools looked in places the job is never granted:

- **The user's home as HOME.** Tools look for their configuration through
  `HOME`. A job ran with the user's own, where the floor denies most of what
  they look for, and where `file-read-metadata` still lets them see it is
  there. `actions/checkout` copies `$HOME/.gitconfig`: a regular `~/.gitconfig`
  made every checkout fail with `EPERM` (re-audit G5). Yarn 2+ found
  `~/.yarnrc.yml`, could not read it, and failed to parse it (G8). Hugging Face
  and Gradle failed the same way on their token and properties files under
  `strict` (L4, L5) - and, once a job's home linked its grants, under a grant of
  `~/.cache` or `~/.gradle` too, the link leading them to the same denied file.
  And anything a job wrote under `HOME` landed in the user's tree.
- **Foundation's temp directory.** `NSTemporaryDirectory()`, `java.io.tmpdir`
  and the staging directory a sandboxed process's atomic writes go through
  (`T/TemporaryItems/NSIRD_*`) are found through the Darwin user directories,
  not `TMPDIR`. The per-user temp directory `T` is shared with everything the
  user runs and is not granted, so every atomic write failed with "You don't
  have permission to save the file": SwiftPM's manifests, xcodebuild's plists
  and caches (G6).
- **Nested sandboxes.** SwiftPM and Xcode run each package manifest and plugin
  under a sandbox of their own, by calling `/usr/bin/sandbox-exec` by its
  absolute path. macOS refuses to apply a sandbox inside another, so every
  manifest a job had not compiled before failed with "sandbox_apply: Operation
  not permitted".
- **The JVM.** It reads neither `TMPDIR`, `HOME` nor `HTTPS_PROXY`:
  `createTempFile` failed on the per-user temp, Maven and Gradle looked for
  their settings in the user's home and went around the proxy, and its
  dual-stack sockets connected to `127.0.0.1` in a way the sandbox cannot
  attribute to loopback, so a loopback connection failed even with loopback
  granted (G7).
- **A granted directory that does not exist.** A job granted `~/.gradle` whose
  user had never run Gradle could not create `~/.gradle`: its parent, the home
  directory, is not writable.

## Solution

### A home of the job's own

`HOME` is `<sandbox>/home`, made empty and `0700` with the sandbox and removed
with it. Before the worker starts, localmost puts in it:

- `.gitconfig`: the per-job global git config `GIT_CONFIG_GLOBAL` points at -
  `http.proxyAuthMethod = basic`, nothing of the user's. checkout copies this
  one now. Should keys of the user's ever be merged in, it would be an
  allowlist of keys, never `credential.*`, `url.*.insteadOf`,
  `core.sshCommand` or `include.path`.
- `.ssh/config`, empty, in a `0700` `.ssh`. ssh finds its directory through
  the user database, not `HOME`, so `GIT_SSH_COMMAND` is
  `ssh -F <home>/.ssh/config -o UserKnownHostsFile=<home>/.ssh/known_hosts`.
- A link for each path the job's approved policy grants under the real home,
  read or write, and each its level grants (`moderate`'s `~/.rustup`,
  `~/Library/Caches` and the rest), at the same relative path:
  `<home>/.npm -> ~/.npm`. A tool that looks for it through `HOME` finds it.
  Only what is there when the job starts is linked: a link to nothing reaches
  nothing, and took the name from a tool that would have made the directory in
  the job's home (`rustup-init`'s `~/.rustup`, `setup-dotnet`'s `~/.dotnet`).
- Never a credential location the floor denies (`~/.ssh`, `~/.aws`,
  `~/.yarnrc.yml`, `~/.cache/huggingface/token` and the rest), nor anything in
  one, whatever the policy grants: found through `HOME`, it failed as the real
  path does, where without it the tool carries on. A granted directory that
  holds one that is there is a directory of the job's own instead, holding a
  link to each of its other entries, and so on down to the credential: under a
  grant of `~/.cache`, `<home>/.cache` is a directory, `huggingface` in it too,
  and `huggingface/hub` a link, with no `token` beside it.
- For a grant of `~` itself, which cannot be linked into itself, a link for
  each entry of the home, the same way, but the one the job's home is in.

`localmost test` does the same in the workspace's `.home`, before the first
step, with the checkout's confirmed policy. The home is made new for the run:
the workspace copy leaves out a `.home` (and `.tmp`) at the checkout's top, in
any case, and the run makes it with a plain `mkdir`.

### A temp directory of the job's own

Before each spawn localmost makes `T/localmost-<data>-<sandbox id>` (`0700`, a
plain `mkdir`), sets `DIRHELPER_USER_DIR_SUFFIX` to its name in the worker's
environment - which moves the job's Darwin user directories, and so
`NSTemporaryDirectory()`, `java.io.tmpdir` and the atomic-write staging
directory, into it - and grants it in the job's profile by both spellings
(`/var/...` and `/private/var/...`), its node excepted. It is removed with the
sandbox, when a spawn fails before its worker starts, and at startup for those
whose sandbox is gone.

### A bin directory of the job's own

`<sandbox>/localmost/bin` is first on the job's `PATH`. It holds `docker`, a
link to the bundled CLI (whose directory used to be put on `PATH` itself), and
two shims:

- `swift` adds `--disable-sandbox` right after `build`, `test` or `run`, and
  after `package`, whose own options go there, unless the job already gave it
  before a `--`. Every other subcommand passes through, and so does
  `swift package --version`, which `package` refuses after
  `--disable-sandbox` ("Unknown option", exit 64).
- `xcodebuild` appends `-IDEPackageSupportDisableManifestSandbox=YES` to a call
  that resolves packages - a build action (`build`, `test`, `archive`,
  `analyze`, `build-for-testing`, `test-without-building`, `clean`, `install`,
  `installsrc`, `docbuild`), `-resolvePackageDependencies`, `-list`,
  `-showBuildSettings`, `-showdestinations`, `-showTestPlans`, a named
  `-project`, `-workspace`, `-scheme`, `-target` or `-alltargets`, or no
  arguments at all - unless the job set it either way. Anything else passes
  through, and so does any call with `-create-xcframework`, which refuses an
  argument it does not know ("invalid argument", exit 70).

Each runs the next tool of its name on `PATH` that is not itself - compared as
files (`test -ef`), so another spelling of its directory on `PATH` (a trailing
slash, a route through `..`) is skipped too. The manifest still runs under the
job's own sandbox.

### JAVA_TOOL_OPTIONS

Every JVM the job starts picks up `-Djava.io.tmpdir=<job temp>`,
`-Duser.home=<job home>` - the JVM takes its home from the user database, not
`HOME`, so Maven, Gradle without `GRADLE_USER_HOME`, sbt and Ivy looked in the
real home, where the floor denies their credential files -
`-Djava.net.preferIPv4Stack=true`, `http(s).proxyHost`/`proxyPort` for the
job's proxy, its credentials as `http(s).proxyUser`/`proxyPassword`, and
`jdk.http.auth.tunneling.disabledSchemes=` and
`jdk.http.auth.proxying.disabledSchemes=` (empty).

### A missing granted directory

A write grant is a seatbelt subpath: the job may create what it names, but
nothing above it. So before spawning, for each write grant under the real home,
the missing directories above what it names are created: one level at a time,
each existing level `lstat`'d and required to be a directory and not a link,
each missing one made empty with a plain `mkdir`, `0755` less the umask, owned
by the user. What the grant names is created too only where the job could not
make it either - a directory above a credential, such as `~/.gradle`, whose
node the profile denies the job's writes - or where the grant says it is a
directory, ending in `/` or `/**`. Otherwise it may name a file: a missing
`~/.python_history` made a directory broke the user's own `python`, outside
any job, with `EISDIR`.

## Preferences

Each convenience is a key of the `jobEnvironment` section of `config.yaml`,
read at every worker spawn. All default on.

| Key | Default | Off means |
|---|---|---|
| `toolShims` | `true` | No `swift`/`xcodebuild` shims; the job calls the tools as they are, and a manifest it has not compiled before fails. The docker link stays. |
| `javaToolOptions` | `true` | No `JAVA_TOOL_OPTIONS`; the JVM's temp file, loopback and proxy fail as before. |
| `perJobTempDir` | `true` | No `T/<suffix>`; Foundation's atomic writes fail as before. |
| `createMissingGrantedDirs` | `true` | The missing directories above a write grant, and a directory it names, stay missing; a job that cannot create them fails. |

The per-job home is not a preference: it is what closes G5 and G8, and an
empty home is never less than the user's own was.

## Key design decisions

- **Links, not copies or grants.** A link names the real path, and seatbelt
  judges the path a link resolves to. So a link reaches exactly what the grant
  already reached, and the floor - `~/.ssh`, `~/.aws`, the credential files in
  the package caches - would still hold through one. It is kept out of the
  home all the same, since a tool that finds a file it cannot read fails where
  one that finds none carries on. Shorter paths are linked first, so a grant of
  `~/.cache` and one of `~/.cache/pip` give one link, not a directory that
  hides the rest of `~/.cache` - unless `~/.cache` holds a credential, when it
  is a directory of links either way.
- **A directory of links is a snapshot.** Its entries are linked as they are
  when the job starts; one the user, or another process, adds to the real
  directory during the job is not in the job's home, and one the job adds goes
  into the job's home, not the real directory.
- **Names compared as the volume compares them.** Filling the home and
  creating granted directories run outside the sandbox, which closes the app's
  directories and the credential locations in any capitalization. So their
  checks fold case and Unicode form as the default APFS volume does: a grant of
  `~/.SSH/x` or `~/.LOCALMOST/...` is treated as the one it lands in.
- **Never follow, never replace.** Every file in the home is created
  exclusively, and nothing already at a name is followed or replaced: the home
  is filled before anything of the job runs in it, and a name taken stays
  taken. The `.gitconfig` comes before the links, so a policy that grants
  `~/.gitconfig` does not get the user's config into git.
- **No runner paths linked.** Run from a writable copy of runner v2.336.0 with
  a fresh `HOME`, `Runner.Listener --version` and `--help`, `run.sh --help` and
  `--once`, `config.sh --help` and `--check`, and `Runner.Worker` wrote
  nothing under it. So the built-in list of real-home paths to link, per target
  where expensive to recreate, is empty.
- **The app makes the temp directory.** One the system makes for a process
  (dirhelper, on the first Foundation call) is marked `com.apple.rootless`, and
  nothing but the system can remove it. So localmost makes it before the job,
  and the profile denies writes to its node: a job that removed it would have
  the system make it again that way.
- **The temp directory is moved out before it is removed.** macOS protects any
  `TemporaryItems` directory in the per-user temp directory by its path: not
  even the user can list or remove the staging directory a job's atomic writes
  left there. Moved out - into the sandbox base, on the same volume, where only
  the app writes - it can be, and it is removed there without following a link,
  as a sandbox is. Every removal first asserts the path is exactly
  `<T>/localmost-<8 hex>-<n>-<12 hex>` in a directory named `T`
  (`assertJobTempDir`), and refuses anything else.
- **Named per data directory.** `<data>` is eight hex characters of the
  sandbox base's hash, so a development build beside the installed app sweeps
  only its own jobs' directories at startup.
- **Arguments, not environment.** Neither SwiftPM nor Xcode has an environment
  switch for its sandbox, and a `sandbox-exec` stub on `PATH` cannot work, as
  both call it by absolute path. So the shims add the argument.
- **Explicit `java.io.tmpdir`.** The suffix moves the JVM's default temp too,
  but the option points it at the job's `TMPDIR` whether the temp-directory
  preference is on or not.

## What the job's environment does not change

- **The user database.** The job's processes run as the user, and tools that
  look the home up by uid rather than through `HOME` still find the real one:
  ssh (hence `GIT_SSH_COMMAND`), cfprefsd, and Foundation's
  `NSHomeDirectory()` and `FileManager.homeDirectoryForCurrentUser` - checked:
  with `HOME` set elsewhere they still return `/Users/<user>`. So SwiftPM's
  shared caches (`~/Library/Caches/org.swift.swiftpm`,
  `~/Library/org.swift.swiftpm`) are still looked for in the real home, are
  denied, and SwiftPM carries on without them with a warning. The real home
  stays floor-denied; the keychain stays a grant. The JVM looks its home up the
  same way, and is given the job's as `user.home` in `JAVA_TOOL_OPTIONS`; a JVM
  started with its own `JAVA_TOOL_OPTIONS` looks in the real home again.
- **Directory walks.** Yarn reads `.yarnrc.yml` from every directory from the
  project up to `/`, not only from `HOME`. A runner job's workspace is under
  `~/.localmost`, so that walk still passes the real home and finds
  `~/.yarnrc.yml` if the user has one; the floor still denies it, and Yarn
  still fails to parse it. The per-job home closes Yarn's `HOME` lookup, not
  this one. Closing it is on the owner's list; one option is to deny
  `file-read-metadata` on the `~/.yarnrc.yml` floor entry, so Yarn's existence
  check finds nothing there.
- **The job's own choices.** A workflow that sets `HOME`, `JAVA_TOOL_OPTIONS`
  or `PATH` in its `env:` replaces what localmost set. One that puts a toolchain
  first on `PATH` - `setup-swift`, say - bypasses the shims, and so does one
  that calls `xcrun swift`, `xcrun xcodebuild` or `/usr/bin/swift`, which find
  the tool through the developer directory, not `PATH`: an uncached manifest
  then fails as it did. A job can change anything in its own home and bin
  directory.
- **`core.sshCommand`.** git gives `GIT_SSH_COMMAND` precedence over
  `core.sshCommand` and `GIT_SSH`, at every config level. So a deploy key a job
  sets up there is not used: `actions/checkout` with `ssh-key` and
  `persist-credentials` stores `core.sshCommand` for later steps' `git push`
  and fetch, and those go out without the key (checkout's own fetch works, as
  it sets `GIT_SSH_COMMAND` for its own git). Before the per-job home, ssh
  skipped the unreadable `~/.ssh/config` and those flows worked. A step that
  needs its `core.sshCommand` runs `unset GIT_SSH_COMMAND` first, or sets
  `GIT_SSH_COMMAND` itself. Writing the same command as `core.sshCommand` in
  the job's `.gitconfig` instead - the global level, which a repository's own
  setting and a job's `GIT_SSH_COMMAND` override - would keep these flows
  working; it is on the owner's list.
- **`DIRHELPER_USER_DIR_SUFFIX`.** A workflow that sets its own in `env:` has
  the system make `T/<value>` for it, and a directory the system makes there is
  marked `com.apple.rootless`: neither the job nor localmost nor the user can
  remove it, and it stays until the system clears the per-user temp. Refusing a
  job-set suffix is a possible follow-up.

## Edge cases

- **A grant of `~` itself** cannot be linked into itself, so each entry of the
  home is linked instead, credential locations and the directory holding the
  job's home (`~/.localmost`) excepted. Paths outside the home, relative paths
  and ones with `..` are not linked.
- **A grant with `*` in it** is matched, within one name, against what is in
  the real home when the job starts: each existing match is linked. `/**` at
  the end grants the directory, as in the profiles. A grant with `*` names no
  single directory, so none is created for it.
- **A grant inside the app's own directories** gets no directory created, so
  a policy naming `~/.localmost/config.yaml` cannot turn the app's settings
  file into a directory. Nor does one inside a credential location the floor
  denies (`~/.ssh`, `~/.aws`, `~/.config` and the rest): the job could not use
  it, and a `~/.ssh` is the user's to make.
- **A link or file already on the way** to a directory to create stops that
  grant, with a warning; nothing is created through a link. A job running
  concurrently with write on the parent could still swap a level for a link
  between the `lstat` and the `mkdir`; the most that can do is create one empty
  directory where the link points.
- **A home on another volume than the per-user temp** cannot have the temp
  directory moved into the sandbox base; it is left, and logged, for the next
  startup, which fails the same way. Its `TemporaryItems` stays until the
  system clears the per-user temp.
- **`JAVA_TOOL_OPTIONS` is printed** by every JVM as it starts ("Picked up
  JAVA_TOOL_OPTIONS: ..."), so the proxy token appears in the job's log, which
  on a public repository anyone can read. It is good only on this Mac's
  loopback, for this job's proxy, which a job already holds in `HTTPS_PROXY`,
  and is replaced when the job ends. A value with whitespace in it is left out,
  since the JVM splits on whitespace.
- **The JDK's own HTTP clients** take proxy credentials from an
  `Authenticator`, which only the job's code can install; the properties are
  for Gradle and clients that read them (Apache HttpClient with system
  properties). Maven reads its proxy from `settings.xml`.
- **Swift Build's link step.** With the shim, a package's manifest compiles and
  `swift build --build-system native` builds and links. Swift 6.4's default
  build system, Swift Build, still fails at its link step: it gives that step
  the per-user temp directory itself as its temp, and `swift-driver` creates
  `T/TemporaryDirectory.XXXXXX` there, which no job is granted. Granting names
  of that shape - as bare `mktemp`'s are - or having the shim choose the native
  build system are both open; until then a workflow passes
  `--build-system native`.
- **Package plugins under xcodebuild** run under Xcode's plugin sandbox, which
  `-IDEPackageSupportDisableManifestSandbox` does not cover.
- **`localmost test`** gets the per-job home; the temp directory, the shims and
  `JAVA_TOOL_OPTIONS` are the runner's, since the CLI does not read the app's
  preferences.
- **Tests inside a job.** A test that wants the real home must ask the user
  database (`os.userInfo().homedir`): inside a job, `HOME` - and so
  `os.homedir()` - is the job's. The constructed JVM test runs the JDK
  `/usr/libexec/java_home` finds, so a contributor running the suite outside a
  job needs a JDK installed (Xcode brings `swiftc`; nothing brings Java).

## Future: a dedicated runner user

The limits above all come from a job running as the user: one uid, one user
database entry, one set of preferences, one keychain, one set of TCC grants.
A dedicated macOS user account for the runner - created once, with an
administrator's approval at setup - would give jobs a real home of their own,
their own preferences and keychain, and no reach into the user's files at the
filesystem-permission level, beneath the sandbox. The costs to design for:
the admin step, files a job produces being owned by another uid (artifacts,
caches the user's own builds share), how the app hands work to and collects it
from processes it no longer owns, and signing identities, which would have to
be provisioned into that account's keychain.
