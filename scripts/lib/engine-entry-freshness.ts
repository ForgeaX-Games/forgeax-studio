import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const ENGINE_ENTRY_OUTPUTS = ['index.mjs', 'index.d.ts'] as const;
export type EngineEntryOutputValidator = (path: string) => boolean;

function isNonEmptyFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** Checks the DevKit's Node entry without executing its CLI behavior. */
export function isValidNodeMjsArtifact(path: string): boolean {
  if (!isNonEmptyFile(path)) return false;
  const node = process.platform === 'win32' ? 'node.exe' : 'node';
  return spawnSync(node, ['--check', path], { stdio: 'ignore' }).status === 0;
}

/**
 * Returns the paths that would make a complete prepare incomplete.
 *
 * Most prepare artifacts only need an existence check here because their
 * package-specific freshness predicates validate their shape. The DevKit CLI
 * is different: it is executed by Node, so an empty or unparsable file must
 * be rejected even when it has a newer mtime than its sources.
 */
export function collectMissingEngineArtifacts(
  requiredPaths: readonly string[],
  validatedPaths: readonly string[] = [],
): string[] {
  const validated = new Set(validatedPaths);
  return requiredPaths.filter((path) =>
    !existsSync(path) || (validated.has(path) && !isValidNodeMjsArtifact(path)),
  );
}

export function formatMissingEngineArtifacts(
  missingPaths: readonly string[],
  retryCommand: string,
): string {
  return [
    'required engine artefacts missing after prepare:',
    ...missingPaths.map((path) => `  - ${path}`),
    `  retry: ${retryCommand}`,
  ].join('\n');
}

/**
 * Checks whether a package entry was built after its sources changed.
 *
 * TypeScript's incremental builder may validate a project without rewriting an
 * unchanged declaration file. In that case the prepare-owned sentinel is the
 * proof that the older index.d.ts was checked successfully against current
 * sources; index.mjs must still be newer on its own.
 */
export function isEngineEntryDistFresh(
  packageDir: string,
  declarationSentinel: string,
  outputs: readonly string[] = ENGINE_ENTRY_OUTPUTS,
  validateOutput: EngineEntryOutputValidator = isNonEmptyFile,
): boolean {
  const outputPaths = outputs.map((output) => join(packageDir, 'dist', output));
  if (
    outputPaths.length === 0 ||
    outputPaths.some((path) => !existsSync(path) || !validateOutput(path))
  ) return false;

  const outputMtimes = outputPaths.map((path) => statSync(path).mtimeMs);
  const declarationProofMs = outputs.includes('index.d.ts')
    ? existsSync(declarationSentinel)
      ? Math.max(
        statSync(join(packageDir, 'dist/index.d.ts')).mtimeMs,
        statSync(declarationSentinel).mtimeMs,
      )
      : statSync(join(packageDir, 'dist/index.d.ts')).mtimeMs
    : undefined;
  const oldestBuildProofMs = Math.min(...outputs.map((output, index) =>
    output === 'index.d.ts' ? declarationProofMs! : outputMtimes[index]));
  const sourceDir = join(packageDir, 'src');
  return !existsSync(sourceDir) || !anyNewerThan(sourceDir, oldestBuildProofMs);
}

export function areEnginePrepareArtifactsFresh(
  enginePkgDir: string,
  entryPackages: readonly string[],
  declarationSentinel: string,
): boolean {
  return entryPackages.every((name) =>
    isEngineEntryDistFresh(join(enginePkgDir, name), declarationSentinel),
  ) && isEngineEntryDistFresh(
    join(enginePkgDir, 'devkit'),
    declarationSentinel,
    ['cli.mjs'],
    isValidNodeMjsArtifact,
  );
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
