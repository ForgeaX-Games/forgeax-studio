#!/usr/bin/env bash

# Shared lifecycle helpers for the fixed-port Studio QA Heavy jobs.
#
# This file is sourced by the workflow step while the runner-local flock is
# held. Cleanup is ownership-scoped: generated Studio QA workspaces may be
# stopped, but a user-owned RuntimeInstance or unrelated listener is only
# diagnosed and causes a fail-closed result. Never turn a port preflight into a
# broad process kill.

# A self-hosted runner can report no LISTEN PID while the kernel still rejects
# the next bind. Keep this recovery window long enough for the observed runner
# transition (~114s), but bounded so a genuinely occupied port still fails
# closed before the job timeout.
STUDIO_QA_FIXED_PORT_SETTLE_CHECKS="${STUDIO_QA_FIXED_PORT_SETTLE_CHECKS:-180}"
STUDIO_QA_FIXED_PORT_SETTLE_INTERVAL_SECONDS="${STUDIO_QA_FIXED_PORT_SETTLE_INTERVAL_SECONDS:-1}"

studio_qa_runtime_ports_for_slot() {
  local slot="$1"
  local offset=$((slot * 10000))
  printf '%s\n' $((18900 + offset)) $((18920 + offset)) $((15173 + offset))
}

studio_qa_runtime_port_bind_probe() {
  local port="$1"
  local error_path output probe_status
  error_path="${TMPDIR:-/tmp}/forgeax-studio-qa-port-bind-probe-${port}-$$.err"
  if ! command -v bun >/dev/null 2>&1; then
    echo "::error title=Studio QA port bind probe unavailable::Bun is required to prove fixed port $port is bindable"
    return 2
  fi
  if output="$(bun --eval "const net = await import('node:net'); const server = net.createServer(); let settled = false; const finish = (result) => { if (settled) return; settled = true; if (server.listening) { server.close(() => console.log(result)); } else { console.log(result); } }; server.once('error', () => finish('busy')); server.listen({ host: '0.0.0.0', port: $port, exclusive: true }, () => finish('free'));" 2>"$error_path")"; then
    probe_status=0
  else
    probe_status=$?
  fi
  if [ "$probe_status" -eq 0 ]; then
    rm -f -- "$error_path"
    case "$output" in
      *busy*) STUDIO_QA_PORT_LISTENERS='bun-bind'; return 0 ;;
      *free*) return 1 ;;
    esac
  fi
  echo "::error title=Studio QA port bind probe failed::Bun could not reliably inspect bindability of fixed port $port"
  cat "$error_path" >&2 2>/dev/null || true
  rm -f -- "$error_path"
  return 2
}

studio_qa_runtime_port_probe() {
  local port="$1"
  local error_path output probe_status
  error_path="${TMPDIR:-/tmp}/forgeax-studio-qa-port-probe-${port}-$$.err"
  STUDIO_QA_PORT_LISTENERS=''

  if command -v lsof >/dev/null 2>&1; then
    if output="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>"$error_path")"; then
      probe_status=0
    else
      probe_status=$?
    fi
    if [ "$probe_status" -eq 0 ]; then
      rm -f -- "$error_path"
      if [ -n "$output" ]; then
        STUDIO_QA_PORT_LISTENERS="$output"
        return 0
      fi
      studio_qa_runtime_port_bind_probe "$port"
      return $?
    fi
    if [ "$probe_status" -eq 1 ] && [ -z "$output" ] && [ ! -s "$error_path" ]; then
      rm -f -- "$error_path"
      studio_qa_runtime_port_bind_probe "$port"
      return $?
    fi
    echo "::error title=Studio QA port preflight failed::lsof could not reliably inspect port $port"
    cat "$error_path" >&2 2>/dev/null || true
    rm -f -- "$error_path"
    return 2
  fi

  if command -v ss >/dev/null 2>&1; then
    if output="$(ss -H -ltnp 2>"$error_path")"; then
      probe_status=0
    else
      probe_status=$?
    fi
    if [ "$probe_status" -ne 0 ]; then
      echo "::error title=Studio QA port preflight failed::ss could not reliably inspect port $port"
      cat "$error_path" >&2 2>/dev/null || true
      rm -f -- "$error_path"
      return 2
    fi
    rm -f -- "$error_path"
    if printf '%s\n' "$output" | awk -v port=":$port" '$1 == "LISTEN" && index($4, port) > 0 { found = 1 } END { exit found ? 0 : 1 }'; then
      STUDIO_QA_PORT_LISTENERS='ss'
      return 0
    fi
    studio_qa_runtime_port_bind_probe "$port"
    return $?
  fi

  if command -v fuser >/dev/null 2>&1; then
    if output="$(fuser -n tcp "$port" 2>"$error_path")"; then
      probe_status=0
    else
      probe_status=$?
    fi
    if [ "$probe_status" -eq 0 ]; then
      rm -f -- "$error_path"
      STUDIO_QA_PORT_LISTENERS="${output:-fuser}"
      return 0
    fi
    if [ "$probe_status" -eq 1 ] && [ -z "$output" ] && [ ! -s "$error_path" ]; then
      rm -f -- "$error_path"
      studio_qa_runtime_port_bind_probe "$port"
      return $?
    fi
    echo "::error title=Studio QA port preflight failed::fuser could not reliably inspect port $port"
    cat "$error_path" >&2 2>/dev/null || true
    rm -f -- "$error_path"
    return 2
  fi

  studio_qa_runtime_port_bind_probe "$port"
  return $?
}

studio_qa_describe_runtime_port() {
  local port="$1"
  echo "[studio-qa] diagnostics for occupied port $port (probe=${STUDIO_QA_PORT_LISTENERS:-unknown})"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>&1 || true
  elif command -v ss >/dev/null 2>&1; then
    ss -H -ltnp 2>&1 | awk -v port=":$port" '$1 == "LISTEN" && index($4, port) > 0' || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -v -n tcp "$port" 2>&1 || true
  fi
}

studio_qa_assert_runtime_slot_free() {
  local slot="$1"
  local failed=0 port probe_status
  while IFS= read -r port; do
    if studio_qa_runtime_port_probe "$port"; then
      echo "::error title=Studio QA fixed port is occupied::slot=$slot port=$port owner=${STUDIO_QA_PORT_LISTENERS:-unknown}"
      studio_qa_describe_runtime_port "$port"
      failed=1
    else
      probe_status=$?
      if [ "$probe_status" -ne 1 ]; then
        failed=1
      fi
    fi
  done < <(studio_qa_runtime_ports_for_slot "$slot")
  return "$failed"
}

studio_qa_assert_fixed_ports_free() {
  local failed=0 slot
  for slot in 0 1 2 3 4; do
    studio_qa_assert_runtime_slot_free "$slot" || failed=1
  done
  return "$failed"
}

studio_qa_wait_for_fixed_ports_free() {
  local checks="${1:-$STUDIO_QA_FIXED_PORT_SETTLE_CHECKS}"
  local interval_seconds="${2:-$STUDIO_QA_FIXED_PORT_SETTLE_INTERVAL_SECONDS}"
  local check
  for ((check = 1; check <= checks; check += 1)); do
    if studio_qa_assert_fixed_ports_free; then
      echo "[studio-qa] all fixed RuntimeInstance ports are free (check $check/$checks)"
      return 0
    fi
    if [ "$check" -lt "$checks" ]; then
      sleep "$interval_seconds"
    fi
  done
  echo "::error title=Studio QA fixed-port lifecycle incomplete::ports remained occupied after $checks checks"
  return 1
}

studio_qa_wait_for_runtime_slot_free() {
  local slot="$1"
  local checks="${2:-$STUDIO_QA_FIXED_PORT_SETTLE_CHECKS}"
  local interval_seconds="${3:-$STUDIO_QA_FIXED_PORT_SETTLE_INTERVAL_SECONDS}"
  local check
  for ((check = 1; check <= checks; check += 1)); do
    if studio_qa_assert_runtime_slot_free "$slot"; then
      echo "[studio-qa] RuntimeInstance slot $slot is free (check $check/$checks)"
      return 0
    fi
    if [ "$check" -lt "$checks" ]; then
      sleep "$interval_seconds"
    fi
  done
  echo "::error title=Studio QA RuntimeInstance slot cleanup incomplete::slot=$slot remained occupied after $checks checks"
  return 1
}

studio_qa_cleanup_generated_workspaces() {
  local workspace scripts_target failed=0
  while IFS= read -r -d '' workspace; do
    [ -L "$workspace/scripts" ] || continue
    [ -f "$workspace/.forgeax/runtime/instance.json" ] || continue
    scripts_target="$(readlink -f "$workspace/scripts" 2>/dev/null || true)"
    [ "$scripts_target" = "${GITHUB_WORKSPACE:-}/scripts" ] || continue
    echo "[studio-qa] stopping generated RuntimeInstance: $workspace"
    if (cd "$workspace" && FORGEAX_WORKSPACE_ROOT="$workspace" bun scripts/fx.ts stop --force); then
      # A successful scoped stop proves its declared ports/PIDs are clear.
      rm -rf -- "$workspace"
    else
      echo "::error title=Studio QA generated RuntimeInstance cleanup failed::unable to stop $workspace"
      failed=1
    fi
  # The producer keeps the stable Studio QA lifecycle contract while the public
  # Studio QA carrier may use its semantic workspace prefix after the suite
  # rename. Both prefixes are generated by this checkout and are safe to
  # inspect; every candidate still has to pass the scripts symlink ownership
  # check above.
  done < <(
    find /tmp -maxdepth 1 -type d \( -name 'sfc07-sample-*' -o -name 'studio-qa-sample-*' \) -print0 2>/dev/null
  )
  return "$failed"
}
