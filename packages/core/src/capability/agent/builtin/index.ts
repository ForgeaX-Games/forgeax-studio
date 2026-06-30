/**
 * 内置 subagent 类型聚合出口(AGENT pack 的 builtin 组)。
 *
 * `builtinSubagents` 即"无 disk agent 时"父模型可用的内置子 agent 类型列表,
 * 交给 `buildSubagentRegistry(builtins, disk)` 作为 builtins 入参(disk 同名覆盖)。
 * 当前包含:
 *   - `Explore`:只读 fan-out 调查 agent(轻装、返回绝对路径)。
 *   - `general-purpose`:通用多步研究/执行 agent(全量工具)。
 *
 * Boundary: 仅 import core-local agent builtin 子模块。
 */
import type { SubagentType } from '../../../agent/subagent-registry';
import { exploreAgent } from './explore';
import { generalPurposeAgent } from './general-purpose';

export { exploreAgent } from './explore';
export { generalPurposeAgent } from './general-purpose';

/** 内置 subagent 类型列表(供 buildSubagentRegistry 作 builtins 入参)。 */
export const builtinSubagents: SubagentType[] = [exploreAgent, generalPurposeAgent];
