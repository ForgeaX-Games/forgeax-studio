import { describe, expect, test } from 'bun:test';
import {
  branchFor,
  directoryFor,
  parseSubmoduleStatusPaths,
  parseWorktreeOptions,
  submoduleUpdateArgs,
  unresolvedSubmodulePaths,
} from './worktree.ts';

describe('Studio worktree bootstrap CLI', () => {
  test('uses the codex branch convention and a safe directory slug', () => {
    expect(branchFor('viewport/grid')).toBe('codex/viewport/grid');
    expect(branchFor('codex/already-prefixed')).toBe('codex/already-prefixed');
    expect(directoryFor('codex/viewport/grid')).toBe('viewport-grid');
  });

  test('parses complete and fast bootstrap options', () => {
    expect(parseWorktreeOptions([
      'feature-name',
      '--from', 'origin/main',
      '--slot', '2',
      '--isolate-user',
      '--env-file', '../local.env',
      '--jobs', '6',
    ])).toEqual({
      name: 'feature-name',
      from: 'origin/main',
      slot: 2,
      isolateUser: true,
      envFile: '../local.env',
      noSetup: false,
      jobs: 6,
    });
    expect(parseWorktreeOptions(['fast', '--fast']).noSetup).toBe(true);
    expect(parseWorktreeOptions(['fast', '--no-setup']).noSetup).toBe(true);
  });

  test('rejects unsafe names and reserved slot zero', () => {
    expect(() => parseWorktreeOptions(['../escape'])).toThrow(/simple git-safe name/);
    expect(() => parseWorktreeOptions(['feature', '--slot', '0'])).toThrow(/slot must be an integer from 1 to 4/);
    expect(() => parseWorktreeOptions(['feature', '--jobs', '33'])).toThrow(/jobs must be an integer from 1 to 32/);
  });

  test('uses shallow parallel submodule initialization with a full-depth retry shape', () => {
    expect(submoduleUpdateArgs(6)).toEqual([
      'submodule', 'update', '--init', '--recursive', '--depth', '1', '--jobs', '6',
    ]);
    expect(submoduleUpdateArgs(6, true)).toEqual([
      'submodule', 'update', '--init', '--recursive', '--jobs', '1',
    ]);
  });

  test('detects unresolved recursive submodules from Git status output', () => {
    expect(unresolvedSubmodulePaths([
      ' aaaaaaa packages/interface',
      '+bbbbbbb packages/editor',
      '-ccccccc packages/editor/packages/engine',
      ' Uddddddd packages/broken',
    ].join('\n'))).toEqual([
      'packages/editor',
      'packages/editor/packages/engine',
      'packages/broken',
    ]);
  });

  test('removes branch annotations before discovering nested floating repos', () => {
    expect(parseSubmoduleStatusPaths([
      ' 4be082e packages/agent-host (remotes/origin/HEAD)',
      '+ee28632 packages/editor (heads/codex/editor-fix)',
      ' a068be1 packages/editor/packages/engine (wasm-artifacts-1578)',
    ].join('\n'))).toEqual([
      'packages/agent-host',
      'packages/editor',
      'packages/editor/packages/engine',
    ]);
  });

  test('owns submodule initialization without replaying the repository post-checkout hook', async () => {
    const source = await Bun.file('./scripts/worktree.ts').text();
    expect(source).toContain('core.hooksPath=${emptyHooksPath}');
    expect(source).toContain('initializeSubmodules(targetRoot, options.jobs)');
    expect(source).not.toContain('Promise.resolve().then(() => initializeSubmodules(targetRoot, options.jobs))');
  });
});
