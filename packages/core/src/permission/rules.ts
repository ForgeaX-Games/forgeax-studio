/**
 * Permission rule model (PERM, consumes C2 `capability/types`).
 *
 * rule 概念:每条规则 = tool name + 可选
 * content glob(如 `Bash(git *)`)。三类规则 deny / ask / always-allow 都用同
 * 一形状,由 `behavior` 区分。`matchRule` 做匹配——name 必须相等(或 MCP
 * server 级 `mcp__server` / `mcp__server__*` 前缀);content 为空 = 整工具匹配,
 * 否则对从 input 抽出的「命令串」做 glob。
 *
 * Boundary: 只 import C2 契约(`../capability/types`)+ node:。不引第三方 glob,
 * 自带一个最小 glob(支持 `*` / `?`,`*` 不跨「空格分词」语义按
 * `Bash(prefix:*)` 习惯——这里用平铺 `*` 匹配任意字符,够覆盖 `git *` / `npm
 * publish:*` 这类前缀规则)。fail-closed:解析失败/形状非法 → 规则不成立(不
 * 授予),由 engine 走更严路径。
 */
import type { PermissionBehavior } from '../capability/types';

/** 一条权限规则。`content` 缺省 = 匹配整个工具;否则对 tool input
 *  抽出的命令串做 glob。 */
export interface PermissionRule {
  /** 工具名,如 `Bash` / `Write` / `mcp__server` / `mcp__server__tool`。 */
  toolName: string;
  /** glob 内容,如 `git *` / `npm publish:*`。缺省 = 整工具规则。 */
  content?: string;
  /** 规则行为(deny / ask / allow;allow 即 always-allow)。 */
  behavior: PermissionBehavior;
  /** 规则来源(用于 decisionReason / 调试),可选。 */
  source?: string;
}

/** 规则集合(host 注入:已合并 deny/ask/allow 各源)。 */
export interface PermissionRuleSet {
  deny: PermissionRule[];
  ask: PermissionRule[];
  /** always-allow。 */
  allow: PermissionRule[];
}

const EMPTY_RULES: PermissionRuleSet = { deny: [], ask: [], allow: [] };

/** 规范化:把可能为 undefined 的桶补成空数组(fail-safe)。 */
export function normalizeRules(rules?: Partial<PermissionRuleSet> | null): PermissionRuleSet {
  if (!rules) return EMPTY_RULES;
  return {
    deny: rules.deny ?? [],
    ask: rules.ask ?? [],
    allow: rules.allow ?? [],
  };
}

/** 解析规则字符串 `Tool(content)` / `Tool` → PermissionRule(不含 behavior)。
 *  返回 null = 形状非法(fail-closed,
 *  调用方应丢弃,不可当成授予)。 */
export function parseRuleString(
  s: string,
  behavior: PermissionBehavior,
  source?: string,
): PermissionRule | null {
  const trimmed = s.trim();
  if (trimmed.length === 0) return null;
  const open = trimmed.indexOf('(');
  if (open === -1) {
    return { toolName: trimmed, behavior, source };
  }
  if (!trimmed.endsWith(')')) return null;
  const toolName = trimmed.slice(0, open).trim();
  if (toolName.length === 0) return null;
  const content = trimmed.slice(open + 1, -1).trim();
  if (content.length === 0) {
    // `Tool()` 等同整工具规则。
    return { toolName, behavior, source };
  }
  return { toolName, content, behavior, source };
}

/** MCP server 级匹配:规则 `mcp__server` 或 `mcp__server__*` 命中
 *  `mcp__server__tool`(server-level rule)。 */
function mcpServerLevelMatch(ruleName: string, toolName: string): boolean {
  if (!ruleName.startsWith('mcp__') || !toolName.startsWith('mcp__')) return false;
  const ruleRest = ruleName.slice('mcp__'.length);
  const toolRest = toolName.slice('mcp__'.length);
  // ruleRest 形如 `server` 或 `server__*`;toolRest 形如 `server__tool`。
  let ruleServer = ruleRest;
  let ruleTool: string | undefined;
  const sep = ruleRest.indexOf('__');
  if (sep !== -1) {
    ruleServer = ruleRest.slice(0, sep);
    ruleTool = ruleRest.slice(sep + 2);
  }
  // 只有「server 级」(无 tool 或 tool 为 *)才走前缀匹配。
  if (ruleTool !== undefined && ruleTool !== '*') return false;
  const toolSep = toolRest.indexOf('__');
  const toolServer = toolSep === -1 ? toolRest : toolRest.slice(0, toolSep);
  return ruleServer.length > 0 && ruleServer === toolServer;
}

/** 最小 glob → RegExp:支持 `*`(任意字符,含空格)与 `?`(单字符);其余字符
 *  转义为字面量。整串锚定(^…$)。 */
function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (const ch of glob) {
    if (ch === '*') {
      out += '.*';
    } else if (ch === '?') {
      out += '.';
    } else {
      // 转义正则元字符。
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  out += '$';
  return new RegExp(out, 's');
}

/** content glob 匹配命令串。`*` 单独成串 = 匹配任意(含空)。 */
export function matchGlob(glob: string, value: string): boolean {
  if (glob === '*') return true;
  if (glob === value) return true;
  try {
    return globToRegExp(glob).test(value);
  } catch {
    // fail-closed:非法 glob 不匹配(不授予)。
    return false;
  }
}

/** 从工具 input 抽出用于 content 匹配的「命令串」。Bash/Shell 类用 `command`
 *  字段;其余 fallback 到常见路径字段或整体 JSON。host 也可在 input 上预置
 *  `__ruleContent` 显式指定(优先)。 */
export function extractRuleContent(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return String(input);
  const obj = input as Record<string, unknown>;
  const explicit = obj.__ruleContent;
  if (typeof explicit === 'string') return explicit;
  const command = obj.command;
  if (typeof command === 'string') return command;
  const filePath = obj.file_path ?? obj.path ?? obj.filePath;
  if (typeof filePath === 'string') return filePath;
  return '';
}

/** 单条规则是否命中 (toolName, input)。整工具规则(无 content)只比 name;
 *  content 规则对抽出的命令串做 glob。 */
export function ruleApplies(rule: PermissionRule, toolName: string, input: unknown): boolean {
  const nameMatch =
    rule.toolName === toolName || mcpServerLevelMatch(rule.toolName, toolName);
  if (!nameMatch) return false;
  if (rule.content === undefined) return true;
  return matchGlob(rule.content, extractRuleContent(input));
}

/** 在一组规则里找第一条命中的(顺序敏感:调用方按 deny→ask→allow 分桶传入)。
 *  返回命中的规则或 undefined。fail-closed:任何条目异常被跳过。 */
export function matchRule(
  rules: ReadonlyArray<PermissionRule>,
  toolName: string,
  input: unknown,
): PermissionRule | undefined {
  for (const rule of rules) {
    try {
      if (ruleApplies(rule, toolName, input)) return rule;
    } catch {
      // 单条规则异常 → 跳过(不因一条坏规则放行其它)。
      continue;
    }
  }
  return undefined;
}
