/**
 * Permission inspect (PERM) —— `/permissions` 命令的 A 层只读能力。
 *
 * 任务 017 的 A 层:把已实现的权限引擎(`engine.ts`)+ 规则集(`rules.ts`)的
 * 「当前 allow/deny/ask 规则 + 当前模式」整理成可渲染的结构,并提供一个
 * `setPermissionMode` 的入参校验适配器。
 *
 * 设计:本文件**只读 / 纯函数**,不持有任何状态。规则集与当前模式由 host 注入
 * (rules 来自 `agent.options.rules`,mode 来自 `agent.currentMode`)——这与 017
 * 的硬边界一致(不碰 engine.ts、不进 tui/)。host / serve 把这两件数据喂进来,
 * 拿到可渲染视图;`setPermissionMode` 的真正生效(改活 agent)由 host 调
 * `agent.setMode(...)` 完成,本文件只负责**把任意字符串安全收敛成合法
 * PermissionMode**(越界 → null,fail-closed)。
 *
 * Boundary: 只 import 同目录 engine/rules 的**类型**(不引第三方)。
 */
import type { PermissionMode } from './engine';
import {
  normalizeRules,
  type PermissionRule,
  type PermissionRuleSet,
} from './rules';

/** 合法权限模式的运行时清单(单一真相)。
 *
 *  ⚠️ 故意不硬编码散落各处:这里用 `satisfies readonly PermissionMode[]` 把它和
 *  engine 暴露的 `PermissionMode` 类型钉在一起——若 021/未来给类型增删模式,这一行
 *  的类型检查会强制同步本清单(漏改即编译失败),避免枚举漂移。
 *  目前类型含 default / acceptEdits / plan / bypassPermissions 四值。 */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
] as const satisfies readonly PermissionMode[];

/** 一条规则的可渲染视图:原始规则 + 还原成 `Tool(content)` / `Tool` 的展示串。 */
export interface PermissionRuleView {
  /** 原始规则(供调用方按需取字段)。 */
  rule: PermissionRule;
  /** 展示串,如 `Bash(git *)` / `Write` / `mcp__server`。 */
  display: string;
}

/** 权限规则 + 当前模式的完整只读视图(`/permissions` 渲染数据源)。 */
export interface PermissionRulesView {
  /** 当前权限模式。 */
  mode: PermissionMode;
  /** allow / ask / deny 三桶,每桶已格式化为可渲染条目。 */
  allow: PermissionRuleView[];
  ask: PermissionRuleView[];
  deny: PermissionRuleView[];
  /** 各桶条数(便于「allow: 3 / ask: 1 / deny: 0」概览,免调用方再数)。 */
  counts: { allow: number; ask: number; deny: number };
}

/**
 * 把一条规则还原成展示串(`parseRuleString` 的逆)。
 * - 无 content → `ToolName`
 * - 有 content → `ToolName(content)`
 */
export function formatRule(rule: PermissionRule): string {
  if (rule.content === undefined || rule.content.length === 0) return rule.toolName;
  return `${rule.toolName}(${rule.content})`;
}

/** 把一桶规则映射成可渲染视图条目。 */
function viewBucket(rules: ReadonlyArray<PermissionRule>): PermissionRuleView[] {
  return rules.map((rule) => ({ rule, display: formatRule(rule) }));
}

/**
 * 整理当前权限规则集 + 模式为可渲染视图。**纯函数**:由 host 注入 rules / mode。
 *
 * @param rules 当前规则集(host 注入,可能为 Partial/null)。内部 normalize 兜底空桶。
 * @param mode  当前权限模式(host 从活 agent 读)。
 */
export function getPermissionRules(
  rules: Partial<PermissionRuleSet> | null | undefined,
  mode: PermissionMode,
): PermissionRulesView {
  const set = normalizeRules(rules);
  const allow = viewBucket(set.allow);
  const ask = viewBucket(set.ask);
  const deny = viewBucket(set.deny);
  return {
    mode,
    allow,
    ask,
    deny,
    counts: { allow: allow.length, ask: ask.length, deny: deny.length },
  };
}

/** value 是否为合法 PermissionMode(运行时守卫,清单见 PERMISSION_MODES)。 */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * `setPermissionMode` 的入参校验适配器:把任意字符串安全收敛成合法 PermissionMode。
 *
 * 合法 → 原值;越界/非字符串 → null(fail-closed,调用方应拒绝切换而非默默降级)。
 * host 拿到非 null 结果后调 `agent.setMode(mode)` 让其对后续 turn 生效。
 */
export function coercePermissionMode(value: unknown): PermissionMode | null {
  return isPermissionMode(value) ? value : null;
}
