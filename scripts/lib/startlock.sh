#!/usr/bin/env bash
# scripts/lib/startlock.sh — macOS-compatible atomic start lock.
#
# F3: run.sh / start.sh have no concurrency guard. Two starts race the TOCTOU
# window between port preflight and the actual vite bind; every vite uses
# strictPort:true, so the loser dies EADDRINUSE with half the stack already up.
#
# flock is NOT available on stock macOS (the main dev platform), so we use a
# `mkdir` lock — POSIX guarantees mkdir is atomic / fails if the dir exists.
# A stale lock whose owner is dead is reclaimed automatically. See perf doc 08
# §StartLock.
#
# This file is `source`d. Caller sets FX_ROOT. fx_startlock_acquire installs an
# EXIT/INT/TERM trap that releases the lock; callers that already have their own
# cleanup trap should call fx_startlock_release from inside it instead and pass
# `notrap` as the 1st arg to acquire.

if [ -z "${FX_ROOT:-}" ]; then
  _sl_self="${BASH_SOURCE[0]}"
  FX_ROOT="$(cd "$(dirname "$_sl_self")/../.." && pwd)"
fi
FX_LOCK_DIR="$FX_ROOT/.forgeax/run.lock"
FX_STARTLOCK_HELD=0

fx_startlock_release() {
  [ "$FX_STARTLOCK_HELD" = "1" ] || return 0
  rm -rf "$FX_LOCK_DIR" 2>/dev/null || true
  FX_STARTLOCK_HELD=0
}

# fx_startlock_acquire [notrap] — acquire the lock or exit 1 with a friendly
# message. Pass "notrap" if the caller manages its own cleanup trap (run.sh
# does — it folds fx_startlock_release into _run_sh_cleanup).
fx_startlock_acquire() {
  local notrap="${1:-}"
  mkdir -p "$FX_ROOT/.forgeax"
  if ! mkdir "$FX_LOCK_DIR" 2>/dev/null; then
    local pid=""
    [ -f "$FX_LOCK_DIR/pid" ] && pid="$(cat "$FX_LOCK_DIR/pid" 2>/dev/null)"
    if [ -n "$pid" ]; then
      local is_alive=0
      if [[ "$OSTYPE" == "msys"* || "$OSTYPE" == "cygwin"* ]]; then
        tasklist /FI "PID eq $pid" 2>/dev/null | grep -q "$pid" && is_alive=1
      else
        kill -0 "$pid" 2>/dev/null && is_alive=1
      fi

      if [ "$is_alive" = "1" ]; then
      echo "  ✗ another run.sh is already starting the stack (pid $pid)." >&2
      echo "    Refusing to start a second time — that would crash half the stack" >&2
      echo "    on strictPort EADDRINUSE. Wait for it, or: bash scripts/stop.sh --force" >&2
      exit 1
    fi
    # Stale lock — previous holder is gone. Reclaim it.
    echo "  · reclaiming stale start lock (holder pid ${pid:-?} is dead)" >&2
    rm -rf "$FX_LOCK_DIR" 2>/dev/null || true
    if ! mkdir "$FX_LOCK_DIR" 2>/dev/null; then
      echo "  ✗ could not acquire start lock at $FX_LOCK_DIR" >&2
      exit 1
    fi
  fi
  echo $$ > "$FX_LOCK_DIR/pid"
  FX_STARTLOCK_HELD=1
  [ "$notrap" = "notrap" ] || trap fx_startlock_release EXIT INT TERM
}
