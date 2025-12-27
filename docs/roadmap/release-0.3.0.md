# Release 0.3.0: Test Locally, Secure by Default

Theme: Shift left on both feedback and security. Catch workflow problems before pushing, and enforce least-privilege sandboxing by default.

## Features

### 1. Workflow Test Mode ([design](./workflow-test-mode.md))

Run workflows locally before pushing.

```bash
localmost test                    # Run default workflow
localmost test --updaterc         # Discover and record access policy
```

### 2. Declarative Sandbox Policy ([design](./localmostrc.md))

Per-repo `.localmostrc` files that declare allowed access. Default-deny sandbox.

```yaml
network:
  allow:
    - registry.npmjs.org
filesystem:
  write:
    - ./build/
```

### 3. CLI Polish

The CLI is now the primary entry point. It needs to be great.

---

## Implementation Tasks

### Phase 1: Standalone CLI Foundation

The test command must work without the Electron app.

- [ ] Extract shared code into `src/shared/` that works in both CLI and app contexts
  - [ ] Workflow YAML parser
  - [ ] Sandbox profile generator
  - [ ] Action fetcher and cache
- [ ] Create `src/cli/test.ts` command structure
- [ ] Implement working tree snapshot
  - [ ] Fast copy via hard links (`cp -al`) with fallback to rsync
  - [ ] Respect `.gitignore` by default, `--no-ignore` flag to include all
  - [ ] Create temp workspace in `~/.localmost/workspaces/`
- [ ] Add cleanup of old workspaces (keep last N, or age-based)

### Phase 2: Action Interception

Synthetic replacements for common actions.

- [ ] `actions/checkout` interception
  - [ ] Stub when checking out current repo (use local working tree)
  - [ ] Clone normally when `repository:` points elsewhere
  - [ ] Handle `submodules: true` via `git submodule update`
  - [ ] Set `GITHUB_SHA`, `GITHUB_REF` from local git state
- [ ] `actions/cache` redirection
  - [ ] Local cache directory at `~/.localmost/cache/`
  - [ ] Same key-based lookup semantics
  - [ ] Cache hit/miss reporting
- [ ] `actions/upload-artifact` stubbing
  - [ ] Save to `~/.localmost/artifacts/` instead of uploading
  - [ ] Report what would have been uploaded
- [ ] `actions/download-artifact` stubbing
  - [ ] Look for artifacts from previous local runs
  - [ ] Warn if artifact not found locally

### Phase 3: Step Execution

Run workflow steps in the sandbox.

- [ ] Step executor that handles both `run:` and `uses:` steps
- [ ] Action fetcher
  - [ ] Download actions from GitHub on first use
  - [ ] Cache in `~/.localmost/actions/`
  - [ ] Handle action versions (`@v4`, `@main`, `@sha`)
- [ ] Environment setup
  - [ ] Set standard GitHub env vars (`GITHUB_WORKSPACE`, `RUNNER_OS`, etc.)
  - [ ] Warn on vars that differ from GitHub (Xcode version, etc.)
- [ ] Output streaming with real-time display
- [ ] Exit code capture and reporting
- [ ] Matrix handling
  - [ ] Run first combination by default
  - [ ] `--full-matrix` to run all
  - [ ] `--matrix "os=macos-latest,node=18"` to run specific combo

### Phase 4: Secrets Handling

- [ ] Detect secrets referenced in workflow (`${{ secrets.FOO }}`)
- [ ] Prompt modes: stub, prompt for value, abort
- [ ] Store prompted values in macOS Keychain (encrypted)
- [ ] `localmost secrets list` — show stored secrets for a repo
- [ ] `localmost secrets clear` — remove stored secrets

### Phase 5: .localmostrc Parser and Validator

- [ ] Define YAML schema for `.localmostrc` v1
- [ ] Parser with helpful error messages for invalid files
- [ ] Wildcard expansion (`*.github.com`, `./build/**`)
- [ ] Schema validation on load

### Phase 6: Discovery Mode (`--updaterc`)

- [ ] Hook sandbox to log all access attempts (network, filesystem)
- [ ] Run workflow in permissive mode while recording
- [ ] Deduplicate and categorize access (by step, by type)
- [ ] Interactive prompt to write/update `.localmostrc`
- [ ] Diff display when updating existing file
- [ ] `--dry-run` to show what would be recorded without writing

### Phase 7: Enforcement Mode

- [ ] Generate `sandbox-exec` profile from `.localmostrc`
- [ ] Clear error messages when access is denied
  - [ ] Show which policy would allow it
  - [ ] Suggest `localmost test --updaterc` to add
- [ ] Fallback behavior when no `.localmostrc` exists
  - [ ] Warn and run in permissive mode
  - [ ] Or `--strict` flag to fail without policy file

### Phase 8: Background Runner Integration

- [ ] Cache `.localmostrc` per repo in app data
- [ ] On job pickup, compare repo's `.localmostrc` to cached version
- [ ] If changed: show diff in notification, require approval
- [ ] If new repo: show policy summary, require initial approval
- [ ] Policy approval UI in app
  - [ ] Side-by-side diff view
  - [ ] Per-line approve/reject (future)
- [ ] Audit log of policy changes and approvals

### Phase 9: CLI Polish

- [ ] Improve install experience
  - [ ] `brew install localmost` (Homebrew formula)
  - [ ] `npx localmost` works without global install
  - [ ] Post-install message with next steps
- [ ] Consistent command structure
  - [ ] `localmost test` — run workflow locally
  - [ ] `localmost start` — launch background app
  - [ ] `localmost status` — show runner state
  - [ ] `localmost policy show` — display current repo's policy
  - [ ] `localmost policy diff` — compare local vs cached
- [ ] Helpful error messages
  - [ ] Suggest fixes for common problems
  - [ ] Link to docs for complex issues
- [ ] `--help` for all commands with examples
- [ ] `--version` shows version, build info, and update availability

### Phase 10: Environment Diff Reporting

- [ ] Detect local environment (Xcode version, macOS version, installed tools)
- [ ] Compare to GitHub runner environment (fetch from known list)
- [ ] Report differences after test run
- [ ] Suggest workflow changes to pin versions
- [ ] `localmost env` — show local environment details

---

## Out of Scope for 0.3.0

- Visual workflow editor
- Per-job policy overrides in `.localmostrc`
- Remote policy management (org-wide policies)
- Windows/Linux support

---

## Success Criteria

1. A developer can run `npx localmost test` in a repo with GitHub Actions and see their workflow execute locally in under a minute.

2. When a workflow accesses something not in `.localmostrc`, it fails with a clear message explaining what was blocked and how to allow it.

3. A developer can generate a complete `.localmostrc` for an existing project by running `localmost test --updaterc` once.

4. The background runner refuses to execute jobs when the repo's `.localmostrc` has changed, until the user reviews and approves the diff.

---

## Open Questions

1. **Policy inheritance**: Should orgs be able to define base policies that repos inherit from? (Probably 0.4.0)

2. **Transitive dependencies**: When `npm install` pulls a new package that phones home, how do we surface that it was the package, not the workflow directly? (Nice to have for 0.3.0)

3. **CI-only steps**: Some steps only make sense in CI (deploy, release). Should `.localmostrc` have a way to mark steps as CI-only so they're skipped locally? Or is commenting them out sufficient?
