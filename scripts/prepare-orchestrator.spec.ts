import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('prepare builds public Orchestrator entries after shared IDE dependencies are installed', () => {
  const src = readFileSync(new URL('./prepare.ts', import.meta.url), 'utf8');
  const build = src.indexOf("run('bun', ['run', '--cwd', 'packages/orchestrator', 'build']");
  expect(build).toBeGreaterThan(src.indexOf('runtime dependencies ready'));
  expect(build).toBeGreaterThan(src.indexOf('@forgeax/ide integration workspace dependencies ready'));
});
