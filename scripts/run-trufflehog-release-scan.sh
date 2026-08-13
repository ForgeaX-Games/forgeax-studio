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
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
allowlist="$script_dir/trufflehog-release-allowlist.json"
report="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/trufflehog-release-scan.jsonl"
errors="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/trufflehog-release-scan.stderr"

docker_args=(
  run --rm
)
scanner_args=(
  filesystem
)

if [ "$scan_mode" = "source" ]; then
  excludes="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/trufflehog-release-scan-excludes.txt"
  cat > "$excludes" <<'EOF'
(^|/)\.git(/|$)
(^|/)node_modules(/|$)
(^|/)\.worktrees(/|$)
(^|/)(coverage|\.cache|\.turbo|\.npm)(/|$)
(^|/)scripts/trufflehog-release-allowlist\.json$
EOF
fi

scanner_bin="${TRUFFLEHOG_BIN:-}"
use_docker=false
if [ -n "$scanner_bin" ]; then
  test -x "$scanner_bin"
  scanner_args+=( "$scan_root" )
  if [ "$scan_mode" = "source" ]; then
    scanner_args+=( --exclude-paths "$excludes" )
  fi
else
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    use_docker=true
    docker_args+=( -v "$scan_root:/scan:ro" )
    scanner_args+=( /scan )
    if [ "$scan_mode" = "source" ]; then
      docker_args+=( -v "$excludes:/scan-excludes.txt:ro" )
      scanner_args+=( --exclude-paths /scan-excludes.txt )
    fi
  else
    scanner_bin="$(bash "$script_dir/install-trufflehog-release-scanner.sh")"
    test -x "$scanner_bin"
    scanner_args+=( "$scan_root" )
    if [ "$scan_mode" = "source" ]; then
      scanner_args+=( --exclude-paths "$excludes" )
    fi
  fi
fi

scanner_args+=(
  --results=verified,unknown
  --fail-on-scan-errors
  --no-update
  --json
)

set +e
if [ "$use_docker" = true ]; then
  docker "${docker_args[@]}" \
    trufflesecurity/trufflehog:3.96.0@sha256:aa821cf4ace8861c7d096d83818cdf7bb9719028a52d37a52eaad44086a52577 \
    "${scanner_args[@]}" \
    >"$report" 2>"$errors"
else
  "$scanner_bin" "${scanner_args[@]}" >"$report" 2>"$errors"
fi
scan_rc=$?
set -e

summary="${report%.jsonl}.summary.jsonl"
summary_rc=0
if [ -s "$report" ]; then
  if node --input-type=module - "$report" "$scan_root" "$scan_mode" "$allowlist" >"$summary" <<'NODE'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, sep } from 'node:path';

const [, , reportPath, scanRoot, scanMode, allowlistPath] = process.argv;
const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));
const root = resolve(scanRoot);
const hashCache = new Map();
const entries = Array.isArray(allowlist.entries) ? allowlist.entries : [];

function metadata(finding) {
  const filesystem = finding.SourceMetadata?.Data?.Filesystem;
  return {
    detector: finding.DetectorName,
    detectorType: finding.DetectorType,
    decoder: finding.DecoderName,
    verified: finding.Verified,
    file: filesystem?.file,
    line: filesystem?.line,
  };
}

function relativeScanPath(file) {
  if (typeof file !== 'string') return undefined;
  const path = file.startsWith('file://') ? file.slice('file://'.length) : file;
  if (path.startsWith('/scan/')) return path.slice('/scan/'.length);
  const localFile = resolve(root, path);
  const relativePath = relative(root, localFile);
  if (relativePath.startsWith('..' + sep) || relativePath === '..' || localFile === root) return undefined;
  return relativePath.split(sep).join('/');
}

function fileDigest(file) {
  if (hashCache.has(file)) return hashCache.get(file);
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  hashCache.set(file, digest);
  return digest;
}

function allowed(finding) {
  const info = metadata(finding);
  const path = relativeScanPath(info.file);
  const raw = finding.RawV2 || finding.Raw;
  if (!path || typeof raw !== 'string') return undefined;
  const localFile = resolve(root, path);
  const relativeToRoot = relative(root, localFile);
  if (relativeToRoot.startsWith('..' + sep) || relativeToRoot === '..' || localFile === root) return undefined;
  let digest;
  try {
    digest = fileDigest(localFile);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (
      entry.mode === scanMode &&
      entry.path === path &&
      entry.line === info.line &&
      entry.detector === info.detector &&
      entry.detectorType === info.detectorType &&
      Array.isArray(entry.decoders) &&
      entry.decoders.includes(info.decoder) &&
      entry.verified === info.verified &&
      entry.raw === raw &&
      entry.sha256 === digest
    ) {
      return entry.id;
    }
  }
  return undefined;
}

let unexpected = 0;
for (const line of readFileSync(reportPath, 'utf8').split(/\r?\n/u)) {
  if (!line.trim()) continue;
  try {
    const finding = JSON.parse(line);
    const allowlistedBy = allowed(finding);
    console.log(JSON.stringify({ ...metadata(finding), allowlistedBy: allowlistedBy ?? null }));
    if (!allowlistedBy) unexpected += 1;
  } catch {
    console.log(JSON.stringify({ parseError: true }));
    unexpected += 1;
  }
}
process.exitCode = unexpected === 0 ? 0 : 1;
NODE
  then
    summary_rc=0
  else
    summary_rc=$?
  fi
fi

if [ "$scan_rc" -ne 0 ]; then
  finding_count="$(wc -l < "$report" | tr -d ' ')"
  echo "TruffleHog scan failed (${finding_count} finding(s) or scanner error; status $scan_rc)."
  if [ -s "$summary" ]; then
    echo "Sanitized TruffleHog findings:"
    cat "$summary"
  else
    echo "TruffleHog returned a scan error; raw scanner diagnostics remain in $errors."
  fi
  exit "$scan_rc"
fi

if [ "$summary_rc" -ne 0 ]; then
  finding_count="$(wc -l < "$report" | tr -d ' ')"
  echo "TruffleHog blocked the release (${finding_count} unexpected finding(s))."
  echo "Sanitized TruffleHog findings:"
  cat "$summary"
  exit 183
fi

if [ -s "$summary" ]; then
  echo "TruffleHog approved only the reviewed false positives below:"
  cat "$summary"
fi

echo "TruffleHog release scan passed."
