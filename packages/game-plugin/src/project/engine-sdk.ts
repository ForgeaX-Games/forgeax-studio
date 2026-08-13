import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { runtimeManifestRoot } from '../runtime/manifest';

function bundledSdkRoot(): string {
  return join(runtimeManifestRoot(), 'assets', 'engine-sdk');
}

export interface EngineSdkInstall {
  readonly changed: boolean;
  readonly sdkRoot: string;
  readonly engineCommit?: string;
  /** Absolute path to the bundled Engine source, when this build carries it. */
  readonly sourceRoot?: string;
}

/**
 * Materialize the Engine API snapshot generated from the bundled Runtime pin.
 *
 * Declarations and examples are copied into the project so they travel with it and
 * typecheck against it. Skills mount into the host's own skill directories, and the
 * Engine source tree stays in the package — it is tens of megabytes, identical for
 * every project, and only read on escalation, so `engine-sdk.json` records its
 * absolute path rather than duplicating it into each game.
 */
export function installEngineSdk(projectRoot: string): EngineSdkInstall {
  const source = bundledSdkRoot();
  const destination = join(projectRoot, '.forgeax', 'engine-sdk');
  if (!existsSync(source)) {
    return { changed: false, sdkRoot: destination };
  }
  mkdirSync(join(projectRoot, '.forgeax'), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    force: true,
    filter: (entry) => {
      if (entry === source) return true;
      const top = entry.slice(source.length + 1).split(sep)[0];
      return top !== 'skills' && top !== 'source';
    },
  });
  let engineCommit: string | undefined;
  try {
    engineCommit = (JSON.parse(readFileSync(join(destination, 'engine-version.json'), 'utf8')) as { engineCommit?: string }).engineCommit;
  } catch {
    /* An SDK without metadata is still useful for source inspection. */
  }
  const bundledSource = join(source, 'source');
  const sourceRoot = existsSync(bundledSource) ? bundledSource : undefined;
  writeFileSync(
    join(projectRoot, '.forgeax', 'engine-sdk.json'),
    `${JSON.stringify({
      version: 2,
      engineCommit: engineCommit ?? 'unknown',
      sdkRoot: destination,
      ...(sourceRoot ? { sourceRoot } : {}),
    }, null, 2)}\n`,
    'utf8',
  );
  const gamesRoot = join(projectRoot, '.forgeax', 'games');
  if (existsSync(gamesRoot)) {
    for (const entry of readdirSync(gamesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const gameRoot = join(gamesRoot, entry.name);
      const tsconfig = join(gameRoot, 'tsconfig.json');
      if (!existsSync(tsconfig)) {
        writeFileSync(
          tsconfig,
          `${JSON.stringify({
            extends: '../../engine-sdk/tsconfig.json',
            include: ['**/*.ts'],
          }, null, 2)}\n`,
          'utf8',
        );
      }
    }
  }
  return { changed: true, sdkRoot: destination, engineCommit, ...(sourceRoot ? { sourceRoot } : {}) };
}
