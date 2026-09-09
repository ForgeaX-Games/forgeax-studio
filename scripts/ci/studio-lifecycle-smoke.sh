#!/usr/bin/env bash

set -euo pipefail

slot="${FORGEAX_LIFECYCLE_SMOKE_SLOT:-4}"
lock_file="${FORGEAX_LIFECYCLE_SMOKE_LOCK:-/tmp/forgeax-studio-lifecycle-smoke-slot-${slot}.lock}"

if ! command -v flock >/dev/null 2>&1; then
  echo "::error title=Lifecycle smoke isolation unavailable::flock is required on the self-hosted Linux runner"
  exit 1
fi

# RuntimeInstance slots are checkout-local but their ports are host-global.
# Serialize the selected CI slot across every checkout on the shared runner.
exec 9>"$lock_file"
flock --wait 600 9

bun fx instance init --slot "$slot" --isolate-user --force

runtime_manifest=".forgeax/runtime/manifest.json"
# The single quotes deliberately protect JavaScript template literals from Bash.
# shellcheck disable=SC2016
mapfile -t endpoint_urls < <(bun -e '
  const manifest = await Bun.file(Bun.argv[1]).json();
  console.log(`${manifest.endpoints.server.url}${manifest.endpoints.server.healthPath}`);
  console.log(`${manifest.endpoints.interface.origin}${manifest.endpoints.interface.healthPath}`);
  console.log(`${manifest.endpoints.engine.url}${manifest.endpoints.engine.healthPath}`);
' "$runtime_manifest")
if (( ${#endpoint_urls[@]} != 3 )); then
  echo "::error title=Lifecycle smoke manifest invalid::expected Server, Interface, and Engine endpoints"
  exit 1
fi
runtime_log=".forgeax/runtime/stack.log"

dump_runtime_log() {
  if [[ -f "$runtime_log" ]]; then
    echo "[lifecycle-smoke] runtime log"
    tail -200 "$runtime_log"
  fi
}

cleanup() {
  local status=$?
  if ! bun fx stop --force; then
    echo "::error title=Lifecycle smoke cleanup failed::the isolated RuntimeInstance could not be stopped"
    status=1
  fi
  if (( status != 0 )); then
    dump_runtime_log
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

probe_endpoint() {
  local label="$1"
  local url="$2"
  local attempt
  for ((attempt = 1; attempt <= 120; attempt += 1)); do
    if curl --fail --silent --show-error --output /dev/null "$url"; then
      echo "[lifecycle-smoke] $label ready after attempt $attempt: $url"
      return 0
    fi
    sleep 0.5
  done
  echo "::error title=Lifecycle smoke readiness failed::$label did not become ready at $url"
  return 1
}

probe_stack() {
  probe_endpoint server "${endpoint_urls[0]}"
  probe_endpoint interface "${endpoint_urls[1]}"
  probe_endpoint engine "${endpoint_urls[2]}"
}

echo "[lifecycle-smoke] start"
bun fx start web
probe_stack

echo "[lifecycle-smoke] restart"
bun fx restart
probe_stack

echo "[lifecycle-smoke] stop"
bun fx stop
trap - EXIT INT TERM
