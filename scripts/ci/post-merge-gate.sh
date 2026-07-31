#!/usr/bin/env bash
# Decide whether a main-push validation can reuse the PR result.
#
# GitHub squash-merges a PR into a commit whose first parent is the main tree
# the PR was based on. Reuse is allowed only when GitHub associates that exact
# merge commit with a merged PR and the parent still equals the PR's recorded
# base SHA. If any lookup or identity check fails, request full validation.
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"

run_full_validation() {
  echo "$1"
  echo "skip_checks=false" >> "$GITHUB_OUTPUT"
  exit 0
}

# The association endpoint identifies the merged PR that introduced a commit on
# the default branch. Do not infer identity from "#N" text in a commit subject:
# a direct commit can mention an unrelated PR number.
pr_number="$(
  gh api "repos/${GITHUB_REPOSITORY}/commits/${GITHUB_SHA}/pulls" \
    --jq '[.[] | select(.merged_at != null)] | last | .number // empty' \
    2>/dev/null || true
)"
[ -n "$pr_number" ] \
  || run_full_validation "No merged PR associated with ${GITHUB_SHA:0:8} — run full validation"

echo "PR number: ${pr_number}"
merge_parent="$(git rev-list --parents -n 1 "$GITHUB_SHA" | awk '{print $2}')"
[ -n "$merge_parent" ] \
  || run_full_validation "Main commit has no parent to compare — run full validation"

pr_details="$(
  gh api "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}" \
    --jq '[.base.sha, .merge_commit_sha, .merged_at] | @tsv' \
    2>/dev/null || true
)"
if ! read -r pr_base pr_merge_commit pr_merged_at <<< "$pr_details"; then
  run_full_validation "Failed to fetch complete merge identity for PR #${pr_number} — run full validation"
fi
[ -n "${pr_base:-}" ] && [ -n "${pr_merge_commit:-}" ] && [ -n "${pr_merged_at:-}" ] \
  || run_full_validation "Failed to fetch complete merge identity for PR #${pr_number} — run full validation"

[ "$pr_merge_commit" = "$GITHUB_SHA" ] \
  || run_full_validation "PR #${pr_number} merge commit does not equal ${GITHUB_SHA:0:8} — run full validation"

echo "merge parent: ${merge_parent}"
echo "PR base:      ${pr_base}"
if [ "$merge_parent" = "$pr_base" ]; then
  echo "PR #${pr_number} base matches the merge parent — reuse PR validation"
  echo "skip_checks=true" >> "$GITHUB_OUTPUT"
else
  run_full_validation "PR #${pr_number} base differs from the merge parent — run full validation"
fi
