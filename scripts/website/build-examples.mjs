#!/usr/bin/env node
// scripts/website/build-examples.mjs — generate the three.js-style live-demo
// gallery for forgeax.github.io from the engine's apps/hello/* examples.
//
// SOURCE OF TRUTH for *which* examples + copy/order = scripts/website/showcase.curation.json
// (the engine is read-only/ubpa, so curation lives studio-side). Each example is a
// standalone Vite app; we `vite build --base=/examples/<id>/` (no engine edits — base
// is a pure CLI override) and copy its dist into <out>/examples/<id>/.
//
// Output (overlaid into the website source repo):
//   <out>/examples/<id>/...        per-example static build (WebGPU/WebGL2)
//   <out>/examples/index.html      bilingual gallery (thumbnail -> live demo)
//   <out>/examples/manifest.json   per-example metadata + engine version/sha stamp
//   <out>/examples/coi-serviceworker.js   COOP/COEP shim (for `coi` examples)
//
// Env:
//   ENGINE_DIR   path to the engine checkout (default: <repo>/packages/engine)
//   OUT_DIR      website staging/root to write into (default: <repo>/website-staging)
//   CURATION     curation json (default: scripts/website/showcase.curation.json)
//   ENGINE_SHA   engine commit sha for the alignment stamp (default: git -C ENGINE_DIR)
//   ENGINE_VERSION  engine version (default: ENGINE_DIR/package.json version)
//   ONLY         comma-list of example ids to build (default: all curated)
//   SKIP_BUILD=1 regenerate gallery/manifest only, reuse existing dist (fast iter)
//
// Usage: node scripts/website/build-examples.mjs

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const ENGINE_DIR = resolve(process.env.ENGINE_DIR || join(REPO, 'packages', 'engine'));
const OUT_DIR = resolve(process.env.OUT_DIR || join(REPO, 'website-staging'));
const CURATION = resolve(process.env.CURATION || join(HERE, 'showcase.curation.json'));
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',').map((s) => s.trim())) : null;
const SKIP_BUILD = process.env.SKIP_BUILD === '1';

const log = (...a) => console.log('\x1b[35m[examples]\x1b[0m', ...a);

function engineStamp() {
  let sha = process.env.ENGINE_SHA || '';
  if (!sha) { try { sha = execFileSync('git', ['-C', ENGINE_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { sha = 'unknown'; } }
  let version = process.env.ENGINE_VERSION || '';
  if (!version) { try { version = JSON.parse(readFileSync(join(ENGINE_DIR, 'package.json'), 'utf8')).version || '0.0.0'; } catch { version = '0.0.0'; } }
  return { sha, shaShort: sha.slice(0, 10), version };
}

// Minimal COOP/COEP service-worker shim (after gzuidhof/coi-serviceworker, MIT) so
// SharedArrayBuffer-using wasm runs on header-less static hosting (github.io).
const COI_SW = `/*! coi-serviceworker v0.1.7 — MIT (gzuidhof). Adds COOP/COEP via a SW so
   SharedArrayBuffer works on static hosts that cannot set response headers. */
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', (e) => {
    if (e.request.cache === 'only-if-cached' && e.request.mode !== 'same-origin') return;
    e.respondWith(fetch(e.request).then((r) => {
      if (r.status === 0) return r;
      const h = new Headers(r.headers);
      h.set('Cross-Origin-Embedder-Policy', 'require-corp');
      h.set('Cross-Origin-Opener-Policy', 'same-origin');
      return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
    }).catch((e2) => console.error(e2)));
  });
} else {
  (() => {
    if (window.crossOriginIsolated !== false) return;
    if (!window.isSecureContext) return;
    navigator.serviceWorker && navigator.serviceWorker.register(window.document.currentScript.src)
      .then((reg) => { reg.addEventListener('updatefound', () => window.location.reload());
        if (reg.active && !navigator.serviceWorker.controller) window.location.reload(); });
  })();
}
`;

// ENGINE BUG WORKAROUND (filed in ENGINE-ISSUES-for-ubpa.md): forgeaxShader hardcodes
// SHADER_MANIFEST_URL = '/shaders/manifest.json' (root-absolute, ignores vite `base`), so a
// demo served under /examples/<id>/ fetches /shaders/manifest.json → 404 → "manifest-malformed"
// → no usable backend → black canvas. Rewrite the absolute engine fetch paths to base-relative
// in the built JS. No engine edit — patches output only.
// The demos require WebGPU (the engine's WebGL2 backend isn't wired as a runtime fallback
// in these app builds). On a browser without WebGPU the engine canvas stays black, so inject
// a friendly notice into each demo's index.html instead of a silent black screen.
const WEBGPU_GUARD = `<script>(function(){var N='__wgpu_notice';function show(){if(document.getElementById(N))return;var d=document.createElement('div');d.id=N;d.style.cssText='position:fixed;inset:0;display:grid;place-items:center;background:#0b0d10;color:#e6e6e6;font:15px/1.6 system-ui,sans-serif;text-align:center;padding:24px;z-index:2147483647';d.innerHTML='<div><div style="font-size:44px">\\u26A1</div><p><b>This demo needs WebGPU</b></p><p style="opacity:.75;max-width:32em">Your browser doesn\\u2019t have working WebGPU. Open in <b>Chrome or Edge</b> (latest), or Safari 26+ / Firefox with WebGPU enabled. \\u8FD9\\u4E2A demo \\u9700\\u8981 WebGPU\\uFF0C\\u8BF7\\u7528\\u6700\\u65B0\\u7248 Chrome / Edge \\u6253\\u5F00\\u3002</p><p style="opacity:.5;font-size:13px">Check chrome://gpu or webgpureport.org</p></div>';(document.body||document.documentElement).appendChild(d);setTimeout(function(){if(d.parentNode)d.parentNode.appendChild(d);},2500);}async function chk(){var ok=false;try{if(navigator.gpu){var a=await navigator.gpu.requestAdapter();ok=!!a;}}catch(e){}if(!ok){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',show);else show();}}chk();})();</script>`;
function injectWebgpuGuard(destDir) {
  const idx = join(destDir, 'index.html');
  if (!existsSync(idx)) return;
  const s = readFileSync(idx, 'utf8');
  if (s.includes('navigator.gpu')) return;
  writeFileSync(idx, s.replace(/<head>/i, `<head>\n${WEBGPU_GUARD}`));
}

// The hello apps never size the canvas drawing buffer, so it stays the 300x150 default
// and the browser upscales it to the viewport → blurry (worse on retina). Set the buffer to
// clientWidth/Height × devicePixelRatio BEFORE the engine module runs (it reads canvas.width
// at init), and on resize. Injected as a module script ahead of the engine entry.
const CANVAS_SIZER = `<script type="module">var c=document.querySelector("#app")||document.querySelector("canvas");function z(){var d=window.devicePixelRatio||1;if(c&&c.tagName==="CANVAS"){c.width=Math.max(1,Math.round(c.clientWidth*d));c.height=Math.max(1,Math.round(c.clientHeight*d));}}z();addEventListener("resize",z);</script>`;
function injectCanvasSizing(destDir) {
  const idx = join(destDir, 'index.html');
  if (!existsSync(idx)) return;
  const s = readFileSync(idx, 'utf8');
  if (s.includes('devicePixelRatio')) return;
  // place the sizer immediately before the FIRST module script (the engine entry)
  writeFileSync(idx, s.replace(/<script type="module"/, `${CANVAS_SIZER}\n<script type="module"`));
}

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

function buildExample(ex) {
  const appDir = join(ENGINE_DIR, 'apps', 'hello', ex.dir);
  const base = `/examples/${ex.id}/`;
  const destDir = join(OUT_DIR, 'examples', ex.id);
  if (!existsSync(join(appDir, 'index.html'))) { log(`SKIP ${ex.id} (no index.html at ${appDir})`); return { ...ex, ok: false, reason: 'no-index' }; }
  if (!SKIP_BUILD) {
    log(`build ${ex.id} (vite --base=${base})`);
    try {
      execFileSync('pnpm', ['exec', 'vite', 'build', `--base=${base}`], { cwd: appDir, stdio: 'pipe' });
    } catch (e) {
      const out = `${(e.stdout || '').toString()}\n${(e.stderr || '').toString()}`.trim() || e.message;
      log(`  ✗ build failed for ${ex.id}:\n${out.split('\n').slice(-20).join('\n')}`);
      return { ...ex, ok: false, reason: 'build-failed' };
    }
  }
  const dist = join(appDir, 'dist');
  if (!existsSync(dist)) return { ...ex, ok: false, reason: 'no-dist' };
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  cpSync(dist, destDir, { recursive: true });
  rebaseAbsoluteAssetPaths(destDir, base);
  injectCanvasSizing(destDir);
  injectWebgpuGuard(destDir);
  if (ex.coi) {
    writeFileSync(join(destDir, 'coi-serviceworker.js'), COI_SW);
    const idx = join(destDir, 'index.html');
    let html = readFileSync(idx, 'utf8');
    if (!html.includes('coi-serviceworker.js')) {
      html = html.replace(/<head>/i, `<head>\n    <script src="${base}coi-serviceworker.js"></script>`);
      writeFileSync(idx, html);
    }
  }
  const files = readdirSync(destDir).length;
  log(`  ✓ ${ex.id} (${files} top-level entries)`);
  return { ...ex, ok: true };
}

// ---------- gallery + manifest rendering ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bi = (zh, en) => `<span data-lang="zh">${esc(zh)}</span><span data-lang="en">${esc(en)}</span>`;

// three.js-docs-style sidebar item (server-rendered so it works without JS too).
function exItem(ex) {
  const tags = (ex.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const dead = ex.ok ? '' : ' is-disabled';
  const href = ex.ok ? `/examples/${ex.id}/` : '#';
  return `        <a class="ex-item${dead}" data-id="${esc(ex.id)}" href="${href}">
          <span class="ex-item-t">${bi(ex.title.zh, ex.title.en)}</span>
          <span class="ex-item-tags">${tags}</span>
        </a>`;
}

export function galleryHtml(examples, stamp) {
  const items = examples.map(exItem).join('\n');
  const data = JSON.stringify(
    examples.map((e) => ({
      id: e.id,
      ok: !!e.ok,
      href: e.ok ? `/examples/${e.id}/` : null,
      title: e.title,
      blurb: e.blurb || { zh: '', en: '' },
    }))
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>引擎示例 · Examples — ForgeaX</title>
<meta name="description" content="Runnable WebGPU engine examples — triangle, glTF, sprites, picking, physics and more, built from the ForgeaX engine. Pick one on the left, run it live on the right." />
<link rel="icon" href="/logo.svg?v=3" type="image/svg+xml" />
<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Fira+Mono:wght@400;500&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/assets/styles.css" />
<style>
  .ex-shell{display:flex;height:calc(100vh - var(--nav-h));overflow:hidden}
  .ex-side{width:300px;flex:none;display:flex;flex-direction:column;background:var(--bg-elevated);border-right:1px solid var(--border-subtle)}
  .ex-side-head{padding:16px 16px 12px;border-bottom:1px solid var(--border-subtle)}
  .ex-side-head h1{font-size:18px;font-weight:800;margin:0 0 4px}
  .ex-side-head p{font-size:12px;color:var(--text-tertiary);margin:0 0 10px}
  #exFilter{width:100%;padding:8px 10px;background:var(--bg-base);border:1px solid var(--border-subtle);border-radius:var(--radius-md);color:var(--text-primary);font-size:13px;outline:none}
  #exFilter:focus{border-color:var(--border-strong)}
  .ex-list{flex:1;overflow:auto;padding:8px}
  .ex-item{display:block;padding:9px 11px;border-radius:var(--radius-md);color:var(--text-secondary);text-decoration:none;border:1px solid transparent;margin-bottom:2px}
  .ex-item:hover{background:var(--bg-floating);color:var(--text-primary)}
  .ex-item.is-active{background:rgba(212,255,72,.10);border-color:rgba(212,255,72,.30);color:var(--text-primary)}
  .ex-item.is-disabled{opacity:.4;pointer-events:none}
  .ex-item-t{display:block;font-size:14px;font-weight:600;line-height:1.3}
  .ex-item-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}
  .ex-item-tags .tag{font-size:10.5px}
  .ex-stamp{padding:10px 16px;border-top:1px solid var(--border-subtle);font-family:var(--font-mono);font-size:11px;color:var(--text-tertiary)}
  .ex-view{flex:1;display:flex;flex-direction:column;min-width:0}
  .ex-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 16px;border-bottom:1px solid var(--border-subtle)}
  .ex-bar-title{font-weight:700;font-size:15px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ex-bar-title small{color:var(--text-secondary);font-weight:400;margin-left:10px;font-size:13px}
  .ex-bar-actions{display:flex;align-items:center;gap:14px;flex:none}
  .ex-badge{font-family:var(--font-mono);font-size:11px;color:var(--text-tertiary)}
  .ex-bar-actions a{color:var(--brand);font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap}
  .ex-frame-wrap{flex:1;position:relative;background:#0b0d10}
  #exFrame{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}
  @media (max-width:760px){
    .ex-shell{flex-direction:column;height:auto}
    .ex-side{width:auto;border-right:0;border-bottom:1px solid var(--border-subtle)}
    .ex-list{max-height:210px}
    .ex-view{height:72vh}
  }
</style>
</head>
<body class="lang-en">
<div id="site-header"></div>
<main class="ex-shell">
  <aside class="ex-side">
    <div class="ex-side-head">
      <h1>${bi('引擎示例', 'Engine Examples')}</h1>
      <p>${bi('选一个，右侧直接跑。', 'Pick one — it runs live on the right.')}</p>
      <input id="exFilter" type="text" autocomplete="off" placeholder="Filter / 筛选…" aria-label="Filter examples" />
    </div>
    <nav class="ex-list" id="exList">
${items}
    </nav>
    <div class="ex-stamp">${bi('对齐引擎', 'aligned to engine')} v${esc(stamp.version)} · <code>${esc(stamp.shaShort)}</code></div>
  </aside>
  <section class="ex-view">
    <div class="ex-bar">
      <div class="ex-bar-title" id="exTitle"></div>
      <div class="ex-bar-actions">
        <span class="ex-badge">${bi('实时 demo', 'live demo')}</span>
        <a id="exOpen" target="_blank" rel="noopener" href="#">${bi('新标签打开 ↗', 'Open ↗')}</a>
      </div>
    </div>
    <div class="ex-frame-wrap">
      <iframe id="exFrame" title="ForgeaX example" allow="fullscreen" src="about:blank"></iframe>
    </div>
  </section>
</main>
<script src="/assets/site.js"></script>
<script>
(function () {
  var EX = ${data};
  var byId = {}; EX.forEach(function (e) { byId[e.id] = e; });
  var frame = document.getElementById("exFrame");
  var titleEl = document.getElementById("exTitle");
  var openEl = document.getElementById("exOpen");
  var list = document.getElementById("exList");
  var items = [].slice.call(list.querySelectorAll(".ex-item"));
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];}); }
  function bi(zh,en){ return '<span data-lang="zh">'+esc(zh)+'</span><span data-lang="en">'+esc(en)+'</span>'; }
  function select(id, push) {
    var e = byId[id]; if (!e || !e.ok) return;
    if (frame.src.indexOf(e.href) < 0) frame.src = e.href;
    titleEl.innerHTML = bi(e.title.zh, e.title.en) + '<small>' + bi(e.blurb.zh, e.blurb.en) + '</small>';
    openEl.href = e.href;
    items.forEach(function (it) { it.classList.toggle("is-active", it.getAttribute("data-id") === id); });
    var act = list.querySelector(".ex-item.is-active"); if (act && act.scrollIntoView) act.scrollIntoView({ block: "nearest" });
    if (push) { try { history.replaceState(null, "", "#" + id); } catch (_) { location.hash = id; } }
  }
  items.forEach(function (it) {
    it.addEventListener("click", function (ev) {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1) return; // let new-tab work
      ev.preventDefault(); select(it.getAttribute("data-id"), true);
    });
  });
  var filter = document.getElementById("exFilter");
  if (filter) filter.addEventListener("input", function () {
    var q = this.value.trim().toLowerCase();
    items.forEach(function (it) {
      var hay = (it.textContent + " " + it.getAttribute("data-id")).toLowerCase();
      it.style.display = (!q || hay.indexOf(q) >= 0) ? "" : "none";
    });
  });
  var firstOk = EX.filter(function (e) { return e.ok; })[0];
  var hashId = (location.hash || "").replace("#", "");
  select((byId[hashId] && byId[hashId].ok) ? hashId : (firstOk && firstOk.id), false);
  window.addEventListener("hashchange", function () {
    var id = (location.hash || "").replace("#", ""); if (byId[id]) select(id, false);
  });
})();
</script>
</body>
</html>
`;
}

function main() {
  const curation = JSON.parse(readFileSync(CURATION, 'utf8'));
  let examples = (curation.examples || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  if (ONLY) examples = examples.filter((e) => ONLY.has(e.id));
  const stamp = engineStamp();
  log(`engine ${stamp.version} @ ${stamp.shaShort} -> ${OUT_DIR}`);
  mkdirSync(join(OUT_DIR, 'examples'), { recursive: true });
  const results = examples.map(buildExample);
  writeFileSync(join(OUT_DIR, 'examples', 'index.html'), galleryHtml(results, stamp));
  const manifest = {
    generatedFrom: 'apps/hello/*',
    engine: stamp,
    examples: results.map((r) => ({ id: r.id, title: r.title, tags: r.tags || [], ok: !!r.ok, reason: r.reason || null, href: r.ok ? `/examples/${r.id}/` : null })),
  };
  writeFileSync(join(OUT_DIR, 'examples', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const ok = results.filter((r) => r.ok).length;
  log(`done: ${ok}/${results.length} examples built. gallery + manifest written.`);
  if (ok === 0) process.exitCode = 1;
}

// run only when invoked directly (not when imported for galleryHtml regeneration)
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
