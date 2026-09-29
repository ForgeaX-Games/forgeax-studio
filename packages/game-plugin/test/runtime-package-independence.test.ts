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

describe('@forgeax/game Engine package independence', () => {
  test('is a platform-neutral exact consumer of the Engine SDK carrier', () => {
    expect(manifest.version).toBe('0.3.10');
    expect(manifest.dependencies).toEqual({ '@forgeax/engine-sdk': '0.3.3', pnpm: '11.7.0' });
    expect(manifest.optionalDependencies).toBeUndefined();
    expect(manifest.os).toBeUndefined();
    expect(manifest.cpu).toBeUndefined();
    expect(manifest.files).toEqual([
      'dist', 'assets', 'docs/asset3d.md', 'docs/plugin-integration-standard.md', 'docs/engine-0.2.1-to-0.3.3-migration.md', 'README.md',
    ]);
  });

  test('owns no Runtime implementation, Engine payload, or Studio fallback', () => {
    for (const path of [
      'src/runtime',
      'src/services/launch.ts',
      'src/services/probe.ts',
      'src/run/static-preview.ts',
      'scripts/build-runtime-artifact.ts',
      'scripts/build-engine-sdk.ts',
    ]) expect(existsSync(join(root, path)), `Game still owns ${path}`).toBeFalse();
    const source = sourceText();
    expect(source).not.toContain('@forgeax/game-runtime');
    expect(source).not.toContain('FORGEAX_STUDIO_ROOT');
    expect(source).not.toContain('FORGEAX_RUNTIME_DEV_FALLBACK');
    expect(source).toContain('@forgeax/engine-sdk');
  });

  test('builds one connector bundle without assembling Engine or Runtime payloads', () => {
    const build = readFileSync(join(root, 'build.mjs'), 'utf8');
    expect(build).not.toContain('@forgeax/game-runtime');
    expect(build).not.toContain('FORGEAX_RUNTIME_ARTIFACT');
    expect(build).not.toContain('FORGEAX_RUNTIME_MANIFEST');
    expect(build).not.toContain('FORGEAX_ENGINE_SDK');
    expect(build).not.toMatch(/resolve\(assets,\s*['"](?:runtime|engine-sdk)['"]\)/);
  });

  test('delegates publishing to the shared reusable workflow', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
    expect(() => Bun.YAML.parse(workflow)).not.toThrow();
    expect(workflow).toContain("tags: ['v*']");
    const parsed = Bun.YAML.parse(workflow) as { jobs: { publish: { uses: string; with: Record<string, unknown> } } };
    expect(parsed.jobs.publish.uses).toMatch(/^ForgeaX-Games\/forgeax-ci\/\.github\/workflows\/npm-publish\.yml@[a-f0-9]{40}$/u);
    expect(parsed.jobs.publish.with['package-profile']).toBe('bin');
    expect(workflow).toMatch(/secrets:\s*\n\s+NPM_TOKEN:\s+\$\{\{ secrets\.NPM_TOKEN \}\}/u);
    expect(workflow).not.toContain('npm publish');
    expect(workflow).not.toContain('FORGEAX_STUDIO_ROOT');
  });
});
