import { describe, expect, test } from 'bun:test';
import { previewBuildEnvironment } from './preview-build-context';

describe('static preview build context', () => {
  test('binds the static entry and the ordinary active-game consumers to one root', () => {
    expect(previewBuildEnvironment({
      gameRoot: '/workspace/project/.forgeax/games/demo',
      gameId: 'demo',
      gameEntry: '/workspace/project/.forgeax/games/demo/src/main.ts',
      projectRoot: '/workspace/project',
      outputRoot: '/workspace/project/.forgeax/cache/preview/build.tmp',
    })).toEqual({
      FORGEAX_GAME_DIR: '/workspace/project/.forgeax/games/demo',
      FORGEAX_GAME_ID: 'demo',
      FORGEAX_STATIC_GAME_DIR: '/workspace/project/.forgeax/games/demo',
      FORGEAX_STATIC_GAME_ID: 'demo',
      FORGEAX_STATIC_GAME_ENTRY: '/workspace/project/.forgeax/games/demo/src/main.ts',
      FORGEAX_BUILD_OUT_DIR: '/workspace/project/.forgeax/cache/preview/build.tmp',
      FORGEAX_PROJECT_ROOT: '/workspace/project',
    });
  });
});
