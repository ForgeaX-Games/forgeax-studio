import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { vitePluginBrand } from './vite-plugin-brand';
// Single-realm editor (feat-20260703): studio serves the forgeax engine
// IN-PROCESS in the :18920 host window — the editor viewport + ep:* panels are
// now in-process React components (renderEdit/renderEditorPanel), not a `/editor`
// iframe. This shared serve fragment (shader manifest + optional pack catalog) is
// the SAME one packages/editor/vite.config.ts consumes for its :15290 host.
//
// Why a RELATIVE import (allow-listed exception to check-boundaries rule 6,
// which otherwise locks studio onto the @forgeax/editor facade): this file is
// CONFIG-TIME code. Vite bundles the config with esbuild but externalizes bare
// package specifiers, so a `@forgeax/editor/...` subpath here would be loaded
// by node's ESM loader — which type-strips the .ts but rejects the preset
// chain's extensionless relative imports (ERR_MODULE_NOT_FOUND). The relative
// path keeps the preset INSIDE the esbuild config bundle, which handles TS +
// extensionless fine. Runtime source imports must still use the facade.
import { engineVitePreset } from '../editor/packages/edit-runtime/src/viewport/engine-vite-preset';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = resolve(PACKAGE_DIR, '../../.env');
if (existsSync(ROOT_ENV)) {
  for (const line of readFileSync(ROOT_ENV, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const SERVER = process.env.FORGEAX_SERVER_URL ?? 'http://127.0.0.1:18900';
const SERVER_WS = SERVER.replace(/^http/, 'ws');
const ENGINE = process.env.FORGEAX_ENGINE_URL ?? 'http://127.0.0.1:15173';
const ENGINE_WS = ENGINE.replace(/^http/, 'ws');
const REEL = process.env.FORGEAX_REEL_URL ?? 'http://127.0.0.1:15175';

// Single-realm engine serve fragment. base '/' — studio's own origin serves both
// the SPA and the engine modules, so shader/pack routes arrive un-prefixed (no
// base-strip). gameDirAbs:null — studio is MULTI-game (slug switches at runtime,
// not fixed at boot), so the in-process engine takes its per-game pack catalog
// from the play engine (:15173) via the existing /preview + /__import proxies
// (ViewportComponent fallback: /preview/pack-index/<slug>.json); the preset then
// only serves /shaders/manifest.json (forgeaxShader). preserveSymlinks:false —
// studio pulls dockview/@radix through packages/interface/node_modules; realpath
// dedupe (resolve.dedupe) collapses the @forgeax family to one instance so the
// in-process engine + editor + interface share ONE editor-shared store.
const enginePreset = engineVitePreset({ base: '/', gameDirAbs: null, preserveSymlinks: false });

// ── optimizeDeps.include — SSOT-derived, symmetric with .exclude (no hand list) ──
// The engine family is EXCLUDED from pre-bundle (enginePreset, native ESM). But
// the front-end app layer studio assembles (interface + the 前L2 overlay apps +
// chat + host-sdk) pulls a large set of THIRD-PARTY deps (dockview, @radix-ui/*,
// cmdk, lucide-react, react-markdown, zod, zustand, …). If those are neither
// excluded nor pre-declared, Vite discovers them mid-crawl on the first cold
// load, triggers an esbuild re-optimize, and FORCES A FULL PAGE RELOAD — which
// aborts every in-flight module request and restarts boot from scratch. On the
// in-process engine that reload means the viewport re-mounts and the boot overlay
// never sees `boot ✓ ready`, so a trivial game (spin-cube) sat on "正在加载游戏…"
// until the 90s hard cap.
//
// Fix: derive the include set the same way exclude is derived — from a SSOT, not
// a hand list (hand-listing was the original exclude bug; architecture-principles
// §1 SSOT / §2 Derive). SSOT here = the `dependencies` of the source packages
// studio aliases into its bundle (the same package dirs listed in resolve.alias).
// We union their non-@forgeax deps: @forgeax/* is handled by exclude, so it must
// never leak into include. Transitive deps (uuidv7, fzstd, @tanstack/*, …) are
// pulled in by this first optimize pass automatically — we only need the direct
// declared set to seed it, which is what kills the re-optimize.
//
// Resolvability gate: a dep DECLARED by a source package is not necessarily
// RESOLVABLE from studio's own module graph — e.g. `zod` is a dep of host-sdk /
// interface but lives in THEIR nested node_modules, and studio imports host-sdk
// via a src alias (not the package), so it never surfaces under studio. Vite
// HARD-FAILS at startup on any optimizeDeps.include entry it cannot resolve
// ("Failed to resolve dependency: zod"), which would crash the dev server. So we
// keep only entries resolvable from here; an un-resolvable one is dropped and, if
// actually imported later, just lazy-optimizes as before (one dep, no reload
// storm). createRequire rooted at this package = the same resolution base Vite's
// scanner uses.
function frontendPrebundleIncludes(): string[] {
  // The front-end source packages studio composes (mirror of resolve.alias
  // targets). Engine/editor packages are intentionally absent — they are the
  // exclude set. host-sdk carries zod; workbench/chat carry markdown+icons.
  const pkgDirs = ['interface', 'chat', 'dashboard', 'settings', 'workbench', 'host-sdk', 'studio'];
  const declared = new Set<string>(['react', 'react-dom', 'react-dom/client']);
  for (const dir of pkgDirs) {
    const pj = resolve(PACKAGE_DIR, '..', dir, 'package.json');
    if (!existsSync(pj)) continue;
    try {
      const deps = (JSON.parse(readFileSync(pj, 'utf-8')) as { dependencies?: Record<string, string> })
        .dependencies ?? {};
      for (const name of Object.keys(deps)) {
        if (!name.startsWith('@forgeax/')) declared.add(name);
      }
    } catch { /* unreadable package.json — skip; a missing dep just re-optimizes as before */ }
  }
  const req = createRequire(resolve(PACKAGE_DIR, 'package.json'));
  return [...declared].filter((name) => {
    try { req.resolve(name); return true; } catch { return false; }
  });
}

const HTTPS_ENABLED = process.env.FORGEAX_INTERFACE_HTTPS === '1';

// Registered external workspaces (~/.forgeax/known-projects.json). After a
// workspace hot-switch (POST /api/workspaces/activate) the Scene viewport's
// ▶ Play imports the game entry via `/@fs/<workspaceRoot>/.forgeax/games/…`
// (edit-runtime host-session resolveGameFsBase); any root outside fs.allow
// 403s → game entry never runs → world has no camera → per-frame RhiError.
// Read once at config load — a workspace registered for the FIRST time
// mid-session still 403s until the dev server restarts (registry re-read then).
function knownWorkspaceRoots(): string[] {
  try {
    // homedir() (node:os) — matches the canonical writer
    // (@forgeax/platform-io lib/known-projects.ts); process.env.HOME is unset on
    // Windows, which would resolve cwd-relative and never match.
    const file = resolve(homedir(), '.forgeax/known-projects.json');
    if (!existsSync(file)) return [];
    const j = JSON.parse(readFileSync(file, 'utf-8')) as { projects?: { path?: string }[] };
    return (j.projects ?? []).map((p) => p.path).filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}

// Prefer a hand-rolled cert at `<root>/.tls/{cert,key}.pem` (covers remote IPs
// in SAN); fall back to package-local then @vitejs/plugin-basic-ssl (localhost only).
const ROOT_TLS = resolve(PACKAGE_DIR, '../../.tls');
const tlsCertPath = existsSync(resolve(ROOT_TLS, 'cert.pem')) ? resolve(ROOT_TLS, 'cert.pem') : resolve(PACKAGE_DIR, '.tls/cert.pem');
const tlsKeyPath = existsSync(resolve(ROOT_TLS, 'key.pem')) ? resolve(ROOT_TLS, 'key.pem') : resolve(PACKAGE_DIR, '.tls/key.pem');
const useCustomCert = HTTPS_ENABLED && existsSync(tlsCertPath) && existsSync(tlsKeyPath);
const httpsServerOption = useCustomCert
  ? { cert: readFileSync(tlsCertPath), key: readFileSync(tlsKeyPath) }
  : undefined;

export default defineConfig(({ command }) => ({
  plugins: [
    vitePluginBrand({ packageDir: PACKAGE_DIR }),
    react(),
    // Engine serve plugins (shader manifest; no pluginPack since gameDirAbs:null).
    // AFTER react() so the SPA transform runs first.
    ...enginePreset.plugins,
    ...(HTTPS_ENABLED && !useCustomCert ? [basicSsl()] : []),
  ],
  // Expose the game slug + abs dir to the client bundle. Studio is multi-game, so
  // both are null at build time (the active game is resolved at runtime by
  // useActiveSlug and passed to ViewportComponent as props in EditRealm). Null on
  // __FORGEAX_GAME_DIR_ABS__ selects the in-process engine's multi-game fallback
  // paths (/preview/pack-index/<slug>.json, root /__import).
  define: {
    __FORGEAX_GAME_SLUG__: JSON.stringify(null),
    __FORGEAX_GAME_DIR_ABS__: JSON.stringify(null),
    // Perf "A": in dev serve, point the in-process engine's asset fetches at the
    // play-engine vite origin (:15173) so a heavy game's asset burst uses its OWN
    // browser connection pool instead of contending with the shell API on the
    // page origin (:18920). Only for `serve` — a production build must keep
    // assets same-origin (empty string) since there's no vite sidecar; the
    // asset-fetch gate then falls back to concurrency-capping (perf "C").
    __FORGEAX_ASSET_ORIGIN__: JSON.stringify(
      command === 'serve' ? (process.env.FORGEAX_ASSET_ORIGIN ?? ENGINE) : '',
    ),
  },
  resolve: {
    // dockview declares react as a peer dep; under bun's isolated node_modules it
    // can resolve a SECOND react copy → "Invalid hook call / resolveDispatcher
    // null". Force a single react instance for all imports (incl. dockview). The
    // preset additionally dedupes the whole @forgeax family (engine-* + editor-*)
    // so the in-process engine, editor packages, and interface resolve to ONE
    // realpath — critical or the ep:* panels read a different editor-shared store
    // than the viewport and blank out. preserveSymlinks:false (preset) because
    // dockview/@radix nested deps live under the interface symlink target.
    dedupe: ['react', 'react-dom', ...enginePreset.resolve.dedupe],
    preserveSymlinks: enginePreset.resolve.preserveSymlinks,
    alias: {
      // More specific subpaths first — Vite matches string aliases by prefix
      // and uses the first hit, so '@forgeax/design' must come last.
      //
      // `@forgeax/interface/` — studio is a thin assembly shell. Its main.tsx
      // imports App / brand / lib / components from L1 via the package name;
      // we route all such subpath imports to interface/src/ here so vite + the
      // file watcher pick up changes immediately (HMR works) and tsc paths
      // (in studio/tsconfig.json) match. `package.json` `exports.*` covers
      // node-side resolution for `require.resolve` callers; this alias covers
      // bundler-side resolution + dev HMR.
      // `@forgeax/chat` — the 前L2 chat app (R4). studio injects it into the
      // interface shell via renderChat; route to chat/src so vite + the watcher
      // pick up source changes (HMR) and tsc paths in studio/tsconfig match.
      // The trailing-slash (subpath) alias MUST precede the bare-name one:
      // Vite does first-prefix-match, and the bare name is itself a prefix of
      // every subpath, so listing it first would greedily rewrite
      // `@forgeax/chat/session-store` → `…/chat/src/index.ts/session-store`.
      '@forgeax/chat/': `${resolve(PACKAGE_DIR, '../chat/src')}/`,
      '@forgeax/chat': resolve(PACKAGE_DIR, '../chat/src/index.ts'),
      // `@forgeax/dashboard` / `@forgeax/settings` / `@forgeax/ai-workbench` —
      // sibling 前L2 overlay apps (R4). Same subpath-before-bare ordering.
      '@forgeax/dashboard/': `${resolve(PACKAGE_DIR, '../dashboard/src')}/`,
      '@forgeax/dashboard': resolve(PACKAGE_DIR, '../dashboard/src/index.ts'),
      '@forgeax/settings/': `${resolve(PACKAGE_DIR, '../settings/src')}/`,
      '@forgeax/settings': resolve(PACKAGE_DIR, '../settings/src/index.ts'),
      '@forgeax/ai-workbench/': `${resolve(PACKAGE_DIR, '../workbench/src')}/`,
      '@forgeax/ai-workbench': resolve(PACKAGE_DIR, '../workbench/src/index.ts'),
      '@forgeax/interface/': `${resolve(PACKAGE_DIR, '../interface/src')}/`,
      // `@/` points to packages/interface/src/ — interface internals use it
      // for their own cross-references (e.g. `@/lib/utils`); when those files
      // are loaded via the studio entry they must still resolve to interface.
      '@/': `${resolve(PACKAGE_DIR, '../interface/src')}/`,
      // @forgeax/design moved into the interface repo (packages/interface/
      // packages/design) so the interface submodule is self-contained.
      '@forgeax/design/preset': resolve(PACKAGE_DIR, '../interface/packages/design/preset.ts'),
      '@forgeax/design/theme': resolve(PACKAGE_DIR, '../interface/packages/design/theme.ts'),
      '@forgeax/design/tokens.css': resolve(PACKAGE_DIR, '../interface/packages/design/tokens.css'),
      '@forgeax/design': resolve(PACKAGE_DIR, '../interface/packages/design/index.ts'),
      '@forgeax/types': resolve(PACKAGE_DIR, '../contracts/types/src/index.ts'),
      '@forgeax/host-sdk': resolve(PACKAGE_DIR, '../host-sdk/src/index.ts'),
    },
  },
  server: {
    port: Number(process.env.FORGEAX_INTERFACE_PORT ?? 18920),
    // Bind IPv4 explicitly. macOS resolves `localhost` to IPv6 `::1` first, but
    // Node's IPv6 wildcard socket is v6-only by default (no v4-mapped accept),
    // so `host: true` / '::' would flip the bind to v6-ONLY and break
    // `127.0.0.1`. Keeping '0.0.0.0' guarantees `http://127.0.0.1:18920` works;
    // use 127.0.0.1 (not localhost) in the browser. (run.sh prints the v4 URL.)
    host: '0.0.0.0',
    strictPort: true,
    open: false,
    // Vite 5+ rejects requests whose Host header isn't localhost/127.0.0.1
    // by default. When the dev server is fronted by a platform-provided
    // domain (e.g. cloud dev-environment gateway), that Host header check
    // fails and the SPA gets "Blocked request. This host is not allowed."
    //
    // Set FORGEAX_INTERFACE_ALLOWED_HOSTS to a comma-separated host list,
    // or to the literal value "true" (case-insensitive) to allow every
    // Host. Unset — or a value that reduces to zero non-empty hosts —
    // keeps vite's safer default (localhost only).
    //
    // Vite matches each host entry as follows:
    //   - exact match          "api.example.com"    -> api.example.com
    //   - leading-dot wildcard ".example.com"       -> example.com AND
    //                                                  *.example.com
    ...(() => {
      const raw = process.env.FORGEAX_INTERFACE_ALLOWED_HOSTS;
      if (raw === undefined) return {};
      const trimmed = raw.trim();
      if (trimmed === '') return {};
      if (trimmed.toLowerCase() === 'true') return { allowedHosts: true as const };
      const hosts = trimmed
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
      // Empty after filter means the value was pure whitespace/commas — fall
      // back to vite's safe default (skip the key entirely) rather than
      // silently forbidding every non-loopback request.
      return hosts.length > 0 ? { allowedHosts: hosts } : {};
    })(),
    ...(httpsServerOption !== undefined ? { https: httpsServerOption } : {}),
    watch: { usePolling: true, interval: 300, ignored: ['**/src-tauri/**'] },
    // Vite 5+ restricts file access to its project root by default.  Marketplace
    // plugin frontends live at ../../marketplace/plugins/*/src/panel.tsx and
    // are statically imported via Sidebar.tsx's LazyPluginPanels map; allow the
    // monorepo root so those imports resolve.  See:
    //   packages/marketplace/plugins/wb-character-forge/DESIGN.md (template).
    fs: { allow: ['..', '../..', ...knownWorkspaceRoots()] },
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER_WS, ws: true, changeOrigin: true },
      // Engine vite has `base: '/preview/'`, so ALL its asset/dep URLs are
      // already prefixed. One proxy catches everything (forgeax/engine/*,
      // games/*, node_modules/.vite/deps/*, @vite, @id, @fs) and the
      // interface's own /node_modules deps stay un-proxied — no collision.
      '/preview': { target: ENGINE, changeOrigin: true, ws: true },
      // createDevImportTransport (engine runtime) POSTs a root-absolute
      // `/__import/<guid>` on a loadByGuid miss to lazily cook a sub-asset
      // (texture cube, gltf scene/skin/animation-clip, …) into the runtime POD.
      // It is NOT under /preview, so route it to the Play engine explicitly.
      // Without this proxy the studio SPA-falls back to index.html and the
      // engine returns 404 for every dev import — every .glb-backed game
      // (witch hellforge, future skinned characters) silently fails to load.
      '/__import': { target: ENGINE, changeOrigin: true },
      // After /__import returns a row, the runtime fetches the pack body at
      // its returned `relativeUrl` — for gltf imports this is
      // `/__forgeax-ddc/<glb-bytes-guid>.pack.json` (vite-plugin-pack DDC seam).
      // It is also outside /preview, so it must be proxied explicitly or the
      // studio SPA falls back to index.html and the runtime parses HTML as JSON.
      '/__forgeax-ddc': { target: ENGINE, changeOrigin: true },
      // The scan-HMR bridge (editor-core scan-hmr-bridge.ts) same-origin GETs
      // `/__pack/scan-done` to replay the last startup-scan payload when the
      // browser mounts after the Node-side WS signal (race compensation). It is
      // also outside /preview, so without this proxy the studio SPA falls back to
      // index.html and the bridge parses HTML as JSON ("Unexpected token '<'").
      // Route the whole /__pack/* surface (index / lookup / scan-done) to the
      // play engine that owns pluginPack's middleware.
      '/__pack': { target: ENGINE, changeOrigin: true },
      // NOTE: the `/editor` -> :15280 proxy is DELETED (single-realm,
      // feat-20260703). The editor engine now boots IN-PROCESS in this :18920
      // host window; there is no edit-runtime iframe to proxy to. The shader
      // manifest is served locally by enginePreset.plugins; the per-game pack
      // catalog + __import come from the play engine (:15173) via /preview +
      // /__import above (ViewportComponent multi-game fallback).
      // Plugin iframe assets — the studio server's serveStatic mounts each
      // plugin's vite build dist under /plugins/<plugin-id>/*. Without this
      // proxy the interface dev server SPA-falls back to its own index.html
      // and the iframe ends up loading a nested studio UI. See:
      //   packages/server/src/main.ts → serveStatic('/plugins/wb-character/*')
      //   packages/marketplace/plugins/wb-character-host/panel.tsx
      '/plugins': { target: SERVER, changeOrigin: true },
      // wb-character iframe legacy shim — the plugin submodule's 88 fetch
      // sites hit /__ce-api__/* expecting the old vite-dev plugin. Studio
      // host owns this surface now via server/src/api/ce-api-shim.ts; route
      // the iframe's calls through to the backend instead of SPA-falling
      // back to interface/index.html.
      '/__ce-api__': { target: SERVER, changeOrigin: true },
      '/__reel__': { target: REEL, changeOrigin: true },
    },
  },
  optimizeDeps: {
    // Exclude the whole @forgeax workspace family (engine-* + editor-*) from
    // pre-bundle — served as native ESM, single instance (SSOT-derived by the
    // preset; pre-bundling under the nested symlink graph OOMs and would also
    // fork the editor-shared singleton). react stays pre-bundled so the
    // single-instance dedupe holds.
    exclude: enginePreset.optimizeDeps.exclude,
    // Symmetric with exclude: derived from the assembled front-end packages'
    // declared deps (SSOT), NOT a hand list — see frontendPrebundleIncludes.
    // Pre-declaring these prevents the cold-load re-optimize + full-page reload
    // that trapped the viewport boot overlay on "正在加载游戏…" until the 90s cap.
    include: frontendPrebundleIncludes(),
  },
  build: {
    // esnext: the in-process engine boot entry uses top-level await.
    target: enginePreset.build.target,
  },
}));
