#!/usr/bin/env bash
# Print whether a PR diff can affect submodule-pin validation.
#
# Output is exactly "true" or "false". Comparison errors are fatal so callers
# cannot mistake an unreadable diff for a safe fast-path.
set -euo pipefail

base_sha="${1:?base SHA is required}"
head_sha="${2:?head SHA is required}"

raw_diff="$(git diff --raw --no-renames "$base_sha" "$head_sha" --)"

if awk '
  $1 == ":160000" ||
  $2 == "160000" ||
  $6 == ".gitmodules" ||
  $6 == ".github/workflows/ci.yml" ||
  $6 == ".github/workflows/game-runtime-publish.yml" ||
  $6 == ".github/workflows/studio-qa.yml" ||
  $6 == ".github/workflows/submodule-pins.yml" ||
  $6 == ".github/workflows/post-merge-gate.yml" ||
  $6 == "scripts/check-submodule-pins.ts" ||
  $6 == "scripts/ci/post-merge-gate.sh" ||
  $6 == "scripts/ci/submodule-pin-change.sh" ||
  $6 == "scripts/ci/ci-producer-result.ts" ||
  $6 == "scripts/ci/capture-job-timing.ts" ||
  $6 == "scripts/ci/change-manifest.ts" ||
  $6 == "scripts/ci/disposable-worktree.ts" ||
  $6 == "scripts/ci/check-runner-policy.ts" ||
  $6 == "scripts/ci/runner-policy.json" ||
  $6 == "scripts/ci/wait-for-prerequisite-checks.ts" ||
  $6 == "packages/recursive-input-contract/ci/producer-manifest.v1.json" ||
  $6 == "packages/recursive-input-contract/schema/ci-producer-result.v1.schema.json" ||
  $6 == "packages/recursive-input-contract/schema/recursive-input-ci-contract.v1.schema.json" ||
  $6 == "packages/recursive-input-contract/src/ci-producer-result.ts" ||
  $6 == "packages/recursive-input-contract/src/ci-contract.ts" ||
  index($6, ".github/actions/fetch-submodules/") == 1 ||
  index($6, ".github/actions/reclaim-disposable-worktree/") == 1 { found=1 }
  END { exit found ? 0 : 1 }
' <<< "$raw_diff"; then
  echo "true"
else
  echo "false"
fi
