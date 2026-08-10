import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

import { deriveNightlyContractRoster } from './nightly-contract-roster.ts';

const ROOT = resolve(import.meta.dir, '../..');
const MOVED_OWNER_FIXTURE = join(import.meta.dir, 'fixtures/nightly-contract-roster/moved-owner-path');

describe('nightly contract owner roster', () => {
  test('derives the current contract owners from workspace manifests', () => {
    const roster = deriveNightlyContractRoster(ROOT);

    expect(roster.map((entry) => entry.name)).toEqual([
      '@forgeax/types',
      '@forgeax/host-sdk',
      '@forgeax/server',
    ]);
    expect(roster.map((entry) => entry.testScript)).toEqual([
      'bun test',
      'bun test',
      'bun test',
    ]);
    expect(roster.map((entry) => entry.path)).toEqual([
      'packages/contracts/types',
      'packages/host-sdk',
      'packages/server',
    ]);
    expect(roster.map((entry) => entry.path)).not.toContain('packages/types');
  });

  test('fails closed when an owner workspace path has moved', () => {
    expect(() => deriveNightlyContractRoster(MOVED_OWNER_FIXTURE)).toThrow(
      /workspace package manifests missing.*packages\/types/,
    );
  });
});
