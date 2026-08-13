import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { __probeBrand } from '../vite-plugin-brand';

test('Studio brand loader uses the shared packages/brand source', () => {
  const previousOverride = process.env.FORGEAX_BRAND_DIR;
  delete process.env.FORGEAX_BRAND_DIR;

  try {
    const packageDir = resolve(import.meta.dir, '..');
    const resolution = __probeBrand(packageDir);
    const expectedRoot = resolve(packageDir, '..', 'brand');

    expect(resolution.brandRoot).toBe(expectedRoot);
    expect(existsSync(resolve(expectedRoot, 'defaults.forgeax.json'))).toBe(true);
    expect(resolution.config.id).toBe('forgeax');
  } finally {
    if (previousOverride === undefined) delete process.env.FORGEAX_BRAND_DIR;
    else process.env.FORGEAX_BRAND_DIR = previousOverride;
  }
});
