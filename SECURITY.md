# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in localmost, please report it through [GitHub Security Advisories](https://github.com/bfulton/localmost/security/advisories/new).

**Please do not open public issues for security vulnerabilities.**

When reporting, please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

## Response Timeline

- **Acknowledgment**: Within 1 week of report
- **Initial assessment**: Within 2 weeks of report
- **Fix timeline**: Depends on severity; critical issues prioritized

We follow coordinated disclosure. If you report a vulnerability, we ask that you give us 90 days to address it before public disclosure.

## Supported Versions

Only the latest release receives security updates. Users should always run the latest version.

## Scope

### In Scope

- The localmost application (Electron app, main/renderer processes)
- Credential storage and handling
- Sandbox and network isolation mechanisms
- IPC between processes
- Authentication flows

### Out of Scope

- **GitHub Actions Runner binary itself** - Report vulnerabilities in the runner binary to [GitHub](https://github.com/actions/runner/security). However, vulnerabilities in localmost's sandboxing or network isolation *of* the runner are in scope.
- **Workflow code** - Security of workflows you write is your responsibility
- **Third-party dependencies** - Report upstream, but please let us know so we can update

## Security Updates

Security fixes are communicated through:
- [GitHub Security Advisories](https://github.com/bfulton/localmost/security/advisories)
- Release notes on [GitHub Releases](https://github.com/bfulton/localmost/releases)

---

# Security Architecture

This section describes the security design of localmost.

## Overview

localmost is an Electron desktop application that manages GitHub Actions self-hosted runners. It handles sensitive credentials and executes external binaries, requiring careful security considerations.

## Threat Model

### What localmost protects against

- **Filesystem writes**: Under `strict`, workflows can write only to the workspace and temp paths. `moderate` and `permissive` additionally allow writes to standard tool caches (`~/.npm`, `~/.cargo`, `~/.gradle`, `~/Library/Caches` and similar)
- **Home directory access**: Workflows cannot read `~/.ssh`, `~/.aws`, `~/.config` or the other credential locations listed above, at any level. `HOME` points inside the workspace, not at your home directory
- **Filesystem reads**: A job can read the OS, the standard toolchain locations (`/opt/homebrew`, `/usr/local`, Xcode), the package-manager caches it can write, and its own workspace. It cannot read `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config`, `~/Library/Keychains`, `~/.netrc`, `~/.npmrc`, or this app's own credential store and approval cache
- **Network exfiltration**: A job's sandbox permits no outbound connection except to its own filtering proxy, so the host policy holds even for code that ignores `HTTP_PROXY` and opens a raw socket. Under `strict` the reachable set is runner infrastructure plus what the repository declares — not npm, PyPI or other registries
- **Credential exposure**: OAuth tokens are encrypted at rest using macOS Keychain

### Policy levels

A repository declares its level in `.localmostrc`:

```yaml
version: 1
level: strict    # strict (default) | moderate | permissive
```

A repository that declares no level runs `strict`. Silence means the tightest
setting, so a policy that says nothing cannot inherit something looser.

The level is part of the policy, so changing it is a policy change: it appears
in the approval diff and takes effect only once approved. A repository cannot
loosen its own sandbox without the machine owner agreeing to it.

- **The app's own control plane**: A job cannot write the approval cache, the settings file, or reach the CLI control socket. Without this, a workflow could approve its own policy and the approval gate would mean nothing

### What localmost trusts (does NOT protect against)

- **GitHub's infrastructure**: OAuth, API responses, and runner binary distribution are trusted. If GitHub is compromised, localmost provides no additional protection.
- **Malware on your machine**: If your system is already compromised, localmost cannot protect you.
- **A compromised GitHub account**: If an attacker has access to your GitHub account, they can modify workflows that run on your runner.
- **Allowlisted hosts**: Data can be exfiltrated to any host the active policy allows. Under `strict` that is runner infrastructure plus whatever the repository declares; looser levels allow more.
- **Approved policies**: Once you approve a repository's `.localmostrc`, everything it declares is granted until the file changes again. Approval is a judgement about that content.
- **Per-job filesystem policy**: A repository's `filesystem` declarations are not applied per job. The sandbox profile is fixed when a runner process starts, which happens before the runner claims a job, so the filesystem boundary is the fixed one described above. The `network` section *is* applied per job, at the moment a worker claims it. Treat `filesystem` entries as documentation of intent, not as an enforced narrowing.
- **Declared system paths**: A policy that declares OS read paths grants them for the whole job. `localmost policy init` seeds that list with OS subpaths (`/usr/bin`, `/usr/lib`, `/System`, `/Library/Developer` and similar) because nothing runs without them. It deliberately excludes `/usr/local`, `/Library/Application Support` and `/Applications`, which hold third-party software and application data - but a policy is free to add them back, and approving one means accepting that.

## Network Policy

Job traffic is routed through a local proxy, which decides each connection by
hostname. macOS `sandbox-exec` cannot filter by hostname - its `(remote ...)`
filter matches only addresses and ports - so the sandbox permits localhost only
and the proxy makes the decision.

Three levels are available in Settings under Job Security:

- **strict** (default): runner infrastructure, plus whatever the repository's
  `.localmostrc` declares
- **moderate**: also GitHub Actions infrastructure, common package registries
  and tool caches
- **permissive**: unrestricted

A small set of hosts is allowed at every level, because the Actions runner is
launched with `HTTP_PROXY` pointed at this proxy and cannot register or poll for
jobs without them: `localhost`, `127.0.0.1`, `github.com`, `api.github.com`,
`*.actions.githubusercontent.com` and `*.blob.core.windows.net`. A single proxy
cannot distinguish the runner's own requests from a job's, so jobs reach those
hosts too.

Filesystem access is not granted implicitly. A job can read its workspace and
temp directories; everything else — including system paths like `/usr` and the
Xcode developer directory that most tools need — must be declared in
`.localmostrc`. Reading a repository's policy therefore tells you everything a
job may touch. `localmost policy init` starts from a policy that runs, and
`localmost test --updaterc` records what a workflow actually needs.

The single exception is the root directory node, which permits an absolute path
to resolve at all. It grants no access to anything inside.

A repository's `.localmostrc` only takes effect once approved. When the runner
sees a new or changed policy it refuses the job and cancels the run; review it
with `localmost policy diff` and approve with `localmost policy approve`. A
repository with no policy is never held for approval — it gets the baseline,
which grants nothing extra.

`codeload.github.com` is deliberately **not** in that set, even though the
runner uses it to download actions during job setup. Actions are third-party
code, and allowing it grants a job the ability to fetch any tarball from GitHub.
Under `strict` a repository that uses actions declares the host in its own
`.localmostrc`; the runner log names any blocked host and points at that file.

## Workflow Secrets

`localmost test` runs a workflow locally, where GitHub is not there to supply
`${{ secrets.X }}`. Values come from a `--secret-file` (`KEY=value` lines) or the
environment, in that order. `--secrets prompt` asks for anything still missing
without echoing it.

- **Never stored.** localmost has no secret store. Nothing is written to disk,
  and nothing persists between runs.
- **Masked in output.** Secret values are replaced with `***` in everything a
  step prints, so a step that echoes one does not spill it into the console or
  the log file.
- **Not in the environment.** Secrets reach a step only through
  `${{ secrets.X }}`, including an explicit `env:` mapping. They are not
  exported into every step's environment, where every child process would see
  them.
- **Missing secrets are announced.** With the default `stub` mode a missing
  secret becomes an empty string and the run says so; a step will act on that
  empty value, so `--secrets abort` is the safer choice for anything that
  deploys or publishes.

For jobs run by the background runner, secrets come from GitHub in the job
payload as they would on any self-hosted runner. They pass through the local
proxy in transit, are handed to the runner binary, and are not parsed, logged
or stored by localmost.

## Authentication

- **OAuth Device Flow**: Uses GitHub's Device Flow for user authentication, appropriate for desktop applications that cannot securely store client secrets
- **Token Management**: Access tokens and refresh tokens are obtained via the GitHub App OAuth flow
- **Token Refresh**: Expired tokens are automatically refreshed using refresh tokens
- **Access tokens are never written to disk**: They live only in memory. Only the refresh token is persisted, and a fresh access token is obtained at startup
- **Required Permissions**:
  - `Administration: Read & Write` - Register and remove self-hosted runners on repositories
  - `Actions: Read & Write` - Check workflow status and cancel running jobs
  - `Metadata: Read` - Access basic repository information (required by GitHub for all apps)
  - `Self-hosted runners: Read & Write` (org-level) - Register runners at the organization level

## Credential Storage

- **Location**: Configuration stored in `~/.localmost/config.yaml`
- **Encryption**: The persisted refresh token is encrypted using Electron's `safeStorage` API
  - Uses macOS Keychain for secure storage
  - Encryption key is managed by the operating system and tied to the user account
  - Encrypted values are stored with an `encrypted:` prefix followed by base64-encoded ciphertext
- **Fail-secure**: Plaintext credentials are rejected; users must re-authenticate if OS encryption is unavailable
- **Non-sensitive data**: Settings like theme, runner count, and repository URLs remain in plaintext for easy user editing
- **Access Control**: The `~/.localmost` directory and all contents are user-only (700 for directories, 600 for files). The app sets `umask(077)` at startup to ensure no group or world access.

## Encryption Export Compliance

This app uses encryption **solely** for secure credential storage via OS-provided APIs:

| Platform | Encryption Provider | Implementation |
|----------|--------------------|-----------------|
| macOS | Apple Keychain Services | Via Electron `safeStorage` |

**No custom cryptographic algorithms are implemented.** The app delegates all encryption to macOS Keychain APIs.

This usage qualifies for:
- **ECCN 5D992**: Mass-market encryption exemption
- **EAR Note 4**: Exemption for authentication and access control
- **Apple App Store**: No additional export compliance documentation required (uses Apple-provided encryption only)

## Electron Security

The application implements Electron security best practices:

- **Context Isolation**: Enabled (`contextIsolation: true`) - renderer cannot access Node.js
- **Node Integration**: Disabled (`nodeIntegration: false`) - renderer runs in browser sandbox
- **Preload Scripts**: Uses `contextBridge.exposeInMainWorld()` for safe IPC
- **Electron Fuses**: Security fuses configured:
  - `RunAsNode`: false - prevents using Electron as Node.js
  - `EnableCookieEncryption`: true
  - `EnableNodeOptionsEnvironmentVariable`: false
  - `EnableNodeCliInspectArguments`: false
  - `EnableEmbeddedAsarIntegrityValidation`: true
  - `OnlyLoadAppFromAsar`: true
- **ASAR Packaging**: Application code is packaged in ASAR archive
- **Single Instance Lock**: Prevents multiple instances from running simultaneously
- **External Link Handling**: External URLs open in system browser, not Electron

## Content Security Policy

The application enforces a strict CSP header for the renderer:
```
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data: https://avatars.githubusercontent.com;
connect-src 'self';
font-src 'self';
frame-src 'none';
object-src 'none'
```

Key security features:
- **No `unsafe-inline`**: All styles are in external CSS files; dynamic styling uses CSS classes and data attributes
- **No `unsafe-eval`**: No use of `eval()`, `new Function()`, or similar dynamic code execution
- **Restricted sources**: Only same-origin resources allowed; `img-src` includes `avatars.githubusercontent.com` for displaying user profile images in the UI
- **No WebSocket directives**: The app uses Electron IPC for all process communication
- **Frame/Object blocking**: Prevents embedding of iframes and plugins

## Runner Binary

- **Source**: Downloads official GitHub Actions runner from `github.com/actions/runner` releases
- **Integrity Verification**: Downloads are verified using SHA256 checksums from GitHub's release API
  - Checksum is fetched from GitHub's official release notes
  - Downloaded tarball hash is computed and compared before extraction
  - Download is rejected if checksums don't match, preventing corrupted or tampered binaries
  - Note: The runner binaries use adhoc code signatures (no verified identity), so we don't verify signatures—the checksum provides equivalent integrity assurance
  - This verification model trusts GitHub's infrastructure, which localmost already relies on for OAuth and API access
- **Execution**: Runner binary is spawned as a child process with controlled environment
- **Process Management**: Child processes are managed via Node.js ChildProcess handles
  - Processes are spawned with `detached: false` so they terminate when parent exits
  - Stop/cleanup uses direct process handles stored in the instances Map
  - Stale process cleanup on startup uses path-specific matching (`~/.localmost/runner.*Runner.Listener`) to avoid affecting unrelated processes
- **Directory Isolation**: Each runner instance has its own working directory

## Runner Security Model

localmost adds isolation layers that the stock GitHub Actions Runner lacks:

### Sandbox Restrictions

| Resource | Access Level |
|----------|--------------|
| File system (write) | Runner working directory and temp dirs only |
| File system (read) | Essential system paths (`/usr/bin`, `/System/Library`, Xcode) |
| Network | Allowlisted hosts only (GitHub, npm, PyPI, etc.) via HTTP proxy |
| Home directory | **Denied** — no access to `~/.ssh`, `~/.aws`, etc. |
| Other applications | **Denied** — no access to `/Applications` (except Xcode) |

### What Remains Accessible

| Resource | Access Level |
|----------|--------------|
| Environment variables | All variables in runner process |
| Process spawning | Can spawn any executable in allowed paths |
| Mach/IPC | System frameworks require this |

### Sandbox Limitations

The sandbox is **not** VM-level isolation. It primarily restricts filesystem writes:

- **Network**: Proxied through an allowlist, but the allowlist is broad (GitHub, npm, PyPI, Docker Hub, etc.). A malicious workflow could exfiltrate data to any allowlisted host.
- **Process spawning**: Allowed for any executable in permitted paths. CI runners genuinely require this capability.
- **Mach/IPC**: Allowed because system frameworks require it. This is a fundamental macOS constraint.
- **Read access**: Broader than write access—runners can read from `/usr/bin`, `/System/Library`, Xcode, etc.

The sandbox reduces attack surface but does not provide full containment. For untrusted code, don't use a self-hosted runner.

### Risk Levels by Repository Type

| Repository Type | Risk Level | Recommendation |
|-----------------|------------|----------------|
| **Private repos you control** | Low | Safe—you're running your own code |
| **Private repos with external contributors** | Medium | Review PRs carefully before running CI |
| **Public repos** | High | **Not recommended**—any PR can run arbitrary code |
| **Forks** | High | Forked repo workflows can be modified maliciously |

### Comparison to GitHub-Hosted Runners

| Feature | GitHub-Hosted | localmost |
|---------|---------------|-----------|
| Fresh environment | New VM each job | Sandbox rebuilt fresh each start |
| Filesystem isolation | VM boundary | sandbox-exec restricts writes |
| Network isolation | VM boundary | Proxy allowlist |
| Credential isolation | No access to host | Home directory denied |

The sandbox is rebuilt fresh on each runner start and confines all writes to the runner directory and temp paths. Workflows cannot modify files elsewhere on your system or exfiltrate data to non-allowlisted hosts.

### User Filter

localmost includes a user filter that restricts which GitHub users' jobs are accepted:

| Mode | Description |
|------|-------------|
| **Everyone** | Accept jobs triggered by any user (default) |
| **Just me** | Only accept jobs triggered by the authenticated user |
| **Allowlist** | Only accept jobs from specific GitHub usernames |

When a job is triggered by a user not matching the filter, localmost automatically cancels the workflow run.

### Recommendations

1. **Only use for private repositories you control**
2. **Review all workflow changes** before they run
3. **Disable "Run workflows from fork pull requests"** in repo settings
4. **Use the user filter** to restrict which users' jobs run locally

For more information on self-hosted runner security, see:
- [GitHub: Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
- [Praetorian: Self-Hosted GitHub Runners Are Backdoors](https://www.praetorian.com/blog/self-hosted-github-runners-are-backdoors/)
- [Synacktiv: GitHub Actions exploitation](https://www.synacktiv.com/en/publications/github-actions-exploitation-self-hosted-runners)

## Heartbeat Mechanism

The runner availability check uses a GitHub Actions variable instead of requiring API tokens in workflows:

- **Repository/Org Variable**: localmost updates a `LOCALMOST_HEARTBEAT` variable with the current timestamp
- **Minimal Data**: Contains only an ISO 8601 timestamp - no secrets or sensitive information
- **No Workflow Tokens**: CI workflows read the variable directly without any authentication
- **Staleness Detection**: Heartbeat older than 90 seconds indicates runner is offline
- **Update Frequency**: Heartbeat is updated every 60 seconds while runners are active
- **Automatic Setup**: Variable is created/updated automatically when the runner starts

This approach simplifies workflows by:
- Allowing workflows to check runner availability without needing API tokens
- Using the same permissions already required for runner registration

## IPC Security

- All IPC communication uses named channels defined in `shared/types.ts`
- Renderer can only invoke explicitly exposed methods via the preload script
- No direct access to Node.js APIs from renderer process

## Log Sanitization

Log messages are sanitized before being written to disk or displayed:
- GitHub tokens (`ghp_*`, `gho_*`, etc.) are redacted
- JWT tokens are redacted
- GitHub registration tokens are redacted
- Encrypted values and bearer tokens are redacted
- Sanitization applies to both the log file and renderer display

## Code Signing

Code signing is required for distribution to prevent tampering warnings and establish trust.

### macOS Requirements

**Certificates needed:**
- Apple Developer Program membership ($99/year)
- "Developer ID Application" certificate for distribution outside App Store
- "Developer ID Installer" certificate if distributing PKG installers

**Entitlements**: See `entitlements.plist` for App Sandbox and Hardened Runtime configuration.

**Forge config for signing and notarization:**
```js
packagerConfig: {
  osxSign: {
    identity: process.env.APPLE_IDENTITY,
    hardenedRuntime: true,
    entitlements: './entitlements.plist',
    'entitlements-inherit': './entitlements.plist',
    'gatekeeper-assess': false,
    strictVerify: true,
  },
  osxNotarize: {
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  },
},
```

**CI environment variables:**
- `APPLE_IDENTITY`: Certificate name (e.g., "Developer ID Application: Your Name (TEAM_ID)")
- `APPLE_ID`: Apple ID email for notarization
- `APPLE_APP_SPECIFIC_PASSWORD`: App-specific password (not your Apple ID password)
- `APPLE_TEAM_ID`: 10-character Team ID from Apple Developer account

**Notarization** is required for macOS 10.15+ to avoid Gatekeeper warnings. Apple scans the signed app for malware before issuing a notarization ticket.

## Verifying Integrity

### Verifying the localmost app

The app is code-signed and notarized by Apple. To verify:

```bash
codesign -dv --verbose=2 /Applications/localmost.app
```

Look for:
- `Authority=Developer ID Application: Bright Fulton (8D3BFBJK55)`
- `TeamIdentifier=8D3BFBJK55`

### Verifying the runner binary

Runner binaries can be independently verified against GitHub's published checksums:

1. Find the expected checksum at https://github.com/actions/runner/releases
2. Compute the checksum of your downloaded runner:
   ```bash
   shasum -a 256 ~/.localmost/runner/arc/v*/actions-runner-*.tar.gz
   ```
3. Compare the hashes

Note: localmost performs this verification automatically during download.
