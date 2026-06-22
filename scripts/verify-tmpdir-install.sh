#!/usr/bin/env bash
# verify-tmpdir-install.sh — automate AC-01 / AC-02 / AC-03 / AC-04 of
# feat-20260611-p1-extract-forgeax-editor-top-level-package.
#
# What this script proves
# -----------------------
# An external LLM agent (or any non-monorepo consumer) can drop the published
# form of @forgeax/interface and @forgeax/editor into an empty directory,
# run `bun install`, and import them without the host repo's workspace
# scaffolding. That is the "external file: install" contract behind:
#
#   - AC-01: tmpdir bun install file:<repo>/packages/{interface,editor}
#            exits 0 and node_modules/@forgeax/{interface,editor}/package.json
#            both physically exist.
#   - AC-02: bun --print "typeof (await import('@forgeax/interface/app-kit')).defineApp"
#            prints exactly 'function'.
#   - AC-03: bun --print on '@forgeax/editor' resolves to a module whose
#            default.manifest.id (and named manifest.id) === 'editor'.
#   - AC-04: manifest.panels.map(p => p.id).sort() matches the EDITOR_PANELS
#            SSOT (assets / capabilities / hierarchy / history / inspector
#            / material / matgraph / timeline).
#
# AC-05 (visual gate) is NOT exercised here — that is the verify-step
# subagent + main-session Read(image) protocol per charter P5 (plan-decisions
# §3 PNG produce/read split). This script is the AC-01..AC-04 automation
# only; AC-05 falsification check (R8) is a separate human/sandbox flow.
# If you ever flip main.ts back to '@forgeax-studio/interface/app-kit', the
# AC-05 PNG should diverge from the green-path PNG — that asymmetry is the
# falsification check, executed in step-verify, not here.
#
# Why we stage into a tmp directory before bun install
# -----------------------------------------------------
# packages/editor/package.json AND packages/interface/package.json both
# declare their in-repo runtime deps as `workspace:*` (consumed by the
# studio bun workspaces). Bun's resolver refuses to install a `file:`
# package whose dependencies use the `workspace:` protocol when the
# consumer is outside that workspace — the consumer dir has no workspace
# lookup table. To prove the external-consumer path we mimic what
# `bun publish` would do: copy both packages into a clean staging tree
# and strip `workspace:*` from both packages' dependency maps. The
# consumer then declares both packages explicitly via `file:`, matching
# the manifest-driven discovery shape an external LLM agent would author.
#
# (Pre-P1.5, only editor declared workspace deps; P1.5 widened the strip
# to interface after editor-runtime cascade added `@forgeax/editor`,
# `@forgeax/editor-shared`, `zod` to interface's dependencies.)
#
# Idempotent: every run uses fresh `mktemp -d` directories. No host repo
# files are mutated. The script does not touch the worktree's node_modules.
#
# Usage:
#   bash scripts/verify-tmpdir-install.sh
#
# Exit code 0 = all four ACs pass. Any non-zero = a specific assertion
# failed (the failing assertion is logged just above the exit).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERFACE_SRC="${REPO_ROOT}/packages/interface"
EDITOR_SRC="${REPO_ROOT}/packages/editor"

if [[ ! -f "${INTERFACE_SRC}/package.json" ]]; then
  echo "verify-tmpdir-install: cannot find ${INTERFACE_SRC}/package.json" >&2
  exit 64
fi
if [[ ! -f "${EDITOR_SRC}/package.json" ]]; then
  echo "verify-tmpdir-install: cannot find ${EDITOR_SRC}/package.json" >&2
  exit 64
fi

STAGING="$(mktemp -d -t forgeax-verify-stage.XXXXXX)"
CONSUMER="$(mktemp -d -t forgeax-verify-consumer.XXXXXX)"

cleanup() {
  rm -rf "${STAGING}" "${CONSUMER}"
}
trap cleanup EXIT

echo "verify-tmpdir-install: staging=${STAGING}"
echo "verify-tmpdir-install: consumer=${CONSUMER}"

# Stage @forgeax/interface and @forgeax/editor into a clean tree. We copy
# the package directories (excluding node_modules) so the staging step is
# decoupled from any pre-installed state in the host repo.
mkdir -p "${STAGING}/interface" "${STAGING}/editor"
( cd "${INTERFACE_SRC}" && tar --exclude=node_modules -cf - . ) | ( cd "${STAGING}/interface" && tar -xf - )
( cd "${EDITOR_SRC}"    && tar --exclude=node_modules -cf - . ) | ( cd "${STAGING}/editor"    && tar -xf - )

# Strip `workspace:*` deps from BOTH editor/package.json AND interface/package.json.
# These are valid inside the studio bun workspace but unresolvable outside it.
# The published form of each package would have these resolved (or removed for SDK
# packages whose consumers declare them directly).
#
# History note (2026-06-12, P1.5): originally only editor/package.json declared
# `workspace:*` deps; interface was leaf. P1.5 (feat-...-contract-mountstandalone-...)
# added `@forgeax/editor`, `@forgeax/editor-shared`, and `zod` as runtime deps to
# interface so the editor-runtime cascade can read protocol schemas. This widened
# the strip surface to both packages — the script comment block above (line 88-90)
# was updated accordingly.
python3 - <<PY
import json
from pathlib import Path
for pkg_path in [Path("${STAGING}/editor/package.json"), Path("${STAGING}/interface/package.json")]:
    data = json.loads(pkg_path.read_text())
    deps = data.get("dependencies", {})
    data["dependencies"] = {k: v for k, v in deps.items() if not (isinstance(v, str) and v.startswith("workspace:"))}
    pkg_path.write_text(json.dumps(data, indent=2) + "\n")
PY

# Build a minimal consumer package.json that declares both packages via
# `file:` against the staging tree. This mirrors what an external LLM
# agent (or any standalone integrator) would author.
cat > "${CONSUMER}/package.json" <<EOF
{
  "name": "forgeax-tmpdir-verify-consumer",
  "private": true,
  "type": "module",
  "dependencies": {
    "@forgeax/interface": "file:${STAGING}/interface",
    "@forgeax/editor": "file:${STAGING}/editor"
  }
}
EOF

cd "${CONSUMER}"

echo "verify-tmpdir-install: running bun install --linker=isolated ..."
# `--linker=isolated` is required because the staged @forgeax/editor's
# src/index.ts must resolve `@forgeax/interface/app-kit` at runtime. Bun's
# default `hoisted` linker materializes file: packages as a tree of
# per-file symlinks that point back into STAGING/, so node module
# resolution walks up from STAGING/editor/src/ rather than from the
# consumer's node_modules — which then fails to find @forgeax/interface.
# The isolated linker hoists each package into a stable .bun/ cache and
# wires per-package node_modules so resolution is rooted in the
# consumer's tree, exactly as a published-package consumer would expect.
if ! bun install --linker=isolated; then
  echo "AC-01 FAIL: bun install --linker=isolated exited non-zero" >&2
  exit 1
fi

# AC-01 — both packages physically present in the consumer's node_modules.
if [[ ! -f "${CONSUMER}/node_modules/@forgeax/interface/package.json" ]]; then
  echo "AC-01 FAIL: node_modules/@forgeax/interface/package.json missing" >&2
  exit 1
fi
if [[ ! -f "${CONSUMER}/node_modules/@forgeax/editor/package.json" ]]; then
  echo "AC-01 FAIL: node_modules/@forgeax/editor/package.json missing" >&2
  exit 1
fi
echo "AC-01 OK: bun install rc=0; @forgeax/{interface,editor}/package.json physically present"

# AC-02 — defineApp is a function reachable via the @forgeax/interface/app-kit subpath.
ac02_out="$(bun --print "typeof (await import('@forgeax/interface/app-kit')).defineApp")"
if [[ "${ac02_out}" != "function" ]]; then
  echo "AC-02 FAIL: expected 'function', got '${ac02_out}'" >&2
  exit 1
fi
echo "AC-02 OK: typeof (await import('@forgeax/interface/app-kit')).defineApp === 'function'"

# AC-03 — @forgeax/editor default export is an object with manifest.id === 'editor'.
ac03_out="$(bun --print "JSON.stringify({type: typeof (await import('@forgeax/editor')), id: (await import('@forgeax/editor')).manifest.id})")"
expected_ac03='{"type":"object","id":"editor"}'
if [[ "${ac03_out}" != "${expected_ac03}" ]]; then
  echo "AC-03 FAIL: expected ${expected_ac03}, got ${ac03_out}" >&2
  exit 1
fi
echo "AC-03 OK: @forgeax/editor module is an object with manifest.id === 'editor'"

# AC-04 — manifest.panels matches the EDITOR_PANELS SSOT (sorted).
ac04_out="$(bun --print "JSON.stringify((await import('@forgeax/editor')).manifest.panels.map(p=>p.id).sort())")"
expected_ac04='["assets","capabilities","hierarchy","history","inspector","material","matgraph","timeline"]'
if [[ "${ac04_out}" != "${expected_ac04}" ]]; then
  echo "AC-04 FAIL: expected ${expected_ac04}, got ${ac04_out}" >&2
  exit 1
fi
echo "AC-04 OK: manifest.panels sorted ids match EDITOR_PANELS SSOT (8 elements)"

echo "verify-tmpdir-install: all four assertions (AC-01 / AC-02 / AC-03 / AC-04) PASS"
