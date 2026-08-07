import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const ENGINE_ENTRY_OUTPUTS = ['index.mjs', 'index.d.ts'] as const;

/**
 * Checks whether a package entry was built after its sources changed.
 *
 * TypeScript's incremental builder may validate a project without rewriting an
 * unchanged declaration file. In that case the prepare-owned sentinel is the
 * proof that the older index.d.ts was checked successfully against current
 * sources; index.mjs must still be newer on its own.
 */
export function isEngineEntryDistFresh(packageDir: string, declarationSentinel: string): boolean {
  const runtimeEntry = join(packageDir, 'dist/index.mjs');
  const declarationEntry = join(packageDir, 'dist/index.d.ts');
  if (!existsSync(runtimeEntry) || !existsSync(declarationEntry)) return false;

  const declarationProofMs = existsSync(declarationSentinel)
    ? Math.max(statSync(declarationEntry).mtimeMs, statSync(declarationSentinel).mtimeMs)
    : statSync(declarationEntry).mtimeMs;
  const oldestBuildProofMs = Math.min(statSync(runtimeEntry).mtimeMs, declarationProofMs);
  const sourceDir = join(packageDir, 'src');
  return !existsSync(sourceDir) || !anyNewerThan(sourceDir, oldestBuildProofMs);
}

function anyNewerThan(dir: string, anchorMs: number): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (anyNewerThan(path, anchorMs)) return true;
    } else if (entry.isFile() && statSync(path).mtimeMs > anchorMs) {
      return true;
    }
  }
  return false;
}
