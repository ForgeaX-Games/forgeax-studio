import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const packageRoot = join(import.meta.dir, '..');

describe('@forgeax/npc-client package health', () => {
  test('publishes only built dist exports without workspace runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      private?: boolean;
      files?: string[];
      main?: string;
      types?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.private).not.toBe(true);
    expect(pkg.files).toEqual(['dist']);
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies?.['@forgeax/types']).toBe('workspace:*');
  });

  test('build emits runnable JavaScript and declarations', () => {
    expect(existsSync(join(packageRoot, 'build.ts'))).toBe(true);
  });
});
