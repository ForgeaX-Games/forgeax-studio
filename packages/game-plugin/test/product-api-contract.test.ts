import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

const root = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('@forgeax/game standalone Engine contract', () => {
  test('uses the exact carrier and does not recreate the retired server scaffold', () => {
    for (const path of ['src/cli/dispatch.ts', 'dist/main.js']) {
      const source = read(path);
      expect(source).toContain('createEmptyGameWithCarrier');
      expect(source).not.toContain('/api/projects');
      expect(source).not.toContain('/api/projects/active');
      expect(source).not.toContain('/api/workbench/games');
    }
  });
});
