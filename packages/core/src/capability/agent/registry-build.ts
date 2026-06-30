/**
 * 由 builtin + disk agent 定义构建 SubagentRegistry (AGENT pack)。
 *
 * 先注册全部 builtin,再注册全部 disk —— **disk 同名覆盖 builtin**
 * (SubagentRegistry.register 已是 last-wins,见 subagent-registry)。这样用户
 * 放在磁盘上的 agent .md 可覆写内置同名类型,而无 disk agent 时行为与只有
 * builtin 完全一致(零回归)。
 *
 * Boundary: 仅 import core-local (agent/subagent-registry)。
 */
import {
  SubagentRegistry,
  type SubagentType,
} from '../../agent/subagent-registry';

/**
 * 把 builtin 与 disk 两组 SubagentType 合并成一个 registry。
 *
 * @param builtins 内置 subagent 类型(先注册)
 * @param disk     磁盘加载的 subagent 类型(后注册,同名覆盖 builtin)
 * @returns 已注册全部类型的 SubagentRegistry
 */
export function buildSubagentRegistry(
  builtins: SubagentType[],
  disk: SubagentType[],
): SubagentRegistry {
  const reg = new SubagentRegistry();
  for (const t of builtins) reg.register(t);
  for (const t of disk) reg.register(t); // last-wins:disk 覆盖同名 builtin
  return reg;
}
