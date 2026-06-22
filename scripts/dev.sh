#!/usr/bin/env bash
# Thin wrapper that forwards to scripts/run.sh — the zero-build
# 3-service orchestrator. server / interface boot from their source
# submodules directly (packages/{server,interface}); engine serves
# from packages/build/engine-src/ via vite.
#
# 2026-05-21: legacy forgeax cli daemon (:3700) dropped; chat path now
# goes through forgeax-server's built-in cli-providers.
#
# To roll back to the old "boot from forgeax/apps/* mirrors" flow, run
# bash packages/forgeax/run.sh "$@" instead.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/run.sh" "$@"
