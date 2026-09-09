import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import contract from './marketplace-package-consumer.v1.json';

const studioRoot = resolve(import.meta.dir, '..');
const ideRoot = resolve(process.env.FORGEAX_IDE_ROOT ?? resolve(studioRoot, 'packages/ide'));

describe('Marketplace npm package consumer contract', () => {
  test('uses the mounted IDE product manifest as the product selection SSOT', () => {
    const manifestPath = resolve(ideRoot, 'product/forgeax-product.json');
    const packagePath = resolve(ideRoot, 'package.json');
    expect(existsSync(manifestPath), `IDE product manifest unavailable at ${manifestPath}`).toBe(true);
    expect(existsSync(packagePath), `IDE package unavailable at ${packagePath}`).toBe(true);

    const product = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      extensions: Array<{ id: string; required: boolean }>;
    };
    const idePackage = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      optionalDependencies: Record<string, string>;
    };
    const selected = new Map(product.extensions.map(({ id, required }) => [id, required]));

    for (const [id, version] of Object.entries(contract.active)) {
      expect(selected.get(id), `${id} must be selected as optional`).toBe(false);
      expect(idePackage.optionalDependencies[id], `${id} exact semver`).toBe(version);
    }
    for (const id of Object.keys(contract.deferred)) {
      expect(selected.has(id), `${id} must remain deferred`).toBe(false);
    }
  });

  test('records compatibility as runtime slugs, never source filesystem locations', () => {
    const serialized = JSON.stringify(contract.legacyRuntimeSlugs);
    expect(serialized).not.toContain('packages/marketplace/extensions');
    for (const slugs of Object.values(contract.legacyRuntimeSlugs)) {
      expect(slugs.length).toBeGreaterThan(0);
      expect(slugs.every((slug) => !slug.includes('/'))).toBe(true);
    }
  });

  test('start and build entrypoints do not discover extension implementations from Marketplace', () => {
    for (const script of ['scripts/run.ts', 'scripts/build-extensions.ts']) {
      const source = readFileSync(resolve(studioRoot, script), 'utf8');
      expect(source, script).not.toContain('packages/marketplace/extensions');
    }
  });
});
