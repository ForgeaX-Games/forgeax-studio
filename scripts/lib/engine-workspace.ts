import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

// Keep in sync with the play-runtime file list in scripts/build-desktop.ts:
// any file vite.config.ts imports relatively must be materialized here too.
const ENGINE_ROOT_FILES = [
  'index.html',
  'vite.config.ts',
  'package.json',
  'pack-catalog.ts',
  'tsconfig.json',
  'rhi-debug-config.ts',
] as const;

export function materializePackagedEngineWorkspace(
  engineResourceRoot: string,
  engineWorkRoot: string,
  projectRoot: string,
  sharedDepsRoot: string = join(engineResourceRoot, '..', 'node_modules'),
): void {
  if (!existsSync(join(engineResourceRoot, 'vite.config.ts'))) {
    throw new Error(`packaged engine is missing ${join(engineResourceRoot, 'vite.config.ts')}`);
  }
  mkdirSync(engineWorkRoot, { recursive: true });

  for (const file of ENGINE_ROOT_FILES) {
    const source = join(engineResourceRoot, file);
    if (existsSync(source)) cpSync(source, join(engineWorkRoot, file), { force: true });
  }
  for (const directory of ['src', 'public']) {
    const source = join(engineResourceRoot, directory);
    const destination = join(engineWorkRoot, directory);
    rmSync(destination, { recursive: true, force: true });
    if (existsSync(source)) {
      cpSync(source, destination, {
        recursive: true,
        dereference: true,
        force: true,
      });
    }
  }
  // play-runtime creates this mount at Vite startup. Its target can be absent
  // in a packaged payload, making the symlink dangling; existsSync then cannot
  // see it on the next launch and Vite reports EEXIST. Recreate it per launch.
  rmSync(join(engineWorkRoot, 'shared-assets'), {
    recursive: true,
    force: true,
  });

  mkdirSync(join(projectRoot, '.forgeax', 'games'), { recursive: true });
  // Merged node_modules view: the engine payload ships only engine-local
  // packages (engine/editor source workspaces + pnpm-store runtime deps);
  // generic third-party lives once in the shared pool staged beside it
  // (resources/node_modules, consumed by the server sidecar). Junction every
  // entry of both into the work root, engine-local winning on conflict, so
  // resolution semantics match a single physical node_modules without
  // duplicating ~5GB into the bundle.
  mergeNodeModulesJunctions(join(engineWorkRoot, 'node_modules'), [
    join(engineResourceRoot, 'node_modules'),
    sharedDepsRoot,
  ]);
  replaceWithJunction(
    join(engineWorkRoot, '.forgeax'),
    join(projectRoot, '.forgeax'),
  );
}

/**
 * Recreate `linkRoot` as a real directory of junctions merging `sourceRoots`
 * in precedence order (first source wins per package). Scoped packages are
 * merged per-member because the same scope (@forgeax) exists in multiple
 * sources with disjoint members.
 */
function mergeNodeModulesJunctions(linkRoot: string, sourceRoots: string[]): void {
  rmSync(linkRoot, { recursive: true, force: true });
  mkdirSync(linkRoot, { recursive: true });
  const linked = new Set<string>();
  const link = (target: string, path: string): void => {
    if (linked.has(path) || !existsSync(target)) return;
    linked.add(path);
    // Junction targets must be absolute: a relative target would be resolved
    // against the LINK's directory and dangle.
    symlinkSync(resolve(target), path, 'junction');
  };
  for (const source of sourceRoots) {
    if (!existsSync(source)) continue;
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const sourceEntry = join(source, entry.name);
      if (entry.name.startsWith('@')) {
        mkdirSync(join(linkRoot, entry.name), { recursive: true });
        for (const sub of readdirSync(sourceEntry, { withFileTypes: true })) {
          link(join(sourceEntry, sub.name), join(linkRoot, entry.name, sub.name));
        }
      } else {
        link(sourceEntry, join(linkRoot, entry.name));
      }
    }
  }
}

function replaceWithJunction(path: string, target: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      rmSync(path, { recursive: true, force: true });
    } else {
      rmSync(path, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  symlinkSync(target, path, 'junction');
}
