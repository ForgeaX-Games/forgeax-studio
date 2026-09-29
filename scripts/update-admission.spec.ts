import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
test('update help returns before any repository operation', () => {
  const result = spawnSync(process.execPath, ['scripts/fx.ts', 'update', '--help'], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Usage: bun fx update');
  expect(result.stdout).not.toContain('Checking working tree');
  expect(result.stderr).toBe('');
});

test('update has no implicit main rebase fallback', async () => {
  const source = await Bun.file(resolve(root, 'scripts/fx.ts')).text();
  const body = source.slice(source.indexOf('async function update('), source.indexOf('async function update(') + 7000);
  expect(body.indexOf('const up = upstream()')).toBeLessThan(body.indexOf('stashDirtyUpdateRepos('));
  expect(body).not.toContain("['rebase', 'origin/main']");
  expect(body).toContain('No changes made.');
});
