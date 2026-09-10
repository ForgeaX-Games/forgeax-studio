#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ] || [ "$1" != "--mode" ] || [ "$3" != "--path" ]; then
  echo "usage: $0 --mode source|package --path DIR" >&2
  exit 2
fi

scan_mode="$2"
scan_root="$4"
if [ "$scan_mode" != "source" ] && [ "$scan_mode" != "package" ]; then
  echo "invalid scan mode: $scan_mode" >&2
  exit 2
fi

scan_root="$(cd "$scan_root" && pwd)"
report="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/trufflehog-release-scan.jsonl"
errors="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/trufflehog-release-scan.stderr"

docker_args=(
  run --rm
  -v "$scan_root:/scan:ro"
)
scanner_args=(
  filesystem /scan
)

if [ "$scan_mode" = "source" ]; then
  excludes="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/trufflehog-release-scan-excludes.txt"
  cat > "$excludes" <<'EOF'
(^|/)\.git(/|$)
(^|/)node_modules(/|$)
(^|/)\.worktrees(/|$)
(^|/)(coverage|\.cache|\.turbo|\.npm)(/|$)
EOF
  docker_args+=( -v "$excludes:/scan-excludes.txt:ro" )
  scanner_args+=( --exclude-paths /scan-excludes.txt )
fi

scanner_args+=(
  --results=verified,unknown
  --fail
  --fail-on-scan-errors
  --no-update
  --json
)

set +e
docker "${docker_args[@]}" \
  trufflesecurity/trufflehog:3.96.0@sha256:aa821cf4ace8861c7d096d83818cdf7bb9719028a52d37a52eaad44086a52577 \
  "${scanner_args[@]}" \
  >"$report" 2>"$errors"
scan_rc=$?
set -e

if [ "$scan_rc" -ne 0 ]; then
  finding_count="$(wc -l < "$report" | tr -d ' ')"
  echo "TruffleHog blocked the release (${finding_count} finding(s) or scan error)."
  exit "$scan_rc"
fi

echo "TruffleHog release scan passed."
