import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

function commandPath(command: string): string {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  return execFileSync(lookup, [command], { encoding: 'utf8' }).trim().split(/\r?\n/u)[0]!;
}

describe('GP-CLI scoped npm bin resolution', () => {
  test('BIN-01: npx selects the packed scoped game alias despite a hostile global forgeax-game', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-bin-resolution-'));
    const packageRoot = join(root, 'package');
    const packageBin = join(packageRoot, 'bin');
    const packRoot = join(root, 'packed');
    const home = join(root, 'home');
    const cache = join(root, 'cache');
    const hostileBin = join(root, 'hostile-bin');
    const hostileMarker = join(root, 'hostile-marker');
    mkdirSync(packageBin, { recursive: true });
    mkdirSync(packRoot, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(cache, { recursive: true });
    mkdirSync(hostileBin, { recursive: true });

    try {
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@forgeax/game',
          version: '1.0.0',
          bin: { 'forgeax-game': 'bin/cli.js', game: 'bin/cli.js' },
        }),
      );
      writeFileSync(
        join(packageBin, 'cli.js'),
        '#!/usr/bin/env node\nconsole.log(`candidate:${process.argv.slice(2).join(",")}`);\n',
      );
      chmodSync(join(packageBin, 'cli.js'), 0o755);
      writeFileSync(
        join(hostileBin, 'forgeax-game'),
        `#!/bin/sh\nprintf hostile > ${JSON.stringify(hostileMarker)}\nexit 99\n`,
      );
      chmodSync(join(hostileBin, 'forgeax-game'), 0o755);

      const npmPath = commandPath(process.platform === 'win32' ? 'npm.cmd' : 'npm');
      const npxPath = commandPath(process.platform === 'win32' ? 'npx.cmd' : 'npx');
      const packOutput = execFileSync(npmPath, ['pack', '--ignore-scripts', '--pack-destination', packRoot], {
        cwd: packageRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          npm_config_cache: cache,
          npm_config_userconfig: join(root, 'npmrc'),
          NPM_CONFIG_USERCONFIG: join(root, 'npmrc'),
          npm_config_audit: 'false',
          npm_config_fund: 'false',
        },
      });
      const archiveName = packOutput.trim().split(/\r?\n/u).at(-1)!;
      const archive = join(packRoot, archiveName);
      const originalPath = process.env.PATH ?? '';
      const output = execFileSync(npxPath, ['--yes', '--package', archive, '--', 'game', 'init'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          npm_config_cache: cache,
          npm_config_userconfig: join(root, 'npmrc'),
          NPM_CONFIG_USERCONFIG: join(root, 'npmrc'),
          npm_config_audit: 'false',
          npm_config_fund: 'false',
          PATH: `${hostileBin}${delimiter}${originalPath}`,
        },
      });

      expect(output).toContain('candidate:init');
      expect(existsSync(hostileMarker)).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, { timeout: 30_000 });
});
