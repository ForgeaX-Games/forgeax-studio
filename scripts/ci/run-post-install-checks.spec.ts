import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATIC_GATES, VITE_BUILDS } from './run-post-install-checks.ts';

describe('post-install CI stages', () => {
  it('keeps the independent static contract set complete', () => {
    expect(STATIC_GATES.map((task) => task.name)).toEqual([
      'Test @forgeax/agent-runtime',
      'Game engine-import resolution gate',
      'Game input-contract gate',
      'Typecheck @forgeax/platform-io',
      'interface package-boundary guard',
      'interface app-agnostic import guard',
      'Editor-core barrel-export contract',
      'New-game Play import-resolution contract',
      'New-game preview import-resolution contract',
    ]);
  });

  it('runs the two Vite-only builds as a separate bounded stage', () => {
    expect(VITE_BUILDS).toHaveLength(2);
    for (const task of VITE_BUILDS) {
      expect(task.args).toEqual(['run', 'vite', 'build']);
    }

    const packageBuild = (path: string): string | undefined => {
      const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, '../..', path), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      return pkg.scripts?.build;
    };
    expect(packageBuild('packages/interface/package.json'))
      .toBe('tsc -b tsconfig.lint.json && vite build');
    expect(packageBuild('packages/studio/package.json'))
      .toBe('tsc -b && vite build');
  });
});
