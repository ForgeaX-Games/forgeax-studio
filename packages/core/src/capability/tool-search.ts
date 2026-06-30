/**
 * ToolSearch + deferred tool loading。当工具集很大时,把声明
 * `shouldDefer()===true`(且非 `alwaysLoad`)的
 * 工具**先不灌给模型**,只给一个 `ToolSearch` 工具 + 一段「可搜索工具清单」
 * (name — searchHint)。模型调 `ToolSearch({query})` 命中后,LOOP 把命中工具
 * 「激活」,下一轮再把它们放进 provider 工具集。
 *
 * 编排(激活态 + effectiveTools 计算)在 agent loop;本文件只出:
 *   - `buildToolSearchTool(deferred, activate)` —— ToolSearch 这个 AgentTool。
 *   - `formatDeferredManifest(deferred)` —— 给 system-reminder 的未激活清单文本。
 *
 * query 三形态(对齐 01.6,通用于所有 deferred 类目):
 *   - `select:nameA,nameB` —— 精确激活这些全名(与 deferred 名集求交,未知忽略)。
 *   - `+term rest`        —— 必含 +term(name/searchHint),再以余下词收窄。
 *   - `keyword...`(裸串)  —— 所有关键词都要命中(name + searchHint),大小写无关。
 *
 * Boundary: 仅 import core-local 契约 + dynamic-reminder。
 */
import { buildTool } from './types';
import type { AgentTool, ToolResult } from './types';
import type { CoreEvent } from '../events/types';
import { wrapSystemReminder } from '../context/dynamic-reminder';

export const TOOL_SEARCH_NAME = 'ToolSearch';

/** max_results 缺省值——截断到前 N 个命中再激活。 */
const DEFAULT_MAX_RESULTS = 5;

/** ToolSearch 输入。 */
export interface ToolSearchInput {
  /**
   * 关键词/意图/精确选择。三形态:
   * - `select:nameA,nameB` 精确激活全名;
   * - `+term rest` 必含 +term 再以余下词收窄;
   * - 裸关键词(空格分隔)按 name+searchHint 做 AND 子串匹配,大小写无关。
   */
  query: string;
  /** 返回并激活的最大命中数(截断在激活之前;缺省 5)。 */
  max_results?: number;
}

/**
 * ToolSearch 结构化结果(对齐 01.6)。`matches` 是截断后的命中(实际激活的集合),
 * `totalMatched` 是截断前的命中总数,`truncatedTo` 是截断上限(= max_results)。
 */
export interface ToolSearchResult {
  /** 截断后的命中工具(即本次激活的集合)。 */
  matches: Array<{ name: string; searchHint?: string }>;
  /** 截断前命中总数(可能 > truncatedTo)。 */
  totalMatched: number;
  /** 本次截断上限(= 生效的 max_results)。 */
  truncatedTo: number;
}

/** 单工具是否含某词(name 或 searchHint 含子串,大小写无关)。 */
function hasTerm(tool: Pick<AgentTool, 'name' | 'searchHint'>, term: string): boolean {
  const needle = term.toLowerCase();
  if (tool.name.toLowerCase().includes(needle)) return true;
  return (tool.searchHint ?? '').toLowerCase().includes(needle);
}

/**
 * 按 query 三形态从 deferred 里筛出命中工具(未截断、保持 deferred 原序)。
 * - `select:` 前缀 → 精确全名匹配(逗号分隔,与 deferred 名集求交,未知忽略)。
 * - 含 `+term` → 必含每个 +term,再以余下裸词收窄(全部 AND)。
 * - 裸词 → 全部 AND 子串匹配。
 */
function filterDeferred(deferred: readonly AgentTool[], query: string): AgentTool[] {
  const q = (query ?? '').trim();
  if (!q) return [];

  // 形态一:select:nameA,nameB —— 精确激活全名。
  if (q.toLowerCase().startsWith('select:')) {
    const wanted = new Set(
      q
        .slice('select:'.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (wanted.size === 0) return [];
    return deferred.filter((t) => wanted.has(t.name));
  }

  // 形态二/三:拆词,分出 +required 与 plain。
  const tokens = q.split(/\s+/).filter(Boolean);
  const required: string[] = [];
  const plain: string[] = [];
  for (const tok of tokens) {
    if (tok.startsWith('+') && tok.length > 1) required.push(tok.slice(1));
    else plain.push(tok);
  }
  const all = [...required, ...plain];
  if (all.length === 0) return [];
  // 所有词(required + plain)都必须命中(name 或 searchHint)。
  return deferred.filter((t) => all.every((term) => hasTerm(t, term)));
}

/**
 * 造 ToolSearch 工具。命中的 deferred 工具(截断到 max_results)经 `activate` 回调登记
 * (由 loop 持有激活态),下一轮 effectiveTools 据此纳入。读 + 并发安全(纯查询,无副作用外溢)。
 * `activate(names)` 契约不变:只激活返回(截断后)的那一批。
 */
export function buildToolSearchTool(
  deferred: readonly AgentTool[],
  activate: (names: string[]) => void,
): AgentTool<ToolSearchInput, ToolSearchResult> {
  return buildTool<ToolSearchInput, ToolSearchResult>({
    name: TOOL_SEARCH_NAME,
    searchHint: 'search for additional tools by keyword and load them',
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    maxResultSizeChars: 20_000,
    inputJSONSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keyword/intent. Forms: "select:nameA,nameB" to load exact tools; "+term rest" to require +term then narrow; or plain keywords (all must match name/searchHint, case-insensitive).',
        },
        max_results: {
          type: 'number',
          description: `Max tools to return and load (truncated before loading). Default ${DEFAULT_MAX_RESULTS}.`,
        },
      },
      required: ['query'],
    },
    async call(input: ToolSearchInput): Promise<ToolResult<ToolSearchResult>> {
      const hits = filterDeferred(deferred, input?.query ?? '');
      const rawMax = input?.max_results;
      const truncatedTo =
        typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
          ? Math.floor(rawMax)
          : DEFAULT_MAX_RESULTS;
      const truncated = hits.slice(0, truncatedTo);
      const matches = truncated.map((t) => ({ name: t.name, searchHint: t.searchHint }));
      if (matches.length > 0) activate(matches.map((m) => m.name));
      return { data: { matches, totalMatched: hits.length, truncatedTo } };
    },
    mapResult(output: ToolSearchResult, toolUseId: string): CoreEvent {
      let content: string;
      if (output.matches.length > 0) {
        const names = output.matches.map((m) => m.name).join(', ');
        const more =
          output.totalMatched > output.matches.length
            ? ` (${output.totalMatched} matched, showing first ${output.matches.length}; raise max_results to see more)`
            : '';
        content = `Loaded ${output.matches.length} tool(s): ${names}.${more} They are available from the next step.`;
      } else {
        content = 'No matching tools found. Try different keywords, "+term" to require a term, or "select:exactName".';
      }
      return {
        type: 'tool.result',
        payload: { toolUseId, content, result: output },
        ts: 0,
        source: TOOL_SEARCH_NAME,
      };
    },
    renderToolUseMessage: (input) => `ToolSearch(${input?.query ?? ''})`,
  });
}

/**
 * 未激活 deferred 工具的可搜索清单,包成 system-reminder(boundary 后、不缓存)。
 * 无未激活工具 → 返回 null(本轮不注入)。
 */
export function formatDeferredManifest(deferred: readonly AgentTool[]): string | null {
  if (deferred.length === 0) return null;
  const lines = deferred.map((t) => `- ${t.name}${t.searchHint ? ` — ${t.searchHint}` : ''}`);
  return wrapSystemReminder(
    `Additional tools are available but not yet loaded. Use the ToolSearch tool with a keyword to load the ones you need:\n${lines.join('\n')}`,
  );
}
