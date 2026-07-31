import { describe, expect, it } from 'bun:test';
import { compareSetupSnapshots, type SetupSnapshot } from './setup-version.ts';

const snapshot = (overrides: Partial<SetupSnapshot> = {}): SetupSnapshot => ({
  schemaVersion: 1,
  recordedAt: '2026-07-31T00:00:00.000Z',
  rootHead: 'root-a',
  submodules: [
    { path: 'packages/editor', pin: 'editor-pin-a', head: 'editor-pin-a' },
  ],
  ...overrides,
});

describe('setup version snapshots', () => {
  it('treats identical root and submodule state as current', () => {
    expect(compareSetupSnapshots(snapshot(), snapshot())).toEqual([]);
  });

  it('detects root, pin, checkout, and topology drift', () => {
    expect(compareSetupSnapshots(
      snapshot(),
      snapshot({
        rootHead: 'root-b',
        submodules: [
          { path: 'packages/editor', pin: 'editor-pin-b', head: 'editor-head-b' },
          { path: 'packages/server', pin: 'server-pin-a', head: '' },
        ],
      }),
    )).toEqual([
      'root HEAD root-a → root-b',
      'packages/editor pin editor-pin-a → editor-pin-b',
      'packages/editor checkout editor-pin-a → editor-head-',
      'packages/server added',
    ]);
  });
});
