/// <reference types="vite/client" />

// Build-time globals injected by studio's vite `define` (vite.config.ts) and read
// by the in-process editor engine boot (edit-runtime ViewportComponent / host-boot),
// whose source studio's tsc program pulls in via the workspace symlink. Both are
// null in studio (multi-game: the active game is pinned at runtime via
// setPinnedSlug + ?scene=/?gameRoot=, not baked at build). Mirrors the editor
// submodule's own edit-runtime/src/globals.d.ts, which studio's program can't see.
declare const __FORGEAX_GAME_DIR_ABS__: string | null;
declare const __FORGEAX_GAME_SLUG__: string | null;
