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

  test('bounds the explicit dependency declarations accepted by IDE #361', () => {
    // These declare an existing source dependency; they remain deletion blockers.
    // Do not exclude manifests or build scripts from the scanner to hide them.
    const declarations = ['package.json', 'product/direct-dependencies.json', 'scripts/check-direct-dependencies.ts'];
    const budget = baseline.consumers.ide.allowedReferences;
    for (const path of declarations) {
      expect(budget[path]).toBe(1);
      expect(evaluateReferenceRatchet({ [path]: 2 }, budget)).toEqual([
        `Interface debt increased: ${path} has 2 references (allowed 1)`,
      ]);
    }
    expect(evaluateReferenceRatchet({ 'src/product/new-interface-consumer.ts': 1 }, budget)).toEqual([
      'new Interface consumer path: src/product/new-interface-consumer.ts (1 reference)',
    ]);
  });

  test('rejects retired IDE paths and additional shell imports after builtin ownership', () => {
    const budget = baseline.consumers.ide.allowedReferences;
    expect(Object.values(budget).reduce((sum, count) => sum + count, 0)).toBe(11);
    for (const path of [
      'packages/extension-gallery/src/index.tsx',
      'packages/files/src/index.tsx',
      'src/integration/rest-studio-domain-clients.ts',
      'src/product/chat-runtime-adapter.tsx',
    ]) {
      expect(evaluateReferenceRatchet({ [path]: 1 }, budget)).toEqual([
        `new Interface consumer path: ${path} (1 reference)`,
      ]);
    }
    for (const [path, allowed] of [['src/main.tsx', 3], ['src/product/studio-composition.tsx', 1], ['src/types/interface-integration.d.ts', 1]] as const) {
      expect(evaluateReferenceRatchet({ [path]: allowed + 1 }, budget)).toEqual([
        `Interface debt increased: ${path} has ${allowed + 1} references (allowed ${allowed})`,
      ]);
    }
  });

  test('rejects Editor library regressions while allowing the standalone application budget', () => {
    // The root-only boundary job does not materialize Editor. Its actual package
    // manifests and tarball are checked by Editor's standalone-package-boundary
    // suite; this root contract must enforce the reference budget independently.
    expect(Object.keys(baseline.consumers.editor.allowedReferences)).toEqual([
      'apps/standalone/main.tsx', 'apps/standalone/package.json', 'vite.config.ts',
    ]);
    expect(evaluateReferenceRatchet({
      'apps/standalone/main.tsx': 3,
      'apps/standalone/package.json': 1,
      'vite.config.ts': 2,
    }, baseline.consumers.editor.allowedReferences)).toEqual([]);
    expect(evaluateReferenceRatchet({
      'package.json': 1,
      'packages/core/src/regression.ts': 1,
    }, baseline.consumers.editor.allowedReferences)).toEqual([
      'new Interface consumer path: package.json (1 reference)',
      'new Interface consumer path: packages/core/src/regression.ts (1 reference)',
    ]);
    expect(evaluateReferenceRatchet({
      'apps/standalone/main.tsx': 4,
    }, baseline.consumers.editor.allowedReferences)).toEqual([
      'Interface debt increased: apps/standalone/main.tsx has 4 references (allowed 3)',
    ]);
  });
});
