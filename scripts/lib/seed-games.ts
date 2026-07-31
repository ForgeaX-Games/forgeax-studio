import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';

interface SeedSharedGamesOptions {
  readonly source: string;
  readonly destination: string;
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
}

export interface SeedSharedGamesResult {
  readonly linked: number;
  readonly refreshed: number;
  readonly unchanged: number;
  readonly skipped: number;
}

export function seedSharedGames(options: SeedSharedGamesOptions): SeedSharedGamesResult {
  const log = options.log ?? (() => {});
  const warn = options.warn ?? log;
  const result = {
    linked: 0,
    refreshed: 0,
    unchanged: 0,
    skipped: 0,
  };
  if (!existsSync(options.source)) {
    log(`source ${options.source} absent — nothing to seed`);
    return result;
  }
  mkdirSync(options.destination, { recursive: true });

  for (const name of readdirSync(options.source)) {
    const sourceGame = join(options.source, name);
    let sourceStat;
    try {
      sourceStat = lstatSync(sourceGame);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!sourceStat.isDirectory()) continue;

    const manifest = join(sourceGame, 'forge.json');
    if (!existsSync(manifest)) {
      result.skipped++;
      log(`skip ${name} (no forge.json)`);
      continue;
    }

    let slug = name;
    try {
      const id = (JSON.parse(readFileSync(manifest, 'utf8')) as { id?: unknown }).id;
      if (typeof id === 'string' && id) slug = id;
    } catch {
      warn(`${name}/forge.json is malformed; using directory name as slug`);
    }

    const target = join(options.destination, slug);
    let targetStat;
    try {
      targetStat = lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (!targetStat) {
      symlinkSync(sourceGame, target, 'junction');
      result.linked++;
      log(`${slug} linked`);
      continue;
    }

    if (targetStat.isSymbolicLink()) {
      if (readlinkSync(target) === sourceGame) {
        result.unchanged++;
        log(`${slug} ok`);
        continue;
      }
      rmSync(target);
      symlinkSync(sourceGame, target, 'junction');
      result.refreshed++;
      log(`${slug} relinked`);
      continue;
    }

    const backup = `${target}.bak-${Math.floor(Date.now() / 1000)}`;
    renameSync(target, backup);
    symlinkSync(sourceGame, target, 'junction');
    result.refreshed++;
    warn(`${slug} was a real dir shadowing a shared-library game — moved to ${backup} and linked.`);
  }

  return result;
}
