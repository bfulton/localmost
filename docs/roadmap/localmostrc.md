# .localmostrc — Declarative Sandbox Policy

A checked-in file that explicitly declares what network and filesystem access a workflow needs.

> **Status:** implemented in 0.3.0. This document describes the design; where the
> shipped behaviour differs it is noted inline.

## Problem

Before 0.3.0 the sandbox used a single global allowlist (GitHub, npm, PyPI, etc.).
That was:

1. **Too permissive** — Every repo got access to everything on the allowlist
2. **Not auditable** — No visibility into what a specific project actually needs
3. **Reactive** — You found out about new access requirements when things failed

## Solution

Each repo declares its sandbox policy in `.localmostrc`:

```yaml
# .localmostrc
version: 1

shared:                          # Applies to all workflows
  network:
    allow:
      - registry.npmjs.org
      - github.com
  filesystem:
    write:
      - ./build/

workflows:                       # Per-workflow additions
  deploy:
    network:
      allow:
        - api.fastlane.tools     # Only deploy needs this
```

**Default sandbox: deny everything.** Only punch holes for what's declared. Each workflow gets shared policy plus its own additions.

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

# Shared policy — baseline for all workflows
shared:
  network:
    allow:
      - "*.github.com"           # Wildcard subdomain
      - "registry.npmjs.org"     # Exact match
    deny:                        # Explicit denials (optional, for clarity)
      - "*.analytics.com"

  filesystem:
    read:
      - "~/.gitconfig"
      - "~/.ssh/known_hosts"
    write:
      - "./build/**"
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

# Per-workflow policies — merged with shared
workflows:
  build:
    filesystem:
      write:
        - "./DerivedData/**"

  deploy:
    network:
      allow:
        - "api.fastlane.tools"
    secrets:
      require:
        - APPSTORE_CONNECT_KEY
```

### Wildcards

| Pattern | Matches |
|---------|---------|
| `*.github.com` | `api.github.com`, `raw.githubusercontent.com` |
| `registry.npmjs.org` | Exact match only |
| `./build/**` | All files under `build/` recursively |
| `~/.ssh/id_*` | `~/.ssh/id_rsa`, `~/.ssh/id_ed25519`, etc. |

### Per-workflow policies

Policies have two levels: **shared** (applies to all workflows) and **per-workflow** (scoped to a specific workflow file).

```yaml
# .localmostrc
version: 1

# Shared policy — applies to ALL workflows
shared:
  network:
    allow:
      - "*.github.com"
      - "registry.npmjs.org"
  filesystem:
    read:
      - "~/.gitconfig"
    write:
      - "./build/**"

# Per-workflow policies — only apply to specific workflows
workflows:
  # Matches .github/workflows/build.yml
  build:
    network:
      allow:
        - "cdn.cocoapods.org"    # CocoaPods for iOS builds
    filesystem:
      write:
        - "./Pods/**"
        - "./DerivedData/**"

  # Matches .github/workflows/deploy.yml
  deploy:
    network:
      allow:
        - "api.fastlane.tools"   # App Store deployment
        - "itunesconnect.apple.com"
    filesystem:
      read:
        - "~/.fastlane/**"       # Fastlane credentials
    env:
      allow:
        - FASTLANE_*
        - MATCH_*
    secrets:
      require:                   # These secrets MUST be provided
        - APPSTORE_CONNECT_KEY
        - MATCH_PASSWORD

  # Matches .github/workflows/test.yml
  test:
    # No additional permissions — inherits only shared policy
```

**Resolution order:**
1. Start with `shared` policy
2. Merge workflow-specific policy (additive)
3. Explicit `deny` in workflow policy can revoke shared access

**Why this matters:**
- A compromised test dependency can't access deploy credentials
- Build workflow can't phone home to analytics even if deploy can
- Each workflow gets exactly what it needs, nothing more

**Workflow matching:**
- Keys under `workflows:` match the workflow filename (without `.yml`/`.yaml`)
- `build` matches `.github/workflows/build.yml`
- For matrix workflows, all jobs in the workflow share the workflow's policy

**Discovery mode with per-workflow policies:**

```bash
localmost test --updaterc build.yml
```

```
Discovered access for build.yml:
  shared (already allowed):
    ✓ registry.npmjs.org
    ✓ github.com

  workflow-specific (new):
    + network: cdn.cocoapods.org
    + filesystem write: ./Pods/**

Add to .localmostrc under workflows.build? [y/n]
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

### Relationship to the policy level

**Shipped behaviour differs from this design.** A `.localmostrc` does not replace
anything; it adds to whatever the configured policy level already allows:

- `strict` (the default): runner infrastructure, a read-only OS baseline, and
  whatever the repo declares. This is closest to the original intent.
- `moderate`: additionally GitHub Actions infrastructure, common registries and
  tool caches.
- `permissive`: no network restrictions.

Two things are always granted regardless of the repo's policy, because nothing
works without them: the hosts the Actions runner itself needs to register and
poll for jobs, and read-only access to Apple-shipped system paths. Both are
documented in SECURITY.md.

A repo's policy only takes effect once approved — see
`localmost policy approve`.

### CI vs local differences

Some access may only be needed in CI (deployment credentials) or only locally (debug tools). Use comments to document:

```yaml
network:
  allow:
    - registry.npmjs.org
    - fastlane.tools         # CI only: app store deployment
```

## Security Benefits

1. **Least privilege by default** — `strict` is the default. Each repo declares what it needs beyond the baseline.

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
