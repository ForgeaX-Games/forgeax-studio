#!/usr/bin/env bun
// exemplar-replay.mjs — agent-native 打样 case 的确定性回放与验收。
//
// 复现 docs/ai-native/agent-native-exemplar.md 描述的 demo,并断言五条不变量。
// 按需跑的验收脚本,不是 CI 门禁 —— 需要一套跑着的 Studio 栈。
//
// 断言纪律(反冻结镜像):只断言"门"的不变量 —— 经 dispatch 进门、账本带
// origin、人机同流、undo 跨 origin、错误结构化。绝不断言 op 总数、schema
// 形状、错误文案 —— 那些是高速迭代的快层,冻结它们只会让本脚本无谓变红。
//
// 材质幕用"复用场景内既有材质"(source→target):2026-08-03 实测
// createMaterial→bindAssetRef 的新造-即-绑定配对在 main 上回归(新 GUID 恒
// ASSET_NOT_FOUND,已另行上报 editor);绑既有材质通路正常,demo 语义等价。
//
// 用法(默认打 :18920/:18900;演示栈传 env):
//   FORGEAX_STUDIO_URL=http://localhost:38920 \
//   FORGEAX_SERVER_URL=http://localhost:38900 \
//   bun scripts/ai-native/exemplar-replay.mjs

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDIO = process.env.FORGEAX_STUDIO_URL ?? 'http://localhost:18920';
const SERVER = process.env.FORGEAX_SERVER_URL ?? 'http://localhost:18900';
const CHANNEL_TIMEOUT = Number(process.env.FORGEAX_CHANNEL_TIMEOUT ?? 45000);
const SETTLE_MS = Number(process.env.FORGEAX_SETTLE ?? 2500);

// playwright 解析:env 覆盖 > 裸包名 > 根 .bun store 里的最新版(免配置)。
async function loadChromium() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const candidates = [];
  if (process.env.FORGEAX_PLAYWRIGHT) candidates.push(process.env.FORGEAX_PLAYWRIGHT);
  candidates.push('playwright');
  try {
    const store = join(repoRoot, 'node_modules', '.bun');
    const vers = readdirSync(store).filter((d) => /^playwright@\d/.test(d)).sort().reverse();
    for (const v of vers) candidates.push(join(store, v, 'node_modules', 'playwright', 'index.mjs'));
  } catch { /* no store */ }
  for (const cand of candidates) {
    try {
      const mod = await import(cand);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return chromium;
    } catch { /* try next */ }
  }
  console.error('cannot resolve playwright — set FORGEAX_PLAYWRIGHT to a playwright index.mjs');
  process.exit(2);
}
const chromium = await loadChromium();

const results = [];
function check(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function api(path, init) {
  const res = await fetch(`${SERVER}${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ── 一次性舞台:建游戏 + 激活(记住原激活位,退出时还原)──────────────
const slug = `demo-exemplar-${Math.random().toString(36).slice(2, 8)}`;
const prevActive = (await api('/api/workbench/active-slug')).body?.activeSlug ?? null;
{
  const created = await api('/api/workbench/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, name: 'Agent Exemplar Replay' }),
  });
  if (!created.body?.ok) {
    console.error(`cannot create stage game: ${JSON.stringify(created.body)}`);
    process.exit(2);
  }
  await api(`/api/workbench/games/${slug}/activate`, { method: 'POST' });
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    try { localStorage.setItem('forgeax.onboarding.seen', '1'); } catch { /* private mode */ }
  });
  const page = await ctx.newPage();
  await page.goto(STUDIO, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!globalThis.__forgeaxEval, { timeout: CHANNEL_TIMEOUT });
  await page.waitForTimeout(SETTLE_MS); // channel 先于场景就绪(SKILL §eval)

  // 页面侧统一入口:一切经 __forgeaxEval(与 agent 的 editor_gateway_eval 同信道)。
  const ev = (code) => page.evaluate((c) => globalThis.__forgeaxEval.eval(c), code);
  const evAwait = (code) => page.evaluate(async (c) => {
    const r = globalThis.__forgeaxEval.eval(c);
    if (r.ok && r.value && typeof r.value.then === 'function') {
      try { return { ok: true, value: await r.value }; } catch (e) { return { ok: false, error: { code: 'AWAIT_THREW', hint: String(e) } }; }
    }
    return r;
  }, code);

  // ── 自描述:能力被现场发现(只断存在,不断数量)──────────────────────
  {
    const r = await ev(`(function(){ const ids = gateway.listOps().map(o=>o.id); return ['setSelection','bindAssetRef'].every(k=>ids.includes(k)); })()`);
    check('INV-2', '自描述:listOps 现场发现本 case 全部能力', r.ok && r.value === true);
  }

  // ── 选主角与配角:target=第一个带网格的实体;source=材质与其不同的另一个 ──
  const cast = await ev(`(function(){
    const q = query({with:['MeshRenderer','Name']});
    if (!q.ok || q.rows.length < 2) return null;
    const mat0 = (row) => { const m = row.MeshRenderer.materials.map(x=>x&&x.raw!==undefined?x.raw:x); return m[0]; };
    const target = q.rows[0];
    const src = q.rows.find(r => mat0(r) !== mat0(target));
    if (!src) return null;
    const d = gateway.describeAsset(mat0(src));
    const a = gateway.resolveAsset(mat0(src));
    return { target: { name: target.Name.value, mat0: mat0(target) },
             source: { name: src.Name.value, guid: d.ok ? d.guid : null,
                       base: a.ok ? ((a.asset.paramValues && a.asset.paramValues.baseColor) || (a.asset.values && a.asset.values.baseColor)) : null } };
  })()`);
  if (!(cast.ok && cast.value && cast.value.source.guid)) {
    check('SETUP', '舞台含 target + 异材质 source', false, JSON.stringify(cast).slice(0, 160));
    throw new Error('no cast');
  }
  const { target, source } = cast.value;
  console.log(`stage: ${slug} · target=${target.name}(mat0=${target.mat0}) · source=${source.name}(${source.guid.slice(0, 8)})`);

  const freshTarget = async () => {
    const r = await ev(`(function(){ const q = query({with:['MeshRenderer','Name']}); const row = q.ok && q.rows.find(r=>r.Name.value===${JSON.stringify(target.name)}); if(!row) return null; const m=row.MeshRenderer.materials.map(x=>x&&x.raw!==undefined?x.raw:x); return {entity: row.entity, mat0: m[0]}; })()`);
    return r.ok ? r.value : null;
  };

  // ── 指点(deixis):人选中 → AI 读回同一句柄 ────────────────────────
  let t = await freshTarget();
  {
    await ev(`gateway.dispatch({kind:'setSelection', id:${t.entity}}, 'human')`);
    const r = await ev(`gateway.selectionReadModel()`);
    check('INV-5', '指点:selectionReadModel 读回人选中的句柄', r.ok && r.value?.primary === t.entity, `primary=${r.ok ? r.value?.primary : '?'}`);
  }

  // ── 结构化错误:坏 GUID → run 失败,错误带 code+hint ────────────────
  {
    const rid = `replay-bad-${Math.random().toString(36).slice(2, 8)}`;
    await ev(`gateway.dispatch({kind:'bindAssetRef', requestId:'${rid}', entity:${t.entity}, component:'MeshRenderer', field:'materials', assetType:'MaterialAsset', guids:['00000000-0000-4000-8000-00000000dead'], slot:0}, 'ai')`);
    const run = await evAwait(`gateway.waitOperationRun('${rid}')`);
    const v = run.value?.value ?? run.value;
    const err = v?.error;
    check('INV-3', '结构化错误:失败 run 带 code + 非空 hint', v?.status === 'failed' && !!err?.code && typeof err?.hint === 'string' && err.hint.length > 0, `code=${err?.code}`);
  }

  // ── 执行:AI 把 source 的材质绑到人选中的 target 上(run 关联)──────
  let bindOk = false;
  {
    const rid = `replay-good-${Math.random().toString(36).slice(2, 8)}`;
    await ev(`gateway.dispatch({kind:'bindAssetRef', requestId:'${rid}', entity:${t.entity}, component:'MeshRenderer', field:'materials', assetType:'MaterialAsset', guids:['${source.guid}'], slot:0}, 'ai')`);
    const run = await evAwait(`gateway.waitOperationRun('${rid}')`);
    const v = run.value?.value ?? run.value;
    bindOk = v?.status === 'succeeded';
    check('BEAT-EXEC', 'bindAssetRef 成功(run 终态 succeeded)', bindOk, `status=${v?.status}${v?.error ? ` err=${v.error.code}` : ''}`);
  }

  // ── 结果可验证:槽位变化,且新材质颜色 = source 的颜色 ──────────────
  let after = null;
  if (bindOk) {
    after = await freshTarget();
    const r = await ev(`(function(){ const a = gateway.resolveAsset(${after.mat0}); return a.ok ? ((a.asset.paramValues && a.asset.paramValues.baseColor) || (a.asset.values && a.asset.values.baseColor)) : null; })()`);
    const sameColor = r.ok && Array.isArray(r.value) && Array.isArray(source.base)
      && r.value.length === source.base.length && r.value.every((x, i) => Math.abs(x - source.base[i]) < 1e-6);
    check('BEAT-VERIFY', '槽位已换且颜色与 source 一致(经门读回)', after.mat0 !== target.mat0 && sameColor, `mat0 ${target.mat0}→${after.mat0}`);
  }

  // ── 留痕:同一条账本流里,人机两源并存 ─────────────────────────────
  {
    const r = await ev(`(function(){ const log = gateway.auditLog(); return { human: log.some(e=>e.op.kind==='setSelection'&&e.origin==='human'), ai: log.some(e=>e.op.kind==='bindAssetRef'&&e.origin==='ai') }; })()`);
    check('INV-4', '留痕:auditLog 单流并载 origin:human 与 origin:ai', r.ok && r.value.human && r.value.ai);
  }

  // ── undo 跨 origin:一次通用 undo 撤掉 AI 的写入,槽位还原 ──────────
  if (bindOk && after) {
    const u = await ev(`gateway.undo()`);
    const back = await freshTarget();
    check('INV-1', '单门+undo:通用 undo 撤销 AI 侧写入,槽还原', u.ok && u.value === true && back && back.mat0 === target.mat0, `mat0 back to ${back?.mat0}`);
  }

  await ev(`gateway.dispatch({kind:'setSelection', id:null}, 'human')`);
} finally {
  await browser.close();
  if (prevActive && prevActive !== slug) {
    await api(`/api/workbench/games/${prevActive}/activate`, { method: 'POST' }).catch(() => {});
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => f.id).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
