import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import config from './vite.config';

describe('Studio cold boot', () => {
  test('prebundles engine dependencies that the initial Vite crawl cannot discover', async () => {
    const resolvedConfig = typeof config === 'function'
      ? await config({
          command: 'serve',
          mode: 'test',
          isSsrBuild: false,
          isPreview: false,
        })
      : await config;
    const includes = resolvedConfig.optimizeDeps?.include ?? [];

    expect(includes).toContain('@forgeax/engine-codec > fzstd');
    expect(includes).toContain('@forgeax/engine-image > jpeg-js');
    expect(includes).toContain('@forgeax/engine-image > upng-js');
    expect(includes).toContain('@forgeax/engine-pack > uuidv7');
  });

  test('composes each shared Noble entry exactly once', async () => {
    const resolvedConfig = typeof config === 'function'
      ? await config({
          command: 'serve',
          mode: 'test',
          isSsrBuild: false,
          isPreview: false,
        })
      : await config;
    const includes = resolvedConfig.optimizeDeps?.include ?? [];
    const nobleIncludes = [
      '@forgeax/engine-animation > @noble/hashes/blake3.js',
      '@forgeax/engine-pack > @noble/hashes/sha2.js',
      '@forgeax/engine-pack > @noble/hashes/utils.js',
    ];

    expect(includes.filter((entry) => nobleIncludes.includes(entry))).toEqual(nobleIncludes);
    for (const entry of nobleIncludes) {
      expect(includes.filter((candidate) => candidate === entry)).toHaveLength(1);
    }
  });

  test('points boot diagnostics at the current extensions endpoint', () => {
    const html = readFileSync(resolve(import.meta.dir, 'index.html'), 'utf8');

    expect(html).not.toContain('/api/bus/plugins');
    expect(html).toContain('/api/extensions/list');
  });
});
