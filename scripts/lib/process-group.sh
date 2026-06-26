#!/usr/bin/env bash
# scripts/lib/process-group.sh — deterministic pid/pgid bookkeeping + reaping.
#
# Sourced by run.sh (writes pidfiles, trap reaps) and stop.sh (enumerate reap).
# Replaces the three half-complete teardown paths (volatile dev-stack.env +
# incomplete hardcoded port table + trap that forgot $ED/$FACE_MASK) with one
# enumerable source: per-service pidfiles under .forgeax/run/. See perf doc 08
# §ProcessGroup.
#
# Each pidfile holds: "<pid> <pgid>" on one line. Services are launched under
# `set -m`, so each `&` job is its own process-group leader ($! == PGID); a
# negative kill argument reaps the whole watcher tree (pnpm → vite + tsx --watch).
#
# This file is `source`d — no `set -e`, no side effects beyond defining funcs +
# FX_RUN_DIR.

# .forgeax/run/ — enumerable pidfile dir. FX_ROOT must be set by the caller
# (run.sh / stop.sh both define ROOT); fall back to deriving it.
if [ -z "${FX_ROOT:-}" ]; then
  _pg_self="${BASH_SOURCE[0]}"
  FX_ROOT="$(cd "$(dirname "$_pg_self")/../.." && pwd)"
fi
FX_RUN_DIR="$FX_ROOT/.forgeax/run"

# Platform dispatch. Process teardown differs fundamentally per OS: mac/linux use
# POSIX process groups (`kill -SIG -- -PGID`); Windows git-bash/MSYS has no POSIX
# groups and its `kill` can't reliably signal native bun.exe/node.exe, so it must
# shell out to `taskkill`. Detected once; consumed by fx_pg_kill / fx_pid_alive.
case "${OSTYPE:-}" in
  msys*|cygwin*|win32*) FX_OS="win" ;;
  darwin*)              FX_OS="mac" ;;
  *)                    FX_OS="linux" ;;
esac

# fx_winpid <pid> — Windows only: map an MSYS pid (what `$!` and pidfiles record)
# to its native WINPID (what taskkill / tasklist require). git-bash `ps` exposes
# WINPID as column 4. A pid absent from the MSYS table (e.g. a WINPID already
# discovered via `netstat -ano`) won't match → echo it back unchanged, so callers
# can pass either pid flavor and get the right Windows pid out.
fx_winpid() {
  local w
  w="$(ps -p "$1" 2>/dev/null | awk 'NR==2{print $4}')"
  printf '%s' "${w:-$1}"
}

# fx_pgid_raw <pid> → the pid's POSIX process-group id (mac/linux). Empty on
# Windows: there are no POSIX process groups there, AND MSYS `ps` does not accept
# `-o` (`ps: unknown option -- o`) — under a caller's `set -euo pipefail` that
# failed command substitution would silently abort the whole script. Always
# returns 0, so it is safe inside `VAR=$(fx_pgid_raw ...)` under set -e/pipefail.
fx_pgid_raw() {
  [ "$FX_OS" = "win" ] && return 0
  ps -o pgid= -p "$1" 2>/dev/null | tr -d ' ' || true
}

# fx_pg_self_pgid — our own process group, so we never group-kill ourselves.
fx_pg_self_pgid() { fx_pgid_raw $$; }

# fx_pgid_of <pid> → the pid's process group, but never our own (empty if same).
fx_pgid_of() {
  local g self
  self="$(fx_pg_self_pgid)"
  g="$(fx_pgid_raw "$1")"
  [ -n "$g" ] && [ "$g" != "$self" ] && printf '%s' "$g"
}

# fx_pg_record <name> <pid> — atomically write .forgeax/run/<name>.pid the moment
# a service is backgrounded (fixes F1's "wrote dev-stack.env only after ALL jobs
# started, so an early crash lost every reaping clue"). mv = atomic rename.
fx_pg_record() {
  local name="$1" pid="$2" pgid tmp
  [ -n "$pid" ] || return 0
  mkdir -p "$FX_RUN_DIR"
  pgid="$(fx_pgid_raw "$pid")"
  tmp="$FX_RUN_DIR/.$name.pid.$$"
  printf '%s %s\n' "$pid" "${pgid:-$pid}" > "$tmp" && mv -f "$tmp" "$FX_RUN_DIR/$name.pid"
}

# fx_pg_kill <SIG> <pid> [pgid] — terminate a service AND its whole child tree
# using each platform's native mechanism. Idempotent. This is the single SSOT
# kill primitive: run.sh's trap and stop.sh (all layers) route through here.
#
#   POSIX (mac/linux): services launch under `set -m`, so each is its own
#     process-group leader; `kill -SIG -- -PGID` reaps the watcher grandchildren
#     (pnpm → vite / tsx --watch) too. Bare-pid kill is the fallback for
#     non-grouped / legacy stacks.
#   Windows (MSYS/git-bash): no POSIX process groups, and MSYS `kill` can't
#     reliably terminate native bun.exe/node.exe. Use `taskkill //T` (whole tree)
#     `//F` (force) against the WINPID (fx_winpid maps the recorded MSYS pid).
#     SIGTERM tries graceful first (taskkill without //F), then forces — Windows
#     console apps can't receive a POSIX-style SIGTERM, so force is the floor.
fx_pg_kill() {
  local sig="$1" pid="$2" g="${3:-}"
  [ -n "$pid" ] || return 0
  if [ "$FX_OS" = "win" ]; then
    local wp; wp="$(fx_winpid "$pid")"
    [ -n "$wp" ] || return 0
    # Single-slash flags + MSYS_NO_PATHCONV=1: taskkill rejects the `//PID` form
    # ("invalid argument '//PID'"), and without NO_PATHCONV git-bash would rewrite
    # a leading `/PID` into a Windows path. /T = whole tree, /F = force.
    case "$sig" in
      KILL|SIGKILL|9) MSYS_NO_PATHCONV=1 taskkill /PID "$wp" /T /F >/dev/null 2>&1 || true ;;
      *) 
         # On Windows, Node.js/Bun console apps often ignore the graceful WM_CLOSE
         # sent by `taskkill /T` without `/F`, especially when deadlocked (e.g. Vite 6).
         # `taskkill` still returns 0 (success) in that case, which skips the `/F` fallback
         # and leaves a zombie process holding the port. We must always use `/F` for these.
         MSYS_NO_PATHCONV=1 taskkill /PID "$wp" /T /F >/dev/null 2>&1 || true ;;
    esac
    return 0
  fi
  [ -z "$g" ] && g="$(fx_pgid_of "$pid")"
  if [ -n "$g" ]; then kill -"$sig" -- "-$g" 2>/dev/null || true; fi
  kill -"$sig" "$pid" 2>/dev/null || true
}

# fx_pid_alive <pid> → exit 0 if the process is still alive. Platform-aware:
# `kill -0` on POSIX; on Windows git-bash that's unreliable for native processes,
# so query `tasklist` by WINPID instead.
fx_pid_alive() {
  if [ "$FX_OS" = "win" ]; then
    local wp; wp="$(fx_winpid "$1")"
    MSYS_NO_PATHCONV=1 tasklist /FI "PID eq $wp" /NH /FO CSV 2>/dev/null | grep -q "\"$wp\""
  else
    kill -0 "$1" 2>/dev/null
  fi
}

# fx_pg_reap_pidfiles <SIG> — signal every recorded service's whole group. Used
# by run.sh's trap (so it no longer hand-lists $SRV/$UI/$ED/$FACE_MASK and can
# never forget a service again) and by stop.sh as its most-reliable first layer.
fx_pg_reap_pidfiles() {
  local sig="$1" f pid pgid
  [ -d "$FX_RUN_DIR" ] || return 0
  for f in "$FX_RUN_DIR"/*.pid; do
    [ -e "$f" ] || continue
    read -r pid pgid < "$f" 2>/dev/null || continue
    fx_pg_kill "$sig" "$pid" "$pgid"
  done
}

# fx_pg_clear — drop all pidfiles (call after a confirmed-clean teardown).
fx_pg_clear() { rm -rf "$FX_RUN_DIR" 2>/dev/null || true; }
