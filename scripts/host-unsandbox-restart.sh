#!/usr/bin/env bash
# Run this in a normal host terminal (NOT Cursor agent sandbox).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
touch "$HOME/.forgeax/unsandbox-probe" 2>/dev/null && echo "unsandboxed: OK" || echo "unsandboxed: FAIL (home .forgeax not writable; FORGEAX_USER_DIR still ok)"
set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a
export FORGEAX_INTERFACE_HTTPS="${FORGEAX_INTERFACE_HTTPS:-1}"
export FORGEAX_USER_DIR="${FORGEAX_USER_DIR:-$ROOT/.forgeax/user-dir}"
mkdir -p "$FORGEAX_USER_DIR"
bun fx stop || true
bun fx start
echo "--- verify ---"
ss -tlnp | grep -E '18900|18920|15173' || true
curl -sk https://127.0.0.1:18920/api/health || true
echo
curl -sk https://127.0.0.1:18920/api/extensions/list | head -c 200 || true
echo
