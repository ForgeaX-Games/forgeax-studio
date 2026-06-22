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

# fx_pg_self_pgid — our own process group, so we never group-kill ourselves.
fx_pg_self_pgid() { ps -o pgid= -p $$ 2>/dev/null | tr -d ' '; }

# fx_pgid_of <pid> → the pid's process group, but never our own (empty if same).
fx_pgid_of() {
  local g self
  self="$(fx_pg_self_pgid)"
  g="$(ps -o pgid= -p "$1" 2>/dev/null | tr -d ' ')"
  [ -n "$g" ] && [ "$g" != "$self" ] && printf '%s' "$g"
}

# fx_pg_record <name> <pid> — atomically write .forgeax/run/<name>.pid the moment
# a service is backgrounded (fixes F1's "wrote dev-stack.env only after ALL jobs
# started, so an early crash lost every reaping clue"). mv = atomic rename.
fx_pg_record() {
  local name="$1" pid="$2" pgid tmp
  [ -n "$pid" ] || return 0
  mkdir -p "$FX_RUN_DIR"
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  tmp="$FX_RUN_DIR/.$name.pid.$$"
  printf '%s %s\n' "$pid" "${pgid:-$pid}" > "$tmp" && mv -f "$tmp" "$FX_RUN_DIR/$name.pid"
}

# fx_pg_kill <SIG> <pid> [pgid] — signal the process group then the bare pid as a
# fallback for non-grouped / legacy stacks. Idempotent.
fx_pg_kill() {
  local sig="$1" pid="$2" g="${3:-}"
  [ -n "$pid" ] || return 0
  [ -z "$g" ] && g="$(fx_pgid_of "$pid")"
  if [ -n "$g" ]; then kill -"$sig" -- "-$g" 2>/dev/null || true; fi
  kill -"$sig" "$pid" 2>/dev/null || true
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
