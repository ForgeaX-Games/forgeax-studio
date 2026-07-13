/// <reference types="vite/client" />

// Build-time globals injected by studio's vite `define` (vite.config.ts) and read
// by the in-process editor engine boot (edit-runtime ViewportComponent / host-boot),
// whose source studio's tsc program pulls in via the workspace symlink. Both are
// null in studio (multi-game: the active game is pinned at runtime via
// setPinnedSlug + ?scene=/?gameRoot=, not baked at build). Mirrors the editor
// submodule's own edit-runtime/src/globals.d.ts, which studio's program can't see.
declare const __FORGEAX_GAME_DIR_ABS__: string | null;
declare const __FORGEAX_GAME_SLUG__: string | null;
// Dedicated origin the in-process engine fetches game assets from (perf "A"):
// in dev this is the play-engine vite (:15173) so asset traffic gets its OWN
// browser connection pool, separate from the shell API on the page origin.
// Empty string = same-origin (packaged build / A disabled → the concurrency
// gate falls back to capping, perf "C").
declare const __FORGEAX_ASSET_ORIGIN__: string;
