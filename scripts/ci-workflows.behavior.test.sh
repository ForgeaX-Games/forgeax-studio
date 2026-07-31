#!/usr/bin/env bash
# Behavioral regression tests for CI shell decisions that YAML/text assertions
# cannot prove: command failures must fail closed, and post-merge reuse requires
# an exact GitHub merge identity.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

init_repo() {
  local repository="$1"
  git -C "$repository" init -q
  git -C "$repository" config user.name "CI Test"
  git -C "$repository" config user.email "ci-test@example.com"
  git -C "$repository" config commit.gpgsign false
  git -C "$repository" config core.hooksPath /dev/null
  git -C "$repository" config core.fsmonitor false
}

commit_file() {
  local repository="$1" path="$2" contents="$3" message="$4"
  mkdir -p "$(dirname "$repository/$path")"
  printf '%s' "$contents" > "$repository/$path"
  git -C "$repository" add "$path"
  git -C "$repository" commit -q -m "$message"
  git -C "$repository" rev-parse HEAD
}

pin_repo="$test_root/pin-repo"
mkdir -p "$pin_repo"
init_repo "$pin_repo"
pin_base="$(commit_file "$pin_repo" README.md $'base\n' base)"
pin_code="$(commit_file "$pin_repo" src/index.ts $'export {};\n' "ordinary code")"

decision="$(cd "$pin_repo" && bash "$root/scripts/ci/submodule-pin-change.sh" "$pin_base" "$pin_code")"
[ "$decision" = "false" ] || fail "ordinary code diff should use the thin pin gate"

pin_validator="$(commit_file "$pin_repo" scripts/ci/submodule-pin-change.sh $'# validator changed\n' "change validator")"
decision="$(cd "$pin_repo" && bash "$root/scripts/ci/submodule-pin-change.sh" "$pin_code" "$pin_validator")"
[ "$decision" = "true" ] || fail "validator changes must run full pin validation"

git -C "$pin_repo" update-index --add --cacheinfo "160000,$pin_validator,packages/example"
git -C "$pin_repo" commit -q -m "change gitlink"
pin_gitlink="$(git -C "$pin_repo" rev-parse HEAD)"
decision="$(cd "$pin_repo" && bash "$root/scripts/ci/submodule-pin-change.sh" "$pin_validator" "$pin_gitlink")"
[ "$decision" = "true" ] || fail "gitlink changes must run full pin validation"

invalid_output=""
if invalid_output="$(cd "$pin_repo" && bash "$root/scripts/ci/submodule-pin-change.sh" deadbeef "$pin_gitlink" 2>/dev/null)"; then
  fail "an unreadable pin diff must fail"
fi
[ "$invalid_output" != "false" ] || fail "an unreadable pin diff was reported as a safe fast-path"

token_bin="$test_root/token-bin"
mkdir -p "$token_bin"
cat > "$token_bin/gh" <<'FAKE_TOKEN_GH'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "api" ] || exit 2
printf '%s\n' "${2:-}" >> "${FAKE_GH_RECORD:?}"
[ "${2:-}" != "${FAKE_GH_FAIL_REPO:-}" ]
FAKE_TOKEN_GH
chmod +x "$token_bin/gh"

token_modules="$test_root/token.gitmodules"
cat > "$token_modules" <<'TOKEN_MODULES'
[submodule "games"]
	path = packages/games
	url = ../forgeax-games.git
[submodule "editor"]
	path = packages/editor
	url = git@github.com:ForgeaX-Games/forgeax-editor.git
TOKEN_MODULES
token_record="$test_root/token-record"
: > "$token_record"
token_output="$(
  PATH="$token_bin:$PATH" \
    GH_TOKEN=test-token \
    GITHUB_REPOSITORY=ForgeaX-Games/forgeax-studio \
    GITHUB_REPOSITORY_OWNER=ForgeaX-Games \
    FAKE_GH_RECORD="$token_record" \
    bash "$root/scripts/ci/check-internal-token-access.sh" "$token_modules"
)"
grep -q 'INTERNAL_TOKEN can read ForgeaX-Games/forgeax-games' <<< "$token_output" \
  || fail "token preflight should report readable relative-url submodules"
grep -q '^repos/ForgeaX-Games/forgeax-editor$' "$token_record" \
  || fail "token preflight should normalize ssh submodule URLs"

token_error="$test_root/token-error"
if PATH="$token_bin:$PATH" \
  GH_TOKEN=test-token \
  GITHUB_REPOSITORY=ForgeaX-Games/forgeax-studio \
  GITHUB_REPOSITORY_OWNER=ForgeaX-Games \
  FAKE_GH_RECORD="$token_record" \
  FAKE_GH_FAIL_REPO=repos/ForgeaX-Games/forgeax-games \
  bash "$root/scripts/ci/check-internal-token-access.sh" "$token_modules" \
  >/dev/null 2>"$token_error"; then
  fail "token preflight must fail when a submodule repository is unreadable"
fi
grep -q 'INTERNAL_TOKEN cannot read ForgeaX-Games/forgeax-games' "$token_error" \
  || fail "token preflight should name the inaccessible repository"

gate_repo="$test_root/gate-repo"
mkdir -p "$gate_repo"
init_repo "$gate_repo"
gate_base="$(commit_file "$gate_repo" README.md $'base\n' base)"
gate_merge="$(commit_file "$gate_repo" src/index.ts $'export {};\n' "merged change (#42)")"
fake_bin="$test_root/fake-bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
case "${2:-}" in
  */commits/*/pulls) printf '%s\n' "${FAKE_ASSOCIATED_PR:-}" ;;
  */pulls/*) printf '%s\n' "${FAKE_PR_DETAILS:-}" ;;
  *) exit 2 ;;
esac
FAKE_GH
chmod +x "$fake_bin/gh"

run_gate() {
  local associated_pr="$1" details="$2" output="$test_root/github-output"
  : > "$output"
  (
    cd "$gate_repo"
    PATH="$fake_bin:$PATH" \
      GITHUB_OUTPUT="$output" \
      GITHUB_REPOSITORY="example/repository" \
      GITHUB_SHA="$gate_merge" \
      FAKE_ASSOCIATED_PR="$associated_pr" \
      FAKE_PR_DETAILS="$details" \
      bash "$root/scripts/ci/post-merge-gate.sh" >/dev/null
  )
  tr -d '\n' < "$output"
}

merged_at="2026-07-30T00:00:00Z"
[ "$(run_gate 42 "$gate_base	$gate_merge	$merged_at")" = "skip_checks=true" ] \
  || fail "exact merged PR identity should reuse validation"
[ "$(run_gate "" "$gate_base	$gate_merge	$merged_at")" = "skip_checks=false" ] \
  || fail "commit-message PR text must not substitute for API association"
[ "$(run_gate 42 "$gate_base	0000000000000000000000000000000000000000	$merged_at")" = "skip_checks=false" ] \
  || fail "mismatched merge commit must run full validation"
[ "$(run_gate 42 "$gate_merge	$gate_merge	$merged_at")" = "skip_checks=false" ] \
  || fail "moved PR base must run full validation"
[ "$(run_gate 42 "$gate_base	$gate_merge	")" = "skip_checks=false" ] \
  || fail "unmerged PR identity must run full validation"

echo "CI workflow behavior tests passed"
