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

  test('points boot diagnostics at the current extensions endpoint', () => {
    const html = readFileSync(resolve(import.meta.dir, 'index.html'), 'utf8');

    expect(html).not.toContain('/api/bus/plugins');
    expect(html).toContain('/api/extensions/list');
  });
});
