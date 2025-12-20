# Claude Code Guidelines

## Decision Making

- Don't disable warnings, linters, or other developer guardrails without discussing first
- When there are multiple valid approaches to a problem, present options and ask before implementing
- Prefer allowlists over blocklists when configuring what to include/exclude

## Build & Packaging

- This is a macOS-only Electron app; no need to support Windows or Linux
- Release builds: on `main` branch with clean working tree
- Dev builds: on any branch or with uncommitted changes
- Use `security find-identity` to detect signing identities from keychain
