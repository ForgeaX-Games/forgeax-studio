import { describe, expect, test } from 'bun:test';
import { loadCiContractFiles } from './ci-contract.ts';
import { reduceCiStatus } from './ci-status.ts';

describe('CI local/external ready reducer', () => {
  test('only the crossed aligned pair is ready across all eight combinations', () => {
    const manifest = loadCiContractFiles().manifest;
    const external = ['aligned', 'misaligned', 'unverified', 'not-checked'] as const;
    let readyCount = 0;
    for (const local of ['aligned', 'non-ready'] as const) {
      for (const state of external) {
        const projection = reduceCiStatus(local, state, manifest);
        if (projection.status === 'ready') readyCount += 1;
        if (local === 'aligned' && state === 'aligned') {
          expect(projection.exitCode).toBe(0);
          expect(projection.overall).toBe('ready');
        } else {
          expect(projection.exitCode).toBe(3);
          expect(projection.overall).toBe('non-ready');
          expect(projection.code).toMatch(/^recursive-input\.ci\./);
          expect(projection.hint.length).toBeGreaterThan(0);
          expect(projection.expected).toHaveProperty('externalRuleset', 'aligned');
          expect(projection.actual).toEqual({ localStatic: local, externalRuleset: state });
          expect(projection.recoveryActions.length).toBeGreaterThan(0);
        }
      }
    }
    expect(readyCount).toBe(1);
  });
});
