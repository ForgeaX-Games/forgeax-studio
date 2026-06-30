import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { vitePluginBrand } from './vite-plugin-brand';

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
const EDITOR = process.env.FORGEAX_EDITOR_URL ?? 'http://127.0.0.1:15280';
const REEL = process.env.FORGEAX_REEL_URL ?? 'http://127.0.0.1:15175';

const HTTPS_ENABLED = process.env.FORGEAX_INTERFACE_HTTPS === '1';

// Prefer a hand-rolled cert at `<root>/.tls/{cert,key}.pem` (covers remote IPs
// in SAN); fall back to package-local then @vitejs/plugin-basic-ssl (localhost only).
const ROOT_TLS = resolve(PACKAGE_DIR, '../../.tls');
const tlsCertPath = existsSync(resolve(ROOT_TLS, 'cert.pem')) ? resolve(ROOT_TLS, 'cert.pem') : resolve(PACKAGE_DIR, '.tls/cert.pem');
const tlsKeyPath = existsSync(resolve(ROOT_TLS, 'key.pem')) ? resolve(ROOT_TLS, 'key.pem') : resolve(PACKAGE_DIR, '.tls/key.pem');
const useCustomCert = HTTPS_ENABLED && existsSync(tlsCertPath) && existsSync(tlsKeyPath);
const httpsServerOption = useCustomCert
  ? { cert: readFileSync(tlsCertPath), key: readFileSync(tlsKeyPath) }
  : undefined;

export default defineConfig({
  plugins: [
    vitePluginBrand({ packageDir: PACKAGE_DIR }),
    react(),
    ...(HTTPS_ENABLED && !useCustomCert ? [basicSsl()] : []),
  ],
  resolve: {
    // dockview declares react as a peer dep; under bun's isolated node_modules it
    // can resolve a SECOND react copy → "Invalid hook call / resolveDispatcher
    // null". Force a single react instance for all imports (incl. dockview).
    dedupe: ['react', 'react-dom'],
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
      '@forgeax/types': resolve(PACKAGE_DIR, '../types/src/index.ts'),
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
    ...(httpsServerOption !== undefined ? { https: httpsServerOption } : {}),
    watch: { usePolling: true, interval: 300, ignored: ['**/src-tauri/**'] },
    // Vite 5+ restricts file access to its project root by default.  Marketplace
    // plugin frontends live at ../../marketplace/plugins/*/src/panel.tsx and
    // are statically imported via Sidebar.tsx's LazyPluginPanels map; allow the
    // monorepo root so those imports resolve.  See:
    //   packages/marketplace/plugins/wb-character-forge/DESIGN.md (template).
    fs: { allow: ['..', '../..'] },
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
      // Editor runtime vite has `base: '/editor/'`; one proxy catches all its
      // asset/dep URLs (forgeax/engine/*, node_modules/.vite/deps/*, @vite,
      // @id, @fs) just like /preview. Mirrors the preview-runtime wiring.
      '/editor': { target: EDITOR, changeOrigin: true, ws: true },
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
      // standalone-editor-demo proxy — dev serve at :15290, reachable
      // through the studio dev server on :18920/standalone/editor
      '/standalone/editor': { target: 'http://127.0.0.1:15290', changeOrigin: true, ws: true },
      '/__reel__': { target: REEL, changeOrigin: true },
    },
  },
});
