#!/usr/bin/env bash
# Stop the forgeax-studio dev stack started by scripts/run.sh.
#
# Post-2026-05-21 architecture: the stack is forgeax-server :18900,
# interface vite :18920, engine vite :15173, optionally wb-narrative
# :8900. Discovery is port-first; we kill whichever PID owns the LISTEN
# socket on each port.
#
# Cross-platform port discovery: lsof on macOS / Linux, netstat -ano +
# powershell on Windows git-bash (where lsof is typically unavailable).
# Without a working discovery tool we exit 1 with a clear message instead
# of silently reporting "nothing to kill" — that previously masked stale
# PIDs and caused "port already in use" on the next run.sh.
#
# Default escalation: SIGTERM → 4s grace → SIGKILL (auto). Pass --no-force
# to revert to the old behavior (warn + exit 1 if anything remains alive
# after 4s; lets you decide how to escalate). --force is accepted as a
# backward-compat alias for the now-default behavior.
#
# After kills, we poll each port for up to 2s waiting for the socket to
# actually release — kernel TIME_WAIT can keep a port "busy" briefly
# even after the owning process exits. Without this poll the immediate
# follow-up `bash scripts/run.sh` would race and report port-in-use.
#
# Compatibility: macOS ships bash 3.2 — no associative arrays. We use
# parallel indexed arrays + a tiny lookup function instead.
#
# Flags:
#   --force, -f   Backward-compat alias (no-op; auto-escalation is now
#                 the default).
#   --no-force    Refuse to escalate to SIGKILL; warn + exit 1 instead
#                 if anything remains alive after the 4s SIGTERM grace.
#                 Useful when you want manual control over kill -9.
#
# Exit codes:
#   0  clean teardown (or nothing was running)
#   1  --no-force was set and stragglers remain after SIGTERM,
#      OR no portable port-discovery tool available,
#      OR ports remain bound after kill + 2s release-poll
#   2  bad CLI args

set -euo pipefail

FORCE=1
PURGE_VITE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force|-f) FORCE=1 ;;
    --no-force) FORCE=0 ;;
    --purge-vite) PURGE_VITE=1 ;;
    -h|--help)
      sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "[stop.sh] unknown arg: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_STACK_FILE="$ROOT/.forgeax/dev-stack.env"

# Orchestration libs (ports SSOT + process-group enumerate-reap + vite cache).
FX_ROOT="$ROOT"
# shellcheck source=lib/ports.sh
. "$SCRIPT_DIR/lib/ports.sh"
# shellcheck source=lib/process-group.sh
. "$SCRIPT_DIR/lib/process-group.sh"
# shellcheck source=lib/vite-cache-guard.sh
. "$SCRIPT_DIR/lib/vite-cache-guard.sh"

if [ -f "$RUN_STACK_FILE" ]; then
  # shellcheck disable=SC1090
  source "$RUN_STACK_FILE"
fi

# Dynamic plugin ports: read plugin-dev-ports.json as a SECOND fallback source
# (beyond dev-stack.env's FORGEAX_RUN_PORTS), since dev-stack.env may be absent
# or stale after a crash (F1). Both frontend + backend ports are recorded there.
PLUGIN_DEV_PORTS_JSON="$ROOT/.forgeax/plugin-dev-ports.json"
DYNAMIC_PLUGIN_PORTS=""
if [ -f "$PLUGIN_DEV_PORTS_JSON" ] && command -v node >/dev/null 2>&1; then
  DYNAMIC_PLUGIN_PORTS="$(node -e '
    try {
      const j=require(process.argv[1]); const out=[];
      for(const k of Object.keys(j.plugins||{})){
        const p=j.plugins[k];
        if(p.frontendPort) out.push(p.frontendPort);
        if(p.backendPort)  out.push(p.backendPort);
      }
      process.stdout.write(out.join(" "));
    } catch {}
  ' "$PLUGIN_DEV_PORTS_JSON" 2>/dev/null || true)"
fi

# ── port → service map (parallel arrays) ──
# Only the FIXED studio services are listed here. Standalone-backend workbench
# plugins (e.g. node-editor apps) use dynamically-allocated ports — those are
# the SSOT in dev-stack.env (FORGEAX_RUN_PORTS, appended below) and are also
# killed by PID (FORGEAX_RUN_PIDS). No plugin ports are hardcoded here.
# Fixed ports come from the SSOT (scripts/lib/ports.sh) — this is what finally
# includes face-mask :18930, which the old hardcoded 5-port table dropped (F1).
PORTS=("${FX_FIXED_PORTS[@]}")
SVCS=("${FX_FIXED_SVCS[@]}")
append_runtime_port() {
  local port="$1"
  [ -n "$port" ] || return 0
  for existing in "${PORTS[@]}"; do
    [ "$existing" = "$port" ] && return 0
  done
  PORTS+=("$port")
  SVCS+=("runtime    (run.sh-managed dynamic service)")
}
# Dynamic plugin ports from BOTH sources (dev-stack.env may be stale/missing →
# plugin-dev-ports.json as fallback). append_runtime_port de-dups.
for runtime_port in ${FORGEAX_RUN_PORTS:-} ${DYNAMIC_PLUGIN_PORTS:-}; do
  append_runtime_port "$runtime_port"
done

START_TS=$SECONDS

# ── portable LISTEN-pid discovery ─────────────────────────────────────
# Pick the first available tool: lsof (mac/linux), ss (linux), netstat
# (windows git-bash). Each prints a single pid per line for the given
# port; we de-dup at the call site.
DISCOVERY_TOOL=""
if command -v lsof >/dev/null 2>&1; then
  DISCOVERY_TOOL="lsof"
elif command -v ss >/dev/null 2>&1; then
  DISCOVERY_TOOL="ss"
elif command -v netstat >/dev/null 2>&1; then
  # Windows netstat (git-bash, MSYS, cmd-via-bash) supports -ano with
  # PID column. macOS netstat does NOT — that's why lsof is preferred
  # above. We only reach this branch on Windows or stripped Linux.
  DISCOVERY_TOOL="netstat"
fi

if [ -z "$DISCOVERY_TOOL" ]; then
  echo "[stop.sh] ERROR: no port-discovery tool found (need lsof, ss, or netstat)." >&2
  echo "  - macOS / Linux: install lsof (brew install lsof / apt install lsof)" >&2
  echo "  - Windows git-bash: netstat should be on PATH; if missing, run from cmd or PowerShell" >&2
  exit 1
fi

# find_listen_pids <port> → 0+ pids (one per line) on stdout
find_listen_pids() {
  local port="$1"
  case "$DISCOVERY_TOOL" in
    lsof)
      lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null
      ;;
    ss)
      # ss output for `ss -tlnp` looks like:
      #   LISTEN 0 511 *:18900 *:* users:(("bun",pid=12345,fd=42))
      # extract pid= when sport == :<port>
      ss -tlnp 2>/dev/null \
        | awk -v p=":$port" '$4 ~ p":" || $4 ~ p"$" { print }' \
        | grep -oE 'pid=[0-9]+' \
        | cut -d= -f2 \
        | sort -u
      ;;
    netstat)
      # Windows: `netstat -ano | findstr LISTENING | findstr :PORT` →
      #   TCP    0.0.0.0:18900    0.0.0.0:0    LISTENING    12345
      # Last column is PID. Match :PORT exactly with trailing space to
      # avoid 18900 matching :189000.
      netstat -ano 2>/dev/null \
        | awk -v p=":$port " '$0 ~ p && $0 ~ /LISTEN/ { sub(/\r$/, "", $NF); print $NF }' \
        | sort -u
      ;;
  esac
}

# Liveness check is now the platform-aware fx_pid_alive (scripts/lib/process-group.sh,
# sourced above) — `kill -0` on POSIX, `tasklist` by WINPID on Windows. Kept as a
# thin alias so existing call sites read naturally.
is_pid_alive() { fx_pid_alive "$1"; }

# pid_cmd <pid> → human-readable command/name (or empty). Cosmetic only.
# MSYS `ps` rejects `-o`, so on Windows ask tasklist for the image name by pid;
# elsewhere use `ps -o command=`. Trailing `|| true` keeps it safe under set -e.
pid_cmd() {
  if [ "$FX_OS" = "win" ]; then
    # CSV format → first field is the image name. /NH drops the header (valid for
    # CSV/TABLE, not LIST). Single-slash + MSYS_NO_PATHCONV, same as taskkill.
    MSYS_NO_PATHCONV=1 tasklist /FI "PID eq $(fx_winpid "$1")" /NH /FO CSV 2>/dev/null \
      | awk -F'","' 'NR==1{gsub(/"/,"",$1); print $1; exit}' || true
  else
    ps -p "$1" -o command= 2>/dev/null | sed 's/^[[:space:]]*//' || true
  fi
}

# is_port_listening <port> → 0 if anything LISTENs on it
is_port_listening() {
  [ -n "$(find_listen_pids "$1")" ]
}

# Process teardown is delegated to the platform-aware fx_pg_kill SSOT primitive
# (scripts/lib/process-group.sh, sourced above): POSIX process-group kill
# (`kill -- -PGID`, reaping watcher grandchildren) on mac/linux, `taskkill //T //F`
# on Windows. SELF_PGID is still computed here for the layer-3 pgrep guard below,
# so we never target stop.sh's own process group.
SELF_PGID="$(fx_pgid_raw $$)"

echo "[stop.sh] scanning forgeax-studio dev stack (discovery=$DISCOVERY_TOOL):"
for i in "${!PORTS[@]}"; do
  printf "  :%-5s  %s\n" "${PORTS[$i]}" "${SVCS[$i]}"
done
echo

# ── discover LISTEN pids per port ─────────────────────────────────────
PIDS=()
PID_PORTS=()
SEEN_PIDS=" "
for port in "${PORTS[@]}"; do
  for pid in $(find_listen_pids "$port"); do
    case "$SEEN_PIDS" in
      *" $pid "*) ;;
      *)
        PIDS+=("$pid")
        PID_PORTS+=("$port")
        SEEN_PIDS="$SEEN_PIDS$pid "
        ;;
    esac
  done
done
for pid in ${FORGEAX_RUN_PIDS:-}; do
  [ -n "$pid" ] || continue
  if is_pid_alive "$pid"; then
    case "$SEEN_PIDS" in
      *" $pid "*) ;;
      *)
        PIDS+=("$pid")
        PID_PORTS+=("dev-stack.env")
        SEEN_PIDS="$SEEN_PIDS$pid "
        ;;
    esac
  fi
done

# Layer 1 (most reliable): pidfiles in .forgeax/run/ recorded by run.sh as each
# service started. Covers editor / face-mask / plugins even when dev-stack.env
# is missing/stale and the port has already drifted (F1 core fix).
if [ -d "$FX_RUN_DIR" ]; then
  for f in "$FX_RUN_DIR"/*.pid; do
    [ -e "$f" ] || continue
    read -r pid _ < "$f" 2>/dev/null || continue
    [ -n "$pid" ] || continue
    is_pid_alive "$pid" || continue
    case "$SEEN_PIDS" in
      *" $pid "*) ;;
      *)
        PIDS+=("$pid")
        PID_PORTS+=("pidfile:$(basename "${f%.pid}")")
        SEEN_PIDS="$SEEN_PIDS$pid "
        ;;
    esac
  done
fi

# Layer 3 (feature fallback): pgrep -f for known stack signatures whose port has
# drifted AND whose pidfile/env entry was lost. Excludes our own process group so
# stop.sh never targets itself. Matches the forgeax-studio working tree only.
if command -v pgrep >/dev/null 2>&1; then
  _root_re="$(printf '%s' "$ROOT" | sed 's/[].[*^$/]/\\&/g')"
  for _sig in \
    "$_root_re/packages/server.*bun.*src/main.ts" \
    "$_root_re/packages/.*vite" \
    "$_root_re/packages/editor/packages/.*vite" \
    "$_root_re/packages/marketplace/plugins/.*vite" \
    "$_root_re/packages/marketplace/plugins/.*tsx.*main.ts" \
    "$_root_re/packages/marketplace/plugins/wb-reel/server/face_mask" \
    "$_root_re/packages/marketplace/plugins/.*headless-renderer.mjs"; do
    for pid in $(pgrep -f "$_sig" 2>/dev/null); do
      [ -n "$pid" ] || continue
      [ "$pid" = "$$" ] && continue
      # never include a pid in our own process group (the shell + node helpers)
      _g="$(fx_pgid_raw "$pid")"
      [ -n "$_g" ] && [ "$_g" = "$SELF_PGID" ] && continue
      case "$SEEN_PIDS" in
        *" $pid "*) ;;
        *)
          PIDS+=("$pid")
          PID_PORTS+=("pgrep")
          SEEN_PIDS="$SEEN_PIDS$pid "
          ;;
      esac
    done
  done
fi

if [ ${#PIDS[@]} -eq 0 ]; then
  echo "[stop.sh] nothing to kill — all ports already free."
  rm -f "$RUN_STACK_FILE" "$PLUGIN_DEV_PORTS_JSON"
  [ -n "${FORGEAX_PLUGIN_DEV_PORTS_FILE:-}" ] && rm -f "$FORGEAX_PLUGIN_DEV_PORTS_FILE"
  fx_pg_clear
  rm -rf "$ROOT/.forgeax/run.lock" 2>/dev/null || true
  [ "$PURGE_VITE" = "1" ] && fx_vite_purge_all
  exit 0
fi

# ── report what we found ──────────────────────────────────────────────
echo "[stop.sh] found ${#PIDS[@]} listener(s):"
for i in "${!PIDS[@]}"; do
  pid="${PIDS[$i]}"
  port="${PID_PORTS[$i]}"
  cmd="$(pid_cmd "$pid")"
  printf "  :%-5s  pid %-7s  %s\n" "$port" "$pid" "${cmd:-<gone>}"
done
echo

# ── SIGTERM + live wait ───────────────────────────────────────────────
echo "[stop.sh] sending SIGTERM to process groups, waiting up to 4s for graceful exit..."
for pid in "${PIDS[@]}"; do fx_pg_kill TERM "$pid"; done

REPORTED=()
for _ in "${PIDS[@]}"; do REPORTED+=(0); done

STILL_PIDS=()
STILL_PORTS=()
for _tick in 1 2 3 4 5 6 7 8; do
  STILL_PIDS=()
  STILL_PORTS=()
  for i in "${!PIDS[@]}"; do
    pid="${PIDS[$i]}"
    if is_pid_alive "$pid"; then
      STILL_PIDS+=("$pid")
      STILL_PORTS+=("${PID_PORTS[$i]}")
    elif [ "${REPORTED[$i]}" = "0" ]; then
      printf "  ✓ pid %-7s (:%s) exited\n" "$pid" "${PID_PORTS[$i]}"
      REPORTED[$i]=1
    fi
  done
  [ ${#STILL_PIDS[@]} -eq 0 ] && break
  sleep 0.5
done

# ── auto-escalate to SIGKILL (default) or warn (--no-force) ──────────
if [ ${#STILL_PIDS[@]} -gt 0 ]; then
  echo
  if [ "$FORCE" = "1" ]; then
    echo "[stop.sh] grace period elapsed — escalating to SIGKILL on ${#STILL_PIDS[@]} straggler(s):"
    for j in "${!STILL_PIDS[@]}"; do
      printf "  ☠ pid %-7s (:%s)\n" "${STILL_PIDS[$j]}" "${STILL_PORTS[$j]}"
      fx_pg_kill KILL "${STILL_PIDS[$j]}"
    done
    sleep 1
  else
    echo "[stop.sh] WARNING (--no-force): ${#STILL_PIDS[@]} process(es) still alive after SIGTERM (4s):" >&2
    for j in "${!STILL_PIDS[@]}"; do
      pid="${STILL_PIDS[$j]}"
      cmd="$(pid_cmd "$pid")"
      printf "  ✗ pid %-7s (:%s)  %s\n" "$pid" "${STILL_PORTS[$j]}" "${cmd:-<gone>}" >&2
    done
    echo >&2
    echo "[stop.sh] drop --no-force to auto-SIGKILL, or kill them manually:" >&2
    for pid in "${STILL_PIDS[@]}"; do
      echo "    kill -9 $pid" >&2
    done
    exit 1
  fi
fi

# ── Wait for socket release (kernel TIME_WAIT) ────────────────────────
# Even after the owning process exits, the kernel may keep the port in
# TIME_WAIT for a brief window. Poll for up to ~5s (F6: bun --watch / vite don't
# set SO_REUSEADDR, so 2s could leave server :18900 still bound → next run.sh
# misfires "port already in use") on real LISTEN state.
for _tick in $(seq 1 10); do
  ANY_BUSY=0
  for port in "${PORTS[@]}"; do
    if is_port_listening "$port"; then ANY_BUSY=1; break; fi
  done
  [ "$ANY_BUSY" = "0" ] && break
  sleep 0.5
done

# ── final port verification ───────────────────────────────────────────
echo
echo "[stop.sh] final port state:"
ANY_BUSY=0
for i in "${!PORTS[@]}"; do
  port="${PORTS[$i]}"
  svc="${SVCS[$i]}"
  if is_port_listening "$port"; then
    printf "  ✗ :%-5s  %s  STILL BUSY\n" "$port" "$svc" >&2
    ANY_BUSY=1
  else
    printf "  ✓ :%-5s  %s\n" "$port" "$svc"
  fi
done

ELAPSED=$(( SECONDS - START_TS ))
if [ "$ANY_BUSY" = "1" ]; then
  echo "[stop.sh] done in ${ELAPSED}s — but some ports remain bound (see above)" >&2
  exit 1
fi
rm -f "$RUN_STACK_FILE" "$PLUGIN_DEV_PORTS_JSON"
[ -n "${FORGEAX_PLUGIN_DEV_PORTS_FILE:-}" ] && rm -f "$FORGEAX_PLUGIN_DEV_PORTS_FILE"
fx_pg_clear
rm -rf "$ROOT/.forgeax/run.lock" 2>/dev/null || true
if [ "$PURGE_VITE" = "1" ]; then
  echo "[stop.sh] --purge-vite: clearing all vite optimizeDeps caches"
  fx_vite_purge_all
fi
echo "[stop.sh] done in ${ELAPSED}s — stack is down, safe to run scripts/run.sh"
