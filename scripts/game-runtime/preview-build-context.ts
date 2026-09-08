export interface PreviewBuildContextOptions {
  readonly gameRoot: string;
  readonly gameId: string;
  readonly gameEntry: string;
  readonly projectRoot: string;
  readonly outputRoot: string;
}

/**
 * The static preview host and the Editor Vite config share one game context.
 * Keep the ordinary GAME_* variables populated during a build-once preview:
 * the pack producer and the single-game mount are consumers of that context,
 * while STATIC_GAME_* remains the browser-entry/staging boundary.
 */
export function previewBuildEnvironment(options: PreviewBuildContextOptions): Record<string, string> {
  return {
    FORGEAX_GAME_DIR: options.gameRoot,
    FORGEAX_GAME_ID: options.gameId,
    FORGEAX_STATIC_GAME_DIR: options.gameRoot,
    FORGEAX_STATIC_GAME_ID: options.gameId,
    FORGEAX_STATIC_GAME_ENTRY: options.gameEntry,
    FORGEAX_BUILD_OUT_DIR: options.outputRoot,
    FORGEAX_PROJECT_ROOT: options.projectRoot,
  };
}
