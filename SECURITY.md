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

- **Filesystem writes**: Workflows cannot write to files outside the runner directory and temp paths
- **Home directory access**: Workflows cannot access `~/.ssh`, `~/.aws`, `~/.config`, or other sensitive dotfiles
- **Network exfiltration**: Workflows can only connect to allowlisted hosts (GitHub, npm, PyPI, etc.)
- **Credential exposure**: OAuth tokens are encrypted at rest using macOS Keychain

### What localmost trusts (does NOT protect against)

- **GitHub's infrastructure**: OAuth, API responses, and runner binary distribution are trusted. If GitHub is compromised, localmost provides no additional protection.
- **Malware on your machine**: If your system is already compromised, localmost cannot protect you.
- **A compromised GitHub account**: If an attacker has access to your GitHub account, they can modify workflows that run on your runner.
- **Allowlisted hosts**: Data can be exfiltrated to any host on the network allowlist (GitHub, npm, etc.).

## Authentication

- **OAuth Device Flow**: Uses GitHub's Device Flow for user authentication, appropriate for desktop applications that cannot securely store client secrets
- **Token Management**: Access tokens and refresh tokens are obtained via the GitHub App OAuth flow
- **Token Refresh**: Expired tokens are automatically refreshed using refresh tokens
- **Required Permissions**:
  - `Administration: Read & Write` - Register and remove self-hosted runners on repositories
  - `Actions: Read & Write` - Check workflow status and cancel running jobs
  - `Metadata: Read` - Access basic repository information (required by GitHub for all apps)
  - `Self-hosted runners: Read & Write` (org-level) - Register runners at the organization level

## Credential Storage

- **Location**: Configuration stored in `~/.localmost/config.yaml`
- **Encryption**: Sensitive tokens (access token, refresh token) are encrypted using Electron's `safeStorage` API
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
