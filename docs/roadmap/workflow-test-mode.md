# Workflow Test Mode

Run and validate GitHub Actions workflows locally before pushing.

> **Superseded in part.** This is the original design. `localmost test` now
> runs each step in a fresh macOS VM from localmost's golden image, through
> the running app, as runner jobs run (see
> [macos-vm-jobs.md](./macos-vm-jobs.md)). What follows about `sandbox-exec`,
> a filesystem box, running without the app, and filesystem discovery
> describes that earlier design and no longer applies; the workflow parsing,
> matrix and secrets handling, and network discovery through the run's proxy
> still do.

## Problem

The CI feedback loop is painfully slow:

```
push → wait 20 min → CI fails (YAML typo) → fix → push → wait 20 min → repeat
```

This kills flow state. For developers iterating fast, it's death by a thousand cuts.

## Solution

A standalone CLI command that executes workflows locally in seconds:

```bash
localmost test                              # Run default workflow
localmost test .github/workflows/build.yml  # Run specific workflow
localmost test build.yml --job build-ios    # Run specific job
```

### Core principle: Parity over perfection

The goal isn't to perfectly simulate GitHub's environment — it's to catch 90% of failures in 10% of the time. Optimize for fast feedback, not identical reproduction.

## User Experience

Output shows real-time streaming, just like watching CI:

```
▶ build-ios
  ✓ actions/checkout@v4 (0.3s)
  ✓ Setup Xcode (1.2s)
  ⠋ Run xcodebuild... (23s)
```

On failure, show exactly what diverged and suggest fixes.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  localmost test                 │
├─────────────────────────────────────────────────┤
│  1. Parse workflow YAML                         │
│  2. Resolve matrix/conditionals                 │
│  3. For each step:                              │
│     - If action → fetch + run in sandbox        │
│     - If run → execute in sandbox               │
│  4. Stream output, capture exit codes           │
│  5. Report pass/fail + diff from expected       │
└─────────────────────────────────────────────────┤
                        │
                        ▼
         ┌──────────────────────────────┐
         │    Existing runner sandbox   │
         │  (network allowlist, fs box) │
         └──────────────────────────────┘
```

### Standalone CLI — No App Required

```
┌─────────────────────────────────────────────────────────┐
│  npm install -g localmost                               │
│  cd my-project                                          │
│  localmost test                                         │
│                                                         │
│  No app. No tray. No auth. No GitHub API calls.         │
└─────────────────────────────────────────────────────────┘
```

This is critical for adoption. The test command should work without installing the full Electron app.

The upgrade path:

```
Day 1:    npx localmost test              (zero install)
             ↓
          npm install -g localmost        (faster repeat runs)
             ↓
Day 7:    localmost start                 (install app, get background CI)
```

## Key Design Decisions

### 1. Use the working tree, not a fresh clone

GitHub runners do a fresh checkout. But for local testing, use the current working directory — including uncommitted changes. That's the whole point: test *before* you commit.

```bash
localmost test            # Uses current directory with uncommitted changes
localmost test --staged   # Uses staged changes only
```

**Implementation:**

The files come from git, which reads the ignore rules as it always does:
`git ls-files -z --cached --others --exclude-standard` (in a checkout that
is not a repository, or lies in a repository that ignores it, the same
against an empty scratch repository), less `.git`, `node_modules` and the
other default excludes. A submodule or a repository nested in the checkout
is listed the same way in it, and what the checkout's rules ignore is taken
out of that too (`git check-ignore --no-index`). `--no-ignore` copies every
file but the default excludes; `--staged` copies the tracked files and
leaves a submodule's directory empty. The `.gitignore` is never handed to
rsync as filter rules, whose syntax reads a lone `!` as "forget every
exclude so far", `.git` among them.

Each path is looked up by the name git lists, which the volume resolves
whatever the Unicode form or case the name has on disk, rather than matched
against a walk of the checkout.

Each file is copied with `COPYFILE_FICLONE`: an APFS clone, which is
copy-on-write and near instant, or a byte copy where the volume cannot clone.
Never a hard link (`cp -al`, `rsync --link-dest`): a hard-linked file is the
checkout's own file, and every step can write the workspace. Links are copied
as links, and FIFOs and sockets are left out.

The copy becomes the runner's `$GITHUB_WORKSPACE`.

### 2. Intercept `actions/checkout`

When parsing the workflow, detect checkout steps and replace with a synthetic step:

```typescript
if (step.uses?.startsWith('actions/checkout')) {
  return {
    type: 'synthetic',
    run: async (ctx) => {
      ctx.env.GITHUB_SHA = await exec('git rev-parse HEAD');
      ctx.env.GITHUB_REF = await exec('git symbolic-ref HEAD');
      ctx.log('Using local working tree');
    }
  };
}
```

**Edge cases:**

| Case | Behavior |
|------|----------|
| `actions/checkout` with `ref:` param | Warn: "Ignoring ref: using local HEAD" |
| `actions/checkout` with `repository:` param | Clone that repo (it's a dependency) |
| Multiple checkouts (monorepo patterns) | First is stubbed, others clone normally |
| `actions/checkout` with `submodules: true` | Run `git submodule update` in the copy |

### 3. Stub expensive/external steps by default

Some steps don't make sense locally:

- `actions/upload-artifact` — no point uploading to GitHub
- `actions/cache` — redirect to local cache transparently
- Deployment steps — dangerous to run locally

Default behavior: stub with a warning. Opt-in to actually run them.

```
⚠ actions/upload-artifact@v4 — stubbed (use --live-artifacts to upload)
```

### 4. Secrets: prompt or stub, never guess

```
⚠ Secret APPSTORE_CONNECT_KEY not found
  [s] Stub with empty string
  [p] Prompt for value (stored in keychain)
  [a] Abort
```

Store prompted secrets locally (encrypted) so you don't re-enter them every run.

### 5. Matrix builds: run one by default

```bash
localmost test               # Run first matrix combo only (fast)
localmost test --full-matrix # Run all matrix combinations
```

Solo devs usually care about one platform. Don't waste time on the full matrix unless asked.

### 6. Show environment diff

After the run, surface environment differences:

```
Environment diff:
  RUNNER_OS: macOS (local) vs macos-latest (GitHub: macOS 14.5)
  Xcode: 16.0 (local) vs 15.4 (GitHub default)

  Suggestion: Add `xcode-select` step to pin Xcode version
```

This catches most "works locally, fails in CI" bugs.

### 7. Redirect `actions/cache` to local storage

Intercept cache actions and point them at a local directory:

```typescript
if (step.uses?.startsWith('actions/cache')) {
  // Redirect to ~/.localmost/cache/
  // Same key-based lookup, just local storage
}
```

This makes repeated test runs much faster than GitHub — no network upload/download.

## What NOT to Build

- **Perfect GitHub environment emulation** — Docker-based GitHub runner images exist. They're slow and heavy. Don't compete there.
- **Visual workflow editor** — Out of scope. This is a CLI-first power tool.
- **Hosted "preview" runs** — Keep it fully local. No new infrastructure.

## Standalone CLI Components

| Component | Source |
|-----------|--------|
| Workflow YAML parser | Shared library (already exists) |
| Step executor | Extracted from runner logic |
| Sandbox (fs/network) | Simplified version — no proxy server, just `sandbox-exec` |
| Action fetcher | Download from GitHub, cache in `~/.localmost/actions/` |

The heavy parts of the current app — GitHub auth, runner registration, heartbeat, tray UI — aren't needed for local testing.

## Integration with .localmostrc

See [localmostrc.md](./localmostrc.md) for the sandbox policy file design.

| Command | Behavior |
|---------|----------|
| `localmost test` | Run the workflow in a macOS VM, its proxy enforcing `.localmostrc` |
| `localmost test --updaterc` | Let every host through, record the hosts reached, prompt to update file |
| `localmost test --dry-run` | Show the steps that would run, without a VM |

## Why This Wins

| Alternative | Problem |
|-------------|---------|
| `act` (existing tool) | Docker-based, slow, Linux-only containers |
| Manual script | Doesn't match workflow semantics |
| Just push and see | 20-minute feedback loop |

localmost already has the sandbox, the runner infrastructure, and the macOS focus. This feature is a natural extension that reuses existing primitives while solving the tightest pain point in the CI loop.
