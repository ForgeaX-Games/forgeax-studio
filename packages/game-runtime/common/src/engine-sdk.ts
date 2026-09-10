import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { EngineSdkInstall } from './types';

export function engineSdkRoot(commonRoot: string): string {
  return join(resolve(commonRoot), 'assets', 'engine-sdk');
}

export function installEngineSdkFrom(commonRoot: string, projectRoot: string): EngineSdkInstall {
  return installEngineSdkSnapshot(engineSdkRoot(commonRoot), projectRoot);
}

/**
 * Materialize an explicit Engine SDK snapshot.
 *
 * Normal package consumers call installEngineSdkFrom with this common package's root.
 * This lower-level entry exists only for standalone tooling that deliberately selects
 * a snapshot through FORGEAX_ENGINE_SDK.
 */
export function installEngineSdkSnapshot(sourceRoot: string, projectRoot: string): EngineSdkInstall {
  const source = resolve(sourceRoot);
  const destination = join(resolve(projectRoot), '.forgeax', 'engine-sdk');
  if (!existsSync(source)) return { changed: false, sdkRoot: destination };

  mkdirSync(join(resolve(projectRoot), '.forgeax'), { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    force: true,
    filter: (entry) => {
      if (entry === source) return true;
      const top = entry.slice(source.length + 1).split(sep)[0];
      // Skills mount into the host's own skill directories rather than the game. The
      // Engine source does travel with the project: an absolute path back into the
      // package dies with an evicted `npx` cache, taking the escalation rung of the
      // knowledge ladder with it.
      return top !== 'skills';
    },
  });

  let engineCommit: string | undefined;
  try {
    engineCommit = (JSON.parse(readFileSync(join(destination, 'engine-version.json'), 'utf8')) as { engineCommit?: string }).engineCommit;
  } catch {
    // Metadata is informative; declarations remain usable without it.
  }
  const installedSource = join(destination, 'source');
  const installedSourceRoot = existsSync(installedSource) ? installedSource : undefined;
  writeFileSync(join(resolve(projectRoot), '.forgeax', 'engine-sdk.json'), `${JSON.stringify({
    version: 2,
    engineCommit: engineCommit ?? 'unknown',
    sdkRoot: destination,
    ...(installedSourceRoot ? { sourceRoot: installedSourceRoot } : {}),
  }, null, 2)}\n`, 'utf8');

  const gamesRoot = join(resolve(projectRoot), '.forgeax', 'games');
  if (existsSync(gamesRoot)) {
    for (const entry of readdirSync(gamesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const tsconfig = join(gamesRoot, entry.name, 'tsconfig.json');
      if (!existsSync(tsconfig)) {
        writeFileSync(tsconfig, `${JSON.stringify({
          extends: '../../engine-sdk/tsconfig.json',
          include: ['**/*.ts'],
        }, null, 2)}\n`, 'utf8');
      }
    }
  }
  return {
    changed: true,
    sdkRoot: destination,
    engineCommit,
    ...(installedSourceRoot ? { sourceRoot: installedSourceRoot } : {}),
  };
}
