# localmost

<img src="assets/icon/icon_128x128.png" alt="localmost icon" width="64" height="64" align="left">
Run most of your builds locally
<br>
Self-hosted GitHub Actions runners for your Mac
<br clear="both" />

## Save time and money on macOS builds

GitHub charges [**$0.062/minute**](https://docs.github.com/en/billing/reference/actions-runner-pricing) for their cheapest `macos` runners. A 20-minute build costs **$1.24**. Push twice a day and you're spending **over $50/month** on CI. Run the same jobs on your MacBook and they finish in less than half the time for $0.

Here's what some open source projects would save:

| Project | Builds/mo | Runners | p90 | Cost/mo |
|---------|-----------|---------|-----|---------|
| [Alamofire](https://github.com/Alamofire/Alamofire/actions) | ~9 | macos-15 | 8m | **$14** |
| [mattermost-mobile](https://github.com/mattermost/mattermost-mobile/actions) | ~225 | macos-15-large | 25m | **$321** |
| [SwiftFormat](https://github.com/nicklockwood/SwiftFormat/actions) | ~72 | macos-15 | 4m | **$22** |

<sup>Pricing as of January 2026. Costs calculated from jobs via [generate-benchmarks.sh](scripts/generate-benchmarks.sh).</sup>

Local builds are also faster. Based on [XcodeBenchmark](https://github.com/devMEremenko/XcodeBenchmark):

| Runner | Time | vs GitHub |
|--------|------|-----------|
| GitHub macos-latest | [967s](https://github.com/bfulton/localmost/actions/runs/20388833445/job/58594848226) | — |
| MacBook Air M2 (2022) | 202s | **4.8x faster** |
| MacBook Pro M4 Max (2024) | 77s | **12.6x faster** |

## Why else use localmost?

Features:
- **Automatic fallback** — workflows detect when your Mac is available; fall back to hosted runners when it's not
- **One-click setup** — no terminal commands, no manually generating registration tokens
- **Lid-close protection** — close your laptop without killing in-progress jobs
- **Multi-runner parallelism** — run 1-16 concurrent jobs
- **Network isolation** — runner traffic is proxied through an allowlist (GitHub, npm, PyPI, etc.)
- **Filesystem sandboxing** — runner processes can only write to their working directory

## What It Is

localmost is a macOS app that manages GitHub's official [actions-runner](https://github.com/actions/runner) binary. It handles authentication, registration, runner process lifecycle, and automatic fallback — the tedious parts of self-hosted runners.

## Workflow Integration

Add to your GitHub Actions workflow to automatically use localmost when available:

```yaml
permissions:
  actions: read
  contents: read

jobs:
  check:
    uses: bfulton/localmost/.github/workflows/check.yaml@main

  build:
    needs: check
    runs-on: ${{ needs.check.outputs.runner }}
    steps:
      - uses: actions/checkout@v4
      # ... your steps
```

<details>
<summary>Prefer not to reference an external workflow? Copy the check inline:</summary>

```yaml
jobs:
  check:
    runs-on: ubuntu-latest
    outputs:
      runner: ${{ steps.check.outputs.runner }}
    steps:
      - id: check
        run: |
          HEARTBEAT="${{ vars.LOCALMOST_HEARTBEAT }}"
          if [ -n "$HEARTBEAT" ]; then
            HEARTBEAT_TIME=$(date -d "$HEARTBEAT" +%s 2>/dev/null || echo "0")
            AGE=$(($(date +%s) - HEARTBEAT_TIME))
            if [ "$AGE" -lt 90 ]; then
              echo "runner=self-hosted" >> $GITHUB_OUTPUT
              exit 0
            fi
          fi
          echo "runner=macos-latest" >> $GITHUB_OUTPUT
```
</details>

## How It Works

The check workflow uses a simple heartbeat mechanism:
- localmost automatically updates a `LOCALMOST_HEARTBEAT` variable in your repo/org every 60 seconds
- The workflow reads this variable and checks the timestamp
- If the timestamp is less than 90 seconds old → use `self-hosted`
- Otherwise → fall back to `macos-latest` (or your configured fallback)

This fallback-to-cloud design is intentional: if your Mac is asleep, offline, or the heartbeat is stale for any reason, workflows continue running on GitHub-hosted runners rather than waiting or failing.

## GitHub App Permissions

localmost uses a GitHub App for authentication. During installation, you'll be asked to grant the following permissions:

### Required Permissions

| Permission | Level | Purpose |
|------------|-------|---------|
| **Administration** | Read & Write | Register and remove self-hosted runners on repositories |
| **Actions** | Read | Check workflow run status to determine if runners are needed |
| **Metadata** | Read | Access basic repository information (required by GitHub for all apps) |
| **Self-hosted runners** (org) | Read & Write | Register and remove self-hosted runners at the organization level |

### Why Administration Permission?

GitHub's permission model requires `Administration: Read & Write` for managing self-hosted runners at the repository level. This is the same permission scope needed by the official `actions/runner` registration process.

While this permission could theoretically allow other administrative actions, localmost **only** uses it for:
- Generating runner registration tokens (`POST /repos/{owner}/{repo}/actions/runners/registration-token`)
- Removing runners when you stop them (`DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}`)

localmost is open source — you can verify this by [searching for `actions/runners` in the codebase](https://github.com/bfulton/localmost/search?q=actions%2Frunners).

For organization-level runners, the narrower `Self-hosted runners: Read & Write` permission is used instead of Administration.

### Repository Access

During GitHub App installation, you choose which repositories to grant access to:
- **All repositories** - localmost can register runners for any repo in your account/org
- **Only select repositories** - limit access to specific repos you want to run locally

You can change this at any time in your GitHub settings under **Applications > Installed GitHub Apps > localmost > Configure**.

### Token Security

localmost uses OAuth device flow authentication. Your access token is:
- Encrypted with macOS Keychain and stored locally
- Scoped only to the repositories you explicitly grant access to
- Revocable at any time from your GitHub settings

## CLI Companion

localmost includes a command-line interface for controlling the app from your terminal:

```bash
# Check runner status
localmost status

# Pause the runner (stops accepting new jobs)
localmost pause

# Resume the runner
localmost resume

# View recent job history
localmost jobs
```

To install the CLI globally after building:

```bash
npm link
```

The CLI communicates with the running localmost app via a Unix socket. The app must be running for CLI commands to work.

## Development

Built with Electron + React/TypeScript. Requires Node.js 18+.

```bash
# Clone and install dependencies
git clone https://github.com/bfulton/localmost.git
cd localmost
npm install

# Start the app in development mode
npm start

# Run tests
npm test

# Build for macOS (creates .dmg)
npm run make
```

## Roadmap

Future feature ideas:

- **Multiple repo/org runner registration** - Support registering runners with more than one repo / org, or a mix of repos and orgs.
- **Resource-aware scheduling** - Pause runners when on battery or during video calls.
- **Quick actions** - Re-run failed job, cancel all jobs.
- **Notifications** - Native macOS notifications for job completion/failure.
- **Deep links** - Jump directly to job logs in GitHub.
- **Audit logging** - Detailed logs of what each job accessed.
- **Network policy customization** - User-defined network allowlists per repo.
- **Auto-update** - In-app update mechanism.
- **Workflow testing mode** - Run and validate workflows locally before pushing.
- **Spotlight integration** - Check status or pause builds from Spotlight.
- **Artifact inspector** - Browse uploaded artifacts without leaving the app.
- **Disk space monitoring** - Warn or pause when disk is low, auto-clean old work dirs.
- **Runner handoff** - Transfer a running job to GitHub-hosted if you need to leave.
