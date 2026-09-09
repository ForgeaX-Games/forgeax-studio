import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  files?: string[];
};

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function sourceText(): string {
  return filesUnder(join(root, 'src'))
    .filter((path) => path.endsWith('.ts'))
    .map((path) => `${relative(root, path)}\n${readFileSync(path, 'utf8')}`)
    .join('\n');
}

describe('@forgeax/game Runtime package independence', () => {
  test('is a platform-neutral exact consumer of Universal', () => {
    expect(manifest.version).toBe('0.2.4');
    expect(manifest.dependencies).toEqual({ '@forgeax/game-runtime': '0.3.33' });
    expect(manifest.optionalDependencies).toBeUndefined();
    expect(manifest.os).toBeUndefined();
    expect(manifest.cpu).toBeUndefined();
    expect(manifest.files).toEqual(['dist', 'assets/skills', 'README.md']);
  });

  test('owns no Runtime or Engine SDK implementation and has no Studio fallback', () => {
    for (const path of [
      'src/runtime',
      'src/project/engine-sdk.ts',
      'scripts/build-runtime-artifact.ts',
      'scripts/build-runtime-manifest.ts',
      'scripts/build-engine-sdk.ts',
    ]) {
      expect(existsSync(join(root, path)), `Game still owns ${path}`).toBeFalse();
    }
    const source = sourceText();
    expect(source).not.toMatch(/(?:\.\.\/)+runtime\//);
    expect(source).not.toContain('FORGEAX_STUDIO_ROOT');
    expect(source).not.toContain('FORGEAX_RUNTIME_DEV_FALLBACK');
    expect(source).not.toContain('forgeax-studio');
    expect(source).toContain("from '@forgeax/game-runtime'");
  });

  test('externalizes Universal and never assembles Runtime payload in the Game build', () => {
    const build = readFileSync(join(root, 'build.mjs'), 'utf8');
    expect(build).toContain("external: ['@forgeax/game-runtime']");
    expect(build).not.toContain('FORGEAX_RUNTIME_ARTIFACT');
    expect(build).not.toContain('FORGEAX_RUNTIME_MANIFEST');
    expect(build).not.toContain('FORGEAX_ENGINE_SDK');
    expect(build).not.toMatch(/resolve\(assets,\s*['"](?:runtime|engine-sdk)['"]\)/);
  });

  test('delegates publishing to the shared reusable workflow instead of inlining it', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
    expect(() => Bun.YAML.parse(workflow)).not.toThrow();
    expect(workflow).toContain("tags: ['v*']");
    expect(workflow).not.toContain('ForgeaX-Games/forgeax-studio');
    expect(workflow).not.toContain('FORGEAX_STUDIO_ROOT');
    // The pipeline (build/scan/publish + every release-security gate) lives in the
    // org-shared workflow; this repo delegates to it, pinned to a version tag. The
    // pipeline's internal structure is contract-tested in forgeax-ci itself.
    expect(workflow).toMatch(/uses:\s+ForgeaX-Games\/forgeax-ci\/\.github\/workflows\/npm-publish\.yml@v\d+/u);
    expect(workflow).toMatch(/secrets:\s*\n\s+NPM_TOKEN:\s+\$\{\{ secrets\.NPM_TOKEN \}\}/u);
    // Security-sensitive steps must not be re-inlined here where they would drift
    // from the shared source.
    expect(workflow).not.toContain('npm publish');
    expect(workflow).not.toContain('verify-release-artifact');
    expect(workflow).not.toContain('--provenance');
  });
});
