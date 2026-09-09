import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

const ACTIVE_ROOT_INPUTS = [
  '.dependency-cruiser.cjs',
  '.env.example',
  '.gitignore',
  '.gitmodules',
  'architecture/layer-model.ts',
  'deploy/dev/scripts/setup-state.ts',
  'packages/extension-discovery/src/scanner.ts',
  'scripts/check-boundaries.ts',
  'scripts/check-submodule-pins.ts',
  'scripts/fx.ts',
  'scripts/fx/commands/public-wrapper.fixture.json',
  'scripts/mirror/oss-assets/.github/workflows/ci.yml',
  'scripts/mirror/publish.sh',
  'scripts/mirror/route-back.sh',
  'scripts/prepare.ts',
] as const;

const RETIRED_ROOT_TOOLS = [
  'scripts/check-extension-layout.ts',
  'scripts/check-extension-layout.spec.ts',
  'scripts/fx/commands/marketplace.ts',
  'scripts/lib/ensure-standalone-plugin-toolchain.ts',
  'scripts/seed-agent-avatars.sh',
] as const;

describe('Marketplace root gitlink retirement', () => {
  test('moves the Forge default agent into the brand pack contract', () => {
    const brand = JSON.parse(read('packages/brand/defaults.forgeax.json')) as {
      assistant: Record<string, unknown> & {
        agent?: { id?: string; personaFiles?: { zh?: string; en?: string }; tools?: string[] };
      };
    };
    expect(brand.assistant.personaOverride).toBeUndefined();
    expect(brand.assistant.agent).toEqual({
      id: 'forge',
      personaFiles: {
        zh: 'personas/forge.zh.md',
        en: 'personas/forge.en.md',
      },
      tools: ['gen3d:*', 'character:*', 'team:*'],
    });
    for (const path of Object.values(brand.assistant.agent!.personaFiles!)) {
      const persona = read(`packages/brand/defaults.forgeax/${path}`);
      expect(persona.length).toBeGreaterThan(3_500);
      expect(persona).toContain('Forge');
    }
  });

  test('removes the Marketplace gitlink and all active root filesystem dependencies', () => {
    const staged = Bun.spawnSync(['git', 'ls-files', '--stage', 'packages/marketplace'], { cwd: ROOT });
    expect(staged.exitCode).toBe(0);
    expect(staged.stdout.toString().trim()).toBe('');
    for (const path of ACTIVE_ROOT_INPUTS) {
      expect(read(path), path).not.toContain('packages/marketplace');
    }
    expect(read('scripts/prepare.ts')).not.toContain('rootOwnedIntegrationSubmodules');
    for (const path of RETIRED_ROOT_TOOLS) expect(existsSync(resolve(ROOT, path)), path).toBe(false);
  });
});
