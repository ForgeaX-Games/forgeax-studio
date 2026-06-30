/**
 * SKILL.md frontmatter 解析 (SKILL pack)。
 *
 * 设计稿: core-layer-spec §3.4 (capability host) — skill 是 prompt 型 Command。
 *
 * Boundary: **不引外部 yaml 库** (boundary 禁)。自写极简 YAML-frontmatter parser，
 * 只覆盖 SKILL.md 实际用到的标量 / 列表 / 引号语法。仅 import core-local + node:。
 */

/**
 * 解析后的原始 frontmatter 值。
 * - 标量 → string
 * - 列表 → string[]
 * - 嵌套块 (如 `hooks:`) → 原样保留的对象 (loader 不解释，执行由 host)。
 */
export type RawFrontmatterValue =
  | string
  | string[]
  | RawFrontmatterObject
  | RawFrontmatterValue[];
/** 嵌套对象 (hooks 等结构化字段，递归)。 */
export interface RawFrontmatterObject {
  [key: string]: RawFrontmatterValue;
}

/** 解析后的原始 frontmatter map (key → 标量 / 列表 / 嵌套对象)。 */
export type RawFrontmatter = Record<string, RawFrontmatterValue>;

/** effort 级别。 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
/** effort 取值：命名级别 | 整数。 */
export type EffortValue = EffortLevel | number;

/** shell 取值。 */
export type FrontmatterShell = 'bash' | 'powershell';

/** SKILL.md 拆分结果。 */
export interface ParsedFrontmatter {
  frontmatter: RawFrontmatter;
  /** 去掉 frontmatter 块后的 markdown 正文。 */
  body: string;
}

/** 已规整为强类型的 skill 元数据 (createSkillCommand 消费)。 */
export interface SkillMeta {
  /** 内容来源名 (用 display name `name:` 覆盖，否则用目录名)。 */
  displayName?: string;
  description: string;
  whenToUse?: string;
  version?: string;
  /** model alias 覆盖 (inherit → undefined)。 */
  model?: string;
  /** allowed-tools 列表 (skill 运行时放行的工具名)。 */
  allowedTools: string[];
  argumentHint?: string;
  /** 命名参数 (frontmatter `arguments:`)，按位映射。 */
  argumentNames: string[];
  /** 用户可 /name 调起 (默认 true)。 */
  userInvocable: boolean;
  /** 禁止 SkillTool (model) 调起 (默认 false)。 */
  disableModelInvocation: boolean;
  /** 执行上下文: 'fork' (子 agent 隔离) | 'inline' (默认)。 */
  context: 'fork' | 'inline';
  /** 条件激活的 path 模式 (有则 loader held back，匹配文件后才激活)。 */
  paths?: string[];
  /** fork 时委派的 agent 名 (frontmatter `agent:`)。 */
  agent?: string;
  /** 推理强度 (level 或整数；非法值 → undefined，降级处理)。 */
  effort?: EffortValue;
  /** !`…` 注入块用的 shell (非法值 → undefined，host 缺省 bash)。 */
  shell?: FrontmatterShell;
  /**
   * skill 级 hooks (frontmatter `hooks:`)。**loader 不解释/不校验**，原样
   * 保留嵌套对象,执行由 host (对齐 task 约束:hooks 解析为原样对象即可)。
   * 无 `hooks:` 时 undefined。
   */
  hooks?: RawFrontmatterObject;
}

// ─── 极简 YAML 标量 ───────────────────────────────────────────────────────────

/** 去掉成对引号 (单/双)。 */
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

/** 解析行内 flow 列表 `[a, b, "c d"]` → string[]；非 flow 返回 null。 */
function parseFlowList(raw: string): string[] | null {
  const t = raw.trim();
  if (!(t.startsWith('[') && t.endsWith(']'))) return null;
  const inner = t.slice(1, -1).trim();
  if (inner === '') return [];
  // 朴素逗号切分 (skill frontmatter 不会嵌套对象)，再 unquote。
  return inner
    .split(',')
    .map((x) => unquote(x))
    .filter((x) => x.length > 0);
}

/** 一行的缩进宽度 (前导空格数；tab 记 1)。空/注释行返回 -1 (无意义)。 */
function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ' || ch === '\t') n++;
    else break;
  }
  return n;
}

/**
 * 解析一段块列表 (`- ...`)。支持:
 *   - scalar               标量项
 *   - "quoted scalar"      引号标量
 *   - key: value           对象项 (单 kv,首行带 `- `)
 *   - key: value\n  k2: v2 对象项 (多 kv,后续行同缩进续接)
 * 用于 hooks 等嵌套结构原样保留 (loader 不解释,执行由 host)。
 *
 * @param lines      行数组
 * @param start      本列表起始行号
 * @param itemIndent 各 `- ` 项的缩进
 * @returns [列表, 消费到的下一行号]
 */
function parseList(
  lines: string[],
  start: number,
  itemIndent: number,
): [RawFrontmatterValue[], number] {
  const list: RawFrontmatterValue[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const ct = line.trim();
    if (ct === '' || ct.startsWith('#')) {
      i++;
      continue;
    }
    if (indentOf(line) < itemIndent) break;
    if (!ct.startsWith('- ')) break;

    const afterDash = ct.slice(2); // 去掉 `- `
    const colon = afterDash.indexOf(':');
    // `- key: value` → 对象项 (key 不能含引号/方括号才算 map kv)。
    if (colon !== -1 && !/^["'\[]/.test(afterDash)) {
      const k = afterDash.slice(0, colon).trim();
      const v = afterDash.slice(colon + 1).trim();
      const itemObj: RawFrontmatterObject = {};
      if (k !== '') {
        const flow = parseFlowList(v);
        itemObj[k] = v === '' ? '' : flow !== null ? flow : unquote(v);
      }
      // 续接同一项的后续 kv 行 (缩进 > itemIndent,非 `- ` 开头)。
      const contentIndent = indentOf(line) + 2;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const cur = lines[j] ?? '';
        const cct = cur.trim();
        if (cct === '' || cct.startsWith('#')) continue;
        if (indentOf(cur) < contentIndent || cct.startsWith('- ')) break;
        const cc = cur.indexOf(':');
        if (cc === -1) break;
        const ck = cur.slice(0, cc).trim();
        const cv = cur.slice(cc + 1).trim();
        if (ck === '') break;
        const cFlow = parseFlowList(cv);
        itemObj[ck] = cv === '' ? '' : cFlow !== null ? cFlow : unquote(cv);
      }
      list.push(itemObj);
      i = j;
      continue;
    }

    // 普通标量项。
    list.push(unquote(afterDash));
    i++;
  }

  return [list, i];
}

/**
 * 解析一段同级 (>= baseIndent 缩进) 的 YAML block 为对象。递归处理嵌套块
 * (如 `hooks:` 下的子 map)，使未知/结构化字段也能被原样保留而不丢整个 skill。
 *
 * 支持:
 *   key: value                标量 (引号可选)
 *   key: [a, b]               行内 flow 列表
 *   key:\n  - item            块列表
 *   key:\n  sub: ...          嵌套对象 (任意深度)
 *   # comment / 空行          跳过
 *
 * @param lines      整个 frontmatter block 的行数组
 * @param start      本层起始行号
 * @param baseIndent 本层最小缩进 (低于此缩进视作上层，停止)
 * @returns [解析出的对象, 消费到的下一行号]
 */
function parseBlock(
  lines: string[],
  start: number,
  baseIndent: number,
): [RawFrontmatterObject, number] {
  const obj: RawFrontmatterObject = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    const indent = indentOf(line);
    if (indent < baseIndent) break; // 退回上层

    // 裸列表项无归属 (理应被块列表头的 lookahead 吸收)，跳过。
    if (trimmed.startsWith('- ')) {
      i++;
      continue;
    }

    const colon = line.indexOf(':');
    if (colon === -1) {
      i++;
      continue;
    }
    const key = line.slice(0, colon).trim();
    if (key === '') {
      i++;
      continue;
    }
    const rest = line.slice(colon + 1).trim();

    if (rest !== '') {
      // 行内值: flow 列表 或 标量。
      const flow = parseFlowList(rest);
      obj[key] = flow !== null ? flow : unquote(rest);
      i++;
      continue;
    }

    // rest 为空：可能是块列表 / 嵌套对象 / 空标量。先看下一有效行的形态。
    let j = i + 1;
    while (j < lines.length) {
      const nt = (lines[j] ?? '').trim();
      if (nt === '' || nt.startsWith('#')) {
        j++;
        continue;
      }
      break;
    }
    if (j >= lines.length || indentOf(lines[j] ?? '') <= indent) {
      // 后面没有更深缩进 → 空标量。
      obj[key] = '';
      i++;
      continue;
    }

    const childIndent = indentOf(lines[j] ?? '');
    const childTrimmed = (lines[j] ?? '').trim();

    if (childTrimmed.startsWith('- ')) {
      const [list, next] = parseList(lines, i + 1, childIndent);
      obj[key] = list;
      i = next;
      continue;
    }

    // 嵌套对象：递归解析该子块 (原样保留，未知结构也不丢)。
    const [child, next] = parseBlock(lines, i + 1, childIndent);
    obj[key] = child;
    i = next;
  }

  return [obj, i];
}

/**
 * 拆分 SKILL.md：开头若有 `---\n...\n---\n` frontmatter 块则解析，否则空 map。
 *
 * 支持的语法 (覆盖 SKILL.md 实际所需):
 *   key: value                标量 (引号可选)
 *   key: [a, b, c]            行内 flow 列表
 *   key:\n  - item            块列表
 *   key:\n  sub: ...          嵌套对象 (如 hooks，任意深度，原样保留)
 *   # comment                 整行注释 (跳过)
 *
 * **未知字段一律容忍**：未识别的 key 进入 map，由 toSkillMeta 忽略——后续
 * 加字段时旧 loader 仍能载。结构错乱也只影响该字段，不丢整个 skill。
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  // 兼容 CRLF。frontmatter 必须从文件最开头起。
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { frontmatter: {}, body: content };
  }
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }
  const block = normalized.slice(4, end);
  // body 从结束分隔符那行之后开始 (跳过 `\n---` + 该行剩余 + 换行)。
  const afterFence = normalized.indexOf('\n', end + 1);
  const body = afterFence === -1 ? '' : normalized.slice(afterFence + 1);

  const [fm] = parseBlock(block.split('\n'), 0, 0);
  return { frontmatter: fm, body };
}

// ─── 规整为 SkillMeta ─────────────────────────────────────────────────────────

/** 嵌套对象判定 (排除 array)。 */
function isObject(v: RawFrontmatterValue | undefined): v is RawFrontmatterObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 列表里只取标量项 (对象项在标量/列表语义下忽略)。 */
function stringItems(arr: RawFrontmatterValue[]): string[] {
  return arr.filter((x): x is string => typeof x === 'string');
}

function asString(v: RawFrontmatterValue | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (isObject(v)) return undefined; // 嵌套对象无标量语义
  return Array.isArray(v) ? stringItems(v).join(' ') : v;
}

function asList(v: RawFrontmatterValue | undefined): string[] {
  if (v === undefined || isObject(v)) return [];
  if (Array.isArray(v)) return stringItems(v).filter((x) => x.length > 0);
  // 标量列表字段允许空格 / 逗号分隔。
  return v
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/** YAML-ish boolean (true/yes/1 → true)。缺省走 fallback。 */
function asBool(
  v: RawFrontmatterValue | undefined,
  fallback: boolean,
): boolean {
  if (v === undefined || isObject(v)) return fallback;
  const first = Array.isArray(v) ? v[0] ?? '' : v;
  const s = String(first).trim().toLowerCase();
  if (s === '') return fallback;
  return s === 'true' || s === 'yes' || s === '1' || s === 'on';
}

/** 命名参数：过滤空 + 纯数字 (与 $0/$1 简写冲突)。 */
function parseArgumentNames(v: RawFrontmatterValue | undefined): string[] {
  const isValid = (n: string): boolean => n.trim() !== '' && !/^\d+$/.test(n);
  return asList(v).filter(isValid);
}

/**
 * effort：命名级别 (low/medium/high/max) | 整数。非法值 → undefined
 * (降级处理，不报错)。
 */
function parseEffortValue(
  v: RawFrontmatterValue | undefined,
): EffortValue | undefined {
  const s = asString(v);
  if (s === undefined || s.trim() === '') return undefined;
  const lower = s.trim().toLowerCase();
  if ((EFFORT_LEVELS as readonly string[]).includes(lower)) {
    return lower as EffortLevel;
  }
  const n = parseInt(lower, 10);
  if (!Number.isNaN(n) && Number.isInteger(n)) return n;
  return undefined; // 非法 → degrade
}

/**
 * shell：bash | powershell。非法/缺省 → undefined (host 缺省 bash，
 * 降级处理)。
 */
function parseShell(
  v: RawFrontmatterValue | undefined,
): FrontmatterShell | undefined {
  const s = asString(v);
  if (s === undefined) return undefined;
  const lower = s.trim().toLowerCase();
  if (lower === 'bash' || lower === 'powershell') return lower;
  return undefined; // 非法 → degrade 到 host 缺省
}

/** path 模式：去掉 `/**` 后缀；全 `**` (match-all) 视作无 paths。 */
function parsePaths(v: RawFrontmatterValue | undefined): string[] | undefined {
  const raw = asList(v);
  if (raw.length === 0) return undefined;
  const patterns = raw
    .map((p) => (p.endsWith('/**') ? p.slice(0, -3) : p))
    .filter((p) => p.length > 0);
  if (patterns.length === 0 || patterns.every((p) => p === '**')) {
    return undefined;
  }
  return patterns;
}

/**
 * 把原始 frontmatter + 正文 + 目录名规整成 SkillMeta。
 *
 * @param fm        parseFrontmatter 的 frontmatter map
 * @param body      markdown 正文 (无 description 时取首行做 fallback)
 * @param dirName   skill 目录名 (description fallback / display 缺省)
 */
export function toSkillMeta(
  fm: RawFrontmatter,
  body: string,
  dirName: string,
): SkillMeta {
  const description =
    asString(fm.description) ??
    firstNonEmptyLine(body) ??
    `Skill: ${dirName}`;

  const rawModel = asString(fm.model);
  const model =
    rawModel === undefined || rawModel === 'inherit' ? undefined : rawModel;

  return {
    displayName: asString(fm.name),
    description,
    whenToUse: asString(fm.when_to_use),
    version: asString(fm.version),
    model,
    allowedTools: asList(fm['allowed-tools']),
    argumentHint: asString(fm['argument-hint']),
    argumentNames: parseArgumentNames(fm.arguments),
    userInvocable: asBool(fm['user-invocable'], true),
    disableModelInvocation: asBool(fm['disable-model-invocation'], false),
    context: asString(fm.context) === 'fork' ? 'fork' : 'inline',
    paths: parsePaths(fm.paths),
    agent: asString(fm.agent),
    effort: parseEffortValue(fm.effort),
    shell: parseShell(fm.shell),
    // hooks 原样保留嵌套对象 (loader 不解释，执行由 host)。非对象 → undefined。
    hooks: isObject(fm.hooks) ? fm.hooks : undefined,
  };
}

function firstNonEmptyLine(body: string): string | undefined {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t !== '' && !t.startsWith('#')) return t;
  }
  // 退而取首个标题文本。
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.startsWith('#')) return t.replace(/^#+\s*/, '').trim() || undefined;
  }
  return undefined;
}
