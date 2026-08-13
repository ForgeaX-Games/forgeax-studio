import { afterEach, describe, expect, it } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanDesktopExtensions,
  selectDesktopExtensionClosure,
  desktopExtensionOutputName,
  desktopExtensionPathEscapesRoot,
  DesktopExtensionSelectionError,
} from './desktop-extension-selection.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const displayName = { zh: 'Test', en: 'Test' };

function agentContribution(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    role: 'test',
    card: { name: displayName, color: '#000', avatar: 'T' },
    personaFile: './persona.md',
    ...overrides,
  };
}

function v1Agent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id,
    version: '0.0.1',
    kind: 'agent',
    displayName,
    provides: { agent: agentContribution(`${id.split('/').at(-1)}-agent`, overrides) },
  };
}

function v1Cli(id: string) {
  return {
    schemaVersion: 1,
    id,
    version: '0.0.1',
    kind: 'cli-provider',
    displayName,
    provides: { cliProvider: { id } },
  };
}

function v1Skill(id: string, skillId = 'skill') {
  return {
    schemaVersion: 1,
    id,
    version: '0.0.1',
    kind: 'skill',
    displayName,
    provides: {
      skills: [{ id: skillId, entry: './SKILL.md' }],
    },
  };
}

function v2(id: string, contributes: Record<string, unknown>, dependencies?: unknown[]) {
  return {
    schemaVersion: 2,
    id,
    version: '0.0.1',
    displayName,
    ...(dependencies ? { dependencies } : {}),
    contributes,
  };
}

function fixture(manifests: Record<string, unknown>[]): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-desktop-selection-'));
  roots.push(root);
  for (const manifest of manifests) {
    const id = String(manifest.id).split('/').at(-1)!;
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'forgeax-extension.json'), `${JSON.stringify(manifest)}\n`);
  }
  return root;
}

describe('desktop extension selection', () => {
  it('rejects root escapes with POSIX or Windows separators', () => {
    expect(desktopExtensionPathEscapesRoot('../outside')).toBe(true);
    expect(desktopExtensionPathEscapesRoot('..\\outside')).toBe(true);
    expect(desktopExtensionPathEscapesRoot('inside/child')).toBe(false);
  });

  it('keeps v1 agent-with-tools as an agent and follows cli/skill soft refs', () => {
    const root = fixture([
      v1Agent('@test/agent', {
        tools: ['test:tool'],
        preferredCliProvider: '@test/cli',
        defaultSkills: [{ source: 'plugin', pluginId: '@test/skill', skillId: 'compose' }],
      }),
      v1Cli('@test/cli'),
      v1Skill('@test/skill', 'compose'),
    ]);
    const parsed = scanDesktopExtensions(root);
    expect(parsed.find((item) => item.id === '@test/agent')?.capabilities.agent).toBe(true);
    const selected = selectDesktopExtensionClosure(parsed, 'lite');
    expect(selected.included.map((item) => item.id)).toEqual([
      '@test/agent', '@test/cli', '@test/skill',
    ]);

    const staged = mkdtempSync(join(tmpdir(), 'forgeax-desktop-staged-'));
    roots.push(staged);
    for (const extension of selected.included) {
      cpSync(extension.dir, join(staged, desktopExtensionOutputName(extension)), {
        recursive: true,
        dereference: true,
      });
    }
    expect(scanDesktopExtensions(staged).map((item) => item.id)).toEqual([
      '@test/agent', '@test/cli', '@test/skill',
    ]);
  });

  it('treats v2 UI contributions as product priority and excludes mixed agents', () => {
    const root = fixture([
      v2('@test/mixed', {
        agents: [agentContribution('mixed')],
        panelTypes: [{ id: 'mixed-panel', runtime: 'inline', entry: './page.tsx' }],
      }),
      v2('@test/agent', { agents: [agentContribution('agent')] }),
      v2('@test/skill', { skills: [{ id: 'skill', entry: './SKILL.md' }] }),
    ]);
    const selected = selectDesktopExtensionClosure(scanDesktopExtensions(root), 'lite');
    expect(selected.included.map((item) => item.id)).toEqual(['@test/agent']);
    expect(selected.excluded.map((item) => item.id)).toEqual(['@test/mixed', '@test/skill']);
  });

  it('follows required dependencies, never follows optional dependencies, and rejects product closure', () => {
    const root = fixture([
      {
        ...v1Agent('@test/root', { }),
        dependencies: [
          { id: '@test/required' },
          { id: '@test/optional', optional: true },
        ],
      },
      v2('@test/required', { skills: [{ id: 'required', entry: './SKILL.md' }] }),
      v2('@test/optional', { skills: [{ id: 'optional', entry: './SKILL.md' }] }),
    ]);
    const selected = selectDesktopExtensionClosure(scanDesktopExtensions(root), 'lite');
    expect(selected.included.map((item) => item.id)).toEqual(['@test/required', '@test/root']);
    expect(selected.excluded.map((item) => item.id)).toEqual(['@test/optional']);

    const productRoot = fixture([
      {
        ...v1Agent('@test/root', {}),
        dependencies: [{ id: '@test/product' }],
      },
      v2('@test/product', { panelTypes: [{ id: 'product-panel', runtime: 'inline', entry: './page.tsx' }] }),
    ]);
    expect(() => selectDesktopExtensionClosure(scanDesktopExtensions(productRoot), 'lite'))
      .toThrow(DesktopExtensionSelectionError);
  });

  it('fails missing required dependencies and cycles, while soft defaultSkills stay warnings', () => {
    const missingRoot = fixture([{
      ...v1Agent('@test/root', { defaultSkills: [{ source: 'plugin', pluginId: '@test/missing' }] }),
      dependencies: [{ id: '@test/required' }],
    }]);
    expect(() => selectDesktopExtensionClosure(scanDesktopExtensions(missingRoot), 'lite'))
      .toThrow(/required dependency @test\/required/);
    const warningRoot = fixture([
      v1Agent('@test/root', { defaultSkills: [{ source: 'plugin', pluginId: '@test/missing' }] }),
    ]);
    expect(selectDesktopExtensionClosure(scanDesktopExtensions(warningRoot), 'lite').warnings)
      .toContain('@test/root defaultSkills references unavailable extension @test/missing');

    const cycleRoot = fixture([
      { ...v1Agent('@test/a'), dependencies: [{ id: '@test/b' }] },
      { ...v1Agent('@test/b'), dependencies: [{ id: '@test/a' }] },
    ]);
    expect(() => selectDesktopExtensionClosure(scanDesktopExtensions(cycleRoot), 'lite'))
      .toThrow(/required dependency cycle/);
  });

  it('rejects duplicate manifest ids and full returns every discovered extension', () => {
    const duplicateRoot = mkdtempSync(join(tmpdir(), 'forgeax-desktop-selection-'));
    roots.push(duplicateRoot);
    for (const name of ['one', 'two']) {
      const dir = join(duplicateRoot, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'forgeax-extension.json'), JSON.stringify(v1Skill('@test/duplicate')));
    }
    expect(() => scanDesktopExtensions(duplicateRoot)).toThrow(/duplicate extension id/);

    const root = fixture([v1Agent('@test/agent'), v1Cli('@test/cli'), v1Skill('@test/skill')]);
    const parsed = scanDesktopExtensions(root);
    expect(selectDesktopExtensionClosure(parsed, 'full').included.map((item) => item.id))
      .toEqual(parsed.map((item) => item.id));
  });
});
