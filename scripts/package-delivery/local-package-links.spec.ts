import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeLocalPackageLinks,
  linkLocalPackage,
  localPackageLinkCiError,
  unlinkLocalPackage,
  validateLocalPackageLinkState,
} from './local-package-links.ts';

describe('local package link contract', () => {
  test('accepts a versioned, checkout-bound link record', () => {
    const state = {
      schemaVersion: 1 as const,
      links: {
        '@forgeax/example': {
          producerPath: '/tmp/example',
          producerRevision: 'a'.repeat(40),
          linkedAt: '2026-08-21T00:00:00.000Z',
        },
      },
    };
    expect(validateLocalPackageLinkState(state)).toEqual(state);
    expect(activeLocalPackageLinks(state)).toEqual(['@forgeax/example']);
    expect(localPackageLinkCiError(state)).toContain('@forgeax/example');
  });

  test('treats malformed state as fail-closed in CI', () => {
    expect(() => validateLocalPackageLinkState({ schemaVersion: 1, links: { bad: {} } })).toThrow();
    expect(localPackageLinkCiError({ schemaVersion: 1, links: { bad: {} } })).toContain('invalid');
    expect(localPackageLinkCiError({ schemaVersion: 1, links: {} })).toBeUndefined();
  });

  test('builds, links, records, and restores without changing dependency manifests', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-links-'));
    const producer = join(root, 'producer');
    mkdirSync(producer);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@forgeax/example': '1.0.0' } }));
    writeFileSync(join(root, 'bun.lock'), 'locked');
    writeFileSync(join(producer, 'package.json'), JSON.stringify({ name: '@forgeax/example', scripts: { build: 'bun build.ts' } }));
    const calls: string[] = [];
    const run = (command: string, args: string[], cwd: string) => {
      calls.push(`${cwd}:${command} ${args.join(' ')}`);
      return command === 'git' ? 'a'.repeat(40) : '';
    };
    try {
      linkLocalPackage({ root, packageName: '@forgeax/example', producerPath: producer, run, now: () => '2026-08-21T00:00:00.000Z' });
      expect(calls).toEqual([
        `${producer}:bun run build`,
        `${producer}:bun link`,
        `${root}:bun link @forgeax/example`,
        `${producer}:git rev-parse HEAD`,
      ]);
      expect(JSON.parse(readFileSync(join(root, '.forgeax/local-package-links.json'), 'utf8')).links['@forgeax/example'].producerRevision).toBe('a'.repeat(40));
      unlinkLocalPackage({ root, packageName: '@forgeax/example', run });
      expect(calls.slice(-2)).toEqual([
        `${root}:bun unlink @forgeax/example`,
        `${root}:bun install --frozen-lockfile --ignore-scripts`,
      ]);
      expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(JSON.stringify({ dependencies: { '@forgeax/example': '1.0.0' } }));
      expect(readFileSync(join(root, 'bun.lock'), 'utf8')).toBe('locked');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
