# Privacy Policy

**Last Updated: December 2025**

## Overview

localmost is an open-source desktop application that enables you to run GitHub Actions self-hosted runners on your local machine. This privacy policy explains what data the application collects, how it's used, and how it's protected.

## Data Collection

### What We Collect

localmost collects and stores the following data **locally on your device**:

1. **GitHub Account Information**
   - GitHub username (login)
   - Display name
   - Profile avatar URL

2. **Authentication Tokens**
   - GitHub OAuth access token
   - GitHub OAuth refresh token (if applicable)
   - Token expiration timestamp

3. **Runner Configuration**
   - Selected repository or organization
   - Runner name and labels
   - Parallelism settings

4. **Application Preferences**
   - Theme preference (light/dark/auto)
   - Startup behavior settings
   - Log and history limits

### What We Do NOT Collect

- We do **not** collect personal information beyond what GitHub provides
- We do **not** track your usage or behavior within the application
- We do **not** send telemetry or analytics data to any server
- We do **not** access or store the contents of your repositories
- We do **not** collect or transmit any data to third parties

## Data Storage

### Local Storage

All data is stored locally on your device. The storage location depends on how the app is installed:

**For development or non-sandboxed builds:**
- `~/.localmost/` directory

**For App Store or sandboxed builds:**
- `~/Library/Application Support/localmost/`

Within this directory, the following files are stored:

| File | Description |
|------|-------------|
| `config.yaml` | Application configuration, GitHub authentication (encrypted), runner settings, and UI preferences |
| `job-history.json` | History of recently executed workflow jobs (repo, workflow name, status, duration) |
| `logs/` | Application log files (rotated, max 10 files) |
| `runner/` | GitHub Actions runner binaries and per-instance configuration |

### Security Measures

- **Encryption**: OAuth tokens are encrypted using the operating system's secure storage (Electron's safeStorage API which uses the system keychain on macOS and credential manager on other platforms)
- **No Plaintext Secrets**: Sensitive credentials are never stored in plaintext
- **Log Sanitization**: Tokens and secrets are automatically redacted from log files
- **Local-Only**: Configuration files never leave your device

## Third-Party Services

### GitHub

localmost integrates with GitHub to:

- Authenticate you via GitHub OAuth Device Flow
- Register self-hosted runners with your repositories or organizations
- Fetch repository and organization information you have access to
- Store runner authentication secrets (LOCALMOST_TOKEN) in your repository/organization secrets

When you authenticate, GitHub receives standard OAuth request data. GitHub's use of your data is governed by [GitHub's Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement).

### GitHub Actions Runner

The GitHub Actions runner binary (downloaded from GitHub's official releases) communicates directly with GitHub's services to:

- Listen for and execute workflow jobs
- Report job status and logs back to GitHub

This communication is between the runner and GitHub; localmost does not intercept or store this data.

## Your Rights

You have full control over your data:

- **Access**: View all stored data in the localmost directory (see "Local Storage" above for the location)
- **Deletion**: Delete your data by removing the localmost directory or signing out within the app
- **Revocation**: Revoke localmost's GitHub access at any time from your [GitHub Applications Settings](https://github.com/settings/applications)

## Data Retention

- Data is retained only while you use the application
- Signing out removes authentication tokens from your device
- Uninstalling the application and removing the localmost directory removes all stored data
- Log files are automatically rotated (maximum 10 files kept)
- Job history is limited to a configurable number of entries (default: 10)

## Children's Privacy

localmost is a developer tool and is not intended for use by children under 13 years of age.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be documented in the application's repository and reflected in the "Last Updated" date above.

## Open Source

localmost is open source software. You can review exactly what data is collected and how it's handled by examining the source code at:

https://github.com/bfulton/localmost

## Contact

For privacy-related questions or concerns, please open an issue on the GitHub repository:

https://github.com/bfulton/localmost/issues
