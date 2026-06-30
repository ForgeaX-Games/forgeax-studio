/**
 * Deferred tool loading + ToolSearch 单测 + loop 集成。
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { buildToolSearchTool, formatDeferredManifest, TOOL_SEARCH_NAME } from '../src/capability/tool-search';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

function tool(name: string, searchHint?: string, deferredFlag = false): AgentTool {
  return buildTool({
    name,
    searchHint,
    shouldDefer: deferredFlag ? () => true : undefined,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    call: async () => ({ data: 'ok' }),
    mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
    maxResultSizeChars: 1000,
  });
}

const SIG = { signal: new AbortController().signal };

describe('buildToolSearchTool', () => {
  test('裸关键词:按 name/searchHint 子串命中并激活', async () => {
    const deferred = [tool('db_query', 'query the postgres database', true), tool('send_email', 'send an email', true)];
    const activated: string[] = [];
    const ts = buildToolSearchTool(deferred, (names) => activated.push(...names));
    const r = await ts.call({ query: 'database' }, SIG);
    expect(r.data.matches.map((m) => m.name)).toEqual(['db_query']);
    expect(r.data.matches[0]?.searchHint).toBe('query the postgres database');
    expect(r.data.totalMatched).toBe(1);
    expect(activated).toEqual(['db_query']);
  });

  test('无命中 → 空 matches, 不激活', async () => {
    const deferred = [tool('db_query', 'postgres', true)];
    const activated: string[] = [];
    const ts = buildToolSearchTool(deferred, (names) => activated.push(...names));
    const r = await ts.call({ query: 'nonsense' }, SIG);
    expect(r.data.matches).toEqual([]);
    expect(r.data.totalMatched).toBe(0);
    expect(activated).toEqual([]);
  });

  test('select: 形态精确激活全名(未知忽略,与 deferred 求交)', async () => {
    const deferred = [
      tool('db_query', 'postgres', true),
      tool('send_email', 'email', true),
      tool('http_get', 'fetch url', true),
    ];
    const activated: string[] = [];
    const ts = buildToolSearchTool(deferred, (names) => activated.push(...names));
    const r = await ts.call({ query: 'select:db_query, http_get, ghost_tool' }, SIG);
    expect(r.data.matches.map((m) => m.name)).toEqual(['db_query', 'http_get']);
    expect(activated).toEqual(['db_query', 'http_get']);
  });

  test('+required 形态:必含 +term 再以余下词收窄', async () => {
    const deferred = [
      tool('db_query', 'read postgres rows', true),
      tool('db_write', 'write postgres rows', true),
      tool('cache_read', 'read redis', true),
    ];
    const activated: string[] = [];
    const ts = buildToolSearchTool(deferred, (names) => activated.push(...names));
    // 必含 "postgres" 且含 "read" → 只有 db_query。
    const r = await ts.call({ query: '+postgres read' }, SIG);
    expect(r.data.matches.map((m) => m.name)).toEqual(['db_query']);
    expect(activated).toEqual(['db_query']);
  });

  test('裸多关键词:全部 AND 才命中', async () => {
    const deferred = [
      tool('db_query', 'read postgres rows', true),
      tool('db_write', 'write postgres rows', true),
    ];
    const activated: string[] = [];
    const ts = buildToolSearchTool(deferred, (names) => activated.push(...names));
    const r = await ts.call({ query: 'postgres write' }, SIG);
    expect(r.data.matches.map((m) => m.name)).toEqual(['db_write']);
    // 单词只命中一边的不算:'postgres redis' 两词不能同时命中任一工具。
    const r2 = await ts.call({ query: 'postgres redis' }, SIG);
    expect(r2.data.matches).toEqual([]);
  });

  test('max_results 截断:totalMatched > truncatedTo,只激活截断后的集合', async () => {
    const deferred = [
      tool('svc_a', 'shared svc', true),
      tool('svc_b', 'shared svc', true),
      tool('svc_c', 'shared svc', true),
    ];
    const activated: string[] = [];
    const ts = buildToolSearchTool(deferred, (names) => activated.push(...names));
    const r = await ts.call({ query: 'shared', max_results: 2 }, SIG);
    expect(r.data.totalMatched).toBe(3);
    expect(r.data.truncatedTo).toBe(2);
    expect(r.data.matches.map((m) => m.name)).toEqual(['svc_a', 'svc_b']);
    expect(activated).toEqual(['svc_a', 'svc_b']);
  });
});

describe('formatDeferredManifest', () => {
  test('空 → null', () => {
    expect(formatDeferredManifest([])).toBeNull();
  });
  test('非空 → system-reminder 含工具名与 searchHint', () => {
    const m = formatDeferredManifest([tool('db_query', 'query postgres', true)]);
    expect(m).not.toBeNull();
    expect(m).toContain('db_query');
    expect(m).toContain('query postgres');
    expect(m).toContain('ToolSearch');
  });
});

// ─── loop 集成 ────────────────────────────────────────────────────────────────

function asstToolUse(id: string, name: string, input: unknown): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'tool_use',
  };
}
function asstText(text: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'end_turn',
  };
}

/** Provider 记录每次请求收到的工具名,用于断言 deferred 行为。 */
function recordingProvider(scripts: ProviderStreamEvent[][]): { provider: LLMProvider; seenTools: string[][] } {
  const seenTools: string[][] = [];
  let call = 0;
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(req) {
      seenTools.push(req.tools.map((t) => t.name));
      const turn = scripts[Math.min(call, scripts.length - 1)];
      call++;
      for (const ev of turn) yield ev;
    },
  };
  return { provider, seenTools };
}

function ctx(tools: AgentTool[], provider: LLMProvider): AgentContext {
  return { agentId: 'a1', provider, config: { systemPromptSlots: [], model: 'm', tools, maxTurns: 8 }, toolContext: {} };
}

async function collect(agent: CoreAgent, input: Parameters<CoreAgent['run']>[0]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}

describe('deferred loading 在 loop 中', () => {
  test('首轮 provider 收到 active + ToolSearch(不含 deferred);ToolSearch 命中后次轮含该工具', async () => {
    const active = tool('echo'); // 非 deferred
    const deferredTool = tool('db_query', 'query postgres', true);
    const { provider, seenTools } = recordingProvider([
      [asstToolUse('s1', TOOL_SEARCH_NAME, { query: 'postgres' })], // turn0: 搜
      [asstToolUse('c1', 'db_query', {})], // turn1: 调被激活的工具
      [asstText('done')], // turn2: 完成
    ]);
    const agent = new CoreAgent({ context: ctx([active, deferredTool], provider) });
    await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });

    // turn0 工具集:echo + ToolSearch, 不含 db_query。
    expect(seenTools[0]).toContain('echo');
    expect(seenTools[0]).toContain(TOOL_SEARCH_NAME);
    expect(seenTools[0]).not.toContain('db_query');
    // turn1 工具集:db_query 已激活。
    expect(seenTools[1]).toContain('db_query');
  });

  test('无工具声明 shouldDefer → 工具集与今天逐字一致(无 ToolSearch 注入)', async () => {
    const { provider, seenTools } = recordingProvider([[asstText('done')]]);
    const agent = new CoreAgent({ context: ctx([tool('echo'), tool('grep')], provider) });
    await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    expect(seenTools[0].sort()).toEqual(['echo', 'grep']);
    expect(seenTools[0]).not.toContain(TOOL_SEARCH_NAME);
  });
});
