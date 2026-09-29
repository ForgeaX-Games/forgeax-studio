import { expect, test } from 'bun:test';
import manifest from '../package.json';
import { RELEASE_IDENTITY } from '../src/install/release-manifest';
import { launchSpec } from '../src/install/clients';

test('release identity and both npm launchers follow the package version', () => {
  expect(RELEASE_IDENTITY.gameVersion).toBe(manifest.version);
  for (const launch of [launchSpec('npx')]) {
    expect(launch.command).toBe('npx');
    expect(launch.args).toContain(`@forgeax/game@${manifest.version}`);
  }
});
