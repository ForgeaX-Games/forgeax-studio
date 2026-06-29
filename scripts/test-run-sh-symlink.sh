#!/bin/bash
# w14: run.sh symlink integration test — idempotency + forge.json guard + graceful skip
#
# This script tests the symlink-discovery logic from scripts/run.sh §3.5 in
# isolation by constructing a minimal filesystem fixture and exercising each
# branch without starting the full studio stack.
#
# Usage:  bash scripts/test-run-sh-symlink.sh
# Output: green "PASS" for each case, red "FAIL" on any unexpected state.

set -e

RED='\033[31m'
GREEN='\033[32m'
RESET='\033[0m'

pass()  { printf "${GREEN}PASS${RESET} %s\n" "$*"; }
fail() { printf "${RED}FAIL${RESET} %s\n" "$*"; exit 1; }

TESTS_PASSED=0
TESTS_FAILED=0

record_pass() { TESTS_PASSED=$((TESTS_PASSED + 1)); pass "$@"; }
record_fail() { TESTS_FAILED=$((TESTS_FAILED + 1)); fail "$@"; }

# ── helpers (same logic as run.sh §3.5, extracted for isolation testing) ───

symlink_discover() {
  local ROOT="$1"
  local INSTANCE_ROOT="$2"

  mkdir -p "$INSTANCE_ROOT/.forgeax/games"

  local GAMES_LIB_DIR="$ROOT/packages/games"
  if [ -d "$GAMES_LIB_DIR" ] && [ -n "$(ls -A "$GAMES_LIB_DIR" 2>/dev/null)" ]; then
    for d in "$GAMES_LIB_DIR"/*/; do
      [ -d "$d" ] || continue
      d="${d%/}"
      local game_forge_json="$d/forge.json"
      if [ ! -f "$game_forge_json" ]; then
        echo "skip $d (no forge.json)"
        continue
      fi
      local slug
      slug=$(python3 -c "import json; print(json.load(open('$game_forge_json'))['id'])" 2>/dev/null)
      if [ -z "$slug" ]; then
        echo "skip $d (forge.json missing 'id' field)"
        continue
      fi
      local link_target="$INSTANCE_ROOT/.forgeax/games/$slug"
      local link_source="$d"
      if [ -L "$link_target" ]; then
        local current
        current=$(readlink "$link_target")
        if [ "$current" = "$link_source" ]; then
          echo "$slug symlink ok (already correct)"
          continue
        fi
        echo "$slug symlink points elsewhere ($current), replacing"
        ln -snf "$link_source" "$link_target"
      elif [ ! -e "$link_target" ]; then
        echo "$slug symlink created"
        ln -snf "$link_source" "$link_target"
      else
        echo "CONFLICT: $link_target exists as real dir, skip" >&2
      fi
    done
  else
    echo "WARNING: packages/games empty/not init"
  fi
}

# ── fixtures ──────────────────────────────────────────────────────────────

setup_fixture() {
  local BASE="$1"
  rm -rf "$BASE"
  mkdir -p "$BASE/packages/games/with-forge"
  mkdir -p "$BASE/packages/games/no-forge"
  mkdir -p "$BASE/packages/games/other-game"
  cat > "$BASE/packages/games/with-forge/forge.json" <<<'{"id":"with-forge","name":"test"}'
  # no-forge has no forge.json intentionally
  cat > "$BASE/packages/games/other-game/forge.json" <<<'{"id":"other-game","name":"other"}'
}

# ── test 1: forge.json guard — with-forge → symlinked, no-forge → skipped ──

echo "=== Test 1: forge.json guard ==="
BASE1="$(mktemp -d)"
setup_fixture "$BASE1"
output=$(symlink_discover "$BASE1" "$BASE1" 2>&1) || true

if echo "$output" | grep -q "with-forge symlink created"; then
  record_pass "Test 1a: with-forge symlink created"
else
  record_fail "Test 1a: expected 'with-forge symlink created'"
fi

if echo "$output" | grep -q "skip.*no-forge.*no forge.json"; then
  record_pass "Test 1b: no-forge directory skipped"
else
  record_fail "Test 1b: expected no-forge skip message"
fi

if echo "$output" | grep -q "other-game symlink created"; then
  record_pass "Test 1c: other-game symlink created"
else
  record_fail "Test 1c: expected other-game symlink created"
fi

# Verify symlinks exist on disk
if [ -L "$BASE1/.forgeax/games/with-forge" ]; then
  record_pass "Test 1d: with-forge symlink on disk"
else
  record_fail "Test 1d: with-forge symlink not on disk"
fi

if [ ! -L "$BASE1/.forgeax/games/no-forge" ] && [ ! -e "$BASE1/.forgeax/games/no-forge" ]; then
  record_pass "Test 1e: no-forge symlink NOT created"
else
  record_fail "Test 1e: no-forge symlink should NOT exist"
fi

rm -rf "$BASE1"

# ── test 2: idempotency — run twice, state constant ───────────────────

echo ""
echo "=== Test 2: idempotency ==="
BASE2="$(mktemp -d)"
setup_fixture "$BASE2"

# First run
symlink_discover "$BASE2" "$BASE2" > /dev/null 2>&1
first_target=$(readlink "$BASE2/.forgeax/games/with-forge")

# Second run
output2=$(symlink_discover "$BASE2" "$BASE2" 2>&1) || true

if echo "$output2" | grep -q "with-forge symlink ok (already correct)"; then
  record_pass "Test 2a: second run reports already correct"
else
  record_fail "Test 2a: second run did not report already correct"
fi

second_target=$(readlink "$BASE2/.forgeax/games/with-forge")
if [ "$first_target" = "$second_target" ]; then
  record_pass "Test 2b: symlink target unchanged after second run"
else
  record_fail "Test 2b: symlink target changed ($first_target vs $second_target)"
fi

if echo "$output2" | grep -q "other-game symlink ok (already correct)"; then
  record_pass "Test 2c: other-game also idempotent"
else
  record_fail "Test 2c: other-game not idempotent"
fi

rm -rf "$BASE2"

# ── test 3: graceful skip — packages/games absent ─────────────────────

echo ""
echo "=== Test 3: graceful skip (empty/absent packages/games) ==="
BASE3="$(mktemp -d)"
# No packages/games directory at all
output3=$(symlink_discover "$BASE3" "$BASE3" 2>&1) || true

if echo "$output3" | grep -q "WARNING.*packages/games.*empty\|not init"; then
  record_pass "Test 3a: warning emitted for missing packages/games"
else
  record_fail "Test 3a: expected warning for missing packages/games"
fi

# Also test empty packages/games directory
BASE3b="$(mktemp -d)"
mkdir -p "$BASE3b/packages/games"
output3b=$(symlink_discover "$BASE3b" "$BASE3b" 2>&1) || true

if echo "$output3b" | grep -q "WARNING.*packages/games.*empty\|not init"; then
  record_pass "Test 3b: warning emitted for empty packages/games"
else
  record_fail "Test 3b: expected warning for empty packages/games"
fi

rm -rf "$BASE3" "$BASE3b"

# ── test 4: real directory conflict — existing non-symlink target ─────

echo ""
echo "=== Test 4: real directory conflict ==="
BASE4="$(mktemp -d)"
mkdir -p "$BASE4/packages/games/my-game"
cat > "$BASE4/packages/games/my-game/forge.json" <<<'{"id":"my-game","name":"test"}'
# Create a REAL directory at the target location (not a symlink)
mkdir -p "$BASE4/.forgeax/games/my-game"
touch "$BASE4/.forgeax/games/my-game/existing-content.txt"

output4=$(symlink_discover "$BASE4" "$BASE4" 2>&1) || true

if echo "$output4" | grep -q "CONFLICT"; then
  record_pass "Test 4a: conflict detected for existing real directory"
else
  record_fail "Test 4a: expected CONFLICT message"
fi

# Existing content must survive
if [ -f "$BASE4/.forgeax/games/my-game/existing-content.txt" ]; then
  record_pass "Test 4b: existing content preserved (not overwritten)"
else
  record_fail "Test 4b: existing content was destroyed"
fi

# Symlink must NOT have been created (it's still a real dir)
if [ -d "$BASE4/.forgeax/games/my-game" ] && [ ! -L "$BASE4/.forgeax/games/my-game" ]; then
  record_pass "Test 4c: target still a real directory (not replaced by symlink)"
else
  record_fail "Test 4c: target replaced by symlink"
fi

rm -rf "$BASE4"

# ── summary ────────────────────────────────────────────────────────────────

echo ""
echo "========================================"
printf "${GREEN}Passed: %d${RESET}  ${RED}Failed: %d${RESET}\n" "$TESTS_PASSED" "$TESTS_FAILED"
echo "========================================"

if [ "$TESTS_FAILED" -gt 0 ]; then
  exit 1
fi
exit 0