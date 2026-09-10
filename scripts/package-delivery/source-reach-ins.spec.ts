import { describe, expect, test } from 'bun:test';
import { findSourceReachIns, newReachIns, sourceReachInFingerprint } from './source-reach-ins.ts';

describe('submodule source reach-in contract', () => {
  test('finds relative imports and literal paths below a gitlink root', () => {
    const findings = findSourceReachIns({
      gitlinks: ['packages/editor', 'packages/server'],
      files: [
        { path: 'packages/studio/src/editor.ts', content: "import x from '../../editor/src/internal.ts';\n" },
        { path: 'vite.config.ts', content: "resolve(root, 'packages/server/src/main.ts')\n" },
        { path: 'packages/studio/src/public.ts', content: "import editor from '@forgeax/editor';\n" },
      ],
    });
    expect(findings.map((finding) => finding.target)).toEqual([
      'packages/editor/src/internal.ts',
      'packages/server/src/main.ts',
    ]);
  });

  test('fails only newly introduced reach-ins against a frozen baseline', () => {
    const current = [
      { file: 'a.ts', line: 1, specifier: '../editor/src/a', target: 'packages/editor/src/a' },
      { file: 'b.ts', line: 2, specifier: '../server/src/b', target: 'packages/server/src/b' },
    ];
    expect(newReachIns(current, [current[0]])).toEqual([current[1]]);
    expect(newReachIns(current, [sourceReachInFingerprint(current[0])])).toEqual([current[1]]);
  });
});
