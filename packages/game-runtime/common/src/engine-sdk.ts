import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { EngineSdkInstall } from './types';

export function engineSdkRoot(commonRoot: string): string {
  return join(resolve(commonRoot), 'assets', 'engine-sdk');
}

export function installEngineSdkFrom(commonRoot: string, projectRoot: string): EngineSdkInstall {
  const source = engineSdkRoot(commonRoot);
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
      return top !== 'skills' && top !== 'source';
    },
  });

  let engineCommit: string | undefined;
  try {
    engineCommit = (JSON.parse(readFileSync(join(destination, 'engine-version.json'), 'utf8')) as { engineCommit?: string }).engineCommit;
  } catch {
    // Metadata is informative; declarations remain usable without it.
  }
  const bundledSource = join(source, 'source');
  const sourceRoot = existsSync(bundledSource) ? bundledSource : undefined;
  writeFileSync(join(resolve(projectRoot), '.forgeax', 'engine-sdk.json'), `${JSON.stringify({
    version: 2,
    engineCommit: engineCommit ?? 'unknown',
    sdkRoot: destination,
    ...(sourceRoot ? { sourceRoot } : {}),
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
  return { changed: true, sdkRoot: destination, engineCommit, ...(sourceRoot ? { sourceRoot } : {}) };
}
