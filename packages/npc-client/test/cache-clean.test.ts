import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageRoot = join(import.meta.dir, '..');

describe('@forgeax/npc-client cache isolation', () => {
  test('packed-consumer smoke never writes the user home', () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'forgeax-npc-client-home-'));
    try {
      const result = spawnSync(process.execPath, ['test/pack-smoke.ts'], {
        cwd: packageRoot,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readdirSync(isolatedHome, { recursive: true })).toEqual([]);
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }, 120_000);
});
