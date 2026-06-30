/**
 * Negative-case tests — encode the error modes from
 * docs/v2-vision/architecture-evolution/03-AGENT-SKILL-PLUGIN-TRINITY.md §6.
 */
import { describe, it, expect } from 'bun:test';
import { ManifestSchema, parseManifest } from '../src/manifest';

const baseValidWorkbench = {
  schemaVersion: 1,
  id: '@forgeax-plugin/example-wb',
  version: '0.1.0',
  kind: 'workbench',
  displayName: { zh: 'Example-ZH', en: 'Example' },
  provides: { workbench: { id: 'example-wb' } },
};

describe('ManifestSchema · happy path', () => {
  it('accepts a minimal workbench manifest', () => {
    const r = ManifestSchema.safeParse(baseValidWorkbench);
    expect(r.success).toBe(true);
  });

  it('accepts string-form displayName (legacy)', () => {
    const r = ManifestSchema.safeParse({ ...baseValidWorkbench, displayName: 'Example' });
    expect(r.success).toBe(true);
  });
});

describe('ManifestSchema · R1 rule (one main kind)', () => {
  it('rejects workbench plugin that ALSO declares provides.agent', () => {
    // Build it via discriminated union — when kind=workbench, AgentManifestSchema
    // strict shape disallows provides.agent. (workbench schema's provides is sealed
    // to {workbench, skills?, tools?, events?}.)
    const bad = {
      ...baseValidWorkbench,
      provides: {
        workbench: { id: 'wb-bad' },
        agent: {
          id: 'agent-bad',
          role: 'coder',
          card: { name: 'X', color: '#fff', avatar: '🤖' },
          personaFile: './x.md',
        },
      },
    };
    const r = ManifestSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });
});

describe('ManifestSchema · required fields', () => {
  it('rejects missing schemaVersion', () => {
    const { schemaVersion, ...rest } = baseValidWorkbench;
    const r = ManifestSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it('rejects unknown kind', () => {
    const r = ManifestSchema.safeParse({ ...baseValidWorkbench, kind: 'unknown-kind' });
    expect(r.success).toBe(false);
  });

  it('rejects bad plugin id format', () => {
    const r = ManifestSchema.safeParse({ ...baseValidWorkbench, id: 'no-scope-id' });
    expect(r.success).toBe(false);
  });
});

describe('ManifestSchema · agent-specific', () => {
  it('rejects kind=agent without personaFile', () => {
    const r = ManifestSchema.safeParse({
      schemaVersion: 1,
      id: '@forgeax-plugin/agent-bad',
      version: '0.1.0',
      kind: 'agent',
      displayName: { zh: 'X' },
      provides: {
        agent: {
          id: 'agent-bad',
          role: 'coder',
          card: { name: 'X', color: '#fff', avatar: '🤖' },
          // personaFile missing
        },
      },
    });
    expect(r.success).toBe(false);
  });
});

describe('ManifestSchema · skill-specific', () => {
  it('rejects kind=skill with empty provides.skills', () => {
    const r = ManifestSchema.safeParse({
      schemaVersion: 1,
      id: '@forgeax-plugin/skill-empty',
      version: '0.1.0',
      kind: 'skill',
      displayName: { zh: 'X' },
      provides: { skills: [] },
    });
    expect(r.success).toBe(false);
  });
});

describe('parseManifest helper', () => {
  it('emits warning when description is missing', () => {
    const r = parseManifest(baseValidWorkbench);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('description'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ManifestToolEntrySchema · requireConfirm three-value enum (AC-01)
// ---------------------------------------------------------------------------
import { ManifestToolEntrySchema } from '../src/tool';

const baseToolEntry = { id: 'my-tool' };

describe('ManifestToolEntrySchema · requireConfirm happy-path', () => {
  it('accepts requireConfirm: "always"', () => {
    const r = ManifestToolEntrySchema.safeParse({ ...baseToolEntry, requireConfirm: 'always' });
    expect(r.success).toBe(true);
  });

  it('accepts requireConfirm: "destructive"', () => {
    const r = ManifestToolEntrySchema.safeParse({ ...baseToolEntry, requireConfirm: 'destructive' });
    expect(r.success).toBe(true);
  });

  it('accepts requireConfirm: "never"', () => {
    const r = ManifestToolEntrySchema.safeParse({ ...baseToolEntry, requireConfirm: 'never' });
    expect(r.success).toBe(true);
  });

  it('accepts missing requireConfirm (undefined)', () => {
    const r = ManifestToolEntrySchema.safeParse(baseToolEntry);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.requireConfirm).toBeUndefined();
    }
  });
});

describe('ManifestToolEntrySchema · requireConfirm reject-path', () => {
  it('rejects requireConfirm: true (boolean)', () => {
    const r = ManifestToolEntrySchema.safeParse({ ...baseToolEntry, requireConfirm: true });
    expect(r.success).toBe(false);
  });

  it('rejects requireConfirm: false (boolean)', () => {
    const r = ManifestToolEntrySchema.safeParse({ ...baseToolEntry, requireConfirm: false });
    expect(r.success).toBe(false);
  });

  it('rejects requireConfirm: "" (empty string)', () => {
    const r = ManifestToolEntrySchema.safeParse({ ...baseToolEntry, requireConfirm: '' });
    expect(r.success).toBe(false);
  });

  it('rejects requireConfirm: "risky" (unknown enum value)', () => {
    const r = ManifestToolEntrySchema.safeParse({ ...baseToolEntry, requireConfirm: 'risky' });
    expect(r.success).toBe(false);
  });

  it('rejects requireConfirm: null', () => {
    const r = ManifestToolEntrySchema.safeParse({ ...baseToolEntry, requireConfirm: null });
    expect(r.success).toBe(false);
  });

  it('rejects requireConfirm: 1 (number)', () => {
    const r = ManifestToolEntrySchema.safeParse({ ...baseToolEntry, requireConfirm: 1 });
    expect(r.success).toBe(false);
  });
});

/* ============================================================================
 * DUAL-MODALITY-UI sec 4.2 - provides.surfaces[]
 * ==========================================================================*/

describe('ManifestSchema - provides.surfaces[]', () => {
  it('accepts workbench manifest with surfaces[]', () => {
    const m = {
      ...baseValidWorkbench,
      provides: {
        workbench: { id: 'example-wb' },
        surfaces: [
          {
            id: 'wb-character.list',
            schema: './surfaces/list.schema.json',
            actions: [
              { id: 'create', exposedToAI: true, permission: 'fs.write' },
              { id: 'delete', exposedToAI: true, permission: 'fs.write', requireConfirm: 'destructive' },
              { id: 'select', exposedToAI: false },
            ],
          },
        ],
      },
    };
    const r = ManifestSchema.safeParse(m);
    expect(r.success).toBe(true);
  });

  it('accepts surface with no actions (snapshot-only)', () => {
    const m = {
      ...baseValidWorkbench,
      provides: {
        workbench: { id: 'example-wb' },
        surfaces: [{ id: 'wb-foo.readonly' }],
      },
    };
    const r = ManifestSchema.safeParse(m);
    expect(r.success).toBe(true);
  });

  it('rejects surface action with empty id', () => {
    const m = {
      ...baseValidWorkbench,
      provides: {
        workbench: { id: 'example-wb' },
        surfaces: [{ id: 'wb.s', actions: [{ id: '' }] }],
      },
    };
    const r = ManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it('rejects surface action with bad requireConfirm value', () => {
    const m = {
      ...baseValidWorkbench,
      provides: {
        workbench: { id: 'example-wb' },
        surfaces: [{ id: 'wb.s', actions: [{ id: 'a', requireConfirm: 'maybe' }] }],
      },
    };
    const r = ManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it('rejects surfaces[] under cli-provider kind (R1)', () => {
    const m = {
      schemaVersion: 1,
      id: '@forgeax-plugin/cli-x',
      version: '0.1.0',
      kind: 'cli-provider',
      displayName: 'cli-x',
      provides: {
        cliProvider: { id: 'cli-x' },
        surfaces: [{ id: 'should.fail' }],
      },
    };
    const r = ManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
  });

  it('accepts tool-kind manifest carrying surfaces[]', () => {
    const m = {
      schemaVersion: 1,
      id: '@forgeax-plugin/t-with-surface',
      version: '0.1.0',
      kind: 'tool',
      displayName: 't-with-surface',
      provides: {
        tools: [{ id: 't.run', schema: { type: 'object' } }],
        surfaces: [{ id: 't.snapshot', actions: [{ id: 'run', exposedToAI: true }] }],
      },
    };
    const r = ManifestSchema.safeParse(m);
    expect(r.success).toBe(true);
  });
});
