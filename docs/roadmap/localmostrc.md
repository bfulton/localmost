# .localmostrc — Declarative Sandbox Policy

A checked-in file that explicitly declares what network and filesystem access a workflow needs.

## Problem

The current sandbox uses a global allowlist (GitHub, npm, PyPI, etc.). This is:

1. **Too permissive** — Every repo gets access to everything on the allowlist
2. **Not auditable** — No visibility into what a specific project actually needs
3. **Reactive** — You find out about new access requirements when things fail

## Solution

Each repo declares its sandbox policy in `.localmostrc`:

```yaml
# .localmostrc
version: 1

network:
  allow:
    - registry.npmjs.org
    - github.com
    - api.fastlane.tools

filesystem:
  read:
    - ~/.gitconfig
    - ~/.ssh/known_hosts
  write:
    - ./build/
    - ./DerivedData/

env:
  - DEVELOPER_DIR
  - HOME
```

**Default sandbox: deny everything.** Only punch holes for what's declared.

## The Workflow

### 1. First run: Discovery mode

```bash
localmost test --updaterc
```

Runs the workflow permissively but logs all access:

```
Discovered access:
  network:
    + registry.npmjs.org (npm install)
    + github.com (actions/checkout)
    + api.cocoapods.org (pod install)    ← new

  filesystem:
    + read: ~/.netrc (git credential)
    + write: ./Pods/                      ← new

Write to .localmostrc? [y/n]
```

### 2. Subsequent runs: Enforced mode

```bash
localmost test
```

Strictly enforces `.localmostrc`. New access = hard failure:

```
✗ Network access denied: api.sketchy-cdn.com
  Not in .localmostrc allowlist

  To allow, run: localmost test --updaterc
```

### 3. Background runner: Cached policy + diff review

The app caches `.localmostrc` per repo. When it changes:

```
┌─────────────────────────────────────────────────┐
│  Policy change detected: myorg/mygame           │
│                                                 │
│  + network: api.newservice.com                  │
│  - network: api.oldservice.com (removed)        │
│                                                 │
│  [Allow] [Deny] [View Diff]                     │
└─────────────────────────────────────────────────┘
```

A compromised dependency that tries to exfiltrate data would:
1. Fail immediately (not in allowlist)
2. Require explicit human approval to add

## File Format

### Full schema

```yaml
# .localmostrc
version: 1

network:
  allow:
    - "*.github.com"           # Wildcard subdomain
    - "registry.npmjs.org"     # Exact match
    - "cdn.cocoapods.org"
  deny:                        # Explicit denials (optional, for clarity)
    - "*.analytics.com"

filesystem:
  read:
    - "~/.gitconfig"
    - "~/.ssh/known_hosts"
  write:
    - "./build/**"
    - "./DerivedData/**"
  deny:
    - "~/.aws/*"               # Explicit paranoia
    - "~/.ssh/id_*"

env:
  allow:
    - DEVELOPER_DIR
    - HOME
    - PATH
  deny:
    - AWS_*
    - GITHUB_TOKEN             # Don't leak to subprocesses
```

### Wildcards

| Pattern | Matches |
|---------|---------|
| `*.github.com` | `api.github.com`, `raw.githubusercontent.com` |
| `registry.npmjs.org` | Exact match only |
| `./build/**` | All files under `build/` recursively |
| `~/.ssh/id_*` | `~/.ssh/id_rsa`, `~/.ssh/id_ed25519`, etc. |

### Per-job overrides (future)

```yaml
jobs:
  build:
    network:
      allow: [npm, github]
  deploy:
    network:
      allow: [npm, github, fastlane]
```

## Why Checked Into Git

**Version controlled:**
- Team members share the same policy
- PR review catches suspicious additions
- History shows when/why access was added

**Auditable:**
```bash
# Find all repos in your org that access unusual domains
grep -r "analytics" *//.localmostrc
```

**Diff-friendly:**
```diff
network:
   allow:
     - registry.npmjs.org
     - github.com
+    - api.newservice.com    # Added for feature X
```

## CLI Commands

| Command | Behavior |
|---------|----------|
| `localmost test` | Enforce `.localmostrc`, fail on violations |
| `localmost test --updaterc` | Permissive, record access, prompt to update |
| `localmost test --dry-run` | Show what *would* be accessed without running |
| `localmost policy show` | Display current policy for this repo |
| `localmost policy diff` | Compare local vs cached policy |

## Edge Cases

### No `.localmostrc` exists

```
No .localmostrc found. Run with --updaterc to generate.
Running in permissive mode (not recommended for untrusted code).
```

### Conflict with global allowlist

When a `.localmostrc` exists, it **replaces** the global allowlist entirely for that repo. This is intentional — the repo author knows what they need.

### CI vs local differences

Some access may only be needed in CI (deployment credentials) or only locally (debug tools). Use comments to document:

```yaml
network:
  allow:
    - registry.npmjs.org
    - fastlane.tools         # CI only: app store deployment
```

## Security Benefits

1. **Least privilege by default** — No more global allowlist. Each repo declares exactly what it needs.

2. **Auditable** — The file is in git. You can grep your org for repos that access unusual domains.

3. **Low friction** — `--updaterc` generates the policy for you. No manual authoring.

4. **Supply chain defense** — A malicious package update that phones home gets blocked unless someone explicitly approves the new domain in a PR.

5. **Defense in depth** — Even if code escapes the sandbox, it can only access declared resources.

## Integration with Workflow Test Mode

See [workflow-test-mode.md](./workflow-test-mode.md) for the local testing CLI design.

The test CLI becomes the policy authoring tool:
- Run your workflow locally
- Let it discover what access it needs
- Review and commit the generated `.localmostrc`

This creates a natural workflow where security policy is generated from actual behavior, not guessed upfront.
