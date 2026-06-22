#!/usr/bin/env bash
# scripts/lib/vite-cache-guard.sh — clear STALE vite optimizeDeps caches only.
#
# vite keys its .vite pre-bundle on package.json/lockfile hashes, NOT on the
# mtime of the symlinked workspace deps it bundles. So when engine dist is
# rebuilt, or editor-shared/editor-core/interface/play/edit source changes, the
# vite servers keep serving a STALE pre-bundle → "Failed to resolve import X" /
# "does not provide an export named X" for paths that exist on disk. See perf
# doc 08 §ViteCacheGuard + the user's repeated "stray vite serving stale
# prebundle" feedback.
#
# Two upgrades over the old inline run.sh logic:
#   F2.1 anchor completeness — each cache compares against ALL of its real
#        source trees (was: only engine-dist + scene/src).
#   F2.2 content fingerprint  — anchor is a content hash of those trees, stored
#        as a sentinel, NOT a bare mtime. `git checkout` / `/main-merge` resets
#        every file mtime to "now", silently defeating the old `-nt` test. A
#        hash is immune. (Same idea the wgpu-wasm section already uses.)
#
# This file is `source`d — defines functions only. Caller sets FX_ROOT.

if [ -z "${FX_ROOT:-}" ]; then
  _vg_self="${BASH_SOURCE[0]}"
  FX_ROOT="$(cd "$(dirname "$_vg_self")/../.." && pwd)"
fi
FX_VITE_SENTINEL_DIR="$FX_ROOT/.forgeax/sentinels"

# fx_vite_purge_all — the explicit "nuke everything" entry (--purge-vite /
# --fresh). Removes every known .vite cache + its content sentinel so the next
# start rebuilds from scratch. Scriptifies the manual `rm -rf **/.vite` users
# kept doing by hand.
fx_vite_purge_all() {
  local c
  for c in \
    "$FX_ROOT/packages/interface/node_modules/.vite" \
    "$FX_ROOT/packages/studio/node_modules/.vite" \
    "$FX_ROOT/packages/editor/packages/edit-runtime/.vite" \
    "$FX_ROOT/packages/editor/packages/edit-runtime/node_modules/.vite" \
    "$FX_ROOT/packages/editor/packages/play-runtime/.vite" \
    "$FX_ROOT/packages/editor/packages/play-runtime/node_modules/.vite"; do
    [ -d "$c" ] && { rm -rf "$c"; echo "[vite-cache] purged ${c#"$FX_ROOT"/}"; }
  done
  rm -f "$FX_VITE_SENTINEL_DIR"/vite-*.hash 2>/dev/null || true
}

# _fx_hash_trees <tree...> — emit ONE content-hash digest for the given source
# trees + lockfile-ish anchors. Uses git hash-object when the source is tracked
# (fast, content-addressed); falls back to a portable find+cksum digest. Robust
# to mtime resets from checkout/merge — that's the whole point.
_fx_hash_trees() {
  local t
  {
    for t in "$@"; do
      [ -e "$t" ] || continue
      if [ -f "$t" ]; then
        cksum < "$t" 2>/dev/null
      else
        # directory: hash file list + each file's content cksum, name-sorted for
        # determinism. Prune node_modules/.vite/dist to keep it cheap + relevant.
        find "$t" \( -name node_modules -o -name .vite -o -name dist \) -prune \
          -o -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \
            -o -name '*.json' -o -name '*.css' -o -name '*.wgsl' -o -name '*.glsl' \) -print 2>/dev/null \
          | LC_ALL=C sort \
          | while IFS= read -r f; do printf '%s ' "$f"; cksum < "$f" 2>/dev/null; done
      fi
    done
  } | cksum | awk '{print $1"-"$2}'
}

# fx_vite_guard <cache-dir> <sentinel-name> <source-tree...> — clear <cache-dir>
# iff its source trees' content hash differs from the stored sentinel (or
# FORGEAX_VITE_FORCE_CLEAN=1). Always refresh the sentinel afterwards so the
# next start compares against current content. No cache present → nothing to do
# (vite builds fresh), but still seed the sentinel.
fx_vite_guard() {
  local cache="$1" sentinel_name="$2"; shift 2
  local sentinel="$FX_VITE_SENTINEL_DIR/vite-$sentinel_name.hash"
  mkdir -p "$FX_VITE_SENTINEL_DIR"
  local now prev
  now="$(_fx_hash_trees "$@")"
  prev=""; [ -f "$sentinel" ] && prev="$(cat "$sentinel" 2>/dev/null)"

  if [ -d "$cache" ]; then
    if [ "${FORGEAX_VITE_FORCE_CLEAN:-}" = "1" ] || [ "$now" != "$prev" ]; then
      rm -rf "$cache"
      echo "[vite-cache] cleared stale ${cache#"$FX_ROOT"/} (source content changed since last optimize)"
    fi
  fi
  printf '%s\n' "$now" > "$sentinel"
}
