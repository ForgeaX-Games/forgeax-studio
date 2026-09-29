import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineGameId, resolveProject } from '../src/project/locate';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(manifest: object, dependency = true) {
  const root = mkdtempSync(join(tmpdir(), 'game-v2-test-'));
  roots.push(root);
  writeFileSync(join(root, 'forge.json'), JSON.stringify(manifest));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: dependency ? { '@forgeax/engine': '0.3.3' } : {} }));
  return root;
}
test('recognizes the strict released v2 manifest without injecting legacy entry', () => {
  const root = fixture({ id: 'template-empty', schemaVersion: '2.0.0', defaultScene: '019fb7ce-1000-7000-8000-000000000001', plugins: [] });
  expect(engineGameId(root)).toBe('template-empty');
  expect(resolveProject(root).root).toBe(root);
});
test('recognizes the released v3 Pack-root manifest', () => {
  const root = fixture({ id: 'game', schemaVersion: '3.0.0', roots: { engine: '0c5bf4c1-bbd0-58e6-8ac9-1347fd716b81' } });
  expect(engineGameId(root)).toBe('game');
  expect(resolveProject(root).root).toBe(root);
});
test('retains legacy recognition and rejects malformed or future manifest shapes', () => {
  expect(engineGameId(fixture({ id: 'legacy', entry: 'src/main.ts' }))).toBe('legacy');
  for (const manifest of [
    { id: 'bad', schemaVersion: '2.0.0', entry: 'src/main.ts' },
    { id: 'bad', schemaVersion: '2.0.0', defaultScene: 'not-a-guid' },
    { id: 'bad', schemaVersion: '3.0.0', entry: 'src/main.ts' },
    { id: 'bad', schemaVersion: '3.0.0', roots: { engine: 'not-a-guid' } },
    { id: 'bad', schemaVersion: '3.0.0', roots: [] },
    { id: 'bad', schemaVersion: '4.0.0', roots: {} },
  ]) expect(engineGameId(fixture(manifest))).toBeUndefined();
  expect(engineGameId(fixture({ id: 'bad', entry: 'src/main.ts' }, false))).toBeUndefined();
});
