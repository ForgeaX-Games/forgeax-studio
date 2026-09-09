import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fixture from './public-wrapper.fixture.json';

const ROOT = resolve(import.meta.dir, '../..', '..');

describe('public root wrapper contract', () => {
  it('declares only public cross-repository commands', () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(Object.keys(fixture.commands)).toEqual(['ide', 'versions', 'teardown']);
    expect(fixture.diagnostics.notMounted).toBe('IDE_MOUNT_NOT_FOUND');
  });

  it('uses a deterministic teardown command', () => {
    const source = readFileSync(resolve(ROOT, 'scripts/fx.ts'), 'utf8');
    const ideSource = readFileSync(resolve(ROOT, 'scripts/fx/commands/ide.ts'), 'utf8');
    expect(source).toContain('public-command-wrapper');
    expect(source).toContain('teardown');
    expect(ideSource).toContain('PUBLIC_TEARDOWN_COMMANDS');
    expect(source).not.toMatch(/packages\/(ide|marketplace|server|editor)\/src/);
  });

  it('does not encode internal paths in the public wrapper fixture', () => {
    const source = readFileSync(resolve(ROOT, 'scripts/fx.ts'), 'utf8');
    for (const fragment of fixture.forbiddenPathFragments) expect(source).not.toContain(fragment);
  });
});
