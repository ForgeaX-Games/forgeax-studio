#!/usr/bin/env bun
// Shared shared-game-library seeder (U1 — de-dups run.sh §3.5's inline bash).
// Symlinks each forge.json-bearing game from a source library dir into
// <instance>/.forgeax/games/<slug>, so the engine + server discovery chain
// (listAllGames / detectActiveSlug) sees shared games like locally-created ones.
//
//   FORGEAX_GAMES_SRC  source library (e.g. <repo>/packages/games)
//   FORGEAX_GAMES_DST  instance games dir (e.g. <instance>/.forgeax/games)
//
// slug = forge.json#id (authoritative), falling back to the directory name.
// A REAL directory of the same slug (a user's own game) is preserved — only
// symlinks are created or refreshed. Idempotent.
//
// PARITY: the desktop .app reimplements this in Rust at
// packages/interface/src-tauri/src/lib.rs::seed_shared_games (no Bun runtime
// dependency at .app launch). Keep the two in sync if you change the algorithm.
import {
  readdirSync, existsSync, lstatSync, readlinkSync, symlinkSync, rmSync, mkdirSync, readFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';

const src = process.env.FORGEAX_GAMES_SRC;
const dst = process.env.FORGEAX_GAMES_DST;
if (!src || !dst) {
  console.error('[seed-games] need FORGEAX_GAMES_SRC + FORGEAX_GAMES_DST');
  process.exit(2);
}
if (!existsSync(src)) {
  console.log(`[seed-games] source ${src} absent — nothing to seed`);
  process.exit(0);
}
mkdirSync(dst, { recursive: true });

for (const name of readdirSync(src)) {
  const dir = join(src, name);
  let st;
  try { st = lstatSync(dir); } catch { continue; }
  if (!st.isDirectory()) continue;
  const forge = join(dir, 'forge.json');
  if (!existsSync(forge)) { console.log(`[seed-games] skip ${name} (no forge.json)`); continue; }

  let slug = name;
  try {
    const id = (JSON.parse(readFileSync(forge, 'utf8')) as { id?: unknown }).id;
    if (typeof id === 'string' && id) slug = id;
  } catch { /* malformed forge.json → fall back to dir name */ }

  const target = join(dst, slug);
  try {
    const tst = lstatSync(target);
    if (tst.isSymbolicLink()) {
      if (readlinkSync(target) === dir) { console.log(`[seed-games] ${slug} ok`); continue; }
      rmSync(target); symlinkSync(dir, target); console.log(`[seed-games] ${slug} relinked`);
    } else {
      // Real dir at the same slug as a shared-library game: this is a stale
      // copy from before seed-games ran (or a manual cp from the source).
      // Editing packages/games/<slug>/ no longer reaches the runtime, which
      // silently lies — the canonical fix is to replace it with the symlink.
      // Keep the real dir as a `<slug>.bak-<ts>` sidecar so any local-only
      // changes are recoverable; never clobber blindly.
      const stamp = String(Math.floor(Date.now() / 1000));
      const backup = `${target}.bak-${stamp}`;
      renameSync(target, backup);
      symlinkSync(dir, target);
      console.warn(`[seed-games] ${slug} was a real dir shadowing a shared-library game — moved to ${backup} and linked.`);
    }
  } catch {
    symlinkSync(dir, target); console.log(`[seed-games] ${slug} linked`);
  }
}
