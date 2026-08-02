#!/usr/bin/env bun
// Project read-only Soul packs from tracked shared games into the writable runtime tree.
// Source: <games>/<slug>/souls/<soulId>; destination: .forgeax/souls-builtin/<soulId>.
// Existing real directories are user-owned and are never replaced.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const gamesRoot = process.env.FORGEAX_GAMES_SRC;
const soulsRoot = process.env.FORGEAX_SOULS_DST;
if (!gamesRoot || !soulsRoot) {
  console.error('[seed-souls] need FORGEAX_GAMES_SRC + FORGEAX_SOULS_DST');
  process.exit(2);
}
if (!existsSync(gamesRoot)) process.exit(0);
mkdirSync(soulsRoot, { recursive: true });

for (const game of readdirSync(gamesRoot)) {
  const sourceRoot = join(gamesRoot, game, 'souls');
  if (!existsSync(sourceRoot)) continue;
  for (const soulId of readdirSync(sourceRoot)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(soulId) || soulId.includes('..')) {
      throw new Error(`[seed-souls] unsafe Soul id ${JSON.stringify(soulId)}`);
    }
    const source = resolve(sourceRoot, soulId);
    if (!lstatSync(source).isDirectory()) continue;
    const target = join(soulsRoot, soulId);
    try {
      const stat = lstatSync(target);
      if (!stat.isSymbolicLink()) {
        console.warn(`[seed-souls] keep user-owned directory ${target}; shared Soul ${soulId} was not projected`);
        continue;
      }
      if (resolve(join(soulsRoot, readlinkSync(target))) === source || resolve(readlinkSync(target)) === source) continue;
      rmSync(target);
    } catch { /* absent target */ }
    symlinkSync(source, target, 'junction');
    console.log(`[seed-souls] ${soulId} linked`);
  }
}
