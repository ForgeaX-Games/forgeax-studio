/**
 * 压缩时的 tool 配对完整性测试(防 400 bug)。
 *   - ensureToolResultPairing:丢孤儿 tool_use/tool_result、去重、清空丢弃。
 *   - 压缩边界安全:LLMCompactionStrategy 不把 tool_use/tool_result 对劈开。
 *   - loop 端到端:压缩劈开后 buildRequest 发出的 messages 仍配对完整(无孤儿)。
 */
import { test, expect, describe } from 'bun:test';
import { ensureToolResultPairing, startsWithToolResult, hasToolResult } from '../src/context/tool-pairing';
import { LLMCompactionStrategy } from '../src/context/compaction-llm';
import { CoreAgent } from '../src/agent/agent';
import { buildTool } from '../src/capability/types';
import type { ProviderMessage, LLMProvider, ProviderStreamEvent, ProviderRequest, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import type { AgentContext } from '../src/agent/types';
import type { CompactionStrategy } from '../src/context/types';

const tu = (id: string) => ({ type: 'tool_use', id, name: 'x', input: {} });
const tr = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'r' });
const txt = (t: string) => ({ type: 'text', text: t });

describe('ensureToolResultPairing — 孤儿清理 + 去重', () => {
  test('丢孤儿 tool_result(无对应 tool_use)', () => {
    const msgs: ProviderMessage[] = [
      { role: 'user', content: [tr('orphan')] },
      { role: 'user', content: 'hello' },
    ];
    const out = ensureToolResultPairing(msgs);
    expect(out.length).toBe(1); // 孤儿那条清空 → 丢
    expect(out[0].content).toBe('hello');
  });

  test('丢孤儿 tool_use(结果被摘走)', () => {
    const msgs: ProviderMessage[] = [
      { role: 'assistant', content: [txt('calling'), tu('gone')] }, // gone 无 result
      { role: 'user', content: 'next' },
    ];
    const out = ensureToolResultPairing(msgs);
    expect(out[0].content).toEqual([txt('calling')]); // tool_use 丢,text 留
  });

  test('完整对保留', () => {
    const msgs: ProviderMessage[] = [
      { role: 'assistant', content: [tu('t1')] },
      { role: 'user', content: [tr('t1')] },
    ];
    expect(ensureToolResultPairing(msgs)).toEqual(msgs);
  });

  test('tool_use id 去重', () => {
    const msgs: ProviderMessage[] = [
      { role: 'assistant', content: [tu('dup')] },
      { role: 'assistant', content: [tu('dup')] }, // 重复 id
      { role: 'user', content: [tr('dup')] },
    ];
    const out = ensureToolResultPairing(msgs);
    const uses = out.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === 'tool_use');
    expect(uses.length).toBe(1); // 仅留首个
  });

  test('string content 原样;空 content 消息丢弃', () => {
    const msgs: ProviderMessage[] = [
      { role: 'user', content: 'plain' },
      { role: 'user', content: [tr('nope')] }, // 孤儿 → 清空 → 丢
    ];
    const out = ensureToolResultPairing(msgs);
    expect(out).toEqual([{ role: 'user', content: 'plain' }]);
  });

  test('startsWithToolResult / hasToolResult', () => {
    expect(startsWithToolResult({ role: 'user', content: [tr('a')] })).toBe(true);
    expect(startsWithToolResult({ role: 'user', content: [txt('h'), tr('a')] })).toBe(false);
    expect(hasToolResult({ role: 'user', content: [txt('h'), tr('a')] })).toBe(true);
    expect(startsWithToolResult({ role: 'user', content: 'str' })).toBe(false);
  });
});

describe('压缩边界安全 — 不劈开 tool 对(BUG 1 修复)', () => {
  test('保留尾部首条是 tool_result 时,边界回退把整对留进尾部', async () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [tu('t1')] },
      { role: 'user', content: [tr('t1')] },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: [tu('t2')] },
      { role: 'user', content: [tr('t2')] }, // index 5
    ];
    // messagesToKeep=1 → naive summarizeUpTo=5(messages[5]=tool_result 起头)→ 应回退到 4
    const strat = new LLMCompactionStrategy({ summarize: async () => 'SUM', messagesToKeep: 1 });
    const { coveredTo } = await strat.compact(messages);
    expect(coveredTo).toBe(3); // summarizeUpTo 回退到 4 → coveredTo=3,t2 对(idx4,5)留尾部
  });
});

describe('loop 端到端 — 压缩劈开后发出的 messages 无孤儿', () => {
  test('compaction 劈开 tool 对 → buildRequest ensureToolResultPairing 兜底,provider 收到的 messages 配对完整', async () => {
    const captured: ProviderRequest[] = [];
    const provider: LLMProvider = {
      api: 'stub',
      async *stream(req): AsyncIterable<ProviderStreamEvent> {
        captured.push(req);
        yield { type: 'assistant', message: { role: 'assistant', content: [txt('ok')] }, usage: EMPTY_USAGE as Usage, stopReason: 'end_turn' };
      },
    };
    // 恶意压缩:把 [0..0] 摘掉(留个 user summary),但 history 第 0 条是某 tool_use 的来源 →
    //   制造孤儿,验证 buildRequest 兜底。
    const evilCompaction: CompactionStrategy = {
      name: 'evil',
      shouldCompact: () => true,
      async compact() {
        // 用 summary(user 字符串)替换 index0 的 assistant(tool_use t1)→ tr('t1') 成孤儿
        return { replacement: { role: 'user', content: '[SUMMARY]' }, coveredFrom: 0, coveredTo: 0 };
      },
    };
    const ctx: AgentContext = {
      agentId: 'a', provider,
      config: { systemPromptSlots: [], model: 'm', tools: [], maxTurns: 2 },
      toolContext: {},
    };
    const agent = new CoreAgent({ context: ctx, compaction: evilCompaction, contextWindow: 10 });
    // history 含一对 tool;摘掉 tool_use 后 tool_result 会成孤儿
    const history: ProviderMessage[] = [
      { role: 'assistant', content: [tu('t1')] },
      { role: 'user', content: [tr('t1')] },
    ];
    for await (const _ of agent.run({ input: { type: 'user', payload: 'go', ts: 0 }, history })) { /* drain */ }

    expect(captured.length).toBeGreaterThan(0);
    // 断言:发给 provider 的 messages 里没有孤儿 tool_result(其 tool_use 已被摘走)
    for (const req of captured) {
      const useIds = new Set<string>();
      const resIds: string[] = [];
      for (const m of req.messages) {
        if (!Array.isArray(m.content)) continue;
        for (const b of m.content as any[]) {
          if (b.type === 'tool_use') useIds.add(b.id);
          else if (b.type === 'tool_result') resIds.push(b.tool_use_id);
        }
      }
      for (const rid of resIds) expect(useIds.has(rid)).toBe(true); // 无孤儿
    }
  });
});
