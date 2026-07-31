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
// The packaged desktop launcher calls the same function. Keep this file as the
// environment-driven CLI adapter used by prepare.ts.
import { seedSharedGames } from './lib/seed-games.ts';

const src = process.env.FORGEAX_GAMES_SRC;
const dst = process.env.FORGEAX_GAMES_DST;
if (!src || !dst) {
  console.error('[seed-games] need FORGEAX_GAMES_SRC + FORGEAX_GAMES_DST');
  process.exit(2);
}

try {
  seedSharedGames({
    source: src,
    destination: dst,
    log: (message) => console.log(`[seed-games] ${message}`),
    warn: (message) => console.warn(`[seed-games] ${message}`),
  });
} catch (error) {
  console.error(`[seed-games] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
