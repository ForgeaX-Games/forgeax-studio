#!/usr/bin/env bun
// scripts/dev-local.ts — local-only launcher: run the studio stack on a port
// block that won't clash with another forgeax-studio on the default ports, bound
// to 127.0.0.1 only. Replaces dev-local.sh; retained as a lower-level launcher
// and intentionally not exposed as a top-level `bun fx` command.
//
// Plugin dev ports are seeded from each plugin manifest's sa.port (shared across
// stacks); FORGEAX_PLUGIN_PORT_OFFSET=10000 moves this stack's whole plugin band
// deterministically so two stacks starting near-simultaneously don't race.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const e = (k: string, v: string) => {
  process.env[k] = process.env[k] ?? v;
};

e('FORGEAX_SERVER_PORT', '28900');
e('FORGEAX_INTERFACE_PORT', '28920');
e('FORGEAX_ENGINE_PORT', '25173');
// No editor port — the Edit engine boots in-process in the interface vite.
e('NARRATIVE_PORT', '28930');
e('FACE_MASK_PORT', '28931');
e('FORGEAX_PLUGIN_PORT_OFFSET', '10000');
const offset = Number.parseInt(process.env.FORGEAX_PLUGIN_PORT_OFFSET as string, 10);
// interface vite reverse-proxies /__reel__ to wb-reel's front vite (default
// 127.0.0.1:15175); after the offset it moves to 15175+offset — keep them in sync.
e('FORGEAX_REEL_URL', `http://127.0.0.1:${15175 + offset}`);

// Bind local-only + point the interface vite proxies at THIS stack's ports.
e('FORGEAX_SERVER_HOST', '127.0.0.1');
e('FORGEAX_SERVER_URL', `http://127.0.0.1:${process.env.FORGEAX_SERVER_PORT}`);
e('FORGEAX_ENGINE_URL', `http://127.0.0.1:${process.env.FORGEAX_ENGINE_PORT}`);

// .env port-override detection — run.ts loads .env, an uncommented port line wins.
const envFile = join(ROOT, '.env');
if (existsSync(envFile) && /^\s*FORGEAX_(SERVER|INTERFACE|ENGINE)_PORT=/m.test(readFileSync(envFile, 'utf8'))) {
  console.error(`  ⚠ ${envFile} has an uncommented FORGEAX_*_PORT — it overrides this script's ports.`);
}

console.log('──────────────────────────────────────────────────────────────');
console.log('  forgeax-studio · local ports (localhost only)');
console.log(`    server     http://127.0.0.1:${process.env.FORGEAX_SERVER_PORT}`);
console.log(`    interface  http://127.0.0.1:${process.env.FORGEAX_INTERFACE_PORT}   ← open this`);
console.log(`    engine     http://127.0.0.1:${process.env.FORGEAX_ENGINE_PORT}`);
console.log(`    plugins    seed+${offset}`);
console.log('──────────────────────────────────────────────────────────────');

// NB: pass env explicitly — under Bun, spawnSync does NOT inherit the parent's
// (runtime-mutated) process.env when `env` is omitted, so the port overrides set
// above would be silently dropped and run.ts would fall back to the default ports.
const r = spawnSync(process.execPath, [join(ROOT, 'scripts/run.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: ROOT,
  env: process.env,
});
process.exit(r.status ?? 0);
