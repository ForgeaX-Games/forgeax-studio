#!/usr/bin/env bash
# Build marketplace workbench-plugin dists that are MISSING or BROKEN.
#
# Why: server serves each workbench plugin's UI from its built `dist/` via
# serveStatic (packages/server/src/main.ts → /plugins/<id>/*). Plugin `dist/`
# is gitignored (each wb-* plugin is its own submodule) and only built by
# scripts/deploy.sh §5. The dev path (start.sh → run.sh) never (re)built them,
# so a missing/partial dist — e.g. an `index.html` whose hashed JS/CSS assets
# were never emitted — makes the plugin iframe 404 / render blank ("未绑定").
#
# This script rebuilds ONLY plugins whose served dist is broken:
#   - no dist index.html, OR
#   - index.html references an assets/*.js|css that does not exist on disk.
# Already-good dists are skipped (fast warm start). Failures are non-fatal —
# one plugin's build error never blocks the rest or the stack startup.
#
# Usage: bash scripts/build-plugins.sh [--force]   (--force rebuilds all)
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

PLUGINS_DIR="$ROOT/packages/marketplace/plugins"
[ -d "$PLUGINS_DIR" ] || { echo "[build-plugins] no plugins dir — skip"; exit 0; }

# Resolve a plugin's served dist dir. Most use dist/; wb-narrative builds to
# viz/dist/. Prefer whichever already has an index.html; else default dist/.
dist_dir_for() {
  local d="$1"
  if [ -f "$d/viz/dist/index.html" ] || { [ -d "$d/viz" ] && [ ! -d "$d/dist" ]; }; then
    printf '%s/viz/dist' "$d"
  else
    printf '%s/dist' "$d"
  fi
}

# Broken = no index.html, or index.html references an asset that's missing.
is_broken() {
  local dist="$1"
  [ -f "$dist/index.html" ] || return 0
  local ref
  for ref in $(grep -oE 'assets/[A-Za-z0-9._-]+\.(js|css)' "$dist/index.html" 2>/dev/null); do
    [ -f "$dist/$ref" ] || return 0
  done
  return 1
}

built=0; skipped=0; failed=0
for d in "$PLUGINS_DIR"/wb-*; do
  name="$(basename "$d")"
  [ -L "$d" ] && continue                      # symlink (node-editor apps run their own dev server)
  [ -f "$d/package.json" ] || continue         # stub plugins have no build — skip
  grep -q '"build"' "$d/package.json" 2>/dev/null || continue
  dist="$(dist_dir_for "$d")"
  if [ "$FORCE" = 0 ] && ! is_broken "$dist"; then
    skipped=$((skipped+1)); continue
  fi
  printf '[build-plugins] building %s (dist broken/missing)…\n' "$name"
  # Always `pnpm install` before a (re)build, even when node_modules exists: a
  # STALE/incomplete node_modules (e.g. a declared devDep like @types/three that
  # was never fetched) makes `tsc` builds fail with no obvious cause. Installing
  # is cheap when already satisfied and fixes the partial-install case (wb-reel).
  if (cd "$d" && pnpm install --no-frozen-lockfile >/dev/null 2>&1 && pnpm build >/tmp/build-plugin-"$name".log 2>&1); then
    if is_broken "$dist"; then
      printf '\033[33m  ⚠ %s built but dist still broken — see /tmp/build-plugin-%s.log\033[0m\n' "$name" "$name"; failed=$((failed+1))
    else
      printf '  ✓ %s\n' "$name"; built=$((built+1))
    fi
  else
    printf '\033[33m  ⚠ %s build failed — see /tmp/build-plugin-%s.log\033[0m\n' "$name" "$name"; failed=$((failed+1))
  fi
done
printf '[build-plugins] done: %d built, %d ok-skipped, %d failed\n' "$built" "$skipped" "$failed"
exit 0
