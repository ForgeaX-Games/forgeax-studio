#!/usr/bin/env bash
# forgeax-studio — open Studio in Chrome with WebGPU reliably enabled.
#
#   bash web.sh        # (top-level shell → this script)
#   bash scripts/open-web.sh
#
# Why a dedicated launcher: the engine renders the editor/preview viewport via
# WebGPU. On a browser where WebGPU isn't enabled-by-default (or the GPU is
# blocklisted), `createApp` fails with "no usable backend". Two traps make this
# hard to fix by hand:
#   1. Chrome ignores `--args` flags when a process for that profile is ALREADY
#      running — so passing --enable-unsafe-webgpu to your everyday Chrome does
#      nothing unless you fully quit it first.
#   2. The flag alone doesn't bypass the GPU blocklist.
# So we launch Chrome on a DEDICATED persistent profile (flags always apply)
# with --enable-unsafe-webgpu + --ignore-gpu-blocklist. The desktop app
# (`bash app.sh`, WebKit/Metal) already has WebGPU and is unaffected.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

# Load .env if present so FORGEAX_INTERFACE_PORT overrides are honoured.
[ -f "$ROOT/.env" ] && { set -a; # shellcheck disable=SC1091
  . "$ROOT/.env"; set +a; }

PORT="${FORGEAX_INTERFACE_PORT:-18920}"
URL="http://localhost:${PORT}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE="$ROOT/.forgeax/chrome-webgpu-profile"   # .forgeax/ is gitignored

port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# 1. stack must be running (web.sh opens a client; it does not boot the server).
if ! port_up "$PORT"; then
  echo "[web] Studio UI (:$PORT) is not up." >&2
  echo "[web]   start the stack first:  bash start.sh      (or: bash app.sh)" >&2
  exit 1
fi

# 2. Chrome must be installed at the standard macOS path.
if [ ! -x "$CHROME" ]; then
  echo "[web] Google Chrome not found at:" >&2
  echo "[web]   $CHROME" >&2
  echo "[web] Install Chrome, or open $URL in a WebGPU-capable browser yourself." >&2
  echo "[web] (The desktop app works without Chrome: bash app.sh)" >&2
  exit 1
fi

mkdir -p "$PROFILE"
echo "[web] launching Chrome (WebGPU forced) → $URL"
echo "[web]   profile: ${PROFILE#"$ROOT"/}   flags: --enable-unsafe-webgpu --ignore-gpu-blocklist"
echo "[web]"
echo "[web] If the viewport still shows 'no usable backend': your GPU acceleration"
echo "[web]   is off, or this is a VM / remote-desktop session (no GPU adapter)."
echo "[web]   Open chrome://gpu and check 'WebGPU' + 'Graphics Feature Status'."
echo "[web]   The desktop app (bash app.sh, WebKit/Metal) renders fine regardless."

# exec the binary directly (NOT `open`, which would attach to an existing
# instance and drop the flags). Background it so this shell returns; Chrome
# keeps running. A dedicated --user-data-dir guarantees the flags take effect.
"$CHROME" \
  --user-data-dir="$PROFILE" \
  --enable-unsafe-webgpu \
  --ignore-gpu-blocklist \
  --no-first-run \
  --no-default-browser-check \
  "$URL" >/dev/null 2>&1 &

echo "[web] Chrome launched (pid $!)."
