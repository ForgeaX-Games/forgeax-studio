/**
 * Loop-level e2e:驱动 CoreAgent.run 走通本轮新增的 6 个反应式/治理行为
 * (max_tokens 续写 / PROMPT_TOO_LONG 反应式压缩 / blocking_limit / stop-hook /
 *  token-budget / same-file 重复读拦截)。这些之前只有 helper 单测,这里补 loop 集成。
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { EventBus } from '../src/events/event-bus';
import { buildTool } from '../src/capability/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { CompactionStrategy } from '../src/context/types';
import type { LLMProvider, ProviderStreamEvent, ProviderMessage, Usage, StopReason } from '../src/provider/types';
import { EMPTY_USAGE, PROMPT_TOO_LONG_MESSAGE } from '../src/provider/types';

type Block = { type: string; [k: string]: unknown };
function asst(content: Block[], stopReason: StopReason, inputTokens = 0, outputTokens = 0): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content },
    usage: { ...EMPTY_USAGE, inputTokens, outputTokens } as Usage,
    stopReason,
  };
}
const txt = (t: string): Block[] => [{ type: 'text', text: t }];
const tu = (id: string, name: string, input: unknown): Block[] => [{ type: 'tool_use', id, name, input }];

type Handler = () => ProviderStreamEvent[] | { throw: unknown };
function mkProvider(handlers: Handler[]): { provider: LLMProvider; reqMessages: ProviderMessage[][]; calls: () => number } {
  const reqMessages: ProviderMessage[][] = [];
  let call = 0;
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(req) {
      reqMessages.push(req.messages);
      const h = handlers[Math.min(call, handlers.length - 1)];
      call++;
      const r = h();
      if (r && !Array.isArray(r) && 'throw' in r) throw (r as { throw: unknown }).throw;
      for (const ev of r as ProviderStreamEvent[]) yield ev;
    },
  };
  return { provider, reqMessages, calls: () => call };
}

function ctx(tools: Parameters<typeof buildTool>[0][], prov: LLMProvider, extra: Record<string, unknown> = {}): AgentContext {
  return {
    agentId: 'a',
    provider: prov,
    config: { systemPromptSlots: [], model: 'm', tools: tools as never, maxTurns: 12, ...extra },
    toolContext: {},
  };
}
async function run(agent: CoreAgent, payload: unknown = 'hi'): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run({ input: { type: 'user', payload, ts: 0 } })) out.push(e);
  return out;
}
function lastDone(evs: AgentEvent[]): string | undefined {
  const d = evs.at(-1);
  return d && d.type === 'done' ? d.terminal.reason : undefined;
}

// ① max_tokens 续写 ─────────────────────────────────────────────────────────
test('max_tokens 截断 + 零 tool_use → 自动续写而非完成', async () => {
  const { provider, reqMessages } = mkProvider([
    () => [asst(txt('partial...'), 'max_tokens')],
    () => [asst(txt('...rest done'), 'end_turn')],
  ]);
  const agent = new CoreAgent({ context: ctx([], provider) });
  const evs = await run(agent);
  expect(lastDone(evs)).toBe('completed');
  expect(reqMessages.length).toBe(2); // 没有当成完成,续了一轮
  expect(JSON.stringify(reqMessages[1]).toLowerCase()).toContain('continue');
});

test('max_tokens 续写受 maxContinuations 硬上限兜底', async () => {
  const { provider } = mkProvider([() => [asst(txt('still going'), 'max_tokens')]]); // 永远 max_tokens
  const agent = new CoreAgent({ context: ctx([], provider), maxContinuations: 2 });
  const evs = await run(agent);
  // 续到上限后不再续 → 落到完成/最大轮(不无限循环)。
  expect(['completed', 'max_turns']).toContain(lastDone(evs) ?? 'none');
});

// ② PROMPT_TOO_LONG 反应式压缩重试 ──────────────────────────────────────────
test('PROMPT_TOO_LONG → 强制压缩后重试同一轮 → 恢复', async () => {
  let compacted = 0;
  const compaction: CompactionStrategy = {
    name: 'spy',
    shouldCompact: () => false,
    async compact() {
      compacted++;
      return { replacement: { role: 'user', content: 'summary' }, coveredFrom: 0, coveredTo: 0 };
    },
  };
  const { provider } = mkProvider([
    () => ({ throw: new Error(PROMPT_TOO_LONG_MESSAGE) }),
    () => [asst(txt('recovered'), 'end_turn')],
  ]);
  const agent = new CoreAgent({ context: ctx([], provider), compaction, retry: { maxRetries: 0 } });
  const evs = await run(agent);
  expect(compacted).toBeGreaterThanOrEqual(1);
  expect(lastDone(evs)).toBe('completed');
});

test('PROMPT_TOO_LONG 但无可压 → done(prompt_too_long)', async () => {
  const compaction: CompactionStrategy = {
    name: 'empty',
    shouldCompact: () => false,
    async compact() {
      return { replacement: { role: 'user', content: 'x' }, coveredFrom: 0, coveredTo: -1 }; // count 0
    },
  };
  const { provider } = mkProvider([() => ({ throw: new Error(PROMPT_TOO_LONG_MESSAGE) })]);
  const agent = new CoreAgent({ context: ctx([], provider), compaction, retry: { maxRetries: 0 } });
  const evs = await run(agent);
  expect(lastDone(evs)).toBe('prompt_too_long');
});

// ③ blocking_limit ──────────────────────────────────────────────────────────
test('压缩后仍超 blockingLimit → done(blocking_limit)', async () => {
  const compaction: CompactionStrategy = {
    name: 'noop',
    shouldCompact: () => false,
    async compact() {
      return { replacement: { role: 'user', content: 'x' }, coveredFrom: 0, coveredTo: 0 };
    },
  };
  const { provider } = mkProvider([() => [asst(txt('never reached'), 'end_turn')]]);
  // window 30k → blockingLimit = 30k-20k-3k = 7k tokens;payload ~10k tokens(40k 字符/4)。
  const agent = new CoreAgent({ context: ctx([], provider, { contextWindow: undefined }), compaction, contextWindow: 30_000 });
  const evs = await run(agent, 'Z'.repeat(40_000));
  expect(lastDone(evs)).toBe('blocking_limit');
});

// ④ stop-hook ───────────────────────────────────────────────────────────────
test('stop-hook preventStop → 续轮;放行后完成', async () => {
  const bus = new EventBus();
  let fired = 0;
  bus.subscribe('stop', (_e, ctl) => {
    fired++;
    if (fired === 1) return ctl.modify({ preventStop: true, reason: 'keep going please' } as never);
    return undefined;
  });
  const { provider, reqMessages } = mkProvider([
    () => [asst(txt('first'), 'end_turn')],
    () => [asst(txt('second'), 'end_turn')],
  ]);
  const agent = new CoreAgent({ context: ctx([], provider), bus });
  const evs = await run(agent);
  expect(fired).toBeGreaterThanOrEqual(2);
  expect(lastDone(evs)).toBe('completed');
  expect(JSON.stringify(reqMessages[1])).toContain('keep going please');
});

test('stop-hook 反复 preventStop 触上限 → done(stop_hook_prevented)', async () => {
  const bus = new EventBus();
  bus.subscribe('stop', (_e, ctl) => ctl.modify({ preventStop: true, reason: 'never stop' } as never));
  const { provider } = mkProvider([() => [asst(txt('x'), 'end_turn')]]);
  const agent = new CoreAgent({ context: ctx([], provider), bus, maxContinuations: 2 });
  const evs = await run(agent);
  expect(lastDone(evs)).toBe('stop_hook_prevented');
});

// ⑤ token-budget ────────────────────────────────────────────────────────────
test('taskBudget 未耗尽 → 续轮;耗尽 → 收尾', async () => {
  const { provider, calls } = mkProvider([
    () => [asst(txt('a'), 'end_turn', 0, 30)],
    () => [asst(txt('b'), 'end_turn', 0, 30)],
  ]);
  const agent = new CoreAgent({ context: ctx([], provider, { taskBudget: { total: 50 } }) });
  const evs = await run(agent);
  expect(calls()).toBeGreaterThanOrEqual(2); // 第一轮想停但预算没用完 → 续了
  expect(['completed', 'max_turns']).toContain(lastDone(evs) ?? 'none');
});

test('无 taskBudget → 行为不变(想停即停)', async () => {
  const { provider, calls } = mkProvider([() => [asst(txt('done'), 'end_turn', 0, 999)]]);
  const agent = new CoreAgent({ context: ctx([], provider) });
  const evs = await run(agent);
  expect(calls()).toBe(1);
  expect(lastDone(evs)).toBe('completed');
});

// ⑥ same-file 重复读拦截 ─────────────────────────────────────────────────────
test('同文件重复读越线 → 拦截当次(不硬杀),其余照常', async () => {
  const reads: string[] = [];
  const readFile = buildTool({
    name: 'read_file',
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    inputJSONSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    call: async (i: { path: string }) => {
      reads.push(i.path);
      return { data: 'content' };
    },
    mapResult: (o, id) => ({ type: 'tool.result', payload: { toolUseId: id, result: o }, ts: 0 }),
    maxResultSizeChars: 1000,
  });
  const { provider } = mkProvider([
    () => [asst(tu('r1', 'read_file', { path: '/f' }), 'tool_use')],
    () => [asst(tu('r2', 'read_file', { path: '/f' }), 'tool_use')],
    () => [asst(tu('r3', 'read_file', { path: '/f' }), 'tool_use')],
    () => [asst(txt('done'), 'end_turn')],
  ]);
  // sameFileReadLimit=2;关掉 error-streak 兜底以隔离 same-file 行为。
  const agent = new CoreAgent({ context: ctx([readFile], provider, {}), sameFileReadLimit: 2, maxToolErrorStreak: 0 });
  const evs = await run(agent);
  expect(reads.length).toBeLessThan(3); // 至少一次被拦,未真正执行
  expect(lastDone(evs)).toBe('completed'); // 未硬杀
  const intercepted = evs.some(
    (e) =>
      e.type === 'tool_result' &&
      (() => {
        const p = (e.result as { payload?: { isError?: boolean; message?: unknown } }).payload;
        return p?.isError === true && /already read/i.test(String(p?.message ?? ''));
      })(),
  );
  expect(intercepted).toBe(true);
});
