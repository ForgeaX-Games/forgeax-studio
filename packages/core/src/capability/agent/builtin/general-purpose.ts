/**
 * 内置 subagent 类型 —— `general-purpose`(通用子 agent)。
 *
 * 一个通用、能干的多步研究/执行子 agent:父模型把一个完整任务交给它,它自己
 * 规划、用全量工具(读/写/搜/跑命令等)推进直到完成,最后精炼汇报结果。
 *
 * - `allowedTools: undefined`:不做工具过滤 = 拿到父侧全量工具;但 'Task' 由
 *   `resolveSubagentTools` 始终强制剥离,杜绝无限派生。
 * - 不设 `omitHeavyContext`:通用 agent 可能需要父侧上下文来完成任务。
 *
 * Boundary: 仅 import core-local 契约。
 */
import type { SubagentType } from '../../../agent/subagent-registry';

/** 内置通用多步研究/执行 subagent:general-purpose。 */
export const generalPurposeAgent: SubagentType = {
  name: 'general-purpose',
  description:
    'General-purpose agent for multi-step research and execution: plans, uses all available tools to complete the task, and reports the result concisely.',
  systemPrompt: [
    'You are a general-purpose subagent: a capable, autonomous agent.',
    '',
    'You are given a task by the parent agent. Plan as needed, use the available tools to carry it out end to end, and complete the task.',
    '',
    'Rules:',
    '- Work the task to completion before reporting back; do not stop early to ask unless truly blocked.',
    '- Use the tools available to you to investigate, make changes, and verify your work.',
    '- When done, report concisely: what you did, the outcome, and any absolute file paths the parent needs.',
  ].join('\n'),
  // allowedTools: undefined → 全量工具('Task' 仍被 resolveSubagentTools 强制剥离)。
};
