#!/usr/bin/env bash
# forgeax-studio bootstrap: provision toolchain (bun / node 22+ / pnpm /
# rust→wasm) on a fresh host, then init submodules + install per-subrepo deps.
#
# Run after `git clone --recurse-submodules` (or if you cloned without it,
# `git submodule update --init --recursive` first — this script will do that
# too as a safety net).
#
# Flags:
#   --yes,  -y         auto-accept every "install missing tool?" prompt
#   --no-toolchain     skip the toolchain provisioning pass entirely
#                      (useful when you've already set it up by hand or are
#                      iterating on this script; deps install still runs)
#   --toolchain-only   provision toolchain and exit BEFORE submodules + bun
#                      install (used by scripts/deploy.sh which does its own
#                      submodule init / pnpm engine build / bun install pass
#                      and only needs us to materialise tools)
#
# Env:
#   FORGEAX_BOOTSTRAP_YES=1     same as --yes
#   FORGEAX_SKIP_HARNESS_SYNC=1 skip the .forgeax-harness sync (passed through)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# Windows / Git Bash: pick up bun / pnpm / cargo bin dirs that PowerShell
# wrote to user PATH after we'd already forked, and force native NTFS
# symlinks so the .forgeax symlinks created later actually link instead of
# silently copying. No-op on macOS / Linux. See scripts/run.sh §0.0.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    export MSYS="${MSYS:-}${MSYS:+ }winsymlinks:nativestrict"
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

YES="${FORGEAX_BOOTSTRAP_YES:-0}"
DO_TOOLCHAIN=1
TOOLCHAIN_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)         YES=1 ;;
    --no-toolchain)   DO_TOOLCHAIN=0 ;;
    --toolchain-only) TOOLCHAIN_ONLY=1 ;;
    -h|--help)        sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ "$DO_TOOLCHAIN" = "0" ] && [ "$TOOLCHAIN_ONLY" = "1" ]; then
  fail "--no-toolchain and --toolchain-only are mutually exclusive"
fi

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Ask "msg [Y/n]"; respect $YES (autoyes) and non-interactive shells (default
# to NO so a piped/CI run never silently mutates $HOME). Return 0 on yes.
confirm() {
  local msg="$1"
  if [ "$YES" = "1" ]; then return 0; fi
  if [ ! -t 0 ]; then return 1; fi
  printf '  %s [Y/n] ' "$msg"
  local ans; read -r ans
  case "${ans:-y}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

UNAME_S="$(uname -s)"
HAS_BREW=0
if [ "$UNAME_S" = "Darwin" ] && command -v brew >/dev/null 2>&1; then HAS_BREW=1; fi

# ─── toolchain provisioning ────────────────────────────────────────────────
# Each ensure_<tool> is idempotent: detect first, install only if absent /
# too old. Failures are loud but non-fatal here — the post-toolchain summary
# re-checks and will exit if something the engine build truly needs is still
# missing.
ensure_curl_git() {
  command -v git  >/dev/null 2>&1 || fail "git not found. Install git first (apt/brew/dnf install git)."
  command -v curl >/dev/null 2>&1 || fail "curl not found. Install curl first (apt/brew/dnf install curl)."
}

# Ensure a `bunx` launcher exists next to `bun`. The official installer creates
# bunx as a symlink → bun, but some installs (e.g. a hand-copied bun binary, or
# certain package managers) ship only `bun`, leaving `bunx` missing. run.sh /
# build-desktop.sh launch vite via bunx, so a missing bunx silently fails the
# UI/engine/editor vite servers (they're backgrounded; the error never aborts
# the run). Recreate the symlink ourselves — idempotent, harmless if present.
ensure_bunx() {
  command -v bunx >/dev/null 2>&1 && return 0
  local bun_path bun_dir
  bun_path="$(command -v bun 2>/dev/null)" || return 0
  bun_dir="$(dirname "$bun_path")"
  if [ -w "$bun_dir" ]; then
    ln -snf bun "$bun_dir/bunx" 2>/dev/null \
      && ok "created bunx → bun symlink in $bun_dir" \
      || warn "could not create bunx symlink in $bun_dir (run.sh uses 'bun x' fallback)"
  fi
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then ok "bun $(bun --version)"; ensure_bunx; return 0; fi
  warn "bun not found"
  confirm "Install bun via the official installer (curl https://bun.sh/install | bash)?" || {
    warn "skipping bun — engine/server install will fail"; return 1
  }
  curl -fsSL https://bun.sh/install | bash
  # bun's installer puts itself in $HOME/.bun/bin and prints a profile snippet
  # that doesn't take effect until the next shell. Source it for THIS shell so
  # the rest of bootstrap.sh can call `bun`.
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if command -v bun >/dev/null 2>&1; then
    ok "bun $(bun --version) installed"
    ensure_bunx
  else
    warn "bun install ran but bun still not on PATH (re-source your shell)"
  fi
}

ensure_node() {
  local major=""
  if command -v node >/dev/null 2>&1; then
    major="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [ "${major:-0}" -ge 22 ] 2>/dev/null; then ok "node $(node -v)"; return 0; fi
    warn "node $(node -v) < 22 — forgeax-server needs ≥22"
  else
    warn "node not found"
  fi
  # Prefer existing nvm if present.
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    confirm "Use nvm to install Node 22?" || { warn "skipping node upgrade"; return 1; }
    # shellcheck disable=SC1090
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm install 22 && nvm use 22
    ok "node $(node -v) (via nvm)"
    return 0
  fi
  # macOS shortcut: brew node@22 if user already lives in brew.
  if [ "$HAS_BREW" = "1" ]; then
    confirm "Install Node 22 via 'brew install node@22'?" || { warn "skipping node install"; return 1; }
    brew install node@22
    # Linking is opt-in for keg-only formulae; nudge it for the current shell.
    local prefix; prefix="$(brew --prefix node@22 2>/dev/null || true)"
    [ -n "$prefix" ] && export PATH="$prefix/bin:$PATH"
    command -v node >/dev/null 2>&1 && ok "node $(node -v) installed" || warn "node@22 installed but not on PATH (run: brew link --overwrite --force node@22)"
    return 0
  fi
  # Linux / fallback: install nvm then node 22.
  confirm "Install nvm (https://github.com/nvm-sh/nvm) + Node 22?" || { warn "skipping node install"; return 1; }
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 22 && nvm use 22
  ok "node $(node -v) installed via nvm"
}

ensure_pnpm() {
  # `pnpm --version` run from the repo root prints a spurious
  #   [WARN] The "workspaces" field in package.json is not supported by pnpm…
  # to stderr: the root package.json is a *bun* workspace (the `workspaces`
  # field is bun's), and pnpm 11 warns whenever it sees that field with no
  # pnpm-workspace.yaml. We can't add pnpm-workspace.yaml at the root — in
  # this repo that file is a load-bearing "install with pnpm, not bun" marker
  # (see deploy.sh §plugins) — and pnpm 11 has no flag to silence the warning.
  # pnpm is only ever used inside packages/engine anyway, so just drop the
  # version probe's stderr; the stdout version string is unaffected.
  if command -v pnpm >/dev/null 2>&1; then ok "pnpm $(pnpm --version 2>/dev/null)"; return 0; fi
  warn "pnpm not found (engine submodule build needs it)"
  # Prefer corepack if the active Node ships it (Node 16.10+ does).
  if command -v corepack >/dev/null 2>&1; then
    confirm "Enable pnpm via 'corepack enable pnpm'?" || { warn "skipping pnpm"; return 1; }
    corepack enable pnpm 2>/dev/null || corepack enable
    corepack prepare pnpm@latest --activate 2>/dev/null || true
    command -v pnpm >/dev/null 2>&1 && { ok "pnpm $(pnpm --version 2>/dev/null) (via corepack)"; return 0; }
  fi
  confirm "Install pnpm via 'npm i -g pnpm'?" || { warn "skipping pnpm"; return 1; }
  npm i -g pnpm
  ok "pnpm $(pnpm --version 2>/dev/null) installed"
}

ensure_rust_wasm() {
  # Three concerns: rustc/cargo, wasm32-unknown-unknown target, wasm-pack.
  # All three are needed by packages/engine/packages/wgpu-wasm/build.sh — if any
  # are missing the engine preview server fails at vite buildStart with
  # "ENOENT wgpu_wasm_bg.wasm" once you run scripts/dev.sh.
  local need_rust=0 need_target=0 need_wp=0
  command -v rustc >/dev/null 2>&1 || need_rust=1
  if [ "$need_rust" = "0" ]; then
    rustup target list --installed 2>/dev/null | grep -q '^wasm32-unknown-unknown$' || need_target=1
  fi
  command -v wasm-pack >/dev/null 2>&1 || need_wp=1

  if [ "$need_rust" = "0" ] && [ "$need_target" = "0" ] && [ "$need_wp" = "0" ]; then
    ok "rust $(rustc --version | awk '{print $2}') + wasm32 target + wasm-pack $(wasm-pack --version | awk '{print $2}')"
    return 0
  fi

  if [ "$need_rust" = "1" ]; then
    warn "rustc not found"
    confirm "Install rust via rustup (https://rustup.rs)?" || { warn "skipping rust — wgpu wasm build will be skipped, preview engine won't start"; return 1; }
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
    # rustup installs to ~/.cargo/bin which is added by the env script.
    # shellcheck disable=SC1091
    [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
    ok "rust $(rustc --version | awk '{print $2}') installed"
    need_target=1
  fi

  if [ "$need_target" = "1" ]; then
    confirm "Add rustup target wasm32-unknown-unknown?" || { warn "skipping wasm target — engine wasm won't build"; return 1; }
    rustup target add wasm32-unknown-unknown
    ok "wasm32-unknown-unknown target added"
  fi

  if [ "$need_wp" = "1" ]; then
    warn "wasm-pack not found"
    if [ "$HAS_BREW" = "1" ]; then
      confirm "Install wasm-pack via 'brew install wasm-pack'?" && { brew install wasm-pack; ok "wasm-pack $(wasm-pack --version | awk '{print $2}') installed"; return 0; }
    fi
    confirm "Install wasm-pack via the official installer (curl https://rustwasm.github.io/wasm-pack/installer/init.sh | sh)?" || { warn "skipping wasm-pack — engine wasm won't build"; return 1; }
    curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
    ok "wasm-pack $(wasm-pack --version | awk '{print $2}') installed"
  fi
}

if [ "$DO_TOOLCHAIN" = "1" ]; then
  bold "▶ Toolchain provisioning"
  ensure_curl_git
  ensure_bun       || true
  ensure_node      || true
  ensure_pnpm      || true
  ensure_rust_wasm || true

  # Final hard check: bun + node 22 are non-negotiable for the next steps
  # (submodule install / engine build). Missing rust/wasm only degrades the
  # engine preview, so we let that pass through as a warning.
  command -v bun  >/dev/null 2>&1 || fail "bun still missing — install it before re-running bootstrap."
  command -v node >/dev/null 2>&1 || fail "node still missing — install Node 22+ before re-running bootstrap."
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "$major" -ge 22 ] || fail "node $major still < 22 — Studio server needs 22+."
  echo
fi

# When invoked as `bootstrap.sh --toolchain-only` (e.g. by deploy.sh's
# pre-flight) we exit here; the caller already handles submodule init +
# bun install with its own filters/cache logic and would just repeat
# what we're about to do.
if [ "$TOOLCHAIN_ONLY" = "1" ]; then
  ok "toolchain ready (--toolchain-only); skipping submodule + bun install"
  exit 0
fi

# ─── submodules + harness clone ────────────────────────────────────────────
bold "▶ git submodule update --init --recursive"
git submodule update --init --recursive

# Materialise the .forgeax-harness floating clone (closed-loop state repo
# forgeax-studio-harness). NOT a submodule — gitignored + script-synced.
# `|| true` keeps a missing/offline harness from blocking bootstrap (the
# stack runs fine without it; sync-harness.mjs handles its own failure policy).
bold "▶ node scripts/sync-harness.mjs  (.forgeax-harness floating clone)"
node "$ROOT/scripts/sync-harness.mjs" || true

# ─── per-subrepo bun install ───────────────────────────────────────────────
# bun-based subrepos: install dependencies.
# forgeax-engine has its own build dance; closed-loop harness state lives in
# the .forgeax-harness floating clone synced above (not a submodule).
# 2026-05-21: dropped packages/cli — forgeax-server's built-in cli-providers
# fully subsume the legacy forgeax cli daemon (:3700, docker-based).
for d in packages/interface packages/server packages/forgeax; do
  if [ -d "$d" ] && [ -f "$d/package.json" ]; then
    bold "▶ bun install ($d)"
    (cd "$d" && bun install --frozen-lockfile 2>/dev/null || bun install)
  fi
done

# packages/forgeax/ is the runnable output. Surface the next step explicitly.
cat <<'EOF'

Bootstrap complete. Next:

  1. cp .env.example .env  (if .env doesn't exist)
     edit .env and set ANTHROPIC_API_KEY
  2. bash scripts/deploy.sh  (engine build + plugins + .env scaffold)
     or:  bash scripts/dev.sh / scripts/run.sh
     → spawns server :18900, studio :18920, engine :15173

Daily dev:
  - UI edits → packages/interface/src/...     (Vite HMR via studio)
  - server edits → packages/server/src/...    (bun --watch hot reload)
  - rebuild: cd packages/build && ./build.sh release-source
  - (or use ./scripts/build.sh release-source which wraps the above)

Submodule bump (after pushing a sub-repo change):
  cd forgeax-studio                           (this dir)
  git submodule update --remote <path-under-packages/>
  git add <path-under-packages/> && git commit -m "bump <subrepo> to $(cd <path-under-packages/> && git rev-parse --short HEAD)"
  git push
EOF
