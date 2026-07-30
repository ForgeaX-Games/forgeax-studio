import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const STUDIO_SOURCE = resolve(import.meta.dir, '..');

function listProductionSource(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    if (statSync(fullPath).isDirectory()) {
      if (name !== '__tests__') listProductionSource(fullPath, files);
      continue;
    }
    if (
      (name.endsWith('.ts') || name.endsWith('.tsx')) &&
      !name.endsWith('.d.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.test.tsx') &&
      !name.endsWith('.spec.ts') &&
      !name.endsWith('.spec.tsx')
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

function importsFrom(source: string): string[] {
  const imports: string[] = [];
  const importPattern =
    /(?:import\s*(?:\([^)]*\)|[^'";]+?\s+from\s+)?|export\s+(?:\*|\{[^}]*\})\s+from\s+)['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(source))) imports.push(match[1]);
  return imports;
}

function productionFiles(): Array<{ path: string; source: string }> {
  return listProductionSource(STUDIO_SOURCE).map((path) => ({
    path,
    source: readFileSync(path, 'utf8'),
  }));
}

describe('Studio runtime UI facade boundary', () => {
  test('routes all editor access through the public @forgeax/editor facade', () => {
    const violations: string[] = [];
    for (const { path, source } of productionFiles()) {
      for (const specifier of importsFrom(source)) {
        const isEditorInternal = specifier.startsWith('@forgeax/editor-');
        const isEnginePackage = /^@forgeax\/engine(?:-|\/|$)/.test(specifier) || /^forgeax-engine(?:-|\/|$)/.test(specifier);
        const isRelativeEditorReachIn = /(^|\/)editor\/packages\//.test(specifier);
        if (isEditorInternal || isEnginePackage || isRelativeEditorReachIn) {
          violations.push(`${relative(resolve(STUDIO_SOURCE, '..', '..', '..'), path)} -> ${specifier}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  test('does not define a second runtime UI graph, provider, or relay', () => {
    const ownershipMarkers = /\b(?:create|use|get)?RuntimeUi(?:Graph|Provider|Relay)\b|\bruntimeUi(?:Graph|Provider|Relay)\b|\b(?:create)?(?:RuntimeUi)?FrameRelay\b/i;
    const violations = productionFiles()
      .flatMap(({ path, source }) => {
        const lines = source.split('\n');
        return lines.flatMap((line, index) =>
          ownershipMarkers.test(line) ? [`${relative(resolve(STUDIO_SOURCE, '..', '..', '..'), path)}:${index + 1}: ${line.trim()}`] : [],
        );
      });
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
