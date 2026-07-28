import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  inspectSchemaVersionFiles,
  inspectSchemaVersionSource,
} from './schema-version-contract.ts';

function TypeScriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : TypeScriptFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

describe('single-version consumer schemas', () => {
  it('uses the TypeScript syntax tree across every AI-native consumer schema', () => {
    const result = inspectSchemaVersionFiles(TypeScriptFiles(import.meta.dir));
    expect(result.checked.length).toBeGreaterThanOrEqual(10);
    expect(result.violations).toEqual([]);
  });

  it('rejects a version union hidden behind a variable alias', () => {
    const result = inspectSchemaVersionSource('indirect.ts', `
      import { z } from 'zod';
      const hiddenVersion = z.union([z.literal(1), z.literal(2)]);
      const consumer = z.object({ schema_version: hiddenVersion });
      void consumer;
    `);
    expect(result.checked).toHaveLength(1);
    expect(result.violations[0]).toContain('exactly one literal schema');
  });

  it('rejects a version union hidden behind an object spread', () => {
    const result = inspectSchemaVersionSource('spread-hidden.ts', `
      import { z } from 'zod';
      const base = { schema_version: z.union([z.literal(1), z.literal(2)]) };
      const consumer = z.object({ ...base });
      void consumer;
    `);
    expect(result.checked).toHaveLength(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('exactly one literal schema');
  });

  it('rejects an object spread whose source cannot be resolved statically', () => {
    const result = inspectSchemaVersionSource('spread-dynamic.ts', `
      import { z } from 'zod';
      declare function shapeFromRuntime(): Record<string, unknown>;
      const consumer = z.object({ ...shapeFromRuntime() });
      void consumer;
    `);
    expect(result.checked).toHaveLength(0);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('must resolve to a static object literal');
  });
});
