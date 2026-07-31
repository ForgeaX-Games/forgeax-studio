import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';

const ENGINE_ROOT_FILES = [
  'index.html',
  'vite.config.ts',
  'package.json',
  'pack-catalog.ts',
  'tsconfig.json',
] as const;

export function materializePackagedEngineWorkspace(
  engineResourceRoot: string,
  engineWorkRoot: string,
  projectRoot: string,
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
  replaceWithJunction(
    join(engineWorkRoot, 'node_modules'),
    join(engineResourceRoot, 'node_modules'),
  );
  replaceWithJunction(
    join(engineWorkRoot, '.forgeax'),
    join(projectRoot, '.forgeax'),
  );
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
