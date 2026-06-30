/**
 * Agent 目录加载 (AGENT pack)。
 *
 * 扫给定目录下的 `*.md` agent 定义文件,解析 frontmatter,规整成
 * `SubagentType`(loadAgentsDir / agent pack)。
 *
 * 一个 agent .md = frontmatter(name/description/role/model/...) + markdown 正文
 * (正文即子 loop 的 systemPrompt):
 *   - frontmatter 缺 `name` 或 `description` → **跳过该文件**(无身份/无用途)。
 *   - `model: inherit` / 空 → undefined(继承父 loop 模型)。
 *   - `tools` 缺省 / 含 `*` → 不设过滤器(全部可用);否则按名过滤。
 *     'Task' 不在此剥离 —— resolveSubagentTools 已强制剥掉,见 subagent-registry。
 *   - 单文件畸形只记 stderr 并跳过,**绝不**让异常冒出 loadAgentDefs。
 *
 * Boundary: 仅 import core-local (skill/frontmatter + agent/subagent-registry)
 * + node:fs / node:path。frontmatter 模块不导出其私有 coercion helper,故本文件
 * 自带极简 asString / asList(boundary: core-local only)。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter, type RawFrontmatterValue } from '../skill/frontmatter';
import type { SubagentType } from '../../agent/subagent-registry';
import type { AgentTool } from '../types';

// ─── 极简 coercion(frontmatter 不导出私有 helper,故 core-local 自带)──────────

/** 嵌套对象判定(排除 array)。 */
function isObject(v: RawFrontmatterValue | undefined): v is Record<string, RawFrontmatterValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 列表里只取标量项(嵌套数组/对象项忽略)。 */
function stringItems(arr: RawFrontmatterValue[]): string[] {
  return arr.filter((x): x is string => typeof x === 'string');
}

/** 取标量字符串:列表取首标量项,嵌套对象无标量语义 → undefined。 */
function asString(v: RawFrontmatterValue | undefined): string | undefined {
  if (v === undefined || isObject(v)) return undefined;
  if (Array.isArray(v)) return stringItems(v)[0];
  return v;
}

/** 取字符串列表:string[] 取标量项;标量按逗号/空白分隔。 */
function asList(v: RawFrontmatterValue | undefined): string[] {
  if (v === undefined || isObject(v)) return [];
  if (Array.isArray(v)) return stringItems(v).filter((x) => x.length > 0);
  return v
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/** YAML-ish boolean(true/yes/1/on → true);缺省/非法 → false。 */
function asBool(v: RawFrontmatterValue | undefined): boolean {
  const s = asString(v);
  if (s === undefined) return false;
  const lower = s.trim().toLowerCase();
  return lower === 'true' || lower === 'yes' || lower === '1' || lower === 'on';
}

/** 取整数:合法整数返回,否则 undefined。 */
function asInt(v: RawFrontmatterValue | undefined): number | undefined {
  const s = asString(v);
  if (s === undefined || s.trim() === '') return undefined;
  const n = Number(s.trim());
  if (!Number.isInteger(n)) return undefined;
  return n;
}

// ─── 单文件解析 ───────────────────────────────────────────────────────────────

/**
 * 解析单个 agent .md → SubagentType;缺 name/description 或解析失败 → null。
 *
 * @param file agent 定义文件绝对路径
 */
function loadOne(file: string): SubagentType | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return null; // 不可读 → 跳过
  }

  const { frontmatter, body } = parseFrontmatter(raw);

  const name = asString(frontmatter.name);
  if (name === undefined || name.trim() === '') return null; // 无身份 → 跳过
  const description = asString(frontmatter.description);
  if (description === undefined || description.trim() === '') return null; // 无用途 → 跳过

  const role = asString(frontmatter.role);

  const rawModel = asString(frontmatter.model);
  const model =
    rawModel === undefined || rawModel.trim() === '' || rawModel.trim() === 'inherit'
      ? undefined
      : rawModel;

  const maxTurns = asInt(frontmatter['max-turns'] ?? frontmatter.maxTurns);
  const omitHeavyContext = asBool(frontmatter['omit-heavy-context']);

  // tools 缺省 / 含 '*' → 不设过滤器(全部);否则按名过滤。'Task' 不在此剥(由
  // resolveSubagentTools 强制剥)。
  const toolNames = asList(frontmatter.tools);
  const allowedTools =
    toolNames.length === 0 || toolNames.includes('*')
      ? undefined
      : (all: AgentTool[]): AgentTool[] => all.filter((t) => toolNames.includes(t.name));

  return {
    name,
    description,
    systemPrompt: body,
    role,
    model,
    maxTurns,
    omitHeavyContext,
    allowedTools,
  };
}

// ─── 多目录扫描 ───────────────────────────────────────────────────────────────

/**
 * 扫多个 agent 根目录,加载所有 `*.md` agent 定义为 `SubagentType`。
 *
 * - 目录不存在 / 不可读 → 跳过该目录(不报错)。
 * - 只认 `*.md` 文件(忽略子目录 / 非 .md / 点开头隐藏文件)。
 * - 单文件畸形 → stderr 警告并跳过,**绝不**让异常冒出本函数。
 * - 同名不去重:调用方(buildSubagentRegistry)按目录序 last-wins 覆盖。
 *
 * @param dirs agent 根目录列表(每个目录下是 `<name>.md`)
 * @returns 解析出的 SubagentType 列表(按目录序、目录内字典序)
 */
export function loadAgentDefs(dirs: string[]): SubagentType[] {
  const defs: SubagentType[] = [];

  for (const dir of dirs) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在 / 不可读 → 跳过
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (!e.name.endsWith('.md')) continue;

      const file = join(dir, e.name);
      // 只认普通文件 / 指向文件的符号链接。
      try {
        if (!statSync(file).isFile()) continue;
      } catch {
        continue;
      }

      try {
        const def = loadOne(file);
        if (def) defs.push(def);
      } catch (err) {
        // 单文件畸形 → 记 stderr 并跳过,绝不冒泡。
        process.stderr.write(
          `[agent-loader] skip malformed agent file ${file}: ${String(err)}\n`,
        );
      }
    }
  }

  return defs;
}
