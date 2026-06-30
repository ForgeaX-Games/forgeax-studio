#!/usr/bin/env node
/**
 * Boundary lint for forgeax-core (设计稿 §9 不变量 10).
 *
 * forgeax-core src/ may import ONLY:
 *   - relative paths (./ ../) within the package
 *   - @forgeax/agent-runtime (the AgentKernel contract) + subpaths
 *   - @forgeax/types (shared DTOs) + subpaths
 *   - node: builtins
 *   - an explicit ALLOW list of provider runtime deps (extended as phases land)
 *
 * It must NOT import forgeax-cli / interface / studio / external-kernel SDKs / @anthropic-ai/*
 * directly — those would invert the host↔core dependency. Fails CI on violation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Bare specifiers allowed (exact or as a scope/pkg prefix).
const ALLOW_PREFIXES = [
  '@forgeax/agent-runtime',
  '@forgeax/types',
  'node:',
  // Bun runtime builtin — used only by co-located `*.test.ts` (analogous to `node:`).
  'bun:',
  // 可观测性契约:机制层只认 @opentelemetry/api(zero-dep / noop-default,**仅 type/noop**)。
  // SDK / exporter / consola 全限 HOST(见 HOST_ALLOW_PREFIXES)。唯一入口 src/observability/contract.ts。
  '@opentelemetry/api',
  // Provider runtime deps land in F1 — add them here when the provider layer moves.
];

const DENY_HINTS = [
  '@forgeax/forgeax-cli',
  '@forgeax/interface',
  '@forgeax/studio',
  '@forgeax/server',
  '@anthropic-ai/',
  '/cli/',
];

// ── HOST layer (src/cli/ + src/tui/) ──
// 这两层是 forgeax-core 自带的「最小宿主」(CLI + Ink TUI),允许:
//   (a) 跨 host 目录的相对 import(含 ../cli/...) —— 不触发 '/cli/' 的 DENY_HINT;
//   (b) 已在 package.json dependencies 里声明的 UI 第三方依赖。
// 机制层(agent/ capability/ provider/ permission/ context/ events/ history/
//   runtime/ kernel-facade/ inject/ diagnostics/)仍走 STRICT 规则不变。
const HOST_DIR_PREFIXES = ['cli/', 'tui/'];
const HOST_ALLOW_PREFIXES = [
  'ink',
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'ink-spinner',
  'cli-highlight',
  'diff',
  // /remote-control(TUI-only):QR 渲染(qrcode 字面 import)。微信通道(remote/wechat/)是
  //   openclaw 纯 HTTP 实现,只用 node: + 全局 fetch,无第三方 bare 依赖,故此处仅需放行 qrcode。
  'qrcode',
  // 可观测性 HOST 实现(src/cli/observability/):OTel SDK + OTLP exporter + consola(v3/B 档)。
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/resources',
  '@opentelemetry/semantic-conventions',
  'consola',
];
// host 文件仍绝对禁止 import 的真·禁区(倒置分层 / 引内核 SDK)。
const HOST_DENY_HINTS = [
  '@forgeax/forgeax-cli',
  '@forgeax/server',
  '@forgeax/interface',
  '@forgeax/studio',
  '@anthropic-ai/',
];

function isHostFile(rel) {
  return HOST_DIR_PREFIXES.some((p) => rel.startsWith(p));
}

function isHostAllowed(spec) {
  if (spec.startsWith('.')) return true; // 相对路径(含 ../cli/...)host 层放行
  if (isAllowed(spec)) return true; // 复用 STRICT 的 allow(node:/agent-runtime/types)
  return HOST_ALLOW_PREFIXES.some((p) => spec === p || spec.startsWith(`${p}/`));
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

// Static `import`/`export ... from '<spec>'` statements always START a line — anchor on
// `^\s*(import|export)` (multiline) so a `from` inside a string literal (e.g. a field key
// `reqStr(o, 'from', ...)`) is never mistaken for a module specifier. The body `[^;]*?` spans
// multi-line import clauses but cannot cross a statement terminator `;`, so a line-starting
// `export const ...;` won't lazily reach a later import's `from`. Plus dynamic import().
const importRe =
  /^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

// `node:` / `bun:` are protocol-scheme builtins → prefix-match without a `/` separator.
const SCHEME_PREFIXES = new Set(['node:', 'bun:']);
function isAllowed(spec) {
  if (spec.startsWith('.')) return true;
  return ALLOW_PREFIXES.some((p) => spec === p || spec.startsWith(SCHEME_PREFIXES.has(p) ? p : `${p}/`));
}

const violations = [];
for (const file of walk(SRC)) {
  const rel = file.replace(`${SRC}/`, '');
  const host = isHostFile(rel);
  const text = readFileSync(file, 'utf8');
  let m;
  while ((m = importRe.exec(text)) !== null) {
    const spec = m[1] ?? m[2];
    if (!spec) continue;
    if (host) {
      // HOST 层:放行相对/node:/agent-runtime/types/声明的 UI 依赖;
      //   只查真·禁区(倒置分层 / 内核 SDK),不查 '/cli/' 这类机制层提示。
      if (!isHostAllowed(spec) || HOST_DENY_HINTS.some((h) => spec.includes(h))) {
        violations.push({ file: rel, spec });
      }
    } else if (!isAllowed(spec) || DENY_HINTS.some((h) => spec.includes(h))) {
      violations.push({ file: rel, spec });
    }
  }
}

if (violations.length > 0) {
  console.error('forgeax-core boundary violations (only agent-runtime/types/node + relative allowed):');
  for (const v of violations) console.error(`  ${v.file}  →  ${v.spec}`);
  process.exit(1);
}
console.log('forgeax-core boundary check: OK');
