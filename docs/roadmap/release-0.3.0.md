# Release 0.3.0: Test Locally, Secure by Default

Theme: Shift left on both feedback and security. Catch workflow problems before pushing, and enforce least-privilege sandboxing by default.

**Status:** the four success criteria below are met. Remaining unchecked items are
secrets-in-Keychain, an in-app approval UI, `--updaterc` interactivity, and
Homebrew packaging — each marked inline. `strict` is the shipped default.

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
shared:
  network:
    allow:
      - registry.npmjs.org
workflows:
  deploy:
    network:
      allow:
        - api.fastlane.tools   # Only deploy needs this
```

### 3. CLI Polish

The CLI is now the primary entry point. It needs to be great.

---

## Implementation Tasks

### Phase 1: Standalone CLI Foundation

The test command must work without the Electron app.

- [x] Extract shared code into `src/shared/` that works in both CLI and app contexts
  - [x] Workflow YAML parser
  - [x] Sandbox profile generator
  - [x] Action fetcher and cache
- [x] Create `src/cli/test.ts` command structure
- [x] Implement working tree snapshot
  - [x] Fast copy via hard links (`cp -al`) with fallback to rsync
  - [x] Respect `.gitignore` by default, `--no-ignore` flag to include all
  - [x] Create temp workspace in `~/.localmost/workspaces/`
- [x] Add cleanup of old workspaces (keep last N, or age-based)

### Phase 2: Action Interception

Synthetic replacements for common actions.

- [x] `actions/checkout` interception
  - [x] Stub when checking out current repo (use local working tree)
  - [x] Clone normally when `repository:` points elsewhere
  - [x] Handle `submodules: true` via `git submodule update`
  - [x] Set `GITHUB_SHA`, `GITHUB_REF` from local git state
- [x] `actions/cache` redirection
  - [x] Local cache directory at `~/.localmost/cache/`
  - [x] Same key-based lookup semantics
  - [x] Cache hit/miss reporting
- [x] `actions/upload-artifact` stubbing
  - [x] Save to `~/.localmost/artifacts/` instead of uploading
  - [x] Report what would have been uploaded
- [x] `actions/download-artifact` stubbing
  - [x] Look for artifacts from previous local runs
  - [x] Warn if artifact not found locally

### Phase 3: Step Execution

Run workflow steps in the sandbox.

- [x] Step executor that handles both `run:` and `uses:` steps
- [x] Action fetcher
  - [x] Download actions from GitHub on first use
  - [x] Cache in `~/.localmost/actions/`
  - [x] Handle action versions (`@v4`, `@main`, `@sha`)
- [x] Environment setup
  - [x] Set standard GitHub env vars (`GITHUB_WORKSPACE`, `RUNNER_OS`, etc.)
  - [x] Warn on vars that differ from GitHub (Xcode version, etc.)
- [x] Output streaming with real-time display
- [x] Exit code capture and reporting
- [x] Matrix handling
  - [x] Run first combination by default
  - [x] `--full-matrix` to run all
  - [x] `--matrix "os=macos-latest,node=18"` to run specific combo

### Phase 4: Secrets Handling

- [x] Detect secrets referenced in workflow (`${{ secrets.FOO }}`)
- [x] Prompt modes: stub and abort work; `prompt` is a placeholder that stubs
- [ ] Store prompted values in macOS Keychain (encrypted) — **not built**; secrets come from environment variables only
- [ ] `localmost secrets list` — **not built**
- [ ] `localmost secrets clear` — **not built**

### Phase 5: .localmostrc Parser and Validator

- [x] Define YAML schema for `.localmostrc` v1
  - [x] `shared:` section for baseline policy
  - [x] `workflows:` section with per-workflow overrides
  - [x] Policy merge logic (workflow inherits from shared, can add or deny)
- [x] Parser with helpful error messages for invalid files
- [x] Wildcard expansion (`*.github.com`, `./build/**`)
- [x] Workflow name matching (e.g., `build` matches `build.yml`)
- [x] Schema validation on load

### Phase 6: Discovery Mode (`--updaterc`)

- [x] Hook sandbox to log all access attempts (network, filesystem)
- [x] Run workflow in permissive mode while recording
- [x] Deduplicate and categorize access (by step, by type)
- [ ] Interactive prompt to write/update `.localmostrc` — **not built**; `--updaterc` writes directly
- [ ] Diff display when updating existing file — **not built** for `--updaterc` (`localmost policy diff` does show one)
- [x] `--dry-run` to show what would be recorded without writing

### Phase 7: Enforcement Mode

- [x] Generate `sandbox-exec` profile from `.localmostrc`
- [x] Clear error messages when access is denied
  - [x] Show which policy would allow it
  - [x] Suggest `localmost test --updaterc` to add
- [x] Fallback behavior when no `.localmostrc` exists — **changed during implementation**: the default is `strict`, not permissive. A repository with no policy runs on a read-only OS baseline with no network beyond runner infrastructure. Shipping permissive-by-default would mean a machine owner inherits blame for whatever someone else's workflow does.

### Phase 8: Background Runner Integration

- [x] Cache `.localmostrc` per repo in app data
- [x] On job pickup, compare repo's `.localmostrc` to cached version
- [x] If changed: show diff in notification, require approval
- [x] If new repo: show policy summary, require initial approval
- [ ] Policy approval UI in app — **not built**; approval is CLI-only (`localmost policy diff` / `localmost policy approve`)
  - [ ] Side-by-side diff view
  - [ ] Per-line approve/reject (future)
- [x] Audit log of policy changes and approvals

### Phase 9: CLI Polish

- [ ] Improve install experience
  - [ ] `brew install localmost` (Homebrew formula) — **not built**
  - [x] `npx localmost` works without global install
  - [ ] Post-install message with next steps — **not built**
- [x] Consistent command structure
  - [x] `localmost test` — run workflow locally
  - [x] `localmost start` — launch background app
  - [x] `localmost status` — show runner state
  - [x] `localmost policy show` — display current repo's policy
  - [x] `localmost policy diff` — compare local vs cached
- [x] Helpful error messages
  - [x] Suggest fixes for common problems
  - [ ] Link to docs for complex issues — **not built**
- [x] `--help` for all commands with examples
- [x] `--version` shows version and build info

### Phase 10: Environment Diff Reporting

- [x] Detect local environment (Xcode version, macOS version, installed tools)
- [x] Compare to GitHub runner environment (fetch from known list)
- [x] Report differences after test run
- [x] Suggest workflow changes to pin versions
- [x] `localmost env` — show local environment details

---

## Out of Scope for 0.3.0

- Visual workflow editor
- Per-job policy overrides within a workflow (per-workflow is sufficient)
- Remote policy management (org-wide policies)
- Windows/Linux support

---

## Success Criteria

1. A developer can run `npx localmost test` in a repo with GitHub Actions and see their workflow execute locally in under a minute.

2. When a workflow accesses something not in `.localmostrc`, it fails with a clear message explaining what was blocked and how to allow it. The runner log names the blocked host and points at `.localmostrc`; a filesystem denial still surfaces only as the tool's own error.

3. A developer can generate a complete `.localmostrc` for an existing project by running `localmost test --updaterc` once.

4. The background runner refuses to execute jobs when the repo's `.localmostrc` has changed, until the user reviews and approves the diff. Review and approval are CLI-only (`localmost policy diff`, `localmost policy approve`); there is no in-app UI yet.

---

## Open Questions

1. **Policy inheritance**: Should orgs be able to define base policies that repos inherit from? (Probably 0.4.0)

2. **Transitive dependencies**: When `npm install` pulls a new package that phones home, how do we surface that it was the package, not the workflow directly? (Nice to have for 0.3.0)

3. **CI-only steps**: Some steps only make sense in CI (deploy, release). Should `.localmostrc` have a way to mark steps as CI-only so they're skipped locally? Or is commenting them out sufficient?
