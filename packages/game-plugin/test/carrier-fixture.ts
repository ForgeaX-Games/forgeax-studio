import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_COMMIT, ENGINE_VERSION } from '../src/engine/release';

/**
 * A tiny packed/hoisted Game Plugin installation used by tests that exercise
 * release consumers. It deliberately lives under node_modules so production
 * carrier resolution follows the same confinement rules as npm installs.
 */
export function installTestCarrier(root: string): string {
  const modules = join(root, '.forgeax-test-plugin', 'node_modules');
  const plugin = join(modules, '@forgeax', 'game');
  const sdk = join(modules, '@forgeax', 'engine-sdk');
  const pnpm = join(modules, 'pnpm');
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, 'package.json'), `${JSON.stringify({
    name: '@forgeax/game',
    version: '0.3.5',
    dependencies: { '@forgeax/engine-sdk': ENGINE_VERSION, pnpm: '11.7.0' },
  })}\n`);
  mkdirSync(join(sdk, 'sdk', 'bin'), { recursive: true });
  writeFileSync(join(sdk, 'package.json'), `${JSON.stringify({ name: '@forgeax/engine-sdk', version: ENGINE_VERSION })}\n`);
  writeFileSync(join(sdk, 'sdk', 'sdk-manifest.json'), `${JSON.stringify({
    schemaVersion: '1.8.0',
    sdkVersion: ENGINE_VERSION,
    engineCommit: ENGINE_COMMIT,
    requirements: { pnpm: '11.7.0' },
    packages: [
      { name: '@forgeax/engine', version: ENGINE_VERSION },
      { name: '@forgeax/engine-devkit', version: ENGINE_VERSION },
    ],
  })}\n`);
  writeFileSync(join(sdk, 'sdk', 'bin', 'forgeax.mjs'), '');
  mkdirSync(join(pnpm, 'bin'), { recursive: true });
  writeFileSync(join(pnpm, 'package.json'), `${JSON.stringify({
    name: 'pnpm', version: '11.7.0', bin: { pnpm: 'bin/pnpm.mjs' },
  })}\n`);
  writeFileSync(join(pnpm, 'bin', 'pnpm.mjs'), '');
  return plugin;
}
