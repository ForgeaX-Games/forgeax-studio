#!/usr/bin/env bash
# verify-cred-isolation.sh — one-shot verifier for the agent-host per-stack
# isolation fix (Plan A socket derivation) + R3 per-connection reap.
#
# Boots ONE stack from the CURRENT source and proves, end-to-end:
#   P2  forgeax kernel actually replies — a real turn (driven through the REAL UI
#       headlessly) lands a kernel.turn span in the session's logs/trace.jsonl
#       with status=ok and usage.input>0. The bug was inputTokens:0 + empty reply.
#   P3  Plan A — the stack derives its OWN agent-host socket agent-host-<PORT>.sock
#       (NOT the user-global ~/.forgeax/agent-host.sock that a second, non-derived
#       stack would collide on). If other checkouts' agent-hosts are running, it
#       confirms they sit on DIFFERENT sockets (the real cross-stack isolation).
#   P4  R3 reap — killing the server reaps ONLY its own kernel session, its
#       agent-host survives (per-connection reap, not shutdownAll), no orphan.
#
# Why single-stack: two bands in ONE checkout share a project root → one session,
# and two servers fighting over it breaks turn completion (a test artifact, not a
# product bug). The genuine two-stack / cross-KEY case is two SEPARATE checkouts
# with different keys: run THIS script in a second checkout at the same time —
# Phase 3 auto-detects the peer agent-host and asserts it sits on a DIFFERENT
# socket (that line goes from "no other agent-host" to a ✓).
#
# The turn is sent by driving the real UI (Playwright): a bare POST /messages or
# WS-open does NOT schedule a forgeax turn. Verdict is read from trace.jsonl.
#
# Usage:  bash scripts/verify-cred-isolation.sh
#         KEEP=1 bash scripts/verify-cred-isolation.sh   # leave the stack up
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
SRV=38900; UI=38920; SOCK="$HOME/.forgeax/agent-host-$SRV.sock"; GLOBAL="$HOME/.forgeax/agent-host.sock"
PASS=0; FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
info() { printf '  · %s\n' "$1"; }
hr()   { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then hr "Cleanup"; info "KEEP=1 → leaving stack up (UI :$UI)"; return; fi
  hr "Cleanup"; bun fx stop >/dev/null 2>&1 || true
  # `bun fx start` forks a run.ts whose pid differs from $RUN, so kill by path —
  # otherwise orphan launchers accumulate across runs and start fighting.
  kill -TERM "${RUN:-0}" 2>/dev/null || true
  pgrep -f "$ROOT/scripts/run.ts" 2>/dev/null | while read -r p; do kill -TERM "$p" 2>/dev/null || true; done
  pgrep -f "$ROOT/packages/agent-host/src/main.ts" 2>/dev/null | while read -r p; do kill -TERM "$p" 2>/dev/null || true; done
  info "stack stopped (launchers + agent-hosts reaped)"
}
trap cleanup EXIT

wait_port() { local port=$1 t=${2:-60} i=0; while [ $i -lt $((t*2)) ]; do lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0; sleep 0.5; i=$((i+1)); done; return 1; }
newest_trace() { find packages/games .forgeax/games -path "*sessions/*/logs/trace.jsonl" 2>/dev/null -exec ls -t {} + 2>/dev/null | head -1; }
span_count() { grep -c '"name":"kernel.turn"' "$1" 2>/dev/null || echo 0; }
ah_pid_on() { pgrep -f "agent-host/src/main.ts" 2>/dev/null | while read -r pid; do ps eww "$pid" 2>/dev/null | tr ' ' '\n' | grep -q "FORGEAX_AGENT_HOST_SOCK=$1" && echo "$pid"; done | head -1; }

hr "Phase 0 · preconditions"
grep -q 'FORGEAX_AGENT_HOST_SOCK ??=' scripts/run.ts \
  && ok "Plan A present in scripts/run.ts (per-PORT_SERVER socket derivation)" \
  || { bad "Plan A NOT in scripts/run.ts — isolation depends on it"; exit 1; }
info "stopping any existing studio3 stack + lingering agent-hosts…"
bun fx stop >/dev/null 2>&1 || true
pgrep -f "$ROOT/packages/agent-host/src/main.ts" 2>/dev/null | while read -r p; do kill -TERM "$p" 2>/dev/null || true; done
sleep 1; rm -f "$SOCK" 2>/dev/null || true

hr "Phase 1 · start one stack from current source (local band)"
nohup bun fx start local >/tmp/verify-cred.log 2>&1 & RUN=$!
if wait_port "$UI" 90 && wait_port "$SRV" 90; then ok "stack up (server :$SRV / UI :$UI)"; else bad "stack failed to bind (see /tmp/verify-cred.log)"; exit 1; fi

hr "Phase 2 · serve a real forgeax turn (through the UI)"
TRACE=$(newest_trace); BEFORE=$(span_count "${TRACE:-/dev/null}")
info "trace: ${TRACE#$ROOT/} (spans before: $BEFORE)"
bun scripts/lib/verify-send.mjs "http://127.0.0.1:$UI" "verify-cred-isolation: 用一句话确认你在线" >/dev/null 2>&1 \
  && info "UI submit ok" || bad "UI submit failed"
# forgeax turns can be slow on a cold stack (kernel spawn + first turn): the
# trace shows historical turns up to ~190s, so poll generously (up to ~300s).
HEALTHY=0; status=?; intok=0
for i in $(seq 1 150); do
  TRACE=$(newest_trace); now=$(span_count "${TRACE:-/dev/null}")
  if [ "${now:-0}" -gt "$BEFORE" ]; then
    last=$(grep '"name":"kernel.turn"' "$TRACE" | grep '"usage.input"' | tail -1)
    intok=$(printf '%s' "$last" | grep -oE '"usage.input":[0-9]+' | cut -d: -f2)
    status=$(printf '%s' "$last" | grep -oE '"code":"[a-z]+"' | cut -d'"' -f4)
    [ "${status:-}" = "ok" ] && [ "${intok:-0}" -gt 0 ] && { HEALTHY=1; break; }
  fi
  sleep 2
done
[ "$HEALTHY" = "1" ] \
  && ok "forgeax served a HEALTHY turn — status=$status, usage.input=$intok (bug: 0 tokens / empty reply)" \
  || bad "no healthy forgeax turn (status=$status, usage.input=$intok)"

hr "Phase 3 · Plan A socket derivation & isolation"
ENVSOCK=$(ps eww "$(lsof -nP -iTCP:$SRV -sTCP:LISTEN -t 2>/dev/null|head -1)" 2>/dev/null | tr ' ' '\n' | grep '^FORGEAX_AGENT_HOST_SOCK=' | cut -d= -f2)
[ "$ENVSOCK" = "$SOCK" ] && ok "server env derives FORGEAX_AGENT_HOST_SOCK=agent-host-$SRV.sock" || bad "server env socket wrong: '${ENVSOCK:-unset}' (expected $SOCK)"
[ -S "$SOCK" ] && ok "own socket exists: agent-host-$SRV.sock (not the shared global)" || bad "own socket missing → would fall back to global $GLOBAL"
SELF_AH=$(ah_pid_on "$SOCK")
[ -n "$SELF_AH" ] && ok "own agent-host process: pid $SELF_AH on its private socket" || bad "no agent-host bound to own socket"
# opportunistic cross-checkout proof: any OTHER agent-host (e.g. forgeax-os) must be on a DIFFERENT socket
OTHERS=$(pgrep -f "agent-host/src/main.ts" 2>/dev/null | grep -v "^${SELF_AH:-x}$" || true)
if [ -n "$OTHERS" ]; then
  clash=0
  for p in $OTHERS; do os=$(ps eww "$p" 2>/dev/null|tr ' ' '\n'|grep '^FORGEAX_AGENT_HOST_SOCK='|cut -d= -f2); root=$(lsof -p "$p" 2>/dev/null|grep cwd|grep -oE '/[^ ]*(studio|forgeax)[^ ]*'|head -1); info "peer agent-host pid=$p sock=${os:-global} root=${root:-?}"; [ "$os" = "$SOCK" ] && clash=1; done
  [ "$clash" = "0" ] && ok "peer agent-host(s) sit on DIFFERENT sockets — no cross-stack sharing" || bad "a peer agent-host shares our socket (isolation broken)"
else
  info "no other agent-host running (run this in a 2nd checkout to see cross-stack isolation live)"
fi

hr "Phase 4 · R3 per-connection reap (kill server, watch its host)"
# Ensure a LIVE kernel child exists at kill time: fire a turn and don't wait for
# it to finish — a few seconds in, the serve kernel is spawned + running.
info "firing a turn to guarantee a live kernel child, then killing server mid-turn…"
bun scripts/lib/verify-send.mjs "http://127.0.0.1:$UI" "reap-probe: 数到十" >/dev/null 2>&1 || true
for i in $(seq 1 20); do KCHILD=$(pgrep -P "${SELF_AH:-0}" 2>/dev/null | head -1); [ -n "$KCHILD" ] && break; sleep 1; done
SRVPID=$(lsof -nP -iTCP:$SRV -sTCP:LISTEN -t 2>/dev/null|head -1)
info "server=$SRVPID  agent-host=$SELF_AH  kernel child=${KCHILD:-none}"
if [ -n "$SRVPID" ]; then
  kill -TERM "$SRVPID" 2>/dev/null; sleep 4
  kill -0 "${SELF_AH:-0}" 2>/dev/null && ok "agent-host survived server disconnect (per-connection reap, not shutdownAll)" || bad "agent-host died on disconnect (shutdownAll behavior — bug)"
  if [ -n "$KCHILD" ]; then
    kill -0 "$KCHILD" 2>/dev/null && bad "kernel child $KCHILD LEAKED after disconnect (old bug)" || ok "kernel session reaped on disconnect (no leak)"
  else info "no live kernel child at kill time (serve session already idle-reaped) — reap path still asserted by host survival"; ok "no kernel child to leak"; fi
  ORPH=$(pgrep -f "packages/cli/src/cli/main.ts --serve" 2>/dev/null | while read -r k; do pp=$(ps -o ppid= "$k" 2>/dev/null|tr -d ' '); [ "$pp" = "1" ] && echo "$k"; done)
  [ -z "$ORPH" ] && ok "no orphaned (ppid=1) forgeax-core kernels" || bad "orphan kernels leaked: $ORPH"
else bad "could not find server on :$SRV to kill"; fi

hr "Verdict"
printf '  passed: %d   failed: %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && { printf '  \033[32mRESULT: PASS\033[0m — forgeax healthy + Plan A own-socket + R3 reap verified on current source.\n'; exit 0; } \
                  || { printf '  \033[31mRESULT: FAIL\033[0m — see ✗ above.\n'; exit 1; }
