#!/usr/bin/env bash
# Assemble the Plan B desktop payload, then (optionally) bundle the .app.
#
# Plan B = ship the `bun` runtime + the server SOURCE + node_modules + asset
# dists inside the Tauri app's Resources, and run the server as a sidecar
# (`bun run <Resources>/resources/server/src/main.ts`). Because we run *source*
# (not a `bun --compile` binary), the server's own `import.meta.dir`-relative
# reads stay valid; FORGEAX_RESOURCE_ROOT (injected by lib.rs) anchors the
# marketplace/interface dists.
#
# Layout produced under packages/interface/src-tauri/resources/ (mirrors the
# repo `packages/` so asset-root.ts resolves identically):
#   resources/node_modules         (cp -RL → dereferences @forgeax/* workspace pkgs)
#   resources/server/{src,builtin,package.json}
#   resources/interface/dist
#   resources/marketplace/plugins/*
# and the bun runtime at:
#   src-tauri/binaries/bun-<target-triple>
#
# Run on the TARGET OS (macOS for the .app). The final `tauri build` step must
# run on macOS to emit a .dmg/.app.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"
# Engine now lives as the editor's nested submodule (top-level packages/engine
# was removed); this is the single source for all engine path references below.
ENGINE_ROOT="$ROOT/packages/editor/packages/engine"
STUDIO=${STUDIO:-1}
if [ "$STUDIO" = "1" ]; then
  IFACE="$ROOT/packages/studio"
else
  IFACE="$ROOT/packages/interface"
fi
RES="$ROOT/packages/interface/src-tauri/resources"
BIN="$ROOT/packages/interface/src-tauri/binaries"

# Step 3 below copies $ROOT/node_modules/* into the bundle, which requires a
# HOISTED root node_modules. bun's default (isolated) linker — what a fresh
# `bash install.sh` / `deploy.sh` produces — leaves the root node_modules empty
# (deps live in per-package node_modules), so without this the assemble fails
# with `cp: .../node_modules/*: No such file or directory`. Re-link hoisted
# (idempotent; safe to run on an already-hoisted tree).
echo "[build-desktop] 0/6 ensuring hoisted root node_modules (bun --linker hoisted)…"
( cd "$ROOT" && bun install --linker hoisted )

echo "[build-desktop] 1/6 building interface SPA…"
# Call vite directly (not `bun run build`) to bypass the package's `tsc -b`
# gate, which currently trips on pre-existing cross-package react-resolution
# errors in marketplace/plugins/wb-plugin-author. The runtime bundle is
# unaffected; resolve those separately if you want the tsc gate back.
( cd "$IFACE" && bun x vite build )

echo "[build-desktop] 1.5/6 building editor edit/play runtimes (forgeax-editor)…"
( cd "$ROOT/packages/editor/packages/edit-runtime" && bun x vite build )
( cd "$ROOT/packages/editor/packages/play-runtime" && bun x vite build )

echo "[build-desktop] 2/6 resetting payload…"
rm -rf "$RES" "$BIN"
mkdir -p "$RES" "$BIN"

echo "[build-desktop] 3/6 assembling server runtime node_modules (cycle-safe)…"
# The server sidecar's runtime closure = third-party deps + the @forgeax SOURCE
# packages it value-imports (only @forgeax/types + @forgeax/agent-runtime; the
# engine-runtime/game-types references are type-only / prompt-template text).
#
# We must NOT `cp -RL "$ROOT/node_modules"` wholesale: with `bun install
# --linker hoisted`, the @forgeax/* and @forgeax-studio/* scopes (plus the
# unscoped forgeax-cli/forgeax-interface) are SYMLINKS into the monorepo —
# including the ~1.4GB engine submodule — and their nested node_modules symlink
# back to root, so dereferencing (-L) explodes the payload or hits link cycles.
# Instead: deref every real third-party dir, skip ALL workspace symlinks, then
# add the two @forgeax source pkgs by hand (sans their nested node_modules; zod
# and @forgeax/types resolve from the sibling third-party tree).
mkdir -p "$RES/node_modules/@forgeax"
for entry in "$ROOT"/node_modules/*; do
  name="$(basename "$entry")"
  case "$name" in
    @forgeax|@forgeax-studio) continue ;;   # workspace scopes (symlinks within)
  esac
  [ -L "$entry" ] && continue               # top-level workspace symlinks (forgeax-cli, forgeax-interface)
  cp -RL "$entry" "$RES/node_modules/$name"
done
for pkg in types agent-runtime; do
  rsync -a --exclude node_modules "$ROOT/packages/$pkg/" "$RES/node_modules/@forgeax/$pkg/"
done
# The server value-imports engine packages (@forgeax/engine-project's forge.json
# loader, @forgeax/engine-runtime's Transform, @forgeax/engine-physics component
# schemas). Vendor ONLY their dependency closure (not every engine package —
# vendoring all ~35 doubled the payload to 2.4GB and broke tauri's resource
# embedding). The closure includes wgpu-wasm (its pkg/ ships, since the rhi-wgpu
# barrel imports ../pkg/wgpu_wasm.js at module load). Third-party deps (zod,
# gl-matrix, …) resolve from the hoisted node_modules copied above.
ENG_CLOSURE_DIRS="$(node -e '
  const fs=require("fs"),path=require("path");
  const base=process.argv[1], byName={};
  for(const d of fs.readdirSync(base)){const pj=path.join(base,d,"package.json");
    if(fs.existsSync(pj)){try{const j=JSON.parse(fs.readFileSync(pj,"utf8"));
      if(j.name)byName[j.name]={dir:d,deps:Object.keys(j.dependencies||{})};}catch(e){}}}
  const seen=new Set(), q=["@forgeax/engine-project","@forgeax/engine-runtime","@forgeax/engine-physics"];
  while(q.length){const n=q.shift();if(seen.has(n)||!byName[n])continue;seen.add(n);
    for(const dep of byName[n].deps)if(dep.startsWith("@forgeax/"))q.push(dep);}
  process.stdout.write([...seen].map(n=>byName[n].dir).join("\n"));
' "$ENGINE_ROOT/packages")"
for d in $ENG_CLOSURE_DIRS; do
  engpkg="$ENGINE_ROOT/packages/$d"
  [ -f "$engpkg/package.json" ] || continue
  pname="$(node -e "try{process.stdout.write(require('$engpkg/package.json').name||'')}catch(e){}")"
  [ -n "$pname" ] || continue
  dest="$RES/node_modules/$pname"
  mkdir -p "$dest"
  # runtime closure only: dist/ (built JS) + pkg/ (wgpu-wasm bindings) + package.json.
  # NOT src/tests/maps — that doubled the payload to 2.4GB and broke tauri bundling.
  cp "$engpkg/package.json" "$dest/"
  [ -d "$engpkg/dist" ] && cp -R "$engpkg/dist" "$dest/dist"
  [ -d "$engpkg/pkg" ]  && cp -R "$engpkg/pkg"  "$dest/pkg"
done
echo "[build-desktop]   vendored engine closure: $(echo "$ENG_CLOSURE_DIRS" | tr '\n' ' ')"

echo "[build-desktop] 4/6 copying server source + builtin…"
mkdir -p "$RES/server"
cp -R "$ROOT/packages/server/src" "$RES/server/"
[ -d "$ROOT/packages/server/builtin" ] && cp -R "$ROOT/packages/server/builtin" "$RES/server/"
cp "$ROOT/packages/server/package.json" "$RES/server/"
# tsconfig.json carries the path aliases bun honors at RUN time. The
# src-relative ones (@/*, @server-lib/*, @forgeax/bus) must ship. But the two
# cross-package aliases (@forgeax/types, @forgeax/agent-runtime) resolve to
# ../../<pkg>/src in the dev tree — a path that doesn't exist in the bundle —
# so strip them and let bun resolve those from the sibling node_modules/@forgeax/*
# packages we staged in step 3. (Without the tsconfig, @server-lib/@/ fail to
# resolve and the server can't boot — verified via the sidecar smoke test.)
cp "$ROOT/packages/server/tsconfig.json" "$RES/server/"
bun -e '
  const fs = require("fs"); const p = process.argv[1];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const paths = (j.compilerOptions && j.compilerOptions.paths) || {};
  // Strip every cross-package @forgeax/* alias (they point at ../../<pkg>/src,
  // which does not exist in the bundle) EXCEPT @forgeax/bus (a src-relative alias
  // that must stay) — bun then resolves them from node_modules/@forgeax/* staged
  // in step 3 (types, agent-runtime, and all engine-* packages).
  for (const k of Object.keys(paths))
    if (k.startsWith("@forgeax/") && !k.startsWith("@forgeax/bus")) delete paths[k];
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
' "$RES/server/tsconfig.json"
# Bake the version snapshot — the packaged server has no .git/dist, so
# getVersion() would fall back to "v0.0.0.0-unknown". version.sh reads git here
# at build time; getVersion() then reads resources/server/dist/version.json.
mkdir -p "$RES/server/dist"
bash "$ROOT/scripts/version.sh" write "$RES/server/dist/version.json" 2>/dev/null \
  && echo "[build-desktop]   version: $(bun -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||"?")' "$RES/server/dist/version.json")" \
  || echo "[build-desktop]   WARN: version.sh failed; version will show unknown"

echo "[build-desktop] 5/7 copying interface dist + marketplace plugin dists…"
# NOTE: 'interface/dist' resource dir name is historical and intentionally
# independent of STUDIO routing (D-5 + D-7) — when STUDIO=1 the source IFACE is
# packages/studio/, but we still emit to $RES/interface/dist to avoid renaming
# the resource path that the server sidecar + marketplace loader already key off.
mkdir -p "$RES/interface"
cp -R "$IFACE/dist" "$RES/interface/dist"
# Editor edit/play runtime dists — served by the same serveStatic under /editor/ and /preview/
mkdir -p "$RES/interface/dist/editor" "$RES/interface/dist/preview"
cp -R "$ROOT/packages/editor/packages/edit-runtime/dist/"* "$RES/interface/dist/editor/"
cp -R "$ROOT/packages/editor/packages/play-runtime/dist/"* "$RES/interface/dist/preview/"
mkdir -p "$RES/marketplace"
# Marketplace ROOT files (manifest.json + src) — agents/loader.ts
# findMarketplaceRoot() requires a manifest.json at the marketplace root to
# compose agent personas/skills; without it the agent silently degrades.
rsync -aL --exclude node_modules --exclude .git --exclude plugins \
  "$ROOT/packages/marketplace/" "$RES/marketplace/"
# Plugin dists + no-build single-file plugins + manifests. The server serves
# these as iframe resources (/plugins/<id>/…); it does NOT need each plugin's
# dev/build node_modules — derefing those balloons the payload to ~2.4GB, vs
# ~200MB without. -L follows any dist symlinks; exclude node_modules/.git.
rsync -aL --exclude node_modules --exclude .git \
  "$ROOT/packages/marketplace/plugins/" "$RES/marketplace/plugins/"

echo "[build-desktop] 6/7 copying engine (vite preview) source + cycle-safe node_modules…"
# Game preview is a LIVE vite dev server (transforms game TS on the fly), not a
# static build. We ship packages/editor/packages/play-runtime so a 2nd bun sidecar can run
# `vite` from it; lib.rs sets up a writable working dir (symlinks node_modules
# back here + .forgeax → project root) and the server reverse-proxies
# /preview/* → the engine. Assemble node_modules cycle-safe (same reason as
# step 3): @forgeax/engine-* symlink into the engine submodule with cross-cyclic
# links, so deref (-L) of the whole tree explodes/loops. Deref real third-party
# dirs, skip the @forgeax symlink scope, then copy each @forgeax/engine-*
# package's BUILT output (dist + pkg incl. the ~17MB wgpu/naga wasm) without its
# nested node_modules. (Engine packages must be pre-built: pnpm -r build +
# wgpu-wasm/build.sh — see docs/features/desktop-tauri-plan-b.md §7.8.)
ENG_SRC="$ROOT/packages/editor/packages/play-runtime"
ENG="$RES/engine"
rm -rf "$ENG"; mkdir -p "$ENG/node_modules/@forgeax"
for f in index.html vite.config.ts package.json pack-catalog.ts tsconfig.json; do
  [ -f "$ENG_SRC/$f" ] && cp "$ENG_SRC/$f" "$ENG/"
done
cp -R "$ENG_SRC/src" "$ENG/src"
[ -d "$ENG_SRC/public" ] && cp -R "$ENG_SRC/public" "$ENG/public"
# Source third-party from the ROOT hoisted node_modules (NOT engine-src's): with
# `bun install --linker hoisted`, vite + its transitive deps live at the root and
# are mere SYMLINKS inside engine-src/node_modules — the skip-symlink rule below
# would drop them, leaving the vite sidecar with no `vite/bin/vite.js` (the engine
# preview then crash-loops and /preview 502s). Deref real root dirs; skip the
# @forgeax workspace scopes + top-level workspace symlinks (handled below).
for entry in "$ROOT"/node_modules/*; do
  name="$(basename "$entry")"
  case "$name" in @forgeax|@forgeax-studio) continue ;; esac
  [ -L "$entry" ] && continue
  # Tolerate transient "file vanished" while copying the live root node_modules —
  # a concurrent process (IDE/tsserver/watcher) can delete a temp file mid-copy,
  # which under `set -e` would abort the WHOLE build at step 6/7. The closure we
  # need (vite + deps) still lands; a stray missing temp is harmless.
  cp -RL "$entry" "$ENG/node_modules/$name" 2>/dev/null || true
done
# Copy ALL engine workspace packages (flat, keyed by package.json name) — not
# just engine-src's DIRECT @forgeax deps. Transitive ones (engine-wgpu-wasm,
# engine-naga, …) are absent from engine-src/node_modules/@forgeax (they live
# deeper / in the engine submodule's own node_modules); a flat sibling set lets
# vite resolve the whole graph. Each excludes its nested node_modules.
for pkgdir in "$ENGINE_ROOT"/packages/*/; do
  [ -f "${pkgdir}package.json" ] || continue
  pname="$(bun -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name||"")}catch{}' "${pkgdir}package.json" 2>/dev/null)"
  case "$pname" in @forgeax/*) ;; *) continue ;; esac
  dest="$ENG/node_modules/$pname"
  mkdir -p "$(dirname "$dest")"
  # Exclude node_modules + Rust `target/` (engine-wgpu-wasm's cargo build dir is
  # ~850MB of artifacts; only its pkg/*.wasm glue is needed at runtime) + .git.
  rsync -aL --exclude node_modules --exclude target --exclude .git "$pkgdir" "$dest/" 2>/dev/null || true
done

# The play-runtime preview entry imports @forgeax/editor-core/protocol (+ editor
# siblings) from the EDITOR workspace — not the engine workspace copied above.
# Vendor the editor-* packages too so vite resolves them.
for pkgdir in "$ROOT"/packages/editor/packages/*/; do
  [ -f "${pkgdir}package.json" ] || continue
  pname="$(bun -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).name||"")}catch{}' "${pkgdir}package.json" 2>/dev/null)"
  case "$pname" in @forgeax/editor-*) ;; *) continue ;; esac
  dest="$ENG/node_modules/$pname"
  mkdir -p "$(dirname "$dest")"
  rsync -aL --exclude node_modules --exclude target --exclude .git "$pkgdir" "$dest/" 2>/dev/null || true
done

# Engine packages' THIRD-PARTY runtime deps. The engine submodule uses pnpm
# (isolated): each package's deps live in its own node_modules (symlinked to the
# .pnpm store), which the per-package rsync above excludes. So the browser-side
# engine modules (engine-pack/image/…) import uuidv7/upng-js/jpeg-js/ajv/… that
# aren't present → vite 500s "Failed to resolve import" → engine can't boot.
# Copy that runtime closure flat into resources/engine/node_modules.
ENGINE_RT_DEPS="uuidv7 upng-js jpeg-js ajv ajv-formats fast-deep-equal json-schema-traverse require-from-string fast-uri zod"
for dep in $ENGINE_RT_DEPS; do
  src="$(find "$ENGINE_ROOT/node_modules/.pnpm" -maxdepth 3 -type d -path "*/node_modules/$dep" 2>/dev/null | head -1)"
  [ -z "$src" ] && { echo "[build-desktop]   WARN: engine runtime dep not found: $dep"; continue; }
  rm -rf "$ENG/node_modules/$dep"
  rsync -aL --exclude node_modules "$src/" "$ENG/node_modules/$dep/" 2>/dev/null || true
done

# Game template for "new game" scaffolding. resolveGameTemplate() (server) looks
# for <projectRoot>/.forgeax/games/_template or <projectRoot>/packages/engine/
# templates/game-default — neither exists under ~/ForgeaxProjects in the .app.
# Ship the template; lib.rs seeds it into the project root on launch.
if [ -d "$ENGINE_ROOT/templates/game-default" ]; then
  rm -rf "$RES/game-template"; mkdir -p "$RES/game-template"
  rsync -aL --exclude node_modules --exclude .git \
    "$ENGINE_ROOT/templates/game-default/" "$RES/game-template/"
fi

# Shared game library (official examples) — packages/games. dev's run.sh §3.5
# symlinks these LIVE into .forgeax/games; the .app must be self-contained, so
# it can't link the git tree — instead we ship a read-only COPY and lib.rs
# symlinks each forge.json-bearing game into <projectRoot>/.forgeax/games/<slug>
# on launch (one-way: edits inside the .app's games aren't git-tracked; refresh
# the official set via `git submodule update --remote packages/games` + rebuild).
if [ -d "$ROOT/packages/games" ]; then
  rm -rf "$RES/games"; mkdir -p "$RES/games"
  for gdir in "$ROOT"/packages/games/*/; do
    [ -f "${gdir}forge.json" ] || continue   # forge.json is the symlink guard (mirrors run.sh)
    gname="$(basename "$gdir")"
    # Bundle only a CURATED set of games. Bundling multiple games whose packs share
    # base-asset GUIDs makes the preview's global pack scan fail with
    # pack-guid-collision → Play loads NO game (Edit is unaffected). Until the
    # preview scopes its pack scan per-active-game, ship a single clean example.
    # Override with DESKTOP_GAMES="spin-cube fps …" (space-separated dir names).
    DESKTOP_GAMES="${DESKTOP_GAMES:-spin-cube}"
    case " $DESKTOP_GAMES " in
      *" $gname "*) ;;
      *) echo "[build-desktop]   skip game (not in DESKTOP_GAMES): $gname"; continue ;;
    esac
    rsync -aL --exclude node_modules --exclude .git \
      --exclude '*.db-wal' --exclude '*.db-shm' --exclude '*.sqlite-wal' --exclude '*.sqlite-shm' \
      "$gdir" "$RES/games/$gname/"
    echo "[build-desktop]   bundled shared game: $gname"
  done
fi

echo "[build-desktop] 7/7 staging bun runtime as sidecar…"
TRIPLE="$(rustc -Vv | sed -n 's/^host: //p')"
if [ -z "$TRIPLE" ]; then echo "could not detect rust host triple" >&2; exit 1; fi
BUN_BIN="$(command -v bun)"
cp "$BUN_BIN" "$BIN/bun-$TRIPLE"
chmod +x "$BIN/bun-$TRIPLE"
echo "[build-desktop] staged bun for $TRIPLE"

echo "[build-desktop] payload ready at $RES"
echo
echo "Next (on macOS):"
echo "  cd packages/interface"
echo "  bun run tauri icon <path-to-1024.png>   # once, generates src-tauri/icons/*"
echo "  bun run tauri build                       # emits .dmg/.app"
