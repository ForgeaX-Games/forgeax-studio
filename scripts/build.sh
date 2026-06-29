#!/usr/bin/env bash
# Thin wrapper that forwards to packages/build/build.sh — the actual
# orchestrator that runs recipes/*.ts to populate packages/forgeax/{apps,packages,games}/
# from the source submodules under packages/. Provided so the
# parent repo exposes one canonical entry point per concern:
# bootstrap / dev / build / deploy.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"
exec bash packages/build/build.sh "$@"
