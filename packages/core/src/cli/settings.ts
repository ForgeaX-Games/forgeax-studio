/**
 * 分层 settings 系统 —— 多 source / 有优先级 / 深 merge 语义 /
 * JSON schema:`settings.json`·`settings.local.json`·`model` 等字段;根目录用
 * `.forgeax`,env 覆盖用 `FORGEAX_CONFIG_DIR`。
 *
 * Source(优先级低→高,后者覆盖前者):
 *   userSettings   全局      `$FORGEAX_CONFIG_DIR/settings.json` 或 `~/.forgeax/settings.json`
 *   projectSettings 项目共享  `<cwd>/.forgeax/settings.json`(提交进 git)
 *   localSettings  项目私有  `<cwd>/.forgeax/settings.local.json`(写时自动 gitignore)
 * (flag/policy 两层本版未做;SETTING_SOURCES 顺序保留扩展位。)
 *
 * 读:`getMergedSettings()` 把各 source 按序深合并(对象递归、数组并集去重、标量覆盖),
 *     session 级缓存,写后失效。写:`updateSettingsForSource()` 只能写三个可编辑层,对
 *     既有文件 merge(`undefined`=删键、数组整替换),落 `JSON + \n`,重置缓存。
 * 读永不抛(缺文件/坏 JSON→{} 或 null);写 best-effort(失败回 error,不抛断交互)。
 * Boundary(HOST 层):仅 core 相对 + node:。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 所有 source(顺序即优先级,低→高;本版仅含三个可编辑层)。 */
export const SETTING_SOURCES = ['userSettings', 'projectSettings', 'localSettings'] as const;
export type SettingSource = (typeof SETTING_SOURCES)[number];

/** settings JSON shape;开放扩展(permissions/hooks/env…)。 */
export interface Settings {
  /** 下次启动的默认 LLM 模型(/model 选择后写入)。 */
  model?: string;
  [key: string]: unknown;
}

/** 全局配置根目录:`FORGEAX_CONFIG_DIR` 优先,否则 `~/.forgeax`。 */
export function configHomeDir(): string {
  return process.env.FORGEAX_CONFIG_DIR || join(homedir(), '.forgeax');
}

/** 项目/local 相对路径。 */
function relativeProjectPath(source: 'projectSettings' | 'localSettings'): string {
  return source === 'projectSettings'
    ? join('.forgeax', 'settings.json')
    : join('.forgeax', 'settings.local.json');
}

/** 某 source 的 settings 文件绝对路径。 */
export function settingsPathForSource(source: SettingSource, cwd: string = process.cwd()): string {
  switch (source) {
    case 'userSettings':
      return join(configHomeDir(), 'settings.json');
    case 'projectSettings':
    case 'localSettings':
      return join(resolve(cwd), relativeProjectPath(source));
  }
}

// ── 缓存(session 级;写后 reset)──
const sourceCache = new Map<string, Settings | null>();
let mergedCache: Settings | null = null;

/** 清空 settings 缓存(写后调用,使下次读重新读盘)。 */
export function resetSettingsCache(): void {
  sourceCache.clear();
  mergedCache = null;
}

/** 读单个 source 的文件;缺文件/解析失败 → null(永不抛)。 */
export function readSettingsForSource(source: SettingSource, cwd: string = process.cwd()): Settings | null {
  const path = settingsPathForSource(source, cwd);
  if (sourceCache.has(path)) return sourceCache.get(path)!;
  let result: Settings | null = null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Settings) : null;
  } catch {
    result = null;
  }
  sourceCache.set(path, result);
  return result;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 读合并:override 覆盖 base —— 对象递归、数组并集去重、标量覆盖。 */
function mergeRead(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const b = out[k];
    if (isPlainObject(b) && isPlainObject(v)) out[k] = mergeRead(b, v);
    else if (Array.isArray(b) && Array.isArray(v)) out[k] = Array.from(new Set([...b, ...v]));
    else out[k] = v;
  }
  return out;
}

/** 各 source 按优先级深合并(低→高),返回快照(至少 {})。session 级缓存。 */
export function getMergedSettings(cwd: string = process.cwd()): Settings {
  if (mergedCache) return mergedCache;
  let merged: Record<string, unknown> = {};
  for (const source of SETTING_SOURCES) {
    const s = readSettingsForSource(source, cwd);
    if (s) merged = mergeRead(merged, s as Record<string, unknown>);
  }
  mergedCache = merged as Settings;
  return mergedCache;
}

/** 写合并:patch 并入既有 —— `undefined`=删键、数组整替换(由调用方算好终态)、对象递归。 */
function mergeWrite(existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      delete out[k];
      continue;
    }
    const b = out[k];
    if (isPlainObject(b) && isPlainObject(v)) out[k] = mergeWrite(b, v);
    else out[k] = v; // 数组整替换、标量覆盖
  }
  return out;
}

/** 把一行 glob 追加进 `<cwd>/.gitignore`(已存在则跳过;best-effort)。 */
function ensureGitignored(rel: string, cwd: string): void {
  try {
    const gi = resolve(cwd, '.gitignore');
    let cur = '';
    try {
      cur = readFileSync(gi, 'utf8');
    } catch {
      /* 无 .gitignore → 新建 */
    }
    const has = cur.split('\n').some((line) => line.trim() === rel);
    if (!has) {
      const sep = cur && !cur.endsWith('\n') ? '\n' : '';
      writeFileSync(gi, cur + sep + rel + '\n', 'utf8');
    }
  } catch {
    /* gitignore 写失败不阻断 */
  }
}

/**
 * 写某可编辑 source 的 settings(merge 进既有文件)。best-effort:成功 `{error:null}`,
 * 失败回 `{error}` 不抛。写 localSettings 时把它加进 `.gitignore`。
 */
export function updateSettingsForSource(
  source: SettingSource,
  patch: Partial<Settings>,
  cwd: string = process.cwd(),
): { error: Error | null } {
  const path = settingsPathForSource(source, cwd);
  try {
    const existing = (readSettingsForSource(source, cwd) ?? {}) as Record<string, unknown>;
    const next = mergeWrite(existing, patch as Record<string, unknown>);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
    resetSettingsCache();
    if (source === 'localSettings') ensureGitignored(relativeProjectPath('localSettings'), cwd);
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e : new Error(String(e)) };
  }
}

/** 便捷:写用户级(全局)settings —— /model 选择默认落这层。 */
export function updateUserSettings(patch: Partial<Settings>, cwd: string = process.cwd()): { error: Error | null } {
  return updateSettingsForSource('userSettings', patch, cwd);
}
