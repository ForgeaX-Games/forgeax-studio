#!/usr/bin/env bash
# ForgeaX Studio — desktop app, one command (Tauri 2).
#
#   bash app.sh            # dev app: a native window running the LIVE source
#   bash app.sh dev        #   (HMR — edit code, see it instantly). Auto-installs
#                          #   on first run. OWNS the dev-stack lifecycle: every
#                          #   launch reaps any old stack + starts a FRESH one,
#                          #   and closing the window stops the WHOLE stack
#                          #   (server/UI/engine/editor/plugins) — no orphans, no
#                          #   re-attaching to a stale stack that serves old code.
#   bash app.sh debug      # same as `dev` but ALSO auto-opens the DevTools panel
#   bash app.sh dev debug  #   (equivalent). Without `debug`, DevTools stays closed.
#   bash app.sh build      # package a distributable .app/.dmg
#   bash app.sh open       # open the last-built .app
#   bash app.sh stop       # stop the dev web stack (server/UI/engine)
#
# Two desktop forms share one shell:
#   - dev   : window loads the vite dev server (:18920) → live, no repackage.
#   - .app  : `app.sh build` freezes the source into a self-contained bundle
#             (its own bun sidecar on 18810/15273). See DEVELOPMENT.md.
#
# Platform: `dev` runs on macOS and on Windows (under Git Bash — prereqs: Rust +
# MinGW-w64 via `winget install BrechtSanders.WinLibs.POSIX.MSVCRT`). The `build`
# / `open` packaging modes are macOS-only (.app/.dmg) for now.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(pwd)"
STUDIO=${STUDIO:-1}; export STUDIO
MODE="${1:-dev}"

# DevTools is OFF by default (it's noisy — engine multi-light warnings etc.).
# Opt in with `app.sh debug` or `app.sh dev debug`; the Rust shell reads
# FORGEAX_DEVTOOLS and only auto-opens the inspector when it is 1.
DEVTOOLS=0
[ "$MODE" = "debug" ] && { MODE="dev"; DEVTOOLS=1; }
for arg in "$@"; do [ "$arg" = "debug" ] && DEVTOOLS=1; done
export FORGEAX_DEVTOOLS="$DEVTOOLS"

port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# ── platform ────────────────────────────────────────────────────────────────
# desktop-dev runs under Git Bash on Windows; branch only where the OS differs
# (mirrors scripts/run.sh's uname-based handling). macOS stays the default path.
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;; *) IS_WINDOWS=0 ;; esac
# Executable suffix for staged sidecars. Tauri's externalBin resolver wants the
# host-triple-suffixed name; on Windows that file MUST carry `.exe`.
EXE=""; [ "$IS_WINDOWS" = 1 ] && EXE=".exe"

# Windows-gnu's Rust toolchain shells out to MinGW-w64 (`gcc`/`dlltool`) to LINK
# the Tauri shell, and rustup does not ship them. Discover a winlibs/msys install
# and prepend it to PATH so `tauri dev`'s cargo build can link. No-op off Windows
# or when a C toolchain is already reachable.
#   Prerequisite note: on the gnu toolchain the lib's `cdylib` crate-type hits
#   GNU ld's "export ordinal too large" limit; src-tauri/Cargo.toml keeps
#   crate-type = ["lib"] for Windows desktop dev (the .exe needs no cdylib).
ensure_cc_toolchain() {
  [ "$IS_WINDOWS" = 1 ] || return 0
  command -v dlltool >/dev/null 2>&1 && command -v gcc >/dev/null 2>&1 && return 0
  local base d
  base="$(cygpath -u "${LOCALAPPDATA:-}" 2>/dev/null)/Microsoft/WinGet/Packages"
  for d in "$base"/BrechtSanders.WinLibs.*/mingw64/bin /c/msys64/mingw64/bin /c/mingw64/bin; do
    if [ -x "$d/dlltool.exe" ] && [ -x "$d/gcc.exe" ]; then
      PATH="$d:$PATH"; export PATH
      echo "[app] MinGW-w64 on PATH: $d"
      return 0
    fi
  done
  echo "[app] WARNING: MinGW-w64 (gcc/dlltool) not found — 'tauri dev' can't link the Rust shell." >&2
  echo "[app]          install once:  winget install BrechtSanders.WinLibs.POSIX.MSVCRT" >&2
  return 0
}

# Reap any previous desktop dev window so a relaunch always lands on fresh source.
reap_dev_windows() {
  if [ "$IS_WINDOWS" = 1 ]; then
    if tasklist 2>/dev/null | grep -iq 'forgeax-studio-desktop'; then
      echo "[app] closing previous dev window(s) so you get the latest code…"
      MSYS_NO_PATHCONV=1 taskkill /IM forgeax-studio-desktop.exe /F >/dev/null 2>&1 || true
      sleep 1
    fi
  elif pgrep -f forgeax-studio-desktop >/dev/null 2>&1; then
    echo "[app] closing previous dev window(s) so you get the latest code…"
    pkill -f forgeax-studio-desktop 2>/dev/null || true
    sleep 1
  fi
}

# Bust the webview HTTP cache so a relaunch can't serve a pre-edit JS bundle,
# while KEEPING localStorage / IndexedDB (editor scene state). Per-engine paths:
# WebView2 (EBWebView) on Windows, WKWebView on macOS.
clear_webview_cache() {
  if [ "$IS_WINDOWS" = 1 ]; then
    local d; d="$(cygpath -u "${LOCALAPPDATA:-}" 2>/dev/null)/com.forgeax.studio/EBWebView"
    rm -rf "$d/Default/Cache" "$d/Default/Code Cache" "$d/Default/GPUCache" >/dev/null 2>&1 || true
  else
    rm -rf "$HOME/Library/Caches/com.forgeax.studio" \
           "$HOME/Library/Caches/forgeax-studio-desktop" \
           "$HOME/Library/Saved Application State/com.forgeax.studio.savedState" >/dev/null 2>&1 || true
  fi
}

case "$MODE" in
  dev|"")
    # First run on a fresh clone: deps + engine build (idempotent).
    if [ ! -f "$ROOT/packages/engine/packages/runtime/dist/index.mjs" ]; then
      echo "[app] first run — installing deps + building engine (install.sh)…"
      bash "$ROOT/install.sh"
    fi
    # Web stack (server :18900 / UI :18920 / engine :15173 / editor :15280 / …).
    # The desktop app OWNS the full dev-stack lifecycle: opening it starts every
    # process FRESH; closing the window (→ tauri:dev exits → the EXIT trap below)
    # tears every process down. So ALWAYS reap any existing stack first — healthy
    # OR stale — then start a clean one. This is the fix for the two failure
    # modes the old "preserve a running stack" path produced:
    #   (a) "I closed the app but vite/server kept running" (orphaned stack), and
    #   (b) "I reopened and attached to a STALE stack serving pre-edit code →
    #       editor/preview came up empty" (re-attach to a leftover :18920).
    # There is never a leftover stack to re-attach to, and current source always
    # wins. stop.sh --force reaps server / UI / engine / editor / face-mask AND
    # the dynamically-ported workbench plugins (pidfiles + pgrep fallback).
    echo "[app] clean restart — reaping any existing/stale web stack first…"
    bash "$ROOT/scripts/stop.sh" --force >/dev/null 2>&1 || true
    # Bust the webview HTTP cache. The stack restart above makes :18920 serve
    # CURRENT source, but the webview persists its resource cache to disk and
    # reuses it across relaunches — so a fresh `tauri dev` window can silently
    # serve the PRE-EDIT JS bundle (app stuck on an old UI while live :18920 is
    # current). Clearing the HTTP cache forces a fresh fetch; localStorage /
    # IndexedDB (editor scene state) is deliberately KEPT. The webview is not
    # running yet (tauri:dev launches below), so this is race-free.
    echo "[app] clearing webview HTTP cache (force fresh source load)…"
    clear_webview_cache
    echo "[app] starting web stack (start.sh) in background…"
    nohup bash "$ROOT/start.sh" > /tmp/forgeax-stack.log 2>&1 &
    printf '[app] waiting for UI :18920'
    for _ in $(seq 1 90); do port_up 18920 && break; printf '.'; sleep 2; done; echo
    if ! port_up 18920; then
      echo "[app] web stack failed to come up — see /tmp/forgeax-stack.log" >&2
      bash "$ROOT/scripts/stop.sh" --force >/dev/null 2>&1 || true
      exit 1
    fi
    # Closing the app window exits `tauri:dev`, firing this trap → the WHOLE dev
    # stack (server / UI / engine / editor / plugins) is torn down. No orphans.
    trap 'echo "[app] app closed — stopping the whole web stack…"; bash "$ROOT/scripts/stop.sh" --force >/dev/null 2>&1 || true' EXIT
    # tauri.conf.json declares `externalBin: ["binaries/bun"]`, so even
    # `tauri dev` resolves a host-triple-suffixed sidecar at build-script time
    # and refuses to start without it. The .app build path stages this in
    # build-desktop.sh step 7/7, but dev mode never did — fresh clones hit
    # `resource path 'binaries/bun-aarch64-apple-darwin' doesn't exist`. Stage
    # the same way build-desktop does (idempotent, skip if present).
    BIN_DIR="$ROOT/packages/interface/src-tauri/binaries"
    TRIPLE="$(rustc -Vv 2>/dev/null | sed -n 's/^host: //p')"
    if [ -n "$TRIPLE" ] && [ ! -x "$BIN_DIR/bun-$TRIPLE$EXE" ]; then
      BUN_BIN="$(command -v bun || true)"
      # Git Bash resolves `bun` without the .exe; the real file carries it.
      [ -n "$BUN_BIN" ] && [ ! -f "$BUN_BIN" ] && [ -f "$BUN_BIN$EXE" ] && BUN_BIN="$BUN_BIN$EXE"
      if [ -n "$BUN_BIN" ] && [ -f "$BUN_BIN" ]; then
        mkdir -p "$BIN_DIR"
        cp "$BUN_BIN" "$BIN_DIR/bun-$TRIPLE$EXE"
        chmod +x "$BIN_DIR/bun-$TRIPLE$EXE"
        echo "[app] staged tauri sidecar: bun-$TRIPLE$EXE"
      fi
    fi
    # tauri.conf.json also declares `resources: ["resources"]` (the .app payload
    # build-desktop.sh assembles for prod). The cargo build script just needs
    # the directory to exist; in dev the bundled payload isn't actually loaded
    # (window points at :18920). Create an empty stub so the resolver passes.
    RES_DIR="$ROOT/packages/interface/src-tauri/resources"
    [ -d "$RES_DIR" ] || mkdir -p "$RES_DIR"
    [ -e "$RES_DIR/.gitkeep" ] || : > "$RES_DIR/.gitkeep"
    # Re-running `app.sh` while an old dev window is still open piles up windows
    # AND the stale one keeps serving pre-edit JS (so a code fix "doesn't show").
    # Reap any prior dev-binary instance first so you always land on a fresh
    # window that loads current vite source.
    reap_dev_windows
    # Windows-gnu: put MinGW-w64 (gcc/dlltool) on PATH so cargo can link the shell.
    ensure_cc_toolchain
    if [ "$DEVTOOLS" = 1 ]; then
      echo "[app] launching desktop dev window (tauri:dev — live HMR, DevTools ON via debug)…"
    else
      echo "[app] launching desktop dev window (tauri:dev — live HMR, DevTools off; use 'app.sh debug' to open it)…"
    fi
    # NOTE: tauri:dev always runs from packages/interface (src-tauri lives here, C-4);
    # STUDIO env routes only the vite dev server (via start.sh → run.sh → cd packages/{studio|interface}).
    cd "$ROOT/packages/interface" && bun run tauri:dev
    ;;

  build)
    echo "[app] packaging .app (build-desktop.sh assembles Resources, then tauri build)…"
    bash "$ROOT/scripts/build-desktop.sh"
    ( cd "$ROOT/packages/interface" && bunx tauri build )
    APP="$ROOT/packages/interface/src-tauri/target/release/bundle/macos/ForgeaX Studio.app"
    [ -d "$APP" ] && echo "[app] ✓ built: $APP   (run: bash app.sh open)" \
                  || { echo "[app] build finished but .app not found (a .dmg styling step may fail headless; the .app itself is usually fine — check the bundle dir)"; exit 1; }
    ;;

  open)
    APP="$ROOT/packages/interface/src-tauri/target/release/bundle/macos/ForgeaX Studio.app"
    [ -d "$APP" ] || { echo "[app] no built .app — run: bash app.sh build" >&2; exit 1; }
    open "$APP" && echo "[app] opened $APP"
    ;;

  stop)
    bash "$ROOT/scripts/stop.sh" "${@:2}"
    ;;

  *)
    echo "usage: bash app.sh {dev|build|open|stop}" >&2; exit 2 ;;
esac
