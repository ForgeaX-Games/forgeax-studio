import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLedgerV1Row } from './ledger-v1.schema';
import { loadCurrentBaselineState } from './baseline-state.ts';

const valid = {
  control_id: 'ctl_008f4dfc7fc3f5e36b4e8deb',
  surface: 'shortcut',
  effect_id: 'composer.set_slash_focused',
  disposition: 'view-opt',
  agent_equiv: 'none',
  headless: 'n-a',
  status: 'exempt',
  owner: 'us',
  evidence: 'packages/chat/src/components/ChatPanel/Composer.tsx:900 — The key handler changes the focused slash-menu row in component-local presentation state.',
} as const;

describe('ledger v1 fail-closed Zod schema', () => {
  it('accepts one exact nine-column row', () => {
    expect(parseLedgerV1Row(valid)).toEqual(valid);
  });

  it('rejects every missing column and every extra column', () => {
    for (const field of Object.keys(valid)) {
      const row = structuredClone(valid) as Record<string, unknown>;
      delete row[field];
      expect(() => parseLedgerV1Row(row), field).toThrow();
    }
    expect(() => parseLedgerV1Row({ ...valid, certainty: 'certain' })).toThrow();
  });

  it('rejects enum drift and hand-written migrated status', () => {
    for (const [field, value] of [
      ['surface', 'toolbar'],
      ['disposition', 'maybe'],
      ['agent_equiv', 'assumed'],
      ['headless', 'unknown'],
      ['status', 'migrated'],
      ['owner', 'somebody'],
    ] as const) {
      expect(() => parseLedgerV1Row({ ...valid, [field]: value }), `${field}=${value}`).toThrow();
    }
  });

  it('enforces status derivation and exemption reason codes', () => {
    expect(() => parseLedgerV1Row({ ...valid, disposition: 'tool', status: 'exempt' })).toThrow();
    expect(() => parseLedgerV1Row({ ...valid, disposition: 'view-opt', status: 'todo' })).toThrow();
    expect(() => parseLedgerV1Row({ ...valid, disposition: 'exempt', status: 'exempt' })).toThrow();
    expect(() => parseLedgerV1Row({ ...valid, disposition: 'exempt:human-input', status: 'todo' })).toThrow();
  });

  it('validates the complete checked-in ledger and its one-row-per-control invariant', () => {
    const root = join(import.meta.dir, '../..');
    const baselineId = loadCurrentBaselineState(root).currentBaselineId;
    const controlsPath = join(root, '.forgeax-harness/docs/ai-native/baseline', baselineId, 'controls.jsonl');
    const controls = readFileSync(controlsPath, 'utf8').trim().split('\n').filter(Boolean);
    const path = join(import.meta.dir, 'ledger-v1.jsonl');
    const rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => parseLedgerV1Row(JSON.parse(line)));
    expect(rows).toHaveLength(controls.length);
    expect(new Set(rows.map((row) => row.control_id)).size).toBe(controls.length);
    expect(rows.some((row) => (row.status as string) === 'migrated')).toBe(false);
  });
});
