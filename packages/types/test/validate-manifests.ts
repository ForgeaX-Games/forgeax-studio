/**
 * Phase A1 验收 / 回归测试.
 *
 * 跑过 packages/marketplace/plugins/* /forgeax-plugin.json + 任何 ~/.forgeax/plugins/
 * 下的玩家自造 plugin。所有真实 manifest 必须 pass；任何失败都 print 详细 path。
 *
 * 用法：bun test/validate-manifests.ts
 *      （也作为 PR-CI 的 lint 步骤接入）
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ManifestSchema, parseManifest, type PluginManifest } from '../src/manifest';

interface Finding {
  path: string;
  ok: boolean;
  errors?: string[];
  warnings?: string[];
  manifest?: PluginManifest;
}

function findRepoRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(cur, 'AGENTS.md')) && existsSync(join(cur, 'packages'))) return cur;
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}

function listManifests(root: string): string[] {
  const out: string[] = [];
  const dirs = [
    join(root, 'packages/marketplace/plugins'),
    join(process.env.HOME ?? '', '.forgeax/plugins'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        if (!statSync(full).isDirectory()) continue;
        const m = join(full, 'forgeax-plugin.json');
        if (existsSync(m)) out.push(m);
      } catch { /* ignore */ }
    }
  }
  return out;
}

function formatZodIssue(prefix: string, issue: unknown): string {
  if (!issue || typeof issue !== 'object') return `${prefix}: ${String(issue)}`;
  const { path, message, code } = issue as { path?: unknown[]; message?: string; code?: string };
  const where = Array.isArray(path) && path.length ? path.join('.') : '<root>';
  return `${prefix} [${code}] @ ${where}: ${message}`;
}

function validate(file: string): Finding {
  let raw: string;
  try { raw = readFileSync(file, 'utf-8'); } catch (e) {
    return { path: file, ok: false, errors: [`read failed: ${(e as Error).message}`] };
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch (e) {
    return { path: file, ok: false, errors: [`invalid JSON: ${(e as Error).message}`] };
  }
  const r = parseManifest(json);
  if (!r.ok) {
    return {
      path: file,
      ok: false,
      errors: r.error?.issues.map((i) => formatZodIssue('zod', i)) ?? ['unknown zod failure'],
      warnings: r.warnings,
    };
  }
  return { path: file, ok: true, manifest: r.manifest, warnings: r.warnings };
}

function main(): number {
  const root = findRepoRoot(process.cwd());
  const files = listManifests(root);
  if (!files.length) {
    console.error('no manifest files found under', root);
    return 2;
  }
  console.log(`# Validating ${files.length} manifest(s) under ${root}\n`);

  const findings = files.map(validate);
  const failed = findings.filter((f) => !f.ok);
  const passed = findings.filter((f) => f.ok);

  for (const f of passed) {
    const id = f.manifest?.id ?? '?';
    const kind = f.manifest?.kind ?? '?';
    const warn = f.warnings?.length ? ` (warnings: ${f.warnings.length})` : '';
    console.log(`  ok  ${id.padEnd(40)} ${kind.padEnd(14)} ${f.path}${warn}`);
  }

  if (failed.length) {
    console.log('\n# Failures');
    for (const f of failed) {
      console.log(`\n  ❌ ${f.path}`);
      for (const e of f.errors ?? []) console.log(`     ${e}`);
    }
  }

  console.log(`\n# Summary: ${passed.length}/${findings.length} ok, ${failed.length} failed`);
  return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main());
}

// Re-export for unit tests (bun test consumers)
export { validate, listManifests, findRepoRoot, ManifestSchema };
