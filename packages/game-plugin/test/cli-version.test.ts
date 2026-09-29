import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { formatVersionTransition } from '../src/cli/dispatch';
import { RELEASE_IDENTITY } from '../src/install/release-manifest';

const root = resolve(import.meta.dir, '..');

describe('CLI version', () => {
  test('formats update transitions from old, current, and unknown configurations', () => {
    expect(formatVersionTransition('0.3.3')).toBe('0.3.3 -> 0.3.10');
    expect(formatVersionTransition('0.3.9')).toBe('0.3.9 -> 0.3.10');
    expect(formatVersionTransition('0.3.10')).toBe('0.3.10');
    expect(formatVersionTransition(undefined)).toBe('unknown -> 0.3.10');
  });

  for (const argument of ['version', '--version', '-v']) {
    test(`prints the running package version for ${argument}`, () => {
      const result = spawnSync(process.execPath, ['src/main.ts', argument], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(
        `${RELEASE_IDENTITY.gamePackage} ${RELEASE_IDENTITY.gameVersion}\n`,
      );
    });
  }

  test('update reports the configured package transition', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'forgeax-game-update-version-'));
    const home = join(fixture, 'home');
    const bin = join(fixture, 'bin');
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      '[mcp_servers.forgeax]\ncommand = "npx"\nargs = ["-y", "-p", "@forgeax/game@0.3.3", "forgeax-game", "mcp"]\n',
    );
    const npx = join(bin, 'npx');
    writeFileSync(
      npx,
      `#!/usr/bin/env node\nconst { spawn } = require('node:child_process');\nconst child = spawn(process.execPath, [${JSON.stringify(resolve(root, 'dist/main.js'))}, 'mcp'], { stdio: 'inherit' });\nchild.on('exit', (code) => process.exit(code ?? 1));\n`,
    );
    chmodSync(npx, 0o755);
    try {
      const result = spawnSync(
        process.execPath,
        [resolve(root, 'dist/main.js'), 'update', '--ide', 'codex'],
        {
          cwd: fixture,
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: home,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          },
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(
        `UPDATED Codex CLI: ${join(realpathSync(home), '.codex', 'config.toml')} (plugin 0.3.3 -> 0.3.10)`,
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
