#!/bin/bash
#
# Generate cost comparison table from public GitHub Actions data
#
# Usage: ./scripts/generate-benchmarks.sh [days]
#   days: Number of trailing days to analyze (default: 30)
#
# Requires: curl, jq
#
# Scrapes actual job data to calculate costs by runner type:
#   - macos (standard): $0.062/min
#   - macos-large: $0.077/min
#   - macos-xlarge: $0.102/min
#
# XcodeBenchmark times (Xcode 16)
#   - GitHub: macos-latest (M1, 3-core) - 967s
#   - MBA 2022: MacBook Air 13" 2022 M2 8-core 16GB - 202s
#   - MBP 2024: MacBook Pro 16" 2024 M4 Max 16-core - 77s

set -euo pipefail

DAYS="${1:-30}"
MAX_RUNS=50  # Limit runs to fetch jobs for (API intensive)

# Rates per minute (January 2026)
RATE_STANDARD="0.062"  # macos, macos-latest, macos-13/14/15
RATE_LARGE="0.077"     # macos-*-large
RATE_XLARGE="0.102"    # macos-*-xlarge

# XcodeBenchmark times in seconds (Xcode 16)
GITHUB_BENCH=967
MBA_BENCH=202
MBP_BENCH=77

# Calculate speedups
MBA_SPEEDUP=$(echo "scale=1; $GITHUB_BENCH / $MBA_BENCH" | bc)
MBP_SPEEDUP=$(echo "scale=1; $GITHUB_BENCH / $MBP_BENCH" | bc)

# Repos to benchmark (owner/repo)
REPOS=(
  "Alamofire/Alamofire"
  "mattermost/mattermost-mobile"
  "nicklockwood/SwiftFormat"
)

# Classify runner label to rate
get_rate() {
  local label="$1"
  if [[ "$label" == *"-xlarge"* ]] || [[ "$label" == *"_xl"* ]]; then
    echo "$RATE_XLARGE"
  elif [[ "$label" == *"-large"* ]] || [[ "$label" == *"_l"* ]]; then
    echo "$RATE_LARGE"
  else
    echo "$RATE_STANDARD"
  fi
}

# Check if label is GitHub-hosted macOS (not self-hosted)
is_github_macos() {
  local label="$1"
  # Must start with "macos" (GitHub-hosted) and not be self-hosted
  [[ "$label" == macos* ]] && [[ "$label" != self* ]]
}

# Calculate date range
if [[ "$OSTYPE" == "darwin"* ]]; then
  START_DATE=$(date -v-${DAYS}d +%Y-%m-%d)
else
  START_DATE=$(date -d "-${DAYS} days" +%Y-%m-%d)
fi

echo "Analyzing builds from last ${DAYS} days (since ${START_DATE})" >&2
echo "Fetching job-level data for accurate runner pricing..." >&2
echo "" >&2

# Output cost table header
echo "| Project | Builds/mo | Runners | p90 | Cost/mo |"
echo "|---------|-----------|---------|-----|---------|"

for repo in "${REPOS[@]}"; do
  name=$(basename "$repo")

  # Fetch recent completed runs
  runs_json=$(curl -s "https://api.github.com/repos/${repo}/actions/runs?created=>=${START_DATE}&status=completed&per_page=${MAX_RUNS}" \
    -H "Accept: application/vnd.github+json" 2>/dev/null || echo '{"workflow_runs":[]}')

  # Check for API errors
  if echo "$runs_json" | jq -e '.message' >/dev/null 2>&1; then
    echo "API error for ${repo}: $(echo "$runs_json" | jq -r '.message')" >&2
    continue
  fi

  # Get run IDs
  run_ids=$(echo "$runs_json" | jq -r '.workflow_runs[].id')
  run_count=$(echo "$runs_json" | jq '.workflow_runs | length')

  if [[ "$run_count" -eq 0 ]]; then
    echo "| [${name}](https://github.com/${repo}/actions) | 0 | — | — | \$0 |"
    continue
  fi

  echo "  ${name}: fetching jobs for ${run_count} runs..." >&2

  total_cost=0
  macos_runs=0
  declare -A runner_labels  # Track unique runner labels
  job_durations=()          # Track job durations for p90

  for run_id in $run_ids; do
    # Fetch jobs for this run
    jobs_json=$(curl -s "https://api.github.com/repos/${repo}/actions/runs/${run_id}/jobs" \
      -H "Accept: application/vnd.github+json" 2>/dev/null || echo '{"jobs":[]}')

    # Process each job
    while IFS= read -r job_line; do
      [[ -z "$job_line" ]] && continue

      # Parse job data: "runner_label duration_seconds"
      runner_label=$(echo "$job_line" | jq -r '.[0]')
      duration_sec=$(echo "$job_line" | jq -r '.[1]')

      # Skip non-GitHub-hosted macOS jobs
      if ! is_github_macos "$runner_label"; then
        continue
      fi

      # Track this runner label
      runner_labels["$runner_label"]=1

      # Track duration for p90 calculation
      job_durations+=("$duration_sec")

      # Calculate cost for this job
      duration_min=$(echo "scale=4; $duration_sec / 60" | bc)
      rate=$(get_rate "$runner_label")
      job_cost=$(echo "scale=4; $duration_min * $rate" | bc)
      total_cost=$(echo "scale=4; $total_cost + $job_cost" | bc)

    done < <(echo "$jobs_json" | jq -c '.jobs[] | select(.conclusion == "success" or .conclusion == "failure") | [(.labels[0] // "unknown"), ((.completed_at | fromdateiso8601) - (.started_at | fromdateiso8601))]')

    # Count runs that had macOS jobs
    has_macos=$(echo "$jobs_json" | jq '[.jobs[].labels[0] // "" | select(startswith("macos") and (startswith("self") | not))] | length')
    if [[ "$has_macos" -gt 0 ]]; then
      ((macos_runs++)) || true
    fi

    # Brief pause to avoid rate limiting
    sleep 0.3
  done

  if [[ "$macos_runs" -eq 0 ]]; then
    echo "| [${name}](https://github.com/${repo}/actions) | 0 | — | — | \$0 |"
    unset runner_labels
    job_durations=()
    continue
  fi

  # Format runner labels
  runners_list=$(printf '%s\n' "${!runner_labels[@]}" | sort | paste -sd, -)

  # Calculate p90 build time
  if [[ ${#job_durations[@]} -gt 0 ]]; then
    sorted_durations=($(printf '%s\n' "${job_durations[@]}" | sort -n))
    p90_index=$(echo "scale=0; ${#sorted_durations[@]} * 90 / 100" | bc)
    [[ "$p90_index" -ge "${#sorted_durations[@]}" ]] && p90_index=$((${#sorted_durations[@]} - 1))
    p90_sec=${sorted_durations[$p90_index]}
    p90_min=$(echo "scale=0; $p90_sec / 60" | bc)
    p90_display="${p90_min}m"
  else
    p90_display="—"
  fi

  # Extrapolate to monthly (30 days)
  monthly_runs=$(echo "scale=0; $macos_runs * 30 / $DAYS" | bc)
  monthly_cost=$(echo "scale=0; $total_cost * 30 / $DAYS" | bc)

  echo "| [${name}](https://github.com/${repo}/actions) | ~${monthly_runs} | ${runners_list} | ${p90_display} | **\$${monthly_cost}** |"
  unset runner_labels
  job_durations=()
done

echo ""
echo "<sup>Pricing as of January 2026. Costs calculated from jobs via [generate-benchmarks.sh](scripts/generate-benchmarks.sh).</sup>"
echo ""
echo "Local builds are also faster. Based on [XcodeBenchmark](https://github.com/devMEremenko/XcodeBenchmark):"
echo ""
echo "| Runner | Time | vs GitHub |"
echo "|--------|------|-----------|"
echo "| GitHub macos-latest | [${GITHUB_BENCH}s](https://gist.github.com/bfulton/7221d2d345501ba59938d00a7b8a7876) | — |"
echo "| MacBook Air M2 (2022) | ${MBA_BENCH}s | **${MBA_SPEEDUP}x faster** |"
echo "| MacBook Pro M4 Max (2024) | ${MBP_BENCH}s | **${MBP_SPEEDUP}x faster** |"
