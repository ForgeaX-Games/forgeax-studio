/**
 * 压缩 e2e + 暴力 fuzz(自造数据,驱动真实 CoreAgent loop / runCompaction)。
 *  - 多次压缩 e2e:增长型 provider → 反复越线压缩 → 完成 + de-nest 不嵌套。
 *  - 暴力 fuzz:seeded 随机消息(图/tool/文本/旧摘要)反复压 + 增量回喂 → 永不嵌套/不崩。
 *  - 真模型 smoke:有 ANTHROPIC_API_KEY 才跑(否则跳过)。
 * 见 docs/features/compaction-overhaul-verification.md §G。
 */
import { describe, test, expect } from 'bun:test';
import { CoreAgent, type CompactionV2Options } from '../src/agent/agent';
import { EventBus } from '../src/events/event-bus';
import { CoreEventType } from '../src/events/events';
import { buildTool } from '../src/capability/types';
import { runCompaction, DETERMINISTIC_SUMMARY_HEADER } from '../src/context/compaction-pipeline';
import { computeWatermarksFromModel } from '../src/context/watermarks';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderStreamEvent, Usage, ProviderMessage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import type { CompactPipelineInput } from '../src/context/compaction-types';

const SMALL = { contextWindow: 21_000, maxOutputTokens: 1_000 }; // effective 20000; emergency 18400
const marks = computeWatermarksFromModel({ contextWindow: 200_000, maxOutputTokens: 64_000 });

function asstToolUse(id: string): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'fetch', input: { n: id } }] }, usage: EMPTY_USAGE as Usage, stopReason: 'tool_use' };
}
function asstDone(): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, usage: EMPTY_USAGE as Usage, stopReason: 'end_turn' };
}

function noNesting(s: string): boolean {
  return !/<previous_user_message>\s*<previous_user_message>/.test(s) &&
    (s.split(DETERMINISTIC_SUMMARY_HEADER).length - 1) <= 1;
}

// ─── 多次压缩 e2e ─────────────────────────────────────────────────────────────
describe('多次压缩 e2e(增长型 provider)', () => {
  test('反复越线 → 多次 CompactionApplied → 完成 + 每次 replacement 不嵌套', async () => {
    // 工具每次返回 ~20k tok 大输出 → 每轮重新越线触发压缩。
    const bigOut = 'd'.repeat(20_000 * 4);
    const fetch = buildTool({
      name: 'fetch',
      // call 返回 ToolResult<Output>;mapResult 收到的是解包后的 Output(= bigOut 字符串)。
      call: async () => ({ data: bigOut }),
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, data: String(o) }, ts: 0 }),
      maxResultSizeChars: Infinity,
    });
    let t = 0;
    const provider: LLMProvider = { api: 'stub', async *stream() { yield t++ < 5 ? asstToolUse(`f${t}`) : asstDone(); } };

    let clock = 1_000_000;
    const summarize = async () => '<summary>llm</summary>';
    const cfg: CompactionV2Options = { summarize, modelInfo: SMALL, nowFn: () => (clock += 60_000), preMessage: false };

    const bus = new EventBus();
    const applied: { content: string }[] = [];
    bus.subscribe(CoreEventType.CompactionApplied, (e) => {
      const r = (e.payload as { replacement: ProviderMessage }).replacement;
      applied.push({ content: String(r.content) });
    });

    const ctx: AgentContext = { agentId: 'e2e', provider, config: { systemPromptSlots: [], model: 'm', tools: [fetch], maxTurns: 10 }, toolContext: {} };
    const agent = new CoreAgent({ context: ctx, bus, compactionV2: cfg });
    const events: AgentEvent[] = [];
    for await (const e of agent.run({ input: { type: 'user', payload: 'go', ts: 0 }, history: [{ role: 'user', content: 'x'.repeat(19_000 * 4) }] })) events.push(e);

    // 多次压缩(首轮 history 越线 + 后续 tool 输出反复越线)
    expect(applied.length).toBeGreaterThanOrEqual(2);
    // 每次 replacement 都不嵌套、单 header
    for (const a of applied) expect(noNesting(a.content)).toBe(true);
    // 跑到完成
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });
});

// ─── 暴力 fuzz(seeded,确定性可复现)─────────────────────────────────────────
describe('暴力 fuzz:随机消息反复压缩永不嵌套/不崩', () => {
  // 简单 LCG(确定性,不依赖 Math.random)
  function lcg(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
  }
  function genMessages(rand: () => number, n: number): ProviderMessage[] {
    const out: ProviderMessage[] = [];
    for (let i = 0; i < n; i++) {
      const r = rand();
      if (r < 0.3) out.push({ role: 'user', content: 'q'.repeat(1 + Math.floor(rand() * 2000)) });
      else if (r < 0.5) out.push({ role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(1 + Math.floor(rand() * 500)) }, { type: 'tool_use', name: 'T', input: { content: 'z'.repeat(3000) } }] } as unknown as ProviderMessage);
      else if (r < 0.7) out.push({ role: 'user', content: [{ type: 'tool_result', content: 'r'.repeat(1 + Math.floor(rand() * 4000)) }] } as unknown as ProviderMessage);
      else if (r < 0.85) out.push({ role: 'user', content: [{ type: 'image', source: { media_type: 'image/png', data: 'i'.repeat(5000) } }] } as unknown as ProviderMessage);
      else out.push({ role: 'assistant', content: [{ type: 'audio', source: { media_type: 'audio/mp3', data: 'm'.repeat(2000) } }] } as unknown as ProviderMessage);
    }
    return out;
  }
  const pin = (over: Partial<CompactPipelineInput>): CompactPipelineInput => ({
    messages: [], scenario: 'full', marks, summarize: async () => '<summary>fuzz</summary>', sufficiencyRatio: 0.15, messagesToKeep: 0, now: 1, ...over,
  });

  test('200 个随机用例:不崩、单 header、无嵌套、coveredFrom=0', async () => {
    const rand = lcg(20260620);
    for (let i = 0; i < 200; i++) {
      const msgs = genMessages(rand, 1 + Math.floor(rand() * 12));
      const keep = Math.floor(rand() * 3);
      const r = await runCompaction(pin({ messages: msgs, messagesToKeep: keep, sufficiencyRatio: rand() * 0.5 }));
      const c = String(r.replacement.content);
      expect(r.coveredFrom).toBe(0);
      expect(noNesting(c)).toBe(true);
    }
  });

  test('增量回喂:把上次 replacement 当历史前缀连压 30 轮,始终不嵌套/单 header', async () => {
    const rand = lcg(424242);
    let history: ProviderMessage[] = genMessages(rand, 6);
    for (let round = 0; round < 30; round++) {
      const msgs = [...history, ...genMessages(rand, 1 + Math.floor(rand() * 4))];
      const r = await runCompaction(pin({ messages: msgs, sufficiencyRatio: 0.2 }));
      const c = String(r.replacement.content);
      expect(noNesting(c)).toBe(true);
      // 把 replacement 作为下一轮历史前缀(模拟多次压缩叠加)
      history = [r.replacement, { role: 'user', content: 'next' } as ProviderMessage];
    }
  });
});

// ─── 真模型 smoke(显式 opt-in 才跑:FORGEAX_COMPACT_E2E_REAL=1 + 有效 key)──────
// 注:仓库 .env 常带 key(沙箱里可能无效),故用显式开关而非仅凭 key 存在,避免误跑 401。
// provider 构造与生产 CLI(cli/main.ts)对齐:透传 ANTHROPIC_BASE_URL(代理网关)+
// anthropic-version 头——否则缺省直连 api.anthropic.com,代理 key 会 401。
describe('真模型 smoke(FORGEAX_COMPACT_E2E_REAL=1 才跑)', () => {
  const runReal = process.env.FORGEAX_COMPACT_E2E_REAL === '1' && !!process.env.ANTHROPIC_API_KEY;
  test.skipIf(!runReal)('真 provider 摘要可用,不崩', async () => {
    const { createAnthropicProvider } = await import('../src/provider/anthropic');
    const { makeProviderSummarize } = await import('../src/context/compaction-llm');
    const provider = createAnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      headers: { 'anthropic-version': '2023-06-01' },
    });
    // 去掉上下文层级后缀(如 `claude-opus-4-8[1m]` → `claude-opus-4-8`)——该后缀是
    // harness 内部记法,代理网关只认裸 model id,带后缀会 key_model_access_denied(401)。
    const model = (process.env.FORGEAX_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8').replace(/\[.*\]$/, '');
    const sum = makeProviderSummarize(provider, model, 'full');
    const text = await sum([
      { role: 'user', content: '我要做个登录页,用 OAuth' },
      { role: 'assistant', content: '好的,我先看 auth.ts,再加 OAuth provider 配置。' },
    ] as ProviderMessage[]);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);
});
