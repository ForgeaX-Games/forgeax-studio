import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
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

describe('@forgeax/game exact Engine boundary', () => {
  test('is platform-neutral and exact-pins the approved SDK carrier and package manager', () => {
    expect(manifest.version).toBe('0.3.10');
    expect(manifest.dependencies).toEqual({ '@forgeax/engine-sdk': '0.3.3', pnpm: '11.7.0' });
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.peerDependenciesMeta).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
    expect(manifest.os).toBeUndefined();
    expect(manifest.cpu).toBeUndefined();
    expect(manifest.files).toEqual(['dist', 'assets', 'docs/asset3d.md', 'docs/plugin-integration-standard.md', 'docs/engine-0.2.1-to-0.3.3-migration.md', 'README.md']);
  });

  test('contains the Engine adapter and no legacy Runtime or static Preview implementation', () => {
    for (const path of [
      'src/runtime',
      'src/services/launch.ts',
      'src/services/probe.ts',
      'src/run/static-preview.ts',
      'src/run/log-paths.ts',
      'scripts/build-authoring-assets.ts',
    ]) expect(existsSync(join(root, path)), `legacy path remains: ${path}`).toBeFalse();
    const source = sourceText();
    expect(source).toContain('4ad48ef03d8f8f1bb74f5bf7cde71c4799d51060');
    for (const forbidden of [
      '@forgeax/game-runtime',
      'FORGEAX_START_COMMAND',
      'FORGEAX_STUDIO_ROOT',
      'FORGEAX_RUNTIME_DEV_FALLBACK',
    ]) expect(source).not.toContain(forbidden);
  });

  test('builds one self-contained connector bundle without assembling Engine payloads', () => {
    const build = readFileSync(join(root, 'build.mjs'), 'utf8');
    expect(build).not.toContain('@forgeax/game-runtime');
    expect(build).not.toContain('FORGEAX_RUNTIME_ARTIFACT');
    expect(build).not.toContain('FORGEAX_ENGINE_SDK');
    expect(build).not.toMatch(/resolve\(assets,\s*['"](?:runtime|engine-sdk)['"]\)/);
  });
});
