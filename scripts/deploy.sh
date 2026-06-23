#!/usr/bin/env bash
# forgeax-studio deploy: one-command end-to-end setup.
# Idempotent — re-running picks up where it left off.
#
# Default behaviour: zero-prompt full auto. Toolchain installs auto-accept,
# .env is seeded from .env.example with placeholders, and no `read` ever
# blocks. Pass --interactive (-i) to ask before installing tools and to
# prompt for API keys at the end.
#
# Steps:
#   0. Bootstrap toolchain (delegates to scripts/bootstrap.sh --toolchain-only:
#      installs missing bun / node 22+ / pnpm / rust+wasm-pack on a fresh host).
#      Skipped with --skip-bootstrap.
#   1. Prereq check (git / bun / node 22+ / curl) — final hard gate
#   2. Submodule init + recursive update
#   3. Engine submodule build (pnpm install + pnpm -r build for core packages)
#   4. bun install in each sub-repo with package.json
#   5. Materialize $ROOT/.env from $ROOT/.env.example. In --interactive mode
#      prompt for ANTHROPIC_API_KEY (required) + optional multimodal/provider
#      keys; otherwise skip prompts (set keys later via the .env file or the
#      Studio Settings drawer).
#   6. Optional: with `--start` flag, exec scripts/dev.sh to launch the stack
#
# Usage:
#   bash scripts/deploy.sh                    # zero-prompt full auto (default)
#   bash scripts/deploy.sh --interactive      # ask before tool installs + key prompts
#   bash scripts/deploy.sh --start            # setup then start the dev stack
#   bash scripts/deploy.sh --no-plugins       # skip plugin install/build (faster)
#   bash scripts/deploy.sh --skip-bootstrap   # don't run scripts/bootstrap.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# Windows / Git Bash compat shim — same as run.sh §0.0 / bootstrap.sh.
# Necessary even though step [0/6] re-runs it inside bootstrap.sh, because
# `--skip-bootstrap` would otherwise bypass it.
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

START=0
SKIP_PLUGINS=0
SKIP_BOOTSTRAP=0
INTERACTIVE=0
for arg in "$@"; do
  case "$arg" in
    --start)            START=1 ;;
    --no-plugins)       SKIP_PLUGINS=1 ;;
    --skip-bootstrap)   SKIP_BOOTSTRAP=1 ;;
    --interactive|-i)   INTERACTIVE=1 ;;
    # Back-compat: --yes / -y were the old auto-accept flags. Auto is now
    # the default, so these are silent no-ops; we just don't reject them.
    --yes|-y)           : ;;
    -h|--help)
      sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Tell sub-scripts to keep their mouths shut unless --interactive.
if [ "$INTERACTIVE" = "0" ]; then
  export FORGEAX_BOOTSTRAP_YES=1            # bootstrap.sh: auto-yes every install prompt
  export FORGEAX_DEPLOY_NO_PROMPT_OPTIONAL=1 # this script: skip optional .env key prompts
fi

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }

# ─── 0. toolchain bootstrap ───────────────────────────────────────────────
# Delegate to scripts/bootstrap.sh --toolchain-only so a fresh host gets
# bun / node22 / pnpm / rust+wasm-pack provisioned before we start asking
# them to run. bootstrap.sh is idempotent: each ensure_* helper detects an
# already-installed tool and prints "✓" without touching anything.
#
# Default mode auto-accepts every install (FORGEAX_BOOTSTRAP_YES=1 exported
# above); --interactive lets bootstrap ask per-tool.
#
# Source shell-rc-style env files that bootstrap may have just modified, so
# fresh installs are visible to step [1/6]'s `command -v` checks without a
# new shell.
if [ "$SKIP_BOOTSTRAP" = "1" ]; then
  bold "[0/6] Toolchain bootstrap skipped (--skip-bootstrap)"
else
  bold "[0/6] Toolchain bootstrap (scripts/bootstrap.sh --toolchain-only)"
  bash "$SCRIPT_DIR/bootstrap.sh" --toolchain-only
  # Pick up newly-installed tools that wrote to ~/.cargo / ~/.bun / nvm.
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  if [ -d "$HOME/.bun/bin" ]; then export BUN_INSTALL="$HOME/.bun"; export PATH="$HOME/.bun/bin:$PATH"; fi
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ] && ! command -v node >/dev/null 2>&1; then
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  fi
fi

# ─── 1. prereq check ───────────────────────────────────────────────────────
# After bootstrap, this is the hard gate — anything still missing means the
# user declined the install prompt or the install failed silently. Fail loud.
bold "[1/6] Checking prerequisites"

command -v git  >/dev/null 2>&1 || fail "git not found. Install git (e.g. apt install git)."
command -v curl >/dev/null 2>&1 || fail "curl not found. Install curl."
command -v bun  >/dev/null 2>&1 || fail "bun not found. Re-run scripts/bootstrap.sh, or install: curl -fsSL https://bun.sh/install | bash"
command -v node >/dev/null 2>&1 || fail "node not found. Re-run scripts/bootstrap.sh, or install Node 22+: nvm install 22"

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node $NODE_MAJOR found; forgeax-server needs ≥22. Run: nvm install 22 && nvm use 22"

ok "git=$(git --version | awk '{print $3}') bun=$(bun --version) node=$(node -v)"

# ─── 2. submodule init ────────────────────────────────────────────────────
bold "[2/6] Initialising submodules"

# SSH fallback for private submodules.
# The .gitmodules URLs are HTTPS (https://github.com/ForgeaX-Games/...), but the
# repos are private. GitHub disabled password auth in 2021, and accounts with
# 2FA can't authenticate over HTTPS without a Personal Access Token — so an
# interactive HTTPS prompt just loops forever asking for a password that never
# works. If the user already has a working SSH key (the common case for anyone
# who cloned the superproject over git@github.com), transparently rewrite
# HTTPS→SSH. This touches neither the global git config nor .gitmodules, so
# HTTPS/PAT users are unaffected: when SSH isn't available the rewrite is
# skipped and git falls back to HTTPS.
#
# We inject the rewrite via GIT_CONFIG_* env vars rather than `-c` on the
# command line, because `--recursive` forks a fresh git process per nested
# submodule (e.g. forgeax-engine-assets under forgeax-engine) and those do
# NOT inherit parent `-c` flags — but they DO inherit the environment. Env
# injection makes the rewrite apply at every recursion depth.
if git config --file .gitmodules --get-regexp url 2>/dev/null | grep -q 'https://github.com/' \
   && ssh -o BatchMode=yes -o ConnectTimeout=5 -T git@github.com 2>&1 | grep -q 'successfully authenticated'; then
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0="url.git@github.com:.insteadOf"
  export GIT_CONFIG_VALUE_0="https://github.com/"
  ok "GitHub SSH key detected — using SSH for private submodules (HTTPS→SSH rewrite, this run only)"
fi

# Never block on an interactive credential prompt. If some path still resolves
# to HTTPS without usable credentials, fail fast with a clear error instead of
# hanging forever on "Username for 'https://github.com':".
export GIT_TERMINAL_PROMPT=0

# Shallow clone by default — these submodules are only needed at the
# super-pinned SHA, and full history of ~9 private repos is the single biggest
# chunk of deploy wall-time. `--depth 1` fetches just the pinned commit.
# git auto-unshallows on demand (e.g. /main-merge fetching newer commits), and
# the `git checkout main` step below works fine on a depth-1 tree. Set
# FORGEAX_SUBMODULE_FULL=1 to fetch full history instead.
SUBMODULE_DEPTH=(--depth 1)
[ "${FORGEAX_SUBMODULE_FULL:-0}" = "1" ] && SUBMODULE_DEPTH=()

# NB: `"${arr[@]+"${arr[@]}"}"` not `"${arr[@]}"` — under `set -u`, macOS's
# bash 3.2 treats an empty array expansion as an unbound variable and aborts
# (fixed only in bash 4.4+). The `+` form expands to nothing when empty.
# The HTTPS→SSH rewrite rides on the GIT_CONFIG_* env vars exported above, so
# it reaches every recursion depth (no `-c` needed here).
git submodule update --init --recursive "${SUBMODULE_DEPTH[@]+"${SUBMODULE_DEPTH[@]}"}"
echo "  (includes packages/games shared game library submodule)"
ok "$(git submodule status | wc -l | tr -d ' ') submodules ready"

# `submodule update` leaves each child detached at the super-pinned SHA.
# Force every submodule onto local `main` (pointing at that SAME SHA — no
# fetch, no pull, no pointer movement) so `git status` reads "on branch main"
# and downstream branch-aware tooling has a stable named branch to work with.
# Pulling newer commits is an explicit user action (e.g. /main-merge), never
# a side effect of deploy.
git submodule foreach --recursive --quiet '
  git branch -f main HEAD >/dev/null 2>&1 || true
  git checkout main >/dev/null 2>&1 || true
'
ok "submodules aligned to local main (super-pinned SHA; no remote fetch)"

# .forgeax-harness is a floating clone of forgeax-studio-harness (closed-loop
# state repo) — NOT a submodule. Materialise it via the sync script. Failure
# is non-fatal (the stack runs without harness state); sync-harness.mjs owns
# its own offline/divergence policy.
printf '  → node scripts/sync-harness.mjs (.forgeax-harness floating clone)\n'
if node "$ROOT/scripts/sync-harness.mjs"; then
  ok ".forgeax-harness floating clone synced"
else
  printf '\033[33m  ⚠ harness sync failed — continuing\033[0m\n'
fi

# Install harness skills/rules into $ROOT via forgeax-install. The IR
# (packages/harness/.../examples/forgeax-studio.json) is machine-independent —
# it declares WHAT to install; we pass WHERE (--target-root "$ROOT") at runtime.
# Manifest + vendored files land under .forgeax-harness/ (materialised above), so
# this must run after the floating-clone sync. install_harness.py is pure stdlib
# (no harness .venv needed). Mount parents (.cursor/skills, .claude/rules, …) must
# exist before linking — a fresh clone only ships .cursor with content, so create
# all 12 here. Non-fatal, same policy as the sync above: the stack runs without
# the harness skills, they just aren't visible to the CLI front-ends.
_install_py="$ROOT/packages/harness/skills/forgeax-install/scripts/install_harness.py"
_install_ir="$ROOT/packages/harness/skills/forgeax-install/examples/forgeax-studio.json"
if [ -f "$_install_py" ] && [ -f "$_install_ir" ] && command -v python3 >/dev/null 2>&1; then
  for _mount in .codebuddy .cursor .agents .claude .claude-internal .workbuddy; do
    mkdir -p "$ROOT/$_mount/skills" "$ROOT/$_mount/rules"
  done
  printf '  → forgeax-install (harness skills/rules → %s)\n' "$ROOT"
  if python3 "$_install_py" --spec "$_install_ir" --target-root "$ROOT"; then
    ok "harness skills/rules installed (mount symlinks + vendor)"
  else
    printf '\033[33m  ⚠ forgeax-install failed — continuing\033[0m\n'
  fi
else
  printf '\033[33m  ⚠ forgeax-install IR or python3 missing — skipping\033[0m\n'
fi

# engine + editor each carry their OWN floating harness clone (forgeax-engine-
# harness / forgeax-editor-harness), wired to their postinstall. Our install
# path never runs those postinstalls (pnpm --frozen-lockfile in the engine
# build, bun workspace install skips sub-package lifecycle scripts), so the
# clones never materialise unless we sync them here explicitly. Same non-fatal
# policy as studio's: each sub-repo's sync-harness.mjs owns offline/divergence.
for _sub in engine editor; do
  _sync="$ROOT/packages/$_sub/scripts/sync-harness.mjs"
  [ -f "$_sync" ] || continue
  printf '  → packages/%s/scripts/sync-harness.mjs (.forgeax-harness floating clone)\n' "$_sub"
  if (cd "$ROOT/packages/$_sub" && node scripts/sync-harness.mjs); then
    ok "packages/$_sub/.forgeax-harness floating clone synced"
  else
    printf '\033[33m  ⚠ %s harness sync failed — continuing\033[0m\n' "$_sub"
  fi
done

# Helper: bun install with automatic recovery from a known-broken state.
# `bun install` occasionally lands in a half-installed state where its own
# node_modules/.bun cache has stale shims, then the next install crashes
# inside a postinstall script (most reliably reproduced on Windows + Git Bash
# with `simple-git-hooks` ENOENT — see Windows GAP-06). Clearing the .bun
# cache and re-running with --ignore-scripts gets past it; postinstalls
# don't matter for our build path. $1 is the dir to install in (defaults
# to cwd). Always preserves bun's own exit code on the second failure.
bun_install_with_retry() {
  local dir="${1:-.}"
  local first_log
  first_log="$(mktemp -t bun-install.XXXXXX)"
  if (cd "$dir" && bun install --frozen-lockfile) >"$first_log" 2>&1; then
    rm -f "$first_log"
    return 0
  fi
  if (cd "$dir" && bun install) >"$first_log" 2>&1; then
    rm -f "$first_log"
    return 0
  fi
  printf '\033[33m  ⚠ bun install failed in %s, clearing .bun cache and retrying with --ignore-scripts\033[0m\n' "$dir"
  rm -rf "$dir/node_modules/.bun"
  if (cd "$dir" && bun install --ignore-scripts); then
    rm -f "$first_log"
    return 0
  fi
  echo "  bun install retry also failed; first failure log:"
  sed 's/^/    /' "$first_log"
  rm -f "$first_log"
  return 1
}

# Helper: install a sub-repo if its node_modules cache is stale.
# The root bun install (post-loop) resolves workspace:* deps via the top-level
# package.json#workspaces. This per-dir pass installs each repository's own
# non-workspace dependencies.
install_dir() {
  local dir="$1"
  if [ ! -f "$dir/package.json" ]; then return 0; fi
  if [ -d "$dir/node_modules" ] && [ "$dir/node_modules" -nt "$dir/package.json" ]; then
    ok "$dir  (cache fresh, skip)"
    return 0
  fi
  printf '  → bun install (%s)\n' "$dir"
  if bun_install_with_retry "$dir"; then
    ok "$dir  installed"
  else
    printf '\033[33m  ⚠ %s  install failed — continuing\033[0m\n' "$dir"
  fi
}

# ─── 3. engine submodule build ─────────────────────────────────────────────
# Engine is a pnpm monorepo inside packages/engine/. Build the packages that
# studio's preview runtime imports at startup. The chain is:
#   engine-src vite.config → engine-vite-plugin-shader
#                         → engine-shader-compiler
#                         → engine-naga → engine-wgpu-wasm
# engine-src/src/main.ts imports @forgeax/engine-app (which transitively pulls
# engine-runtime / engine-ecs / engine-audio / engine-physics / etc) plus
# engine-runtime / engine-ecs directly, so engine-app's `dist/` must exist —
# without it vite returns HTTP 500 on /preview/src/main.ts ("Failed to resolve
# entry for package @forgeax/engine-app"). The `engine-app...` filter below
# covers all of main.ts's runtime import surface in one shot.
# engine-src's vite.config.ts ALSO imports @forgeax/engine-vite-plugin-pack at
# config-load time, so that package's tsup `dist/` must exist too — without it
# vite dies with "Failed to resolve entry for package
# @forgeax/engine-vite-plugin-pack" before the dev server even starts.
# All these packages need their tsup `dist/` materialised before run.sh starts.
# (engine-wgpu-wasm's `build` is the tsup JS shim only — the actual `.wasm`
# binary is NOT committed to git (see packages/wgpu-wasm/.gitignore
# "zero-binary invariant") and is built separately in step [3b] below.)
bold "[3/6] Building engine submodule packages"
if [ -d "$ROOT/packages/engine" ]; then
  # `...` suffix on each filter tells pnpm to also build that package's
  # transitive deps (engine-input / engine-rhi / engine-image / engine-pack /
  # engine-shader / engine-math etc). Without it, engine-runtime's `dist/`
  # imports `@forgeax/engine-input` which has no dist → vite resolveId fails
  # ("Failed to resolve entry for package @forgeax/engine-input").
  # engine-project is consumed by packages/server (workbench.ts / scaffold), not
  # by the preview runtime, so nothing in the filters above pulls it transitively.
  # Without its dist/, `bun src/main.ts` throws "Cannot find module
  # @forgeax/engine-project" at startup and every /api/* 500s — list it explicitly.
  (cd "$ROOT/packages/engine" && pnpm install --frozen-lockfile && \
    pnpm --filter '@forgeax/engine-app...' \
         --filter '@forgeax/engine-runtime...' --filter '@forgeax/engine-ecs...' \
         --filter '@forgeax/engine-types...' --filter '@forgeax/engine-vite-plugin-shader...' \
         --filter '@forgeax/engine-vite-plugin-pack...' \
         --filter '@forgeax/engine-shader-compiler...' --filter '@forgeax/engine-naga...' \
         --filter '@forgeax/engine-wgpu-wasm...' \
         --filter '@forgeax/engine-gltf...' --filter '@forgeax/engine-image...' --filter '@forgeax/engine-pack...' \
         --filter '@forgeax/engine-project...' \
         -r build) || \
    fail "engine submodule build failed. Check that pnpm is installed (npm i -g pnpm)."
  ok "engine packages built"
  # Note: engine packages emit dist/*.mjs only; .d.ts come from a separate
  # root-level `tsc -b` (engine package.json#scripts.build = `pnpm -r build
  # && tsc -b`). We deliberately do NOT run that here — engine main currently
  # has tsc -b errors of its own (GPU type drift), and studio runtime doesn't
  # need .d.ts (vite/esbuild strip types). Studio-side typecheck handles the
  # missing .d.ts via ambient `declare module` shims in the editor submodule
  # (editor/src/forgeax-engine.d.ts). Remove this note + add `tsc -b` once
  # engine main is tsc -b clean.
else
  fail "packages/engine submodule directory missing — run git submodule update --init --recursive"
fi

# ─── 3b. engine wgpu wasm binary ───────────────────────────────────────────
# packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm is git-ignored (zero-binary
# invariant) and is read by engine-vite-plugin-shader's buildStart hook when
# run.sh boots the preview engine. Without it vite dies with
# "ENOENT ... wgpu_wasm_bg.wasm". Building it needs a Rust→wasm toolchain
# (rustc ≥1.93 + wasm-pack + the wasm32-unknown-unknown target), which not
# every deploy host has. So this step is best-effort: if the toolchain is
# missing we WARN with install hints and continue (the operator can run
# packages/wgpu-wasm/build.sh later).
#
# Freshness check, NOT just existence: pkg/wgpu_wasm.js is the wasm-bindgen
# JS glue and IS committed — when an engine bump rewrites a #[wasm_bindgen]
# fn signature, the new committed wgpu_wasm.js stops importing the old symbol
# while a stale local wgpu_wasm_bg.wasm still _exports_ it. vite then dies at
# instantiate time:  "Import #N "./wgpu_wasm_bg.js" "__wbg_<oldsym>": function
# import requires a callable" (bug-20260612). Treat the wasm as stale if any
# of {src/**, Cargo.toml, Cargo.lock, committed pkg/wgpu_wasm.js} is newer.
# `find -newer X` returning a single hit is enough → rebuild.
WGPU_WASM_DIR="$ROOT/packages/engine/packages/wgpu-wasm"
WASM_ARTEFACT="$WGPU_WASM_DIR/pkg/wgpu_wasm_bg.wasm"
WASM_SENTINEL="$ROOT/.forgeax/sentinels/wgpu-wasm.built"
bold "[3b/6] Building engine wgpu wasm binary"

# Freshness anchor: prefer the post-build sentinel we write below over the
# .wasm itself. Reason — `git checkout` resets every source file's mtime to
# "now", so right after a fresh checkout the source files are technically
# newer than the wasm built moments before, and the loop below would
# rebuild on every deploy. The sentinel is touched after a successful
# build, so it's always >= the source mtimes that triggered it. If the
# sentinel is missing (clean clone, or first deploy after this change
# landed) we fall back to the .wasm itself.
_wgpu_wasm_stale() {
  [ -f "$WASM_ARTEFACT" ] || return 0  # missing → stale
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

# Mark the wasm as freshly-built. Both deploy-time (after a successful
# wasm-pack invocation) and the run.sh fallback path use the same sentinel,
# so the freshness check above is monotonic across the two scripts.
_touch_wasm_sentinel() {
  mkdir -p "$(dirname "$WASM_SENTINEL")"
  : > "$WASM_SENTINEL"
}

if ! _wgpu_wasm_stale; then
  ok "wgpu wasm already built and fresh (skip) — $WASM_ARTEFACT"
  # If a previous build pre-dates this sentinel scheme, retroactively mark
  # it so we don't rebuild on the next run for no reason.
  [ -f "$WASM_SENTINEL" ] || _touch_wasm_sentinel
elif ! command -v rustc >/dev/null 2>&1 || ! command -v wasm-pack >/dev/null 2>&1; then
  printf '\033[33m  ⚠ Rust→wasm toolchain missing — skipping wgpu wasm build.\033[0m\n'
  echo   "    The preview engine (run.sh) will fail until this is built. To fix:"
  command -v rustc     >/dev/null 2>&1 || echo "      • install rust:      https://rustup.rs"
  command -v wasm-pack >/dev/null 2>&1 || echo "      • install wasm-pack: brew install wasm-pack  (or: cargo install wasm-pack)"
  echo   "      • add wasm target:  rustup target add wasm32-unknown-unknown"
  echo   "    then re-run: bash packages/engine/packages/wgpu-wasm/build.sh"
else
  if [ -f "$WASM_ARTEFACT" ]; then
    printf '  → wgpu wasm stale (src / Cargo / pkg/wgpu_wasm.js newer than build sentinel) — rebuilding\n'
  else
    printf '  → wgpu wasm missing — building\n'
  fi
  rustup target list --installed 2>/dev/null | grep -q '^wasm32-unknown-unknown$' || \
    rustup target add wasm32-unknown-unknown
  if (cd "$WGPU_WASM_DIR" && bash build.sh); then
    _touch_wasm_sentinel
    ok "wgpu wasm built — $WASM_ARTEFACT"
  else
    printf '\033[33m  ⚠ wgpu wasm build failed — preview engine will not start until fixed.\033[0m\n'
  fi
fi

# ─── 4. root workspaces bun install ───────────────────────────────────────
# 2026-05-24: root package.json#workspaces now covers all monorepo packages
# (packages/* + packages/build/engine-src + packages/engine/packages/*).
# A single root `bun install` resolves every workspace:*/hoisted dep in one
# pass — no more per-subrepo install_dir loop.
#
# 2026-05-21: dropped packages/cli — the forgeax cli daemon (:3700, docker-
# based instance provisioning) is fully superseded by forgeax-server's
# built-in cli-providers (claude-code / codex / cursor / forgeax). Skipping
# `bun install` here also avoids macOS users hitting the docker / sshfs
# postinstall toolchain that lived in packages/cli/.
bold "[4/6] Installing workspace dependencies"
bun_install_with_retry "$ROOT" || fail "root bun install failed"
ok "workspace dependencies resolved"

# ─── 5. plugin install + build ────────────────────────────────────────────
# Plugins under packages/marketplace/plugins/* with their own package.json
# need bun install + (if there's a build script) a vite build, since
# server's serveStatic mounts /plugins/<name>/* to the plugin's dist/.
# Without dist/, the iframe-hosted workbenches (wb-character) render blank.
# Stub plugins (admin / cli-* / wb-anim / etc.) have no package.json and
# are auto-skipped — the loop is generic so newly-shipped plugins just work.
bold "[5/6] Installing + building marketplace plugins"
if [ "$SKIP_PLUGINS" -eq 1 ]; then
  printf '  (skipped — --no-plugins)\n'
else
  for d in packages/marketplace/plugins/*/; do
    name="$(basename "$d")"
    [ "$name" = "_template" ] && continue
    [ -f "$d/package.json" ] || continue

    # Some plugins are their own pnpm workspaces (e.g. node-editor has
    # apps/*/frontend, apps/*/backend, packages/* nested under it).
    # `install_dir` uses bun which doesn't understand pnpm-workspace.yaml,
    # so run `pnpm install` instead for those.
    if [ -f "$d/pnpm-workspace.yaml" ]; then
      printf '  → pnpm install (%s pnpm workspace)\n' "$name"
      _pnpm_log="$(mktemp -t pnpm-install.XXXXXX)"
      # The `--no-frozen-lockfile` on the fallback is load-bearing in CI:
      # pnpm treats CI=true as "frozen-lockfile default ON", so a bare
      # `pnpm install` retry under GitHub Actions repeats the first
      # failure verbatim (surfaced 2026-06-16 on node-editor lockfile
      # drift vs apps/wb-2d-scene-asset-generator/frontend/package.json).
      if (cd "$d" && pnpm install --frozen-lockfile 2>"$_pnpm_log" || pnpm install --no-frozen-lockfile 2>>"$_pnpm_log"); then
        ok "$d  pnpm workspace installed"
      else
        # ERR_PNPM_IGNORED_BUILDS: pnpm 11 refuses to run unapproved
        # postinstall scripts (e.g. esbuild's). The fix lives inside the
        # plugin's package.json (add `pnpm.onlyBuiltDependencies: ["esbuild"]`)
        # and that's a marketplace-submodule change. Until that lands, point
        # the user at the workaround instead of failing silently.
        if grep -q 'ERR_PNPM_IGNORED_BUILDS' "$_pnpm_log"; then
          printf '\033[33m  ⚠ %s  pnpm 11 blocked esbuild postinstall (ERR_PNPM_IGNORED_BUILDS).\033[0m\n' "$d"
          printf '    Approve once with:  (cd %s && pnpm approve-builds)\n' "$d"
          printf '    or pin in the plugin %spackage.json:\n' "$d"
          printf '      "pnpm": { "onlyBuiltDependencies": ["esbuild"] }\n'
        else
          printf '\033[33m  ⚠ %s  pnpm install failed — continuing\033[0m\n' "$d"
        fi
      fi
      rm -f "$_pnpm_log"
    else
      install_dir "${d%/}"
    fi

    if node -e "try{const p=require('./${d%/}/package.json');process.exit(p.scripts&&p.scripts.build?0:1)}catch{process.exit(1)}"; then
      # Skip rebuild if dist/ is newer than src/ — cheap mtime check.
      if [ -d "${d}dist" ] && [ "${d}dist" -nt "${d}package.json" ]; then
        ok "$d  build cache fresh, skip"
      else
        printf '  → bun run build (%s)\n' "$d"
        (cd "$d" && bun run build)
        ok "$d  built"
      fi
    fi
  done
fi

# ─── 6. .env scaffold ─────────────────────────────────────────────────────
# Studio dev mode reads its .env at $ROOT/.env (2026-05-13 refactor — was
# packages/forgeax/.env). deploy.sh seeds from $ROOT/.env.example and
# interactively asks for the keys most plugins/providers need.
bold "[6/6] Configuring \$ROOT/.env"
ENV_FILE="$ROOT/.env"
ENV_EXAMPLE="$ROOT/.env.example"

# Helper: set or replace a KEY=value in $ENV_FILE. If the key already has
# a non-empty value, leave it. Only updates when the user supplies a value.
upsert_env() {
  local key="$1" val="$2"
  [ -z "$val" ] && return 0
  if grep -qE "^#?\s*${key}=" "$ENV_FILE"; then
    sed -i.bak -E "s|^#?\s*${key}=.*$|${key}=${val}|" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
  else
    printf '\n%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

# Migrate legacy location if needed.
if [ ! -f "$ENV_FILE" ] && [ -f packages/forgeax/.env ]; then
  cp packages/forgeax/.env "$ENV_FILE"
  ok "migrated legacy packages/forgeax/.env → \$ROOT/.env"
fi

if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  ok "created \$ROOT/.env from .env.example"
fi

# Required: ANTHROPIC_API_KEY.
# In default (non-interactive) mode we don't `read` — just warn and move on.
# The user edits .env (or the Studio Settings drawer) before first chat.
if ! grep -qE '^ANTHROPIC_API_KEY=.+' "$ENV_FILE"; then
  if [ "$INTERACTIVE" = "1" ] && [ -t 0 ]; then
    printf '\n  ANTHROPIC_API_KEY is required (https://console.anthropic.com,\n'
    printf '  or any Anthropic-compatible proxy key — e.g. LiteLLM / forgeax-llm-proxy).\n'
    printf '  Paste it now, or press Enter to fill in manually later: '
    read -r KEY
    upsert_env ANTHROPIC_API_KEY "$KEY"
    if [ -n "$KEY" ]; then
      ok "ANTHROPIC_API_KEY set"
    else
      printf '  (skipped — edit %s before scripts/dev.sh)\n' "$ENV_FILE"
    fi
  else
    printf '\033[33m  ⚠ ANTHROPIC_API_KEY not set in %s\033[0m\n' "$ENV_FILE"
    printf '    edit it before chatting in Studio, or paste in Studio Settings drawer.\n'
    printf '    (Re-run with --interactive to be prompted here.)\n'
  fi
else
  ok "ANTHROPIC_API_KEY already set"
fi

# Optional but common: ANTHROPIC_BASE_URL (proxy) — paired with the key above.
if ! grep -qE '^ANTHROPIC_BASE_URL=.+' "$ENV_FILE" && [ "$INTERACTIVE" = "1" ] && [ -t 0 ] && [ "${FORGEAX_DEPLOY_NO_PROMPT_OPTIONAL:-}" != "1" ]; then
  printf '  ANTHROPIC_BASE_URL (Enter for direct anthropic.com, or paste proxy URL\n'
  printf '    e.g. https://your-litellm-proxy.example.com): '
  read -r BASE
  upsert_env ANTHROPIC_BASE_URL "$BASE"
fi

# Optional: multimodal + extra cli-provider keys.
if [ "$INTERACTIVE" = "1" ] && [ -t 0 ] && [ "${FORGEAX_DEPLOY_NO_PROMPT_OPTIONAL:-}" != "1" ]; then
  printf '\n  Optional keys (Enter to skip — can also set in Studio Settings drawer later):\n'
  printf '    OPENAI_API_KEY (codex cli-provider): '            ; read -r K; upsert_env OPENAI_API_KEY            "$K"
  printf '    GEMINI_API_KEY (sprite + 备立绘): '              ; read -r K; upsert_env GEMINI_API_KEY            "$K"
  printf '    ARK_IMAGE_KEY  (Seedream 主立绘): '              ; read -r K; upsert_env ARK_IMAGE_KEY             "$K"
  printf '    ARK_VIDEO_KEY  (Seedance · wb-cinematic): '      ; read -r K; upsert_env ARK_VIDEO_KEY             "$K"
  printf '    AZURE_GPT_IMAGE_KEY (备 sprite): '               ; read -r K; upsert_env AZURE_GPT_IMAGE_KEY       "$K"
  if [ -n "${K:-}" ]; then
    printf '    AZURE_GPT_IMAGE_ENDPOINT (https://…openai.azure.com): '
    read -r K; upsert_env AZURE_GPT_IMAGE_ENDPOINT "$K"
    printf '    AZURE_GPT_IMAGE_DEPLOYMENT (e.g. gpt-image-1): '
    read -r K; upsert_env AZURE_GPT_IMAGE_DEPLOYMENT "$K"
  fi
  printf '    LITELLM_PROXY_KEY (multi-model proxy): '     ; read -r K; upsert_env LITELLM_PROXY_KEY         "$K"
  if [ -n "${K:-}" ]; then
    printf '    LITELLM_PROXY_BASE_URL (e.g. https://your-litellm-proxy.example.com/v1): '
    read -r K; upsert_env LITELLM_PROXY_BASE_URL "${K}"
  fi
  printf '\n'
fi

# ─── 7. seed sample games into .forgeax/games/ ────────────────────────────
# Studio's listAllGames scans <projectRoot>/.forgeax/games/ only — that's
# instance-local working copies, gitignored. The shared sample library lives
# at packages/games/ (the forgeax-games submodule) and ships with the repo.
# This step copies each sample into .forgeax/games/<slug>/ on first deploy
# so a fresh clone has playable demos in the game dropdown out of the box.
#
# Idempotent: a sample whose target already exists is left alone — the user
# may have edited it. Symlinks would be tighter but break the "clone the
# sample, edit your copy" UX every Studio template flow assumes.
echo
bold "[7/7] Seeding sample games to .forgeax/games/"
GAMES_SRC="$ROOT/packages/games"
GAMES_DST="$ROOT/.forgeax/games"
mkdir -p "$GAMES_DST"
if [ -d "$GAMES_SRC" ]; then
  seeded=0
  skipped=0
  for sample in "$GAMES_SRC"/*/; do
    [ -d "$sample" ] || continue
    slug="$(basename "$sample")"
    # Skip non-game dirs (top-level README etc.) — game dirs always carry forge.json.
    [ -f "$sample/forge.json" ] || continue
    target="$GAMES_DST/$slug"
    if [ -e "$target" ]; then
      skipped=$((skipped+1))
      continue
    fi
    # rsync excludes node_modules / .forgeax (build / runtime state that the
    # source dir shouldn't carry but we filter just in case).
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --exclude='node_modules' --exclude='.forgeax' "$sample" "$target/"
    else
      cp -R "$sample" "$target"
      rm -rf "$target/node_modules" "$target/.forgeax" 2>/dev/null || true
    fi
    printf '  + seeded %s\n' "$slug"
    seeded=$((seeded+1))
  done
  ok "sample games: $seeded seeded, $skipped already present"
else
  printf '  → packages/games not found (skipped)\n'
fi

# ─── done ──────────────────────────────────────────────────────────────────
echo
bold "Deploy complete."
echo
echo "Next:"
echo "  bash scripts/dev.sh                 # start 3-service dev stack"
echo "  bash scripts/build.sh release       # synthesize + publish to packages/forgeax/{server,interface,engine,harness}/"
echo
echo "Endpoints once scripts/dev.sh is running:"
echo "  http://localhost:18920      Studio UI"
echo "  http://localhost:18900      Server (HTTP + SSE)"
echo "  http://localhost:15173      Engine renderer"

if [ "$START" -eq 1 ]; then
  echo
  bold "[start] Launching dev stack…"
  exec bash "$SCRIPT_DIR/dev.sh"
fi
