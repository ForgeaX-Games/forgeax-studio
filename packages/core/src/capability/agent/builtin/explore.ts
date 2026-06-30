/**
 * 内置 subagent 类型 —— `Explore`(只读调查 agent)。
 *
 * Explore 是一个**只读**的并行调查/搜索子 agent:父模型把"去仓库里查清某件事"
 * fan-out 给它,它用读/搜工具(Read/Glob/Grep 等)定位事实,**返回结论 + 绝对
 * 路径**,从不创建/修改任何文件。语义:轻量、只读、答复精炼。
 *
 * - `omitHeavyContext: true`:Explore 只需任务描述即可干活,父侧大块 perception /
 *   历史对它无益,略去以省 token(标记由 subagent.ts 在 fork 时消费)。
 * - `allowedTools`:只放行只读/搜索类工具(见 `READONLY`);排除 Write/Edit/
 *   NotebookEdit 等写工具,'Task' 由 `resolveSubagentTools` 始终强制剥离。
 *   不放行 Bash(本仓 bash 非只读),避免它意外改盘。
 *
 * Boundary: 仅 import core-local 契约。
 */
import type { SubagentType } from '../../../agent/subagent-registry';
import type { AgentTool } from '../../../capability/types';

/**
 * Explore 可用的只读/搜索工具名集合。
 *
 * 同时收录 canonical name(本仓内置工具的 `name`,小写蛇形)与 PascalCase 别名,
 * 无论 host 用哪种登记法都能命中。涵盖:文件读取(read_file/Read)、
 * 文件名 glob(glob/Glob)、内容 grep(grep/Grep)、网页拉取(web_fetch/WebFetch)、
 * 网页搜索(web_search/WebSearch)。**不含**任何写工具与 bash。
 */
const READONLY = new Set<string>([
  'read_file',
  'Read',
  'glob',
  'Glob',
  'grep',
  'Grep',
  'web_fetch',
  'WebFetch',
  'web_search',
  'WebSearch',
]);

/** 内置只读调查 subagent:Explore。 */
export const exploreAgent: SubagentType = {
  name: 'Explore',
  role: 'explorer',
  omitHeavyContext: true,
  description:
    'Read-only fan-out investigator: searches the codebase/web and returns concise conclusions with absolute file paths; never creates or modifies files.',
  systemPrompt: [
    'You are Explore, a read-only investigation subagent.',
    '',
    'Your job is to find facts in the codebase (and, when applicable, on the web) and report them concisely.',
    '',
    'Rules:',
    '- You are READ-ONLY. You MUST NOT create, modify, move, or delete any file.',
    '- Use the read/search tools (Read, Glob, Grep, and web read tools) to investigate.',
    '- Always report concrete findings, not guesses. Quote the load-bearing lines when relevant.',
    '- Refer to files by their ABSOLUTE paths.',
    '- Keep your final report concise: lead with the conclusion, then the supporting evidence (path + line).',
  ].join('\n'),
  allowedTools: (all: AgentTool[]) => all.filter((t) => READONLY.has(t.name)),
};
