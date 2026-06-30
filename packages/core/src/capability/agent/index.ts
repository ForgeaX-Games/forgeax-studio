/**
 * AGENT pack —— disk agent 定义加载 + SubagentRegistry 构建出口。
 *
 * `loadAgentDefs(dirs)` 扫磁盘 `*.md` agent 定义为 `SubagentType`;
 * `buildSubagentRegistry(builtins, disk)` 把内置 + 磁盘两组合并成一个 registry
 * (disk 同名覆盖 builtin)。集成方据此让用户用磁盘 agent .md 扩展/覆写子 agent
 * 类型,无 disk agent 时与纯 builtin 行为一致(零回归)。
 *
 * Boundary: 仅 import core-local agent 子模块 + 转出 SubagentType 类型。
 */
export { loadAgentDefs } from './loader';
export { buildSubagentRegistry } from './registry-build';
export { inspectAgents } from './inspect';
export type { AgentInfo, AgentSource, InspectAgentsArgs } from './inspect';
export type { SubagentType } from '../../agent/subagent-registry';
