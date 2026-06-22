#!/usr/bin/env bash
# forgeax-studio installer — top-level entry point.
#
# What it does (delegates to scripts/deploy.sh — args forwarded):
#   - Bootstraps toolchain (bun / node 22+ / pnpm / rust+wasm-pack) on a fresh
#     host. Default zero-prompt full auto; pass `--interactive` to be asked
#     per tool, or `--skip-bootstrap` to skip toolchain entirely.
#   - Verifies prereqs (git / bun / node 22+ / curl)
#   - Initializes submodules + builds engine packages
#   - Runs bun install in each sub-repo + builds marketplace plugins
#   - Materializes $ROOT/.env from .env.example. With `--interactive` it also
#     prompts for ANTHROPIC_API_KEY (otherwise: warn, edit .env later).
#
# After this:  bash start.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec bash scripts/deploy.sh "$@"
