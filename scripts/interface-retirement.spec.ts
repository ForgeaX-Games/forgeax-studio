import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import baseline from './interface-retirement.v1.json';
import {
  auditInterfaceRetirement,
  evaluateReferenceRatchet,
  scanInterfaceReferences,
  type ReferenceBudget,
} from './interface-retirement';

const ROOT = join(import.meta.dir, '..');

describe('Interface retirement contract', () => {
  test('allows existing debt to disappear but rejects every new consumer path', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'interface-retirement-ratchet-'));
    try {
      mkdirSync(join(scratch, 'src'), { recursive: true });
      writeFileSync(join(scratch, 'src/existing.ts'), [
        "import type { AppHost } from '@forgeax/interface/core/app-shell/types';",
      ].join('\n'));
      writeFileSync(join(scratch, 'src/new.ts'), [
        "import { App } from '@forgeax/interface/App';",
      ].join('\n'));

      const budget: ReferenceBudget = {
        'src/existing.ts': 2,
      };
      const references = scanInterfaceReferences(scratch);

      expect(evaluateReferenceRatchet(references, budget)).toEqual([
        'new Interface consumer path: src/new.ts (1 reference)',
      ]);
      expect(references['src/existing.ts']).toBe(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('does not scan materialized nested repositories as parent consumers', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'interface-retirement-nested-repo-'));
    try {
      mkdirSync(join(scratch, 'nested/.git'), { recursive: true });
      writeFileSync(join(scratch, 'nested/source.ts'), "import '@forgeax/interface';\n");

      expect(scanInterfaceReferences(scratch)).toEqual({});
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('freezes the latest-main debt as a monotonic baseline', () => {
    const audit = auditInterfaceRetirement(ROOT, baseline);

    expect(audit.ratchetViolations).toEqual([]);
    expect(audit.consumers.chat.referenceCount).toBe(0);
    expect(audit.consumers.dashboard.referenceCount).toBe(0);
    expect(audit.consumers.settings.referenceCount).toBe(0);
    expect(audit.consumers.ide.referenceCount).toBeGreaterThan(0);
  });

  test('keeps strict deletion readiness red until consumers and the Studio gitlink are gone', () => {
    const audit = auditInterfaceRetirement(ROOT, baseline);

    expect(audit.ready).toBe(false);
    expect(audit.readinessBlockers).toContain('ide still references @forgeax/interface');
    expect(audit.readinessBlockers).toContain('Studio still tracks packages/interface as a gitlink');
    expect(audit.readinessBlockers).toContain('Interface package retirement merge evidence is not recorded');
  });
});
