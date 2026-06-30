/**
 * Agent 巡检 —— 把 builtin + disk 两组 SubagentType 摊平成可展示的清单(AGENT pack)。
 *
 * `/agents` 命令(及 Studio serve 出口)要回答"有哪些子 agent、各自角色/工具集/来源"。
 * 本文件提供**纯函数** `inspectAgents`:吃 builtin 组 + disk 组(+ 可选父侧全量工具),
 * 吐 `AgentInfo[]`,不持有任何状态、不读盘、不碰 registry 单例,故 serve / host / 测试
 * 均可直接复用同一真相。
 *
 * 数据来源(确认过 file:line):
 *   - builtin 组 = `capability/agent/builtin/index.ts` 的 `builtinSubagents`(Explore /
 *     general-purpose);
 *   - disk 组 = `capability/agent/loader.ts` 的 `loadAgentDefs(dirs)`(扫
 *     `.forgeax/agents/*.md`);
 *   - 合并语义对齐 `registry-build.ts`:**disk 同名 last-wins 覆盖 builtin**。
 *
 * 工具解析与 `agent/subagent-registry.ts` 的 `resolveSubagentTools` 同逻辑(应用
 * allowedTools 过滤 + 强制剥 'Task' 防递归),与子 loop 真正 fork 时拿到的工具集
 * **一致**。未提供 `allTools` 时,工具列用占位 `'*'`(无过滤器)或 `[]`(有过滤器
 * 但缺上下文无法展开)。
 *
 * Boundary: 仅 import core-local(agent/subagent-registry + capability/types)。
 */
import type { SubagentType } from '../../agent/subagent-registry';
import type { AgentTool } from '../types';

/** 一个 agent 的来源:内置 vs 用户磁盘(`.forgeax/agents/*.md`)。 */
export type AgentSource = 'builtin' | 'custom';

/**
 * `/agents` 展示用的单个 agent 摘要。
 *
 * - `name`:类型标识(Task.subagent_type 取此值)。
 * - `role`:角色标识(SubagentType.role;缺省 undefined)。
 * - `description`:一句话用途(给父模型/用户看)。
 * - `tools`:该 agent 实际可用的工具名列表(已剥 'Task')。
 *   · 提供 `allTools` → 真实解析结果(与 fork 时一致);
 *   · 未提供且无 `allowedTools` 过滤器 → `['*']`(表示全量);
 *   · 未提供但有过滤器 → `[]`(无法在缺工具上下文下展开,留空表"按声明过滤")。
 * - `source`:`'builtin'` 或 `'custom'`(disk 同名覆盖内置 → 记为 custom)。
 */
export interface AgentInfo {
  name: string;
  role?: string;
  description: string;
  tools: string[];
  source: AgentSource;
}

/** inspectAgents 入参:两组定义 + 可选父侧全量工具(用于精确解析工具集)。 */
export interface InspectAgentsArgs {
  /** 内置 subagent 组(= `builtinSubagents`)。 */
  builtins: SubagentType[];
  /** 磁盘加载的 subagent 组(= `loadAgentDefs(dirs)`)。 */
  disk: SubagentType[];
  /** 可选:父侧全量工具;提供则按真实 fork 逻辑解析每个 agent 的工具集。 */
  allTools?: AgentTool[];
}

/**
 * 把某个 SubagentType 解析成可展示的工具名列表。
 *
 * 解析逻辑与 `resolveSubagentTools`(subagent-registry)对齐,保证与子 loop fork 时
 * 拿到的工具集一致:**先应用 allowedTools 过滤,再无条件剥掉 'Task'**(防递归)。
 *
 * - 有 `allTools` → 真实解析结果(含强制剥 'Task');
 * - 无 `allTools`:无过滤器 → `['*']`(全量);有过滤器 → `[]`(缺上下文,无法展开)。
 */
function toolNamesOf(t: SubagentType, allTools?: AgentTool[]): string[] {
  if (allTools) {
    const picked = t.allowedTools ? t.allowedTools(allTools) : allTools;
    // 防递归:子 agent 永不拿到 Task,无论上面过滤器是否疏忽放行(对齐 resolveSubagentTools)。
    return picked.filter((tool) => tool.name !== 'Task').map((tool) => tool.name);
  }
  return t.allowedTools ? [] : ['*'];
}

/**
 * 摊平 builtin + disk 两组为 `/agents` 清单。
 *
 * 合并语义对齐 `buildSubagentRegistry`:先 builtin 后 disk,**同名 disk 覆盖 builtin**
 * (覆盖项记 `source: 'custom'`)。结果按 name 字典序稳定排序,便于渲染/快照测试。
 *
 * @returns 去重(按 name)后的 AgentInfo 列表
 */
export function inspectAgents(args: InspectAgentsArgs): AgentInfo[] {
  const { builtins, disk, allTools } = args;
  const byName = new Map<string, AgentInfo>();

  for (const t of builtins) {
    byName.set(t.name, {
      name: t.name,
      role: t.role,
      description: t.description,
      tools: toolNamesOf(t, allTools),
      source: 'builtin',
    });
  }
  // disk last-wins:同名覆盖并改记来源为 custom(与 registry-build 的覆盖语义一致)。
  for (const t of disk) {
    byName.set(t.name, {
      name: t.name,
      role: t.role,
      description: t.description,
      tools: toolNamesOf(t, allTools),
      source: 'custom',
    });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
