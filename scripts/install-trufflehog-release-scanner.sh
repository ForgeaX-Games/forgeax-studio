#!/usr/bin/env bash
set -euo pipefail

version='3.96.0'
asset="trufflehog_${version}_linux_amd64.tar.gz"
expected_sha256='7105f1cd6577f058a9e39d0578f1a99c8a1e481e4d3512cd8a09acfe22a0fdc0'
install_dir="${1:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/trufflehog-bin}"
archive="$install_dir/$asset"
binary="$install_dir/trufflehog"
url="https://github.com/trufflesecurity/trufflehog/releases/download/v${version}/${asset}"

mkdir -p "$install_dir"

if [ -x "$binary" ] && "$binary" --version 2>&1 | grep -Fq "$version"; then
  printf '%s\n' "$binary"
  exit 0
fi

rm -f "$binary" "$archive"
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  --retry 8 --retry-delay 2 --retry-max-time 90 --retry-all-errors \
  --output "$archive" "$url"
printf '%s  %s\n' "$expected_sha256" "$archive" | sha256sum -c - >&2
tar -xzf "$archive" -C "$install_dir" trufflehog
chmod 0755 "$binary"
rm -f "$archive"

test -x "$binary"
"$binary" --version 2>&1 | grep -F "$version" >/dev/null
printf '%s\n' "$binary"
