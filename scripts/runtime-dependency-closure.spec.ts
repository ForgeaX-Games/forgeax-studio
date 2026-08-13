import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveBunDependency } from './lib/runtime-dependency-closure';

describe('Runtime dependency closure', () => {
  test('follows the parent package lock link when multiple versions exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-runtime-dependency-'));
    try {
      const store = join(root, 'node_modules/.bun');
      const parent = join(store, 'cos-request@1.3.3/node_modules/cos-request');
      const oldCookie = join(store, 'tough-cookie@4.1.4/node_modules/tough-cookie');
      const newCookie = join(store, 'tough-cookie@5.1.2/node_modules/tough-cookie');
      mkdirSync(dirname(parent), { recursive: true });
      mkdirSync(oldCookie, { recursive: true });
      mkdirSync(newCookie, { recursive: true });
      writeFileSync(join(oldCookie, 'package.json'), JSON.stringify({ name: 'tough-cookie', version: '4.1.4' }));
      writeFileSync(join(newCookie, 'package.json'), JSON.stringify({ name: 'tough-cookie', version: '5.1.2' }));
      symlinkSync('../../tough-cookie@4.1.4/node_modules/tough-cookie', join(dirname(parent), 'tough-cookie'));

      expect(resolveBunDependency(root, store, parent, 'tough-cookie')).toBe(realpathSync(oldCookie));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
