# Security

This document describes the security architecture of localmost and tracks known security issues.

## Security Architecture

### Overview

localmost is an Electron desktop application that manages GitHub Actions self-hosted runners. It handles sensitive credentials and executes external binaries, requiring careful security considerations.

### Authentication

- **OAuth Device Flow**: Uses GitHub's Device Flow for user authentication, which is appropriate for desktop applications that cannot securely store client secrets
- **Token Management**: Access tokens and refresh tokens are obtained via the GitHub App OAuth flow
- **Token Refresh**: Expired tokens are automatically refreshed using refresh tokens
- **Scopes**: Requires `Administration: Read & Write` for runner management (GitHub's requirement)

### Credential Storage

- **Location**: Configuration stored in `~/.localmost/config.yaml`
- **Encryption**: Sensitive tokens (access token, refresh token) are encrypted using Electron's `safeStorage` API
  - Uses macOS Keychain for secure storage
  - Encryption key is managed by the operating system and tied to the user account
  - Encrypted values are stored with an `encrypted:` prefix followed by base64-encoded ciphertext
- **Fail-secure**: Plaintext credentials are rejected; users must re-authenticate if OS encryption is unavailable
- **Non-sensitive data**: Settings like theme, runner count, and repository URLs remain in plaintext for easy user editing
- **Access Control**: File permissions are default user permissions

### Encryption Export Compliance

This app uses encryption **solely** for secure credential storage via OS-provided APIs:

| Platform | Encryption Provider | Implementation |
|----------|--------------------|-----------------|
| macOS | Apple Keychain Services | Via Electron `safeStorage` |

**No custom cryptographic algorithms are implemented.** The app delegates all encryption to macOS Keychain APIs.

This usage qualifies for:
- **ECCN 5D992**: Mass-market encryption exemption
- **EAR Note 4**: Exemption for authentication and access control
- **Apple App Store**: No additional export compliance documentation required (uses Apple-provided encryption only)

### Electron Security

The application implements several Electron security best practices:

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

### Content Security Policy

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
- **Restricted sources**: Only same-origin resources allowed, with specific exceptions for GitHub avatars
- **No WebSocket directives**: The app uses Electron IPC for all process communication, eliminating the need for WebSocket CSP permissions
- **Frame/Object blocking**: Prevents embedding of iframes and plugins

### Runner Binary

- **Source**: Downloads official GitHub Actions runner from `github.com/actions/runner` releases
- **Integrity Verification**: Downloads are verified using SHA256 checksums and GitHub attestations (Sigstore/SLSA)
  - Checksum is fetched from GitHub's official release notes
  - Downloaded tarball hash is computed and compared before extraction
  - Download is rejected if checksums don't match, preventing corrupted or tampered binaries
  - GitHub attestations are checked to verify the release went through GitHub's official build pipeline
- **Execution**: Runner binary is spawned as a child process with controlled environment
- **Process Management**: Child processes are managed via Node.js ChildProcess handles
  - Processes are spawned with `detached: false` so they terminate when parent exits
  - Stop/cleanup uses direct process handles stored in the instances Map
  - Stale process cleanup on startup uses path-specific matching (`~/.localmost/runner.*Runner.Listener`) to avoid affecting unrelated processes
- **Directory Isolation**: Each runner instance has its own working directory

### Runner Security Model (Important)

localmost adds isolation layers that the stock GitHub Actions Runner lacks:

#### Sandbox Restrictions

| Resource | Access Level |
|----------|--------------|
| File system (write) | Runner working directory and temp dirs only |
| File system (read) | Essential system paths (`/usr/bin`, `/System/Library`, Xcode) |
| Network | Allowlisted hosts only (GitHub, npm, PyPI, etc.) via HTTP proxy |
| Home directory | **Denied** — no access to `~/.ssh`, `~/.aws`, etc. |
| Other applications | **Denied** — no access to `/Applications` (except Xcode) |

#### What Remains Accessible

| Resource | Access Level |
|----------|--------------|
| Environment variables | All variables in runner process |
| Process spawning | Can spawn any executable in allowed paths |
| Mach/IPC | System frameworks require this |

#### Risk Levels by Repository Type

| Repository Type | Risk Level | Recommendation |
|-----------------|------------|----------------|
| **Private repos you control** | Low | Safe—you're running your own code |
| **Private repos with external contributors** | Medium | Review PRs carefully before running CI |
| **Public repos** | High | **Not recommended**—any PR can run arbitrary code |
| **Forks** | High | Forked repo workflows can be modified maliciously |

#### How localmost Compares to GitHub-Hosted Runners

| Feature | GitHub-Hosted | localmost |
|---------|---------------|-----------|
| Fresh environment | New VM each job | Sandbox rebuilt fresh each start |
| Filesystem isolation | VM boundary | sandbox-exec restricts writes |
| Network isolation | VM boundary | Proxy allowlist |
| Credential isolation | No access to host | Home directory denied |

The sandbox is rebuilt fresh on each runner start and confines all writes to the runner directory and temp paths. Workflows cannot modify files elsewhere on your system or exfiltrate data to non-allowlisted hosts.

#### Recommendations

1. **Only use for private repositories you control**
2. **Review all workflow changes** before they run
3. **Disable "Run workflows from fork pull requests"** in repo settings

For more information on self-hosted runner security, see:
- [GitHub: Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
- [Praetorian: Self-Hosted GitHub Runners Are Backdoors](https://www.praetorian.com/blog/self-hosted-github-runners-are-backdoors/)
- [Synacktiv: GitHub Actions exploitation](https://www.synacktiv.com/en/publications/github-actions-exploitation-self-hosted-runners)

### Heartbeat Mechanism

The runner availability check uses a GitHub Actions variable instead of requiring API tokens in workflows:

- **Repository/Org Variable**: localmost updates a `LOCALMOST_HEARTBEAT` variable with the current timestamp
- **Minimal Data**: Contains only an ISO 8601 timestamp - no secrets or sensitive information
- **No Workflow Tokens**: CI workflows read the variable directly without any authentication
- **Staleness Detection**: Heartbeat older than 90 seconds indicates runner is offline
- **Update Frequency**: Heartbeat is updated every 60 seconds while runners are active
- **Automatic Setup**: Variable is created/updated automatically when the runner starts

This approach improves security by:
- Eliminating the need for tokens in workflow secrets
- Keeping sensitive OAuth tokens out of CI/CD pipelines
- Using the same permissions already required for runner registration

### IPC Security

- All IPC communication uses named channels defined in `shared/types.ts`
- Renderer can only invoke explicitly exposed methods via the preload script
- No direct access to Node.js APIs from renderer process

### Log Sanitization

Log messages are sanitized before being written to disk or displayed:
- GitHub tokens (`ghp_*`, `gho_*`, etc.) are redacted
- JWT tokens are redacted
- GitHub registration tokens are redacted
- Encrypted values and bearer tokens are redacted
- Sanitization applies to both the log file and renderer display

### Code Signing

Code signing is required for distribution to prevent tampering warnings and establish trust.

#### macOS Requirements

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

## Reporting Security Issues

If you discover a security vulnerability, please report it by:
1. Opening a private security advisory on GitHub
2. Emailing the maintainers directly

Please do not open public issues for security vulnerabilities.

## Known Issues

### App Store Distribution (Guideline 2.5.2)

**Status:** Not pursuing

Mac App Store distribution is incompatible with localmost's architecture due to Apple's Guideline 2.5.2, which prohibits apps from downloading and executing code not reviewed by Apple.

localmost is distributed outside the App Store via:
- Direct download (DMG) with Apple notarization
- Homebrew cask (planned)
- GitHub Releases

This is consistent with other developer tools (Docker Desktop, VS Code, iTerm2) which also distribute outside the App Store.

### Runner Sandbox Limitations

**Status:** Mitigated

Runner processes are sandboxed via `sandbox-exec` with filesystem and network restrictions. However, the sandbox is not a complete security boundary:

- Processes can still spawn other executables in allowed paths
- Environment variables are accessible
- Mach/IPC operations are allowed (required for system frameworks)

See [Runner Security Model](#runner-security-model-important) for details.
