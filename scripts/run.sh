#!/bin/bash
# forgeax-studio: zero-build dev orchestrator.
#
# Boot order: server (:18900) → interface (:18920) + engine (:15173).
# Each service runs from its source submodule's own node_modules — no build
# pipeline / no forgeax/apps/* mirror. Edits in packages/{interface,server}
# take effect immediately (Vite HMR + bun --watch).
#
# Engine is the one exception: packages/engine source is a complex multi-package repo
# without a "just serve me" dev script, so we still serve the built/synthesized
# forgeax/engine. Run `./scripts/build.sh release-source` to refresh it.
#
# 2026-05-21: forgeax cli daemon (:3700) + docker-based instance pre-warm
# removed — forgeax-server's built-in cli-providers (claude-code / codex /
# cursor / forgeax) fully subsume that role. The old daemon was a docker-only
# path that broke on macOS for users without Docker Desktop.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# ---- 0.-1 orchestration libs (ports SSOT / process-group reap / vite cache /
#          start lock). All four are `source`d, side-effect-free until called.
#          See scripts/lib/*.sh + performance-analysis-2/08-*.md (F1/F2/F3).
FX_ROOT="$ROOT"
# shellcheck source=lib/ports.sh
. "$SCRIPT_DIR/lib/ports.sh"
# shellcheck source=lib/process-group.sh
. "$SCRIPT_DIR/lib/process-group.sh"
# shellcheck source=lib/vite-cache-guard.sh
. "$SCRIPT_DIR/lib/vite-cache-guard.sh"
# shellcheck source=lib/startlock.sh
. "$SCRIPT_DIR/lib/startlock.sh"

# ---- 0.-1.b CLI flags (run.sh-level; start.sh forwards "$@") ----
# --purge-vite / --fresh : nuke every .vite cache + sentinel before starting,
#   the discoverable form of the old hidden FORGEAX_VITE_FORCE_CLEAN env.
for _arg in "$@"; do
  case "$_arg" in
    --purge-vite|--fresh)
      fx_vite_purge_all
      echo "[run.sh] vite caches purged (--purge-vite/--fresh)"
      ;;
  esac
done

# ---- 0.-1.c start lock (F3) — macOS-compatible mkdir atomic lock. Prevents a
#      second start racing the strictPort bind and crashing half the stack.
#      'notrap': release is folded into _run_sh_cleanup below (single trap).
fx_startlock_acquire notrap

# ---- STUDIO routing default ----
# The :18920 UI vite serves packages/studio when STUDIO=1, else packages/interface.
# Only studio injects the edit/preview surfaces via PanelRenderers context; plain
# interface renders "No editor/preview configured" placeholders. app.sh / start.sh
# already default STUDIO=1; mirror that here so a bare `bash scripts/run.sh` gets
# the full studio UI too. Set STUDIO=0 to run the thin interface package.
STUDIO=${STUDIO:-1}; export STUDIO

# ---- 0.0 Windows / Git Bash compatibility shim ----
# When run.sh is invoked from PowerShell-launched Git Bash on Windows two
# Windows-specific footguns surface long before any of our own checks:
#
# 1. PATH propagation. PowerShell-installed bun / pnpm / rustup write to user
#    PATH, but a `bash -c` child inherits the PowerShell process's PATH from
#    fork time and never sees the new entries. Probe the canonical install
#    locations and prepend any that exist — idempotent, harmless on macOS /
#    Linux (the directories simply don't exist there).
# 2. Symlink semantics. Git Bash's MSYS layer fakes symlinks by copying files
#    by default, which makes `ln -snf` either fail with EBUSY or silently turn
#    a symlink target into a copy — both break the .forgeax symlinks below.
#    Force native NTFS symlinks via MSYS=winsymlinks:nativestrict.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    # Native symlinks (developer mode or admin shell required for the actual
    # CreateSymbolicLink to succeed; nativestrict prevents the silent copy
    # fallback so we fail loud with a useful error instead of corrupting state).
    export MSYS="${MSYS:-}${MSYS:+ }winsymlinks:nativestrict"
    # Common Windows install dirs for bun / pnpm / cargo / nvm-windows. None of
    # these exist on macOS/Linux, so we can probe unconditionally.
    for _bin in \
      "$HOME/.bun/bin" \
      "$HOME/.cargo/bin" \
      "${LOCALAPPDATA:-$HOME/AppData/Local}/pnpm" \
      "${APPDATA:-$HOME/AppData/Roaming}/npm" \
      "${LOCALAPPDATA:-$HOME/AppData/Local}/Programs/wasm-pack"; do
      if [ -d "$_bin" ]; then
        case ":$PATH:" in *":$_bin:"*) ;; *) PATH="$_bin:$PATH" ;; esac
      fi
    done
    export PATH
    ;;
esac

# ---- 0. version banner + env confirmation ----
# Print version banner + write a versions.json that server/interface will read.
# See scripts/version.sh + CHANGELOG.md for the v0.M.D.N scheme.
bash "$SCRIPT_DIR/version.sh" banner
FORGEAX_VERSION="$(bash "$SCRIPT_DIR/version.sh" print)"
export FORGEAX_VERSION
bash "$SCRIPT_DIR/version.sh" write "$ROOT/packages/server/dist/version.json" >/dev/null 2>&1 || true
bash "$SCRIPT_DIR/version.sh" check || true

# ---- 0.x breaking change notice ----
echo ""
echo "  ⚠ BREAKING CHANGE: Preview 运行时引擎已从 Three.js 切换到 forgeax-engine ECS。"
echo "  存量 THREE.js 游戏代码合并后将无法运行，需按新 scaffold 重写为 ECS 范式。"
echo "  详见 CHANGELOG.md。"
echo ""

# ---- 1. .env ----
# Studio dev mode reads its .env at the monorepo root ($ROOT/.env). The
# packages/forgeax submodule used to host .env, but post-2026-05-13 refactor
# studio is fully decoupled from packages/forgeax for runtime: engine source
# moved to packages/editor/packages/play-runtime/, games to instance .forgeax/games/,
# and config to the instance root .env here. packages/forgeax is now a pure
# release artifact destination — not needed for studio dev.
ENV_FILE="$ROOT/.env"
ENV_EXAMPLE="$ROOT/.env.example"
# Backward-compat: if studio-root .env is missing but packages/forgeax/.env
# exists (legacy location), seed from it. Otherwise seed from the example.
if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$ROOT/packages/forgeax/.env" ]; then
    cp "$ROOT/packages/forgeax/.env" "$ENV_FILE"
    echo "  Migrated packages/forgeax/.env -> $ENV_FILE."
  elif [ -f "$ENV_EXAMPLE" ]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    echo
    echo "  Created $ENV_FILE from $ENV_EXAMPLE."
    echo "  Edit it to set ANTHROPIC_API_KEY=sk-ant-... then run again."
    echo
    exit 1
  else
    echo "  ERROR: no .env at $ENV_FILE and no .env.example to seed from." >&2
    exit 1
  fi
fi
set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "  ⚠ ANTHROPIC_API_KEY is not set in $ENV_FILE — chat/agent features will fail." >&2
  echo "  Set it in $ENV_FILE to enable agent-based game generation." >&2
fi

# Optional-key audit — show user which 2nd-tier keys are wired (masked).
# Same SAFE_ENV_KEYS as packages/server/src/api/settings.ts. Helps spot
# "wb-character-forge 调失败 → 哦是没填 GEMINI_API_KEY" early.
_kkey_status() {
  local name="$1"
  local val="${!name:-}"
  if [ -n "$val" ]; then
    printf '  ✓ %-26s %s***%s\n' "$name" "${val:0:4}" "${val: -4}"
  else
    printf '  · %-26s (unset · optional)\n' "$name"
  fi
}
echo "[env]  key audit (优化 wb-* / multi-provider 体验):"
for k in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY ARK_IMAGE_KEY ARK_VIDEO_KEY \
         AZURE_GPT_IMAGE_KEY LITELLM_PROXY_KEY CURSOR_API_KEY; do
  _kkey_status "$k"
done

# wb-narrative runs as a standalone API on :8900. Its entry reads
# packages/marketplace/plugins/wb-narrative/.env — sync from root .env so
# users only configure GEMINI / proxy once at the studio root.
WB_NARR_DIR="$ROOT/packages/marketplace/plugins/wb-narrative"
_sync_wb_narrative_env() {
  local narr_env="$WB_NARR_DIR/.env"
  local gemini="${GEMINI_API_KEY:-}"
  local proxy="${LLM_PROXY_URL:-${LITELLM_PROXY_BASE_URL:-}}"
  local proxy_key="${LITELLM_PROXY_KEY:-}"

  if [ -z "$gemini" ] && [ -z "$proxy" ]; then
    return 0
  fi

  if [ ! -f "$narr_env" ] && [ -f "$WB_NARR_DIR/.env.example" ]; then
    cp "$WB_NARR_DIR/.env.example" "$narr_env"
  elif [ ! -f "$narr_env" ]; then
    printf '# Synced from forgeax-studio/.env by run.sh\n' > "$narr_env"
  fi

  _upsert_narr_env() {
    local key="$1" val="$2"
    [ -z "$val" ] && return 0
    if grep -qE "^#?\\s*${key}=" "$narr_env" 2>/dev/null; then
      sed -i.bak -E "s|^#?\\s*${key}=.*$|${key}=${val}|" "$narr_env"
      rm -f "$narr_env.bak"
    else
      printf '\n%s=%s\n' "$key" "$val" >> "$narr_env"
    fi
  }

  _upsert_narr_env GEMINI_API_KEY "$gemini"
  _upsert_narr_env LLM_PROXY_URL "$proxy"
  _upsert_narr_env LITELLM_PROXY_KEY "$proxy_key"
}
_sync_wb_narrative_env

_narrative_will_start() {
  [ -f "$WB_NARR_DIR/.env" ] && grep -qE '^(GEMINI_API_KEY|LLM_PROXY_URL)=.+' "$WB_NARR_DIR/.env" 2>/dev/null
}
if _narrative_will_start; then
  printf '  ✓ %-26s :%s (wb-narrative)\n' "narrative API" "${NARRATIVE_PORT:-8900}"
else
  printf '  · %-26s skipped — set GEMINI_API_KEY or LLM_PROXY_URL in %s\n' "narrative API" "$ENV_FILE"
  printf '    (auto-syncs to wb-narrative/.env on next start)\n'
fi
echo ""

# ---- 1.5 Node 22+ guard ----
# Auto-load nvm and switch to 22 if the current PATH points at an older
# Node — `source ~/.bashrc` only loads the nvm function, it does NOT auto
# `nvm use default`, so an interactive shell pinned to v20 trickles into
# this script. If nvm is present and an alias resolves to >=22, use it.
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ]; then
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    # shellcheck source=/dev/null
    \. "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm use 22 >/dev/null 2>&1 || nvm use default >/dev/null 2>&1 || true
    # Some non-interactive shells keep an earlier Node at the front of PATH even
    # after `nvm use`. Resolve the Node 22 binary directly and prepend it so
    # child tools (pnpm/vite/tsx) inherit the same runtime.
    NVM_NODE_22="$(nvm which 22 2>/dev/null || true)"
    if [ -n "$NVM_NODE_22" ] && [ -x "$NVM_NODE_22" ]; then
      export PATH="$(dirname "$NVM_NODE_22"):$PATH"
    fi
    NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
  fi
fi
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ]; then
  echo "  ERROR: forgeax-server requires Node 22+ (current: $(node -v 2>/dev/null || echo 'not installed'))." >&2
  echo "  Install: nvm install 22 && nvm use 22" >&2
  exit 1
fi
echo "[node]  $(node -v)"

# ---- 2. port preflight ----
PREFLIGHT_PORTS=(
  "server:${FORGEAX_SERVER_PORT:-18900}"
  "interface:${FORGEAX_INTERFACE_PORT:-18920}"
  "engine:${FORGEAX_ENGINE_PORT:-15173}"
  "editor:${FORGEAX_EDITOR_PORT:-15280}"
)
PREFLIGHT_BUSY=0
for port_pair in "${PREFLIGHT_PORTS[@]}"; do
  name="${port_pair%:*}"; port="${port_pair#*:}"
  if (echo >/dev/tcp/127.0.0.1/$port) 2>/dev/null; then
    echo "  ✗ port $port ($name) already in use" >&2
    PREFLIGHT_BUSY=1
  fi
done
if [ "$PREFLIGHT_BUSY" -eq 1 ]; then
  echo >&2
  echo "  Stop the previous stack first:" >&2
  echo "    bash scripts/stop.sh           # SIGTERM + 4s grace" >&2
  echo "    bash scripts/stop.sh --force   # escalate to SIGKILL" >&2
  echo "  Or set FORGEAX_SKIP_PREFLIGHT=1 to override." >&2
  [ "${FORGEAX_SKIP_PREFLIGHT:-}" = "1" ] || exit 1
fi

# ---- 2.5 workspace install self-heal ----
# Vite 解析 `@forgeax/engine-runtime` 等 workspace:* 依赖,要求根 node_modules
# 已被 bun install 链接好。deploy.sh 首次安装会做这件事,但如果用户清掉了
# node_modules / 切到一个没装过的检出 / 新增了 workspace 包,run.sh 不补装就
# 会让 vite 抛 `Failed to resolve import "@forgeax/engine-runtime"` —— 用户
# 看到的是中间游戏画面崩出 overlay,定位很费劲。这里检测 sentinel,缺则自动
# 一次性补装;补完仍缺再 fail 并指向 deploy.sh。引擎 dist 的检查在它后面,
# 因为 dist 是 deploy.sh 第 3 步产物,与 workspace link 无关、独立失败路径。
# Bun (1.3.x, 2026-05) 的 workspace 安装把 @forgeax/* 链接到**消费者本地**
# node_modules 而不是 hoist 到根,所以 sentinel 必须查 engine-src 自己的
# node_modules —— 那也正是 vite 实际去解析的位置。
WS_SENTINEL="$ROOT/packages/editor/packages/play-runtime/node_modules/@forgeax/engine-runtime/package.json"
if [ ! -f "$WS_SENTINEL" ]; then
  echo "[run.sh] workspace dependencies not linked (missing $WS_SENTINEL)"
  echo "[run.sh]   running: bun install (one-shot self-heal)"
  if ! (cd "$ROOT" && bun install); then
    echo "  ERROR: bun install failed. Run: bash scripts/deploy.sh" >&2
    exit 1
  fi
  if [ ! -f "$WS_SENTINEL" ]; then
    echo "  ERROR: bun install finished but $WS_SENTINEL still missing." >&2
    echo "  This usually means the engine submodule isn't initialised." >&2
    echo "  Run: bash scripts/deploy.sh" >&2
    exit 1
  fi
fi
echo "[workspace] @forgeax/* linked"

# ---- 2.x engine dist precondition ----
# The engine submodule must be built before the preview vite dev server can
# resolve the packages engine-src imports. Missing dist → explicit failure (P3)
# rather than the confusing runtime symptom (vite returns HTTP 500 on
# /preview/src/main.ts: "Failed to resolve entry for package @forgeax/engine-*").
#
# Guard the FULL entry set engine-src depends on, not just engine-runtime:
#   - src/main.ts imports     engine-app / engine-runtime / engine-ecs
#   - vite.config.ts imports  engine-vite-plugin-pack / engine-vite-plugin-shader
#     (engine-image is pulled by vite-plugin-pack)
# dist/ dirs are gitignored build artefacts, so a fresh checkout / clean /
# submodule re-update leaves them absent — that's the recurring cause here.
# All are produced by deploy.sh step [3]; the wgpu wasm (step [3b]) is guarded
# by vite-plugin-shader's own buildStart and surfaces separately.
ENGINE_PKG_DIR="$ROOT/packages/engine/packages"
ENGINE_ENTRY_PKGS="app runtime ecs vite-plugin-pack vite-plugin-shader"
ENGINE_MISSING=""
for p in $ENGINE_ENTRY_PKGS; do
  [ -f "$ENGINE_PKG_DIR/$p/dist/index.mjs" ] || ENGINE_MISSING="$ENGINE_MISSING $p"
done
if [ -n "$ENGINE_MISSING" ]; then
  echo "  ERROR: engine dist missing for:$ENGINE_MISSING" >&2
  echo "  (expected packages/engine/packages/<pkg>/dist/index.mjs)" >&2
  echo "  The forgeax-engine submodule has not been fully built yet." >&2
  echo "  Run: bash scripts/deploy.sh  (or scripts/install.sh to rebuild engines)" >&2
  exit 1
fi
echo "[engine] dist found for entry packages:$ENGINE_ENTRY_PKGS" | sed 's/  */ /g'

# ---- 2.x.a engine dist FRESHNESS precondition ----
# dist existing is not enough: after switching the engine pin (a `/main-merge`,
# a manual submodule checkout) the gitignored dist is the PREVIOUS engine's
# build, so the runtime loads STALE component schemas. The symptom is maddening
# and far from the cause — e.g. engine #479 merged DirectionalLightShadow into
# DirectionalLight, but a stale dist still rejects `castShadow` →
# "[editor] native scene instantiate failed" / Play FALLBACK, with no hint that
# the fix is "rebuild the engine dist". `git checkout` resets tracked src mtimes
# to "now" while leaving the gitignored dist untouched, so `src newer than dist`
# is a reliable post-checkout staleness signal (a fresh build always writes dist
# AFTER reading src). Catch it here and hand the user the exact fix, mirroring
# the wgpu-wasm guard below.
if [ "${FORGEAX_SKIP_ENGINE_DIST_FRESHNESS:-}" != "1" ]; then
  ENGINE_STALE=""
  for p in $ENGINE_ENTRY_PKGS; do
    pdir="$ENGINE_PKG_DIR/$p"
    [ -d "$pdir/src" ] && [ -f "$pdir/dist/index.mjs" ] || continue
    if [ -n "$(find "$pdir/src" -type f -newer "$pdir/dist/index.mjs" -print -quit 2>/dev/null)" ]; then
      ENGINE_STALE="$ENGINE_STALE $p"
    fi
  done
  if [ -n "$ENGINE_STALE" ]; then
    echo "  ERROR: engine dist STALE (src newer than dist) for:$ENGINE_STALE" >&2
    echo "  The engine pin changed but its TypeScript dist was not rebuilt, so the" >&2
    echo "  runtime loads OLD component schemas → 'native scene instantiate failed'" >&2
    echo "  / Play FALLBACK / spawn-data-unknown-field on edits that are actually valid." >&2
    echo "  Rebuild the engine dist:" >&2
    echo "    bash scripts/deploy.sh        # builds engine dist (+ wasm, + deps)" >&2
    echo "  Override (not recommended): FORGEAX_SKIP_ENGINE_DIST_FRESHNESS=1 bash scripts/run.sh" >&2
    exit 1
  fi
  echo "[engine] dist fresh"
fi

# ---- 2.x.b wgpu_wasm freshness precondition ----
# pkg/wgpu_wasm_bg.wasm is gitignored (zero-binary invariant); pkg/wgpu_wasm.js
# (the wasm-bindgen JS glue) IS committed. When an engine bump rewrites a
# #[wasm_bindgen] fn signature the new committed wgpu_wasm.js stops importing
# the old symbol while a stale local .wasm still exports it, and vite dies
# inside engine-vite-plugin-shader's buildStart with:
#   "WebAssembly.instantiate(): Import #N ... requires a callable"
# That error has no obvious path back to "rebuild the wasm". Catch the drift
# here and hand the user the exact fix instead. deploy.sh §3b already does the
# build under the same staleness rule; this is the run.sh-only safety net for
# users who skip deploy.sh between checkouts.
WGPU_WASM_DIR="$ROOT/packages/engine/packages/wgpu-wasm"
WASM_ARTEFACT="$WGPU_WASM_DIR/pkg/wgpu_wasm_bg.wasm"
WASM_SENTINEL="$ROOT/.forgeax/sentinels/wgpu-wasm.built"
# Compare against the sentinel mtime when present, falling back to the
# .wasm artefact itself. The sentinel exists for the case where the user
# just ran `wgpu-wasm/build.sh` (deploy.sh / a wrapper writes it after a
# successful build). Without the sentinel we'd misfire on git checkouts:
# `git checkout` resets every source file's mtime to "now", so a wasm built
# moments ago looks older than its own source. The sentinel is set AFTER
# the build, so it's always >= the source mtimes that triggered the build.
_wgpu_wasm_stale_run() {
  [ -f "$WASM_ARTEFACT" ] || return 0
  # Use the sentinel as the freshness anchor when it exists.
  local anchor="$WASM_ARTEFACT"
  [ -f "$WASM_SENTINEL" ] && anchor="$WASM_SENTINEL"
  for cand in \
    "$WGPU_WASM_DIR/Cargo.toml" \
    "$WGPU_WASM_DIR/Cargo.lock" \
    "$WGPU_WASM_DIR/pkg/wgpu_wasm.js"; do
    [ -f "$cand" ] && [ "$cand" -nt "$anchor" ] && return 0
  done
  [ -d "$WGPU_WASM_DIR/src" ] && \
    [ -n "$(find "$WGPU_WASM_DIR/src" -type f -newer "$anchor" -print -quit 2>/dev/null)" ] && return 0
  return 1
}
if _wgpu_wasm_stale_run; then
  if [ ! -f "$WASM_ARTEFACT" ]; then
    echo "  ERROR: wgpu wasm artefact missing: $WASM_ARTEFACT" >&2
  else
    echo "  ERROR: wgpu wasm stale (src / Cargo / committed pkg/wgpu_wasm.js newer than $WASM_ARTEFACT)." >&2
    echo "  Vite would die at startup with 'WebAssembly.instantiate ... requires a callable'." >&2
  fi
  echo "  Rebuild:" >&2
  echo "    bash $WGPU_WASM_DIR/build.sh         # fast: just the wasm" >&2
  echo "    bash scripts/deploy.sh                                              # full: also re-resolves engine deps" >&2
  echo "  Override (not recommended): FORGEAX_SKIP_WGPU_WASM_FRESHNESS=1 bash scripts/run.sh" >&2
  [ "${FORGEAX_SKIP_WGPU_WASM_FRESHNESS:-}" = "1" ] || exit 1
fi
echo "[engine] wgpu wasm fresh"

# ---- 2.6 vite optimizeDeps cache self-heal ----
# vite keys its dependency pre-bundle (.vite) on package.json/lockfile hashes,
# NOT on the mtime of the symlinked workspace deps it bundles. So when the
# engine dist is rebuilt (deploy / manual / a `/main-merge` that pulled a new
# ubpa engine) or @forgeax/scene source changes, the vite servers keep serving
# a STALE pre-bundle of the OLD engine — the editor (:15280) / preview then
# fail `createApp: no usable backend` (or a stale-module TypeError), while a
# sibling vite that happened to re-optimize still works (the "Play 好 Edit 坏"
# symptom). Compare each cache against the engine dist + scene source and clear
# only the stale ones, so an unchanged restart stays fast (vite re-optimizes a
# cleared cache on first load). FORGEAX_VITE_FORCE_CLEAN=1 clears all three;
# FORGEAX_VITE_NO_CLEAN=1 skips. Runs in run.sh, which BOTH start.sh and app.sh
# invoke → covers web and desktop-app starts.
# F2 (perf doc 08 §ViteCacheGuard): each cache is compared by CONTENT HASH (not
# bare mtime, which checkout/merge resets) against ALL of its real source trees
# (was: only engine-dist + scene/src — the anchor gap that let editor-shared /
# editor-core / interface / play / edit edits serve a stale pre-bundle). The
# guard also refreshes the sentinel each run. FORGEAX_VITE_NO_CLEAN=1 skips;
# FORGEAX_VITE_FORCE_CLEAN=1 / --purge-vite force-clear (handled in the lib).
# @forgeax/scene is now re-exported from the engine packages (no standalone
# packages/scene/src), so the engine-dist anchor already covers it.
ENGINE_DIST_DIR="$ROOT/packages/engine/packages/runtime/dist"
INTERFACE_SRC="$ROOT/packages/interface/src"
PLAY_SRC="$ROOT/packages/editor/packages/play-runtime/src"
EDIT_SRC="$ROOT/packages/editor/packages/edit-runtime/src"
EDITOR_SHARED_SRC="$ROOT/packages/editor/packages/editor-shared/src"
EDITOR_CORE_SRC="$ROOT/packages/editor/packages/editor-core/src"
ROOT_LOCK="$ROOT/bun.lock"
if [ "${FORGEAX_VITE_NO_CLEAN:-}" != "1" ]; then
  # interface/.vite : engine dist · interface/src · lockfile
  fx_vite_guard "$ROOT/packages/interface/node_modules/.vite" interface \
    "$ENGINE_DIST_DIR" "$INTERFACE_SRC" "$ROOT_LOCK"
  # studio/.vite : engine dist · interface/src (studio pre-bundles it) · lock
  fx_vite_guard "$ROOT/packages/studio/node_modules/.vite" studio \
    "$ENGINE_DIST_DIR" "$INTERFACE_SRC" "$ROOT_LOCK"
  # play-runtime/.vite : engine dist · play/src · editor-shared/core · lock
  fx_vite_guard "$ROOT/packages/editor/packages/play-runtime/.vite" play-runtime \
    "$ENGINE_DIST_DIR" "$PLAY_SRC" "$EDITOR_SHARED_SRC" "$EDITOR_CORE_SRC" "$ROOT_LOCK"
  # edit-runtime/.vite : engine dist · edit/src · editor-shared/core · lock
  fx_vite_guard "$ROOT/packages/editor/packages/edit-runtime/.vite" edit-runtime \
    "$ENGINE_DIST_DIR" "$EDIT_SRC" "$EDITOR_SHARED_SRC" "$EDITOR_CORE_SRC" "$ROOT_LOCK"
fi

# ---- 3. instance .forgeax/ ----
# Instance model (2026-05-13 refactor): every running stack — studio dev mode
# and a downloaded release-forgeax — is an "instance" with its own
# `<instance-root>/.forgeax/games/` runtime tree. Gitignored, per-checkout,
# throwaway. The forgeax.git release artifact has NO games/ tracked content.
#
# Studio dev mode: instance root = $ROOT (forgeax-studio).
# Engine source moved to packages/editor/packages/play-runtime/ (the forgeax-editor
# submodule's play-runtime package, was packages/build/engine-src/); studio mode
# boots vite from there directly.
# We still symlink packages/editor/packages/play-runtime/.forgeax -> $INSTANCE_ROOT/.forgeax
# so the engine's vite (rooted at play-runtime) can
# serve /preview/.forgeax/games/<id>/... from the instance's actual games dir.
INSTANCE_ROOT="$ROOT"
ENGINE_SRC_DIR="$ROOT/packages/editor/packages/play-runtime"
mkdir -p "$INSTANCE_ROOT/.forgeax/games"

# Symlink so engine vite can resolve `/preview/.forgeax/games/...` to the
# instance's actual games dir. ENGINE_SRC_DIR has its own .gitignore that
# excludes the .forgeax symlink from packages/build's git.
#
# Self-heal a real directory at this path (Windows / Git Bash sometimes lands
# here when MSYS=winsymlinks isn't set early enough and ln -snf silently
# falls back to a copy; or when an aborted run left a half-materialised dir).
# Empty real dir → silent rm. Non-empty → rename to .forgeax.bak-<ts> and
# warn so the user can recover any local state. Both paths converge on the
# canonical `ln -snf`.
_FX_SYMLINK="$ENGINE_SRC_DIR/.forgeax"
if [ -L "$_FX_SYMLINK" ] || [ ! -e "$_FX_SYMLINK" ]; then
  # Use Node.js to create a 'junction' safely on Windows without Admin privileges, acts as normal symlink on Mac/Linux
  node -e "const fs = require('fs'); try { fs.unlinkSync('$_FX_SYMLINK'); } catch(e){} fs.symlinkSync('$INSTANCE_ROOT/.forgeax', '$_FX_SYMLINK', 'junction');"
elif [ -d "$_FX_SYMLINK" ] && [ -z "$(ls -A "$_FX_SYMLINK" 2>/dev/null)" ]; then
  rmdir "$_FX_SYMLINK" 2>/dev/null || rm -rf "$_FX_SYMLINK"
  node -e "const fs = require('fs'); fs.symlinkSync('$INSTANCE_ROOT/.forgeax', '$_FX_SYMLINK', 'junction');"
  echo "[run.sh] cleared empty real dir at $_FX_SYMLINK and replaced with symlink"
elif [ -d "$_FX_SYMLINK" ]; then
  _FX_BAK="$_FX_SYMLINK.bak-$(date +%Y%m%d-%H%M%S)"
  mv "$_FX_SYMLINK" "$_FX_BAK"
  node -e "const fs = require('fs'); fs.symlinkSync('$INSTANCE_ROOT/.forgeax', '$_FX_SYMLINK', 'junction');"
  echo "  ⚠ $_FX_SYMLINK was a real directory; moved to $_FX_BAK and replaced with symlink." >&2
  echo "    If you had local state under it, rsync it into $INSTANCE_ROOT/.forgeax/ then delete the .bak." >&2
else
  echo "  ERROR: $_FX_SYMLINK exists as something we can't classify (not symlink, not dir)." >&2
  echo "  Move/clear it first, then re-run." >&2
  exit 1
fi
unset _FX_SYMLINK _FX_BAK

# ---- 3.5 shared game library symlink discovery ----
# Walk packages/games/*/ and symlink games with forge.json into
# $INSTANCE_ROOT/.forgeax/games/<slug> so the engine + server discovery
# chain sees them identically to locally-created games.
GAMES_LIB_DIR="$ROOT/packages/games"
if [ -d "$GAMES_LIB_DIR" ] && [ -n "$(ls -A "$GAMES_LIB_DIR" 2>/dev/null)" ]; then
  # Shared seeder (U1): single source of truth in scripts/seed-games.ts —
  # reads forge.json#id, idempotent symlink, preserves real dirs. The desktop
  # .app uses the parity Rust impl (lib.rs::seed_shared_games).
  FORGEAX_GAMES_SRC="$GAMES_LIB_DIR" FORGEAX_GAMES_DST="$INSTANCE_ROOT/.forgeax/games" \
    bun "$ROOT/scripts/seed-games.ts" || echo "  ⚠ [run.sh] seed-games failed (continuing without shared games)"
else
  cat >&2 <<'EOF'
  ⚠ [run.sh] packages/games/ is empty or not initialised — shared game library unavailable.
     To restore:  git submodule update --init packages/games
     Or:          bash scripts/deploy.sh
     Studio will start without shared games; locally-created games unaffected.
EOF
fi

# FORGEAX_PROJECT_ROOT is the instance root — server watches its .forgeax/games/.
export FORGEAX_PROJECT_ROOT="$INSTANCE_ROOT"

# Make our pnpm wrapper visible to child processes.
export PATH="$ROOT/.bin:$PATH"

# ---- 3.75 Heal broken/missing workbench-plugin dists ----
# Static workbench plugins (wb-ui / wb-character / …) are served from their
# built `dist/` by the server (main.ts serveStatic /plugins/<id>/*). That dist
# is gitignored (each plugin is its own submodule) and only built by deploy.sh
# §5 — so a missing/partial dist (e.g. index.html whose hashed JS/CSS were never
# emitted) makes the plugin iframe 404 / render blank. Rebuild ONLY the broken
# ones here so the dev path self-heals; good dists are skipped (fast). Non-fatal.
if [ -x "$ROOT/scripts/build-plugins.sh" ]; then
  bash "$ROOT/scripts/build-plugins.sh" || true
fi

# ---- 3.8 Standalone-backend workbench plugins (generic, manifest-driven) ----
# Most workbench plugins are `embeddedAlso:true` static frontends served in-
# process by the host (main.ts serveStatic). A few declare their OWN backend +
# Vite dev server — `entry.standalone` with embeddedAlso:false + start + port
# (today: the node-editor apps wb-scene-generator / wb-3d-lowpoly). Those need a
# launched process pair, so we discover them GENERICALLY from the marketplace
# manifests (no plugin names hardcoded) and launch each below in §4. Runtime
# port state is kept under .forgeax/ (gitignored) so server/UI observe the
# actual frontend ports.
RUNTIME_DIR="$ROOT/.forgeax"
PLUGIN_DEV_PORTS_FILE="$RUNTIME_DIR/plugin-dev-ports.json"
RUN_STACK_FILE="$RUNTIME_DIR/dev-stack.env"
mkdir -p "$RUNTIME_DIR"

ALLOCATED_PORTS=" ${FORGEAX_SERVER_PORT:-18900} ${FORGEAX_INTERFACE_PORT:-18920} ${FORGEAX_ENGINE_PORT:-15173} ${FORGEAX_EDITOR_PORT:-15280} "
_port_is_busy() {
  local port="$1"
  (echo >/dev/tcp/127.0.0.1/$port) 2>/dev/null
}
_port_already_allocated() {
  case "$ALLOCATED_PORTS" in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}
_alloc_port() {
  local __var="$1"
  local port="$2"
  while _port_is_busy "$port" || _port_already_allocated "$port"; do
    port=$((port + 1))
  done
  ALLOCATED_PORTS="$ALLOCATED_PORTS$port "
  printf -v "$__var" '%s' "$port"
}
# Plugin run mode. This is the dev orchestrator, so by default we run plugins in
# HMR (`pnpm dev` → Vite dev server + `tsx --watch` backend): editing plugin or
# kernel source hot-reloads the iframe, matching how server/interface/engine
# already run under --watch. Set FORGEAX_PLUGIN_HMR=0 to use the bundled-dist
# `serve` path instead (faster first paint, no live reload — what the packaged
# .app ships). Either preference degrades gracefully if the chosen script is
# absent, so the host never hard-fails on a plugin that has only one of them.
_has_script() { node -e "process.exit((require('$1/package.json').scripts||{})['$2']?0:1)" 2>/dev/null; }
_ext_plugin_cmd() {
  if [ "${FORGEAX_PLUGIN_HMR:-1}" != "0" ]; then
    if _has_script "$1" dev; then echo dev; elif _has_script "$1" serve; then echo serve; else echo dev; fi
  else
    if _has_script "$1" serve; then echo serve; elif _has_script "$1" dev; then echo dev; else echo serve; fi
  fi
}

# Discover launchable plugins generically: any marketplace manifest whose
# entry.standalone has embeddedAlso:false + a start command + a numeric port.
# The node-editor apps are reached via the committed L0 symlinks
# plugins/{wb-3d-lowpoly,wb-scene-generator} → node-editor/apps/*; discovery is
# L0 (no ~/.forgeax L1 symlink). For each, allocate a frontend port (seeded from
# the manifest) + a backend port (frontend+2), and a per-plugin workspace root
# keyed by shortId. Parallel arrays carry this to the launch loop in §4.
MP_PLUGINS_DIR="$ROOT/packages/marketplace/plugins"
PLUGIN_DIRS=(); PLUGIN_IDS=(); PLUGIN_SHORTIDS=()
PLUGIN_FPORTS=(); PLUGIN_BPORTS=(); PLUGIN_PROOTS=(); PLUGIN_PIDS=()
while IFS=$'\t' read -r _dir _id _sid _fseed; do
  [ -n "$_dir" ] || continue
  _alloc_port _fp "$_fseed"
  _alloc_port _bp "$((_fseed + 2))"
  # Per-plugin workspace root (gitignored). Each backend owns its own projects/
  # + workspace.json; sharing one dir would leak projects across plugins. Keyed
  # by shortId so the path is derived, never hardcoded.
  _proot="$INSTANCE_ROOT/.forgeax/workbench/$_sid"
  mkdir -p "$_proot"
  PLUGIN_DIRS+=("$_dir"); PLUGIN_IDS+=("$_id"); PLUGIN_SHORTIDS+=("$_sid")
  PLUGIN_FPORTS+=("$_fp"); PLUGIN_BPORTS+=("$_bp"); PLUGIN_PROOTS+=("$_proot")
  echo "[run.sh] + $_sid frontend :$_fp backend :$_bp (workspace .forgeax/workbench/$_sid)"
done < <(node -e '
  const fs=require("fs"),path=require("path");
  const root=process.argv[1];
  let ds=[]; try{ds=fs.readdirSync(root,{withFileTypes:true})}catch{process.exit(0)}
  for(const d of ds){
    if(!(d.isDirectory()||d.isSymbolicLink())) continue;
    const mf=path.join(root,d.name,"forgeax-plugin.json");
    if(!fs.existsSync(mf)) continue;
    let m; try{m=JSON.parse(fs.readFileSync(mf,"utf8"))}catch{continue}
    const sa=m.entry&&m.entry.standalone;
    if(!(sa&&sa.embeddedAlso===false&&sa.start&&typeof sa.port==="number")) continue;
    const id=String(m.id||d.name);
    const shortId=id.replace(/^@[^/]+\//,"");
    // Resolve symlinks (the node-editor apps are reached via committed L0
    // symlinks) to the real path so pnpm finds the monorepo workspace root.
    let dir=path.join(root,d.name); try{dir=fs.realpathSync(dir)}catch{}
    process.stdout.write([dir,id,shortId,sa.port].join("\t")+"\n");
  }
' "$MP_PLUGINS_DIR")

if [ "${#PLUGIN_DIRS[@]}" -eq 0 ]; then
  echo "[run.sh]   no standalone-backend plugins discovered under $MP_PLUGINS_DIR"
fi

# Emit plugin-dev-ports.json so the server/UI observe the actual (possibly
# shifted) frontend ports. Generic over discovered plugins; keyed by full id.
{
  echo '{'
  echo '  "generatedBy": "scripts/run.sh",'
  echo '  "plugins": {'
  for _i in "${!PLUGIN_DIRS[@]}"; do
    [ "$_i" -gt 0 ] && echo ','
    printf '    "%s": {"frontendPort": %s, "backendPort": %s}' \
      "${PLUGIN_IDS[$_i]}" "${PLUGIN_FPORTS[$_i]}" "${PLUGIN_BPORTS[$_i]}"
  done
  [ "${#PLUGIN_DIRS[@]}" -gt 0 ] && echo
  echo '  }'
  echo '}'
} > "$PLUGIN_DEV_PORTS_FILE"
export FORGEAX_PLUGIN_DEV_PORTS_FILE="$PLUGIN_DEV_PORTS_FILE"

# Targeted teardown: kill each service's whole PROCESS GROUP, not just its
# parent PID. The services below are launched under `set -m` (job control), so
# every `&` job is its own process-group leader and $! == its PGID. A negative
# argument to kill targets the group, so `kill -- -$PGID` reaps the watcher
# grandchildren too (pnpm → vite + `tsx --watch`). Without this, those
# grandchildren orphaned to init on teardown and piled up across restarts,
# squatting plugin ports (e.g. 9567 EADDRINUSE crash-loops). Bare-PID kill is
# the fallback if the group is already gone.
#
# F1 fix: reap by ENUMERATING the pidfiles in .forgeax/run/ (fx_pg_reap_pidfiles)
# rather than hand-listing variables — the old loop forgot $ED (edit-runtime
# :15280) and $FACE_MASK (:18930), orphaning them to init on Ctrl-C so a stray
# vite kept serving a stale prebundle. Enumeration covers every recorded service
# (incl. editor / face-mask / plugins) and stays correct as services are added.
# Bare-variable kill is kept as a belt-and-suspenders fallback in case a pidfile
# write lost a race.
_run_sh_cleanup() {
  fx_pg_reap_pidfiles TERM
  for _pid in "${SRV:-}" "${UI:-}" "${EN:-}" "${ED:-}" "${NARR:-}" "${FACE_MASK:-}" "${PLUGIN_PIDS[@]}"; do
    [ -n "$_pid" ] || continue
    kill -TERM -- "-$_pid" 2>/dev/null || kill -TERM "$_pid" 2>/dev/null || true
  done
  fx_pg_clear
  fx_startlock_release
  rm -f "$RUN_STACK_FILE" "$PLUGIN_DEV_PORTS_FILE"
}
trap _run_sh_cleanup SIGINT SIGTERM EXIT

# Fresh run dir — drop any pidfiles from a previous (crashed) run before we
# start recording this run's services.
fx_pg_clear; mkdir -p "$FX_RUN_DIR"

# ---- 4. server + interface + engine + plugin backends in parallel ----
# Engine vite runs from packages/editor/packages/play-runtime/ — the canonical source
# location for the synthesized MVP engine. This decouples studio dev mode
# from packages/forgeax/engine/ (which is now PURELY a release-pipeline
# output target, recreated by `scripts/build.sh publish` from this same
# source).
echo "[run.sh] starting server :18900 (forgeax-server source) + interface :18920 (forgeax-interface source) + engine :15173 (packages/editor/packages/play-runtime) + editor :15280 (edit-runtime / Edit mode)"

# wb-narrative standalone API — only if its .env has a key configured.
if _narrative_will_start; then
  echo "[run.sh] + narrative API :${NARRATIVE_PORT:-8900} (wb-narrative standalone)"
else
  echo "[run.sh]   narrative API skipped (set GEMINI_API_KEY or LLM_PROXY_URL in $ENV_FILE or wb-narrative/.env)"
fi

echo "[run.sh] open http://localhost:18920 to use the Studio UI"
echo "[run.sh]   浏览器(WebGPU)用: bash web.sh   ·   桌面 App 用: bash app.sh"

# Enable job control so every backgrounded service below starts in its OWN
# process group (group-leader pid == $! == PGID). The EXIT trap (_run_sh_cleanup)
# and scripts/stop.sh rely on this to group-kill each service tree — parent plus
# its watcher grandchildren (vite / `tsx --watch`) — instead of orphaning them.
# Process-group membership is fixed at fork time, so we `set +m` again right
# after the launches without losing the groups. No job-control notifications are
# printed in this non-interactive context.
set -m

(cd "$ROOT/packages/server" && exec bun --watch src/main.ts) &
SRV=$!; fx_pg_record server "$SRV"

# Wait for server to bind before starting interface (avoids proxy ECONNREFUSED race)
SERVER_READY_RETRIES=40  # 40 × 0.25s = 10s max
for _i in $(seq 1 $SERVER_READY_RETRIES); do
  (echo >/dev/tcp/127.0.0.1/${FORGEAX_SERVER_PORT:-18900}) 2>/dev/null && break
  sleep 0.25
done

(cd "$ROOT/packages/$([ "$STUDIO" = "1" ] && echo studio || echo interface)" && exec bun x vite) &
UI=$!; fx_pg_record interface "$UI"
(cd "$ROOT/packages/editor/packages/play-runtime" && exec bun x vite) &
EN=$!; fx_pg_record engine "$EN"
# Editor edit-runtime host (✎ Edit mode) — its own vite on :15280, iframed by the
# interface (/editor proxy). Without this the Edit tab is blank (proxy 500).
(cd "$ROOT/packages/editor/packages/edit-runtime" && exec bun x vite --port "${FORGEAX_EDITOR_PORT:-15280}" --host 127.0.0.1) &
ED=$!; fx_pg_record editor "$ED"

if _narrative_will_start; then
  (cd "$WB_NARR_DIR" && exec npx tsx --env-file=.env src/api/server.ts) &
  NARR=$!; fx_pg_record narrative "$NARR"
fi

# （2026-06）人脸打码 Python sidecar 已移除：wb-reel 的 /__ce-api__/face-mask
# 现为同进程透传（不再依赖 python/torch）。需要真打码时在该端点接入纯 TS 方案。

# External plugin dev servers (vite) are iframed by the interface. When the
# interface is HTTPS (FORGEAX_INTERFACE_HTTPS=1, e.g. remote-IP access) those
# iframes must also be HTTPS or the browser blocks them as mixed content. Reuse
# the studio's own TLS cert (covers the same hosts/IPs) so the plugin vite can
# serve HTTPS; the plugin's vite.config reads VITE_DEV_HTTPS_CERT/KEY when set.
PLUGIN_TLS_CERT=""
PLUGIN_TLS_KEY=""
if [ "${FORGEAX_INTERFACE_HTTPS:-}" = "1" ] && [ -f "$ROOT/.tls/cert.pem" ] && [ -f "$ROOT/.tls/key.pem" ]; then
  PLUGIN_TLS_CERT="$ROOT/.tls/cert.pem"
  PLUGIN_TLS_KEY="$ROOT/.tls/key.pem"
fi

# Launch each discovered standalone-backend plugin (generic; see §3.8). Each
# backend gets its OWN per-plugin FORGEAX_PROJECT_ROOT (the global one above is
# the server's .forgeax/games/) so it owns an isolated projects/ + workspace.json
# — sharing would leak projects across plugins. Each launch is its own process
# group (set -m) so teardown group-kills its watcher tree (pnpm → vite + tsx).
for _i in "${!PLUGIN_DIRS[@]}"; do
  _dir="${PLUGIN_DIRS[$_i]}"
  (
    cd "$_dir" || exit 1
    # node-editor backends log via pino + pino-pretty, which offloads to a
    # thread-stream worker. thread-stream@3.1.0 (pulled by pino 9) crashes
    # under Node 22+ with "this should not happen: undefined", killing the
    # backend (Unhandled 'error' event). Default these backends to plain JSON
    # logging (no worker) — pretty colour is pointless in this multi-process
    # muxed output anyway, and JSON is easier for agents to parse. Override
    # per-run by exporting FORGEAX_LOG_PRETTY=1 before run.sh.
    export FORGEAX_LOG_PRETTY="${FORGEAX_LOG_PRETTY:-0}"
    FORGEAX_PROJECT_ROOT="${PLUGIN_PROOTS[$_i]}" \
    PORT="${PLUGIN_BPORTS[$_i]}" \
    VITE_DEV_PORT="${PLUGIN_FPORTS[$_i]}" \
    VITE_API_TARGET="http://localhost:${PLUGIN_BPORTS[$_i]}" \
    VITE_DEV_HTTPS_CERT="$PLUGIN_TLS_CERT" \
    VITE_DEV_HTTPS_KEY="$PLUGIN_TLS_KEY" \
    exec pnpm "$(_ext_plugin_cmd "$_dir")"
  ) &
  PLUGIN_PIDS+=("$!"); fx_pg_record "plugin-${PLUGIN_SHORTIDS[$_i]}" "$!"

  # Optional headless renderer: if a plugin ships scripts/headless-renderer.mjs
  # and has playwright installed, run its `?pane=urdf` viewer in headless
  # Chromium so an agent's screenshot capture always has a live renderer (no
  # human-opened panel). Feature-detected per plugin, not hardcoded. Opt out
  # with FORGEAX_LOWPOLY_HEADLESS_RENDERER=0.
  if [ "${FORGEAX_LOWPOLY_HEADLESS_RENDERER:-1}" != "0" ] \
     && [ -d "$_dir/node_modules/playwright" ] && [ -f "$_dir/scripts/headless-renderer.mjs" ]; then
    echo "[run.sh] + ${PLUGIN_SHORTIDS[$_i]} headless renderer (agent screenshots; disable: FORGEAX_LOWPOLY_HEADLESS_RENDERER=0)"
    (
      cd "$_dir" && \
      LOWPOLY_FRONTEND_PORT="${PLUGIN_FPORTS[$_i]}" \
      exec node scripts/headless-renderer.mjs
    ) &
    PLUGIN_PIDS+=("$!"); fx_pg_record "plugin-${PLUGIN_SHORTIDS[$_i]}-headless" "$!"
  fi
done

# Job control no longer needed past the launches; the groups created above keep
# their PGIDs regardless of monitor mode, and the final `wait` behaves as before.
set +m

{
  echo "# generated by scripts/run.sh"
  echo "FORGEAX_RUN_PIDS=\"${SRV:-} ${UI:-} ${EN:-} ${ED:-} ${NARR:-} ${PLUGIN_PIDS[*]}\""
  echo "FORGEAX_RUN_PORTS=\"${FORGEAX_SERVER_PORT:-18900} ${FORGEAX_INTERFACE_PORT:-18920} ${FORGEAX_ENGINE_PORT:-15173} ${FORGEAX_EDITOR_PORT:-15280} ${NARRATIVE_PORT:-8900} ${PLUGIN_FPORTS[*]} ${PLUGIN_BPORTS[*]}\""
  echo "FORGEAX_PLUGIN_DEV_PORTS_FILE=\"$PLUGIN_DEV_PORTS_FILE\""
} > "$RUN_STACK_FILE"

wait
