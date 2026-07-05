#!/usr/bin/env node
// scripts/website/build-games.mjs — static-bake studio games (packages/games/*) into
// <out>/games/<slug>/ for the website, by reusing the engine's apps/preview bootstrap.
//
// The engine apps/preview only globs its own templates/*, so to bake a studio game we
// generate a TRANSIENT host under <engine>/apps/.wsite-host-<slug>/ (copied from
// apps/preview, repointed at one game via a `@wgame` alias + pluginPack root), build it
// with --base=/games/<slug>/, copy dist out, then REMOVE the host. Nothing is committed
// to the (read-only) engine — it's a build scaffold regenerated from the live engine each
// run, so it tracks engine API drift instead of vendoring a stale copy.
//
// NOTE: static build-mode asset resolution is engine-internal and version-sensitive; a
// game that builds is marked ok in the manifest but render is not headlessly verified.
//
// Env: ENGINE_DIR, GAMES_DIR (default <repo>/packages/games), OUT_DIR, ONLY=slug,..
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const ENGINE_DIR = resolve(process.env.ENGINE_DIR || join(REPO, 'packages', 'engine'));
const GAMES_DIR = resolve(process.env.GAMES_DIR || join(REPO, 'packages', 'games'));
const OUT_DIR = resolve(process.env.OUT_DIR || join(REPO, 'website-staging'));
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',').map((s) => s.trim())) : null;
// Persistent WHITELIST for the public gallery (see games.curation.json). Returns an
// ORDERED slug list, or null if the file is absent (→ legacy: publish all).
const CURATION = join(HERE, 'games.curation.json');
function allowlist() {
  if (!existsSync(CURATION)) return null;                      // no file → publish all (legacy)
  try {
    const c = JSON.parse(readFileSync(CURATION, 'utf8'));
    return Array.isArray(c.allow) ? c.allow.map((s) => String(s).trim()).filter(Boolean) : [];
  } catch { return []; }                                       // malformed → fail SAFE: publish nothing
}
// Static game rendering depends on engine asset support that isn't available in a static build
// (loadByGuid needs the dev ImportTransport/DDC; see ENGINE-ISSUES). Until that lands, ship an
// honest "coming soon" gallery instead of black demo pages. Flip GAMES_LIVE=1 once supported.
const LIVE = process.env.GAMES_LIVE === '1';
const log = (...a) => console.log('\x1b[36m[games]\x1b[0m', ...a);

// See build-examples.mjs: WebGPU-required notice + base-relative path rewrite.
const WEBGPU_GUARD = `<script>(function(){var N='__wgpu_notice';function show(){if(document.getElementById(N))return;var d=document.createElement('div');d.id=N;d.style.cssText='position:fixed;inset:0;display:grid;place-items:center;background:#0b0d10;color:#e6e6e6;font:15px/1.6 system-ui,sans-serif;text-align:center;padding:24px;z-index:2147483647';d.innerHTML='<div><div style="font-size:44px">\\u26A1</div><p><b>This game needs WebGPU</b></p><p style="opacity:.75;max-width:32em">Your browser doesn\\u2019t have working WebGPU. Open in <b>Chrome or Edge</b> (latest). \\u8FD9\\u4E2A\\u6E38\\u620F\\u9700\\u8981 WebGPU\\uFF0C\\u8BF7\\u7528\\u6700\\u65B0\\u7248 Chrome / Edge \\u6253\\u5F00\\u3002</p></div>';(document.body||document.documentElement).appendChild(d);setTimeout(function(){if(d.parentNode)d.parentNode.appendChild(d);},2500);}async function chk(){var ok=false;try{if(navigator.gpu){var a=await navigator.gpu.requestAdapter();ok=!!a;}}catch(e){}if(!ok){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',show);else show();}}chk();})();</script>`;
function injectWebgpuGuard(destDir) {
  const idx = join(destDir, 'index.html');
  if (!existsSync(idx)) return;
  const s = readFileSync(idx, 'utf8');
  if (s.includes('navigator.gpu')) return;
  writeFileSync(idx, s.replace(/<head>/i, `<head>\n${WEBGPU_GUARD}`));
}

// See build-examples.mjs: size the canvas buffer to display × dpr (else 300x150 → blurry).
const CANVAS_SIZER = `<script type="module">var c=document.querySelector("#app")||document.querySelector("canvas");function z(){var d=window.devicePixelRatio||1;if(c&&c.tagName==="CANVAS"){c.width=Math.max(1,Math.round(c.clientWidth*d));c.height=Math.max(1,Math.round(c.clientHeight*d));}}z();addEventListener("resize",z);</script>`;
function injectCanvasSizing(destDir) {
  const idx = join(destDir, 'index.html');
  if (!existsSync(idx)) return;
  const s = readFileSync(idx, 'utf8');
  if (s.includes('devicePixelRatio')) return;
  writeFileSync(idx, s.replace(/<script type="module"/, `${CANVAS_SIZER}\n<script type="module"`));
}

// See build-examples.mjs: rewrite engine's root-absolute fetch paths to base-relative.
function rebaseAbsoluteAssetPaths(dir, base) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!/\.(js|mjs|html)$/.test(e.name)) continue;
      const s = readFileSync(p, 'utf8');
      const r = s.split('/shaders/manifest.json').join(`${base}shaders/manifest.json`)
                 .split('/pack-index.json').join(`${base}pack-index.json`);
      if (r !== s) writeFileSync(p, r);
    }
  }
}

// pluginPack bakes the absolute filesystem path of each asset into pack-index.json's
// relativeUrl and does NOT copy the pack assets into dist (dev-serve model). For a static
// deploy we copy the referenced files into dist under /games/<slug>/ and rewrite the URLs.
function relocatePackAssets(destDir, gameDir, slug) {
  const idxPath = join(destDir, 'pack-index.json');
  if (!existsSync(idxPath)) return;
  const raw = JSON.parse(readFileSync(idxPath, 'utf8'));
  const entries = Array.isArray(raw) ? raw : raw.entries || [];
  const webBase = `/games/${slug}`;
  for (const e of entries) {
    const url = e.relativeUrl || '';
    if (!url.startsWith(gameDir)) continue;
    const rest = url.slice(gameDir.length); // e.g. /assets/base-material.pack.json
    const src = join(gameDir, rest);
    const dst = join(destDir, rest);
    if (existsSync(src) && !existsSync(dst)) { mkdirSync(dirname(dst), { recursive: true }); cpSync(src, dst, { recursive: true }); }
    e.relativeUrl = webBase + rest;
  }
  writeFileSync(idxPath, JSON.stringify(raw, null, 2));
}

function discoverGames() {
  const out = [];
  for (const name of readdirSync(GAMES_DIR)) {
    const dir = join(GAMES_DIR, name);
    const forge = join(dir, 'forge.json');
    if (!existsSync(forge)) continue;
    let f; try { f = JSON.parse(readFileSync(forge, 'utf8')); } catch { continue; }
    const slug = f.id || name;
    const entry = f.entry || 'main.ts';
    out.push({ slug, name: f.name || slug, dir, entry, forge: f, hasScene: existsSync(join(dir, 'scene.pack.json')), buildable: existsSync(join(dir, entry)) });
  }
  return out;
}

function hostVite() {
  return `import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';
const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..');
const GAME_DIR = process.env.WSITE_GAME_DIR;
export default defineConfig({
  plugins: [forgeaxShader(), pluginPack({ roots: [GAME_DIR] })],
  resolve: { alias: { '@wgame': GAME_DIR } },
  server: { fs: { allow: [monorepoRoot, GAME_DIR] } },
  build: { target: 'esnext', rollupOptions: { input: { main: resolve(here, 'index.html') } } },
});
`;
}

function hostMain(entry) {
  const imp = entry.replace(/^\.?\//, '');
  return `import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createApp, loadGame } from '@forgeax/engine-app';
import gameModule from '@wgame/${imp}';
const canvas = document.querySelector('#app');
if (!canvas) throw new Error('host: missing <canvas id="app">');
const app = await createApp(canvas, {}, { ...forgeaxBundlerAdapter() });
if (!app.ok) { console.error('[host] createApp failed', app.error); throw new Error('createApp'); }
const assets = app.value.renderer.assets;
assets.configurePackIndex(import.meta.env.BASE_URL + 'pack-index.json');
const ctx = { world: app.value.world, assets, app: app.value, registerUpdate: (fn) => app.value.registerUpdate(fn) };
const loaded = await loadGame('${'${slug}'}', () => Promise.resolve({ default: gameModule }));
if (!loaded.ok) { console.error('[host] loadGame failed', loaded.error); throw new Error('loadGame'); }
await loaded.value(ctx);
app.value.start();
window.addEventListener('pagehide', () => { app.value.stop(); app.value.renderer.dispose(); });
`;
}

function buildGame(g) {
  if (!g.buildable) return { ...g, ok: false, reason: 'no-entry' };
  const base = `/games/${g.slug}/`;
  const hostDir = join(ENGINE_DIR, 'apps', `.wsite-host-${g.slug}`);
  const previewDir = join(ENGINE_DIR, 'apps', 'preview');
  const destDir = join(OUT_DIR, 'games', g.slug);
  const engineNm = join(ENGINE_DIR, 'node_modules');
  const gameNm = join(g.dir, 'node_modules');
  let madeGameNm = false;
  try {
    rmSync(hostDir, { recursive: true, force: true });
    mkdirSync(join(hostDir, 'src'), { recursive: true });
    // reuse preview's index.html + package.json + tsconfig; override vite.config + main
    for (const f of ['index.html', 'package.json', 'tsconfig.json']) {
      if (existsSync(join(previewDir, f))) cpSync(join(previewDir, f), join(hostDir, f));
    }
    // The host is a brand-new dir (created after pnpm install) so it has no deps; reuse
    // preview's installed node_modules (has vite + @forgeax/*). The GAME lives outside the
    // engine workspace, so its main.ts can't resolve @forgeax/* — give it the engine's
    // node_modules too (transient; removed after if we created it).
    symlinkSync('../preview/node_modules', join(hostDir, 'node_modules'));
    if (!existsSync(gameNm)) { symlinkSync(engineNm, gameNm); madeGameNm = true; }
    writeFileSync(join(hostDir, 'vite.config.ts'), hostVite());
    writeFileSync(join(hostDir, 'src', 'main.ts'), hostMain(g.entry).replace('${slug}', g.slug));
    log(`build ${g.slug} (transient host, --base=${base})`);
    const viteBin = join(previewDir, 'node_modules', '.bin', 'vite');
    execFileSync(viteBin, ['build', `--base=${base}`], { cwd: hostDir, stdio: 'pipe', env: { ...process.env, WSITE_GAME_DIR: g.dir } });
    const dist = join(hostDir, 'dist');
    if (!existsSync(dist)) return { ...g, ok: false, reason: 'no-dist' };
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    cpSync(dist, destDir, { recursive: true });
    rebaseAbsoluteAssetPaths(destDir, base); // engine hardcodes /shaders/manifest.json — see build-examples.mjs
    relocatePackAssets(destDir, g.dir, g.slug); // copy pack assets into dist + fix their URLs
    injectCanvasSizing(destDir);
    injectWebgpuGuard(destDir);
    log(`  ✓ ${g.slug} (${readdirSync(destDir).length} entries)`);
    return { ...g, ok: true };
  } catch (e) {
    const out = `${(e.stdout || '').toString()}\n${(e.stderr || '').toString()}`.trim() || e.message;
    log(`  ✗ ${g.slug}:\n${out.split('\n').slice(-15).join('\n')}`);
    return { ...g, ok: false, reason: 'build-failed' };
  } finally {
    rmSync(hostDir, { recursive: true, force: true }); // never leave a host in the engine tree
    if (madeGameNm) { try { unlinkSync(gameNm); } catch { /* symlink only */ } }
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bi = (zh, en) => `<span data-lang="zh">${esc(zh)}</span><span data-lang="en">${esc(en)}</span>`;
function card(g) {
  const live = g.ok;
  const desc = bi(g.forge.description?.zh || g.forge.description || '', g.forge.description?.en || g.forge.description || '');
  if (live) {
    return `      <a class="game" href="/games/${g.slug}/" target="_blank" rel="noopener">
        <div class="thumb"><div class="play">▶</div><span class="soon">${bi('实时 demo', 'live demo')}</span></div>
        <div class="body"><div class="top"><h3>${esc(g.name)}</h3></div><p>${desc}</p></div></a>`;
  }
  // Coming-soon: NO play button (it falsely implies playable). Clear badge, not a link.
  return `      <div class="game card-disabled" aria-disabled="true" title="Coming soon">
        <div class="thumb"><span class="badge-soon">${bi('网页版即将上线', 'web demo coming soon')}</span></div>
        <div class="body"><div class="top"><h3>${esc(g.name)}</h3></div><p>${desc}</p></div></div>`;
}
function galleryHtml(games) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>游戏 · Games — ForgeaX</title>
<link rel="icon" href="/logo.svg?v=3" type="image/svg+xml" />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Fira+Mono:wght@400;500&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/assets/styles.css" />
<style>
  .game{display:block;color:inherit;text-decoration:none;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:var(--radius-xl);overflow:hidden;transition:border-color .2s,transform .2s}
  a.game:hover{border-color:var(--border-strong);transform:translateY(-2px)}
  .game.card-disabled{opacity:.6;cursor:default}
  .game .thumb{aspect-ratio:16/10;background:linear-gradient(135deg,var(--bg-floating),var(--bg-base));display:grid;place-items:center;position:relative;border-bottom:1px solid var(--border-subtle)}
  .game .thumb .play{width:54px;height:54px;border-radius:50%;background:rgba(212,255,72,.12);border:1px solid rgba(212,255,72,.35);display:grid;place-items:center;color:var(--brand);font-size:20px}
  .game .thumb .soon{position:absolute;bottom:10px;right:10px;font-family:var(--font-mono);font-size:11px;color:var(--text-tertiary)}
  .game .thumb .badge-soon{font-family:var(--font-mono);font-size:12px;color:var(--text-tertiary);border:1px dashed var(--border-strong);border-radius:999px;padding:6px 14px}
  .game .body{padding:18px} .game .body h3{font-size:18px;font-weight:700} .game .body p{color:var(--text-secondary);font-size:14.5px;margin:8px 0 0}
</style></head>
<body class="lang-en"><div id="site-header"></div>
<main class="wrap"><div class="page-head"><h1>${bi('游戏', 'Games')}</h1>
<p>${bi('用 ForgeaX Studio 做出的游戏。可在浏览器直接游玩的版本即将上线 —— 这些游戏目前在 Studio 内运行。引擎示例可立即游玩,见 ', 'Games made with ForgeaX Studio. In-browser playable builds are coming soon — these run today inside the Studio. For runnable demos now, see ')}<a href="/examples/">${bi('引擎示例', 'Examples')}</a>。</p></div>
<div class="section" style="padding-top:18px"><div class="grid c2">
${games.map(card).join('\n')}
</div></div></main><script src="/assets/site.js"></script></body></html>
`;
}

function main() {
  let games = discoverGames();
  // WHITELIST: keep only allow-listed slugs, in the curation array's order. `[]` → none.
  const allow = allowlist();
  if (allow) {
    const rank = new Map(allow.map((s, i) => [s, i]));
    games = games.filter((g) => rank.has(g.slug)).sort((a, b) => rank.get(a.slug) - rank.get(b.slug));
    log(`whitelist: ${games.length}/${allow.length || 0} allowed game(s) — ${games.map((g) => g.slug).join(', ') || '(none — all hidden)'}`);
  }
  if (ONLY) games = games.filter((g) => ONLY.has(g.slug));
  mkdirSync(join(OUT_DIR, 'games'), { recursive: true });
  // Until engine static-asset support lands, don't bake/deploy demo dirs (they'd render
  // black via loadByGuid → asset-not-imported). Ship a coming-soon gallery instead.
  const results = LIVE ? games.map(buildGame) : games.map((g) => ({ ...g, ok: false, reason: 'engine-static-assets-pending' }));
  writeFileSync(join(OUT_DIR, 'games', 'index.html'), galleryHtml(results));
  writeFileSync(join(OUT_DIR, 'games', 'manifest.json'), JSON.stringify({ games: results.map((r) => ({ slug: r.slug, name: r.name, ok: !!r.ok, reason: r.reason || null, href: r.ok ? `/games/${r.slug}/` : null })) }, null, 2) + '\n');
  const ok = results.filter((r) => r.ok).length;
  log(`done: ${ok}/${results.length} games baked. gallery + manifest written.`);
}
main();
