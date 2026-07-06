#!/usr/bin/env bun
// scripts/dev-local2.ts — SECOND local-only port band.
//
// Same intent as dev-local.ts (run the whole studio stack bound to 127.0.0.1 on
// a non-default port block) but on a THIRD, distinct band — for the case where
// BOTH the default ports (dev.ts → run.ts: 18900/18920/15173/15280) AND the
// dev-local.ts band (28900/28920/25173/25280) are already taken by other
// forgeax-studio checkouts / projects on this machine.
//
// This is a THIN wrapper: it only presets the port band + plugin offset, then
// delegates to dev-local.ts, which owns all the local-only launcher logic
// (127.0.0.1 binding, interface-vite proxy targets, reel URL, .env override
// warning). dev-local.ts uses set-if-absent (`process.env[k] ?? v`) semantics,
// so the values we preset here win and its own defaults are skipped. Keeping one
// launcher implementation avoids duplicating ~60 lines (SSOT).

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const e = (k: string, v: string) => {
  process.env[k] = process.env[k] ?? v;
};

// Band 3 — distinct from default (18900/15173) and dev-local (28900/25173).
e('FORGEAX_SERVER_PORT', '38900');
e('FORGEAX_INTERFACE_PORT', '38920');
e('FORGEAX_ENGINE_PORT', '35173');
e('FORGEAX_EDITOR_PORT', '35280');
e('NARRATIVE_PORT', '38930');
e('FACE_MASK_PORT', '38931');
// Distinct plugin band too (dev-local uses 10000) so all three stacks can
// coexist without their dynamic plugin ports racing.
e('FORGEAX_PLUGIN_PORT_OFFSET', '20000');

// Delegate to the shared local-only launcher. Pass env explicitly — under Bun,
// spawnSync does NOT inherit the parent's runtime-mutated process.env when `env`
// is omitted, so the overrides set above would be silently dropped.
const r = spawnSync(process.execPath, [join(ROOT, 'scripts/dev-local.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: ROOT,
  env: process.env,
});
process.exit(r.status ?? 0);
