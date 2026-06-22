#!/usr/bin/env bash
# scripts/lib/ports.sh — single source of truth for the FIXED studio ports.
#
# Both run.sh (preflight / launch) and stop.sh (teardown) source this file so a
# port is declared exactly once. Dynamic plugin ports (node-editor apps, reel,
# etc.) are NOT here — they are allocated at launch and recorded in
# .forgeax/dev-stack.env (FORGEAX_RUN_PORTS) + .forgeax/plugin-dev-ports.json,
# which stop.sh reads as the dynamic-port source. See perf doc 08 §PortRegistry.
#
# Every value honours an env override so the three run formats (web-dev /
# desktop-dev / desktop-prod) can re-point ports without editing this file.
#
# IMPORTANT: this file is `source`d, not executed — no `set -e`, no side effects.

FX_PORT_SERVER="${FORGEAX_SERVER_PORT:-18900}"
FX_PORT_INTERFACE="${FORGEAX_INTERFACE_PORT:-18920}"
FX_PORT_ENGINE="${FORGEAX_ENGINE_PORT:-15173}"
FX_PORT_EDITOR="${FORGEAX_EDITOR_PORT:-15280}"
FX_PORT_NARRATIVE="${NARRATIVE_PORT:-8900}"
FX_PORT_FACEMASK="${FACE_MASK_PORT:-18930}"

# Fixed ports that stop.sh must always sweep, even when dev-stack.env is missing
# (the F1 root cause: face-mask :18930 + editor :15280 were never in the table /
# trap). Order mirrors FX_FIXED_SVCS below for the stop.sh report.
FX_FIXED_PORTS=(
  "$FX_PORT_SERVER"
  "$FX_PORT_INTERFACE"
  "$FX_PORT_ENGINE"
  "$FX_PORT_EDITOR"
  "$FX_PORT_NARRATIVE"
  "$FX_PORT_FACEMASK"
)
FX_FIXED_SVCS=(
  "server     (forgeax-server / bun --watch)"
  "interface  (vite)"
  "engine     (vite — engine-src / play-runtime)"
  "editor     (vite — edit-runtime / Edit mode)"
  "narrative  (wb-narrative API · optional)"
  "face-mask  (wb-reel python sidecar · optional)"
)
