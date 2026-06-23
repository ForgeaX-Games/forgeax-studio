#!/usr/bin/env bash
# forgeax-studio launcher — top-level entry point.
#
# Boots the 3-service dev stack (server / interface / engine). Default ports:
#   18900  forgeax-server   ← runtime core (chat / cli-providers / commands /
#                              sessions / bus surfaces · 内含原 cli daemon 的
#                              全部 chat 职能)
#   18920  forgeax-interface (Studio UI · vite HMR)
#   15173  engine renderer  (vite, packages/build/engine-src)
# Override via FORGEAX_{SERVER,INTERFACE,ENGINE}_PORT in $ROOT/.env.
#
# 2026-05-21: 砍掉了 forgeax cli daemon (旧 :3700) + agenteam instance
# provision 链路 —— server 的 cli-providers (bc / codex / cursor /
# forgeax) 已经完整接管该角色,旧 daemon 的 docker-based "instance" 抽象
# 在 macOS 上是噪音源。docker 不再是 Studio 跑起来的硬依赖。
#
# Prereq: ./install.sh (or bash scripts/deploy.sh) must have been run once.
# Open http://localhost:${FORGEAX_INTERFACE_PORT:-18920} in a browser.
set -euo pipefail
STUDIO=${STUDIO:-1}; export STUDIO
cd "$(dirname "${BASH_SOURCE[0]}")"
exec bash scripts/run.sh "$@"
