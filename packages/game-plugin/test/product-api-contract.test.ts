import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

const root = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('@forgeax/game product API contract', () => {
  test('uses canonical project routes in source and the shipped CLI bundle', () => {
    for (const path of ['src/cli/dispatch.ts', 'dist/main.js']) {
      const source = read(path);
      expect(source).toContain('/api/projects');
      expect(source).toContain('/api/projects/active');
      expect(source).not.toContain('/api/workbench/games');
    }
  });
});
