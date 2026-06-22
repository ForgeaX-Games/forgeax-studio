#!/usr/bin/env bash
# forgeax-studio · version helper
#
# Version scheme:  v0.M.D.N
#   0 — pre-1.0 epoch
#   M.D — main 最新 commit 的月.日 (e.g. 5.18)
#   N — main 自第 1 天起累计 commit 数 (monotone, 永远 +1)
#
# Usage:
#   bash scripts/version.sh              → v0.5.18.486
#   bash scripts/version.sh json         → { version, sha, date, totalCommits, branch }
#   bash scripts/version.sh banner       → 启动横幅 (run.sh 用)
#   bash scripts/version.sh check        → 比对 CHANGELOG 顶版本 vs git 最新,差太多 warn
#   bash scripts/version.sh write FILE   → 把 JSON 写到 FILE (e.g. packages/server/dist/version.json)
#   bash scripts/version.sh stats DATE   → 当日跨 8 仓 +X/-Y 统计 (写 CHANGELOG 用)
#
# Idempotent · 无副作用 (write 子命令除外)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# All git ops scoped to the forgeax-studio root.
git_in() { git -C "$ROOT" "$@" 2>/dev/null; }

# ─── core derivations ─────────────────────────────────────────────────────
if ! git_in rev-parse --git-dir >/dev/null; then
  # Not in a git checkout (e.g. shallow tarball release). Fall back to file.
  if [ -f "$ROOT/.version" ]; then
    VERSION="$(cat "$ROOT/.version")"
    SHA="?"
    DATE="?"
    N="?"
    BRANCH="?"
  else
    VERSION="v0.0.0.0-unversioned"
    SHA="?"
    DATE="?"
    N="0"
    BRANCH="?"
  fi
else
  SHA="$(git_in log -1 --pretty=format:'%h' HEAD)"
  DATE="$(git_in log -1 --pretty=format:'%ad' --date=short HEAD)"
  # Git for Windows does not support strftime's "-" no-pad modifier here.
  M_D="$(git_in log -1 --pretty=format:'%ad' --date=format:'%m.%d' HEAD | sed -E 's/(^|\.)0/\1/g')"
  N="$(git_in rev-list --count HEAD)"
  BRANCH="$(git_in rev-parse --abbrev-ref HEAD)"
  # If detached HEAD, branch shows "HEAD" — replace with the sha.
  [ "$BRANCH" = "HEAD" ] && BRANCH="$SHA"
  # Dirty marker (working tree has changes) — append "+dirty" so users notice.
  if ! git_in diff --quiet || ! git_in diff --cached --quiet; then
    DIRTY="+dirty"
  else
    DIRTY=""
  fi
  VERSION="v0.${M_D}.${N}${DIRTY}"
fi

cmd="${1:-print}"

case "$cmd" in
  print|"")
    echo "$VERSION"
    ;;

  json)
    cat <<EOF
{
  "version": "$VERSION",
  "sha": "$SHA",
  "date": "$DATE",
  "totalCommits": $([ "$N" = "?" ] && echo 0 || echo "$N"),
  "branch": "$BRANCH"
}
EOF
    ;;

  banner)
    # Used by scripts/run.sh + packages/server boot. Compact 3-line ASCII.
    local_y='\033[33m'
    local_g='\033[32m'
    local_m='\033[90m'
    local_b='\033[1m'
    local_r='\033[0m'
    printf "${local_b}╔════════════════════════════════════════════════════════════╗${local_r}\n"
    printf "${local_b}║${local_r}  ${local_y}ForgeaX Studio${local_r}  ·  ${local_b}${VERSION}${local_r}\n"
    printf "${local_b}║${local_r}  ${local_m}commit ${SHA} · ${DATE} · branch ${BRANCH}${local_r}\n"
    printf "${local_b}║${local_r}  ${local_m}CHANGELOG: ${ROOT}/CHANGELOG.md${local_r}\n"
    printf "${local_b}╚════════════════════════════════════════════════════════════╝${local_r}\n"
    ;;

  check)
    # Compare CHANGELOG.md top version with git-derived version.
    CHANGELOG="$ROOT/CHANGELOG.md"
    if [ ! -f "$CHANGELOG" ]; then
      echo "warn: CHANGELOG.md not found at $CHANGELOG" >&2
      exit 1
    fi
    TOP="$(grep -oE '^## v0\.[0-9]+\.[0-9]+\.[0-9]+' "$CHANGELOG" | head -1 | sed 's/^## //')"
    if [ -z "$TOP" ]; then
      echo "warn: no version section found in CHANGELOG.md" >&2
      exit 1
    fi
    if [ "$TOP" = "${VERSION%+dirty}" ]; then
      echo "✓ CHANGELOG synced ($TOP)"
      exit 0
    fi
    # Extract N from each.
    TOP_N="${TOP##*.}"
    GIT_N="$N"
    DIFF=$((GIT_N - TOP_N))
    if [ "$DIFF" -le 3 ]; then
      echo "✓ CHANGELOG within 3 commits ($TOP vs ${VERSION%+dirty})"
      exit 0
    fi
    echo "⚠  CHANGELOG ${TOP} is $DIFF commits behind ${VERSION%+dirty}." >&2
    echo "   Consider adding entries — see scripts/version.sh + CHANGELOG.md rules." >&2
    exit 0  # warn-only, don't fail CI
    ;;

  write)
    OUT="${2:-}"
    if [ -z "$OUT" ]; then
      echo "usage: bash scripts/version.sh write <path-to-version.json>" >&2
      exit 2
    fi
    mkdir -p "$(dirname "$OUT")"
    bash "$0" json > "$OUT"
    echo "wrote $OUT ($VERSION)"
    ;;

  stats)
    # Cross-8-repo +/- on a given day. Format:
    #   9 仓 +X / -Y(净 ±Z)· 主仓 +A / -B · N commits 当日
    # Used to fill the "代码增量" line in CHANGELOG.md sections.
    TARGET_DATE="${2:-$(date -u +%Y-%m-%d)}"
    if ! echo "$TARGET_DATE" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
      echo "usage: bash scripts/version.sh stats YYYY-MM-DD  (default: today UTC)" >&2
      exit 2
    fi
    REPOS=(
      "$ROOT"
      "$ROOT/packages/engine"
      "$ROOT/packages/harness"
      "$ROOT/packages/build"
      "$ROOT/packages/cli"
      "$ROOT/packages/server"
      "$ROOT/packages/interface"
      "$ROOT/packages/marketplace"
      # studio-harness removed 2026-06-06; content vendored to repo root
    )
    TOTAL_ADD=0; TOTAL_DEL=0
    MAIN_ADD=0; MAIN_DEL=0
    MAIN_N=0
    for r in "${REPOS[@]}"; do
      [ -d "$r/.git" ] || [ -f "$r/.git" ] || continue
      # parse shortstat for the day's commits
      stats="$(git -C "$r" log --no-merges --shortstat --pretty=tformat:'' \
        --since="$TARGET_DATE 00:00" --until="$TARGET_DATE 23:59:59" 2>/dev/null || true)"
      # grep -E may exit 1 on empty match — wrap in awk-only sum to avoid pipefail abort.
      add=$(echo "$stats" | awk '{ for(i=1;i<=NF;i++) if ($i ~ /insertion/) s += $(i-1) } END { print s+0 }')
      del=$(echo "$stats" | awk '{ for(i=1;i<=NF;i++) if ($i ~ /deletion/)  s += $(i-1) } END { print s+0 }')
      TOTAL_ADD=$((TOTAL_ADD + add))
      TOTAL_DEL=$((TOTAL_DEL + del))
      if [ "$r" = "$ROOT" ]; then
        MAIN_ADD=$add; MAIN_DEL=$del
        MAIN_N="$(git -C "$r" log --no-merges --oneline \
          --since="$TARGET_DATE 00:00" --until="$TARGET_DATE 23:59:59" 2>/dev/null | wc -l | tr -d ' ')"
      fi
    done
    NET=$((TOTAL_ADD - TOTAL_DEL))
    SIGN="+"; [ "$NET" -lt 0 ] && SIGN=""
    printf "8 仓 +%s / -%s(净 %s%s)· 主仓 +%s / -%s · %s commits 当日\n" \
      "$TOTAL_ADD" "$TOTAL_DEL" "$SIGN" "$NET" "$MAIN_ADD" "$MAIN_DEL" "$MAIN_N"
    ;;

  *)
    echo "unknown subcommand: $cmd" >&2
    echo "see: bash scripts/version.sh --help (or just '$0' for default)" >&2
    exit 2
    ;;
esac
