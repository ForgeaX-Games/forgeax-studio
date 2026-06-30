/**
 * Subagent 类型注册表(subagent_type / agent pack)。
 *
 * 一个 `SubagentType` = 一种命名的子 agent 角色:自带 system 首段、可选工具过滤、
 * 模型/turns/预算约束。父模型在 Task 工具里通过 `subagent_type` 选一种类型,registry
 * 据此解析出该子 loop 的 system + tools(详见 subagent.ts `TaskToolDeps`)。
 *
 * 本文件只管"注册/解析",真正的 fork loop 在 subagent.ts。Sub 集成方把本 registry
 * 的解析 helper(`resolveSubagentTools` / `resolveSubagentSystem`)接到 `TaskToolDeps`
 * 的 `resolveTools` / `resolveSystem` 上。
 *
 * 防递归铁律:`resolveSubagentTools` **永远剥掉名为 'Task' 的工具**——无论某类型的
 * `allowedTools` 过滤器是否疏忽放行,子 agent 都拿不到 Task,杜绝无限派生。
 *
 * Boundary: 仅 core 相对 import + node builtins。
 */
import type { AgentTool } from '../capability/types';

/**
 * 一种命名的 subagent 类型(角色)。
 *
 * - `name`:类型标识,Task 工具的 `subagent_type` 取此值。
 * - `description`:给父模型看的一句话用途(进 Task 工具 description 列表)。
 * - `systemPrompt`:子 loop 的 system 首段(leadingSystemText)。
 * - `allowedTools`:可选工具过滤器,从全量工具中挑出本类型可用的子集;
 *   缺省 = 全部(但 'Task' 仍会被强制剥离,见 `resolveSubagentTools`)。
 * - `model` / `maxTurns` / `budget`:可选的子 loop 约束。
 */
export interface SubagentType {
  /** 类型标识(唯一);Task.subagent_type 取此值。 */
  name: string;
  /** 给父模型看的一句话用途。 */
  description: string;
  /** 可选:子 agent 的角色标识(进 `subagent.start` 等事件,供 host 路由/展示用)。 */
  role?: string;
  /** 子 loop 的 system 首段。 */
  systemPrompt: string;
  /** 可选工具过滤:从全量工具挑子集;缺省=全部('Task' 始终被剥)。 */
  allowedTools?: (all: AgentTool[]) => AgentTool[];
  /** 可选:覆盖子 loop 模型。 */
  model?: string;
  /** 可选:子 loop 最大轮数。 */
  maxTurns?: number;
  /** 可选:子 loop 总预算。 */
  budget?: { total: number };
  /** 可选:略去重型上下文(如父侧大块 perception / 历史),让子 loop 轻装上阵。 */
  omitHeavyContext?: boolean;
}

/**
 * Subagent 类型注册表(Map-backed)。
 *
 * - `register`:按 name 注册,同名覆盖。
 * - `resolve`:按 type 取;`resolve(undefined)` → undefined(无默认类型)。
 * - `list`:返回所有已注册类型(注册顺序无保证,以 Map 迭代序为准)。
 */
export class SubagentRegistry {
  private readonly types = new Map<string, SubagentType>();

  /** 注册一种类型;同名覆盖(后注册胜出)。 */
  register(t: SubagentType): void {
    this.types.set(t.name, t);
  }

  /** 按 type 解析;type 为 undefined 或未注册 → undefined。 */
  resolve(type?: string): SubagentType | undefined {
    if (type === undefined) return undefined;
    return this.types.get(type);
  }

  /** 列出所有已注册类型。 */
  list(): SubagentType[] {
    return [...this.types.values()];
  }
}

/**
 * 从 registry 解析某类型的子 agent 可用工具集——供 Sub 集成方接到 `TaskToolDeps.resolveTools`。
 *
 * 行为:
 * 1. 若该类型存在且声明了 `allowedTools` 过滤器 → 用之;否则用全量 `all`。
 * 2. **无论如何**剥掉所有名为 'Task' 的工具(防子 agent 再派子 agent 的无限递归)。
 *
 * @param reg  类型注册表
 * @param type subagent 类型(可为 undefined/未注册 → 回退全量)
 * @param all  父侧全量工具
 * @returns 子 agent 实际可用的工具(必不含 'Task')
 */
export function resolveSubagentTools(
  reg: SubagentRegistry,
  type: string | undefined,
  all: AgentTool[],
): AgentTool[] {
  const t = reg.resolve(type);
  const picked = t?.allowedTools ? t.allowedTools(all) : all;
  // 防递归:子 agent 永不拿到 Task,无论上面过滤器是否疏忽放行。
  return picked.filter((tool) => tool.name !== 'Task');
}

/**
 * 从 registry 解析某类型的子 agent system 首段——供 Sub 集成方接到 `TaskToolDeps.resolveSystem`。
 *
 * @param reg      类型注册表
 * @param type     subagent 类型(可为 undefined/未注册)
 * @param fallback 类型缺失时的兜底 system 文本
 * @returns 该类型的 `systemPrompt`,否则 `fallback`(均缺则 undefined)
 */
export function resolveSubagentSystem(
  reg: SubagentRegistry,
  type: string | undefined,
  fallback?: string,
): string | undefined {
  const t = reg.resolve(type);
  return t?.systemPrompt ?? fallback;
}

/**
 * 把已注册类型渲染成一段简短列表——供 Task 工具 description 展示可选 `subagent_type`。
 *
 * 形如:`- planner: 规划任务\n- coder: 写代码`;无类型时返回空串。
 *
 * @param reg 类型注册表
 * @returns 每行 `- <name>: <description>` 的列表文本
 */
export function describeSubagentTypes(reg: SubagentRegistry): string {
  return reg
    .list()
    .map((t) => `- ${t.name}: ${t.description}`)
    .join('\n');
}
