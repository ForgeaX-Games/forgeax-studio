/**
 * 压缩边界 + 覆盖补全(核心逻辑要求 100% 单测)。
 * 覆盖:de-nest 递归折叠、确定性骨架边界、L1 分类全分支、micro-compaction 边界、
 * makeProviderSummarize、jsonish 异常、空/单/全图/全tool/孤儿tool_result/极小窗口。
 * 见 docs/features/compaction-overhaul-verification.md §边界。
 */
import { describe, test, expect, mock } from 'bun:test';
import {
  runCompaction,
  renderDeterministicSummary,
  stripDeterministicHeader,
  isPriorCompactionSummary,
  DETERMINISTIC_SUMMARY_HEADER,
} from '../src/context/compaction-pipeline';
import {
  deterministicCompact,
  OMIT_IMAGE,
  OMIT_MEDIA,
  OMIT_TOOL_RESULT,
  OMIT_ARG,
  estimateTokens,
} from '../src/context/deterministic-compact';
import { microCompact, CLEARED_TOOL_PLACEHOLDER } from '../src/context/micro-compaction';
import { makeProviderSummarize } from '../src/context/compaction-llm';
import { computeWatermarksFromModel } from '../src/context/watermarks';
import type { ProviderMessage, LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE, PROMPT_TOO_LONG_MESSAGE } from '../src/provider/types';
import type { CompactPipelineInput } from '../src/context/compaction-types';

const marks = computeWatermarksFromModel({ contextWindow: 200_000, maxOutputTokens: 64_000 });
const pin = (over: Partial<CompactPipelineInput>): CompactPipelineInput => ({
  messages: [], scenario: 'full', marks, summarize: async () => '<summary>s</summary>',
  sufficiencyRatio: 0.15, messagesToKeep: 0, now: 1, ...over,
});

// ─── de-nest 递归折叠(核心修复)────────────────────────────────────────────────
describe('de-nest 多次压缩不嵌套', () => {
  test('renderDeterministicSummary:旧确定性摘要不被二次包裹', () => {
    const prior: ProviderMessage = {
      role: 'user',
      content: `${DETERMINISTIC_SUMMARY_HEADER}\n\n<previous_user_message>\nfirst q\n</previous_user_message>`,
      ...({ _compactionSummary: true, _deterministic: true } as Record<string, unknown>),
    } as ProviderMessage;
    const out = renderDeterministicSummary([prior, { role: 'user', content: 'second q' } as ProviderMessage]);
    // header 只出现一次
    expect(out.split(DETERMINISTIC_SUMMARY_HEADER).length - 1).toBe(1);
    // <previous_user_message> 不嵌套(不出现连续两个开标签未闭合)
    expect(out).not.toMatch(/<previous_user_message>\s*<previous_user_message>/);
    expect(out).toContain('first q'); // 旧内容保留
    expect(out).toContain('second q'); // 新内容包裹
  });

  test('连续两次确定性压缩:最终仍单 header、无嵌套', async () => {
    const summarize = mock(async () => '<summary>never</summary>'); // sufficiency 命中 → 不应调
    const small: ProviderMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ];
    const r1 = await runCompaction(pin({ messages: small, summarize }));
    expect(r1.usedLLM).toBe(false);
    // 第二次:把 r1.replacement 作为历史前缀再压
    const r2 = await runCompaction(pin({ messages: [r1.replacement, { role: 'user', content: 'q2' } as ProviderMessage], summarize }));
    expect(r2.usedLLM).toBe(false);
    const c2 = r2.replacement.content as string;
    expect(c2.split(DETERMINISTIC_SUMMARY_HEADER).length - 1).toBe(1); // 单 header
    expect(c2).not.toMatch(/<previous_user_message>\s*<previous_user_message>/); // 无嵌套
    expect(summarize).toHaveBeenCalledTimes(0);
  });

  test('stripDeterministicHeader:有/无 header', () => {
    expect(stripDeterministicHeader(`${DETERMINISTIC_SUMMARY_HEADER}\n\nbody`)).toBe('body');
    expect(stripDeterministicHeader('no header here')).toBe('no header here');
  });

  test('isPriorCompactionSummary', () => {
    expect(isPriorCompactionSummary({ _compactionSummary: true })).toBe(true);
    expect(isPriorCompactionSummary({ role: 'user' })).toBe(false);
    expect(isPriorCompactionSummary(null)).toBe(false);
    expect(isPriorCompactionSummary('x')).toBe(false);
  });

  test('LLM 摘要被后续确定性压缩 de-nest(跨路径)', () => {
    const priorLLM: ProviderMessage = {
      role: 'user',
      content: 'This session is being continued from a previous conversation...\n\nSummary:\ndid X',
      ...({ _compactionSummary: true } as Record<string, unknown>),
    } as ProviderMessage;
    const out = renderDeterministicSummary([priorLLM]);
    expect(out).toContain('did X');
    expect(out).not.toMatch(/<previous_user_message>/); // LLM 内容无 header → 原样并入,不包裹
  });
});

// ─── 确定性骨架边界 + jsonish 异常 ────────────────────────────────────────────
describe('renderDeterministicSummary 边界', () => {
  test('assistant 含 tool_use / tool_result 渲染', () => {
    const out = renderDeterministicSummary([
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { path: 'a' } }, { type: 'text', text: 'hi' }] } as unknown as ProviderMessage,
      { role: 'user', content: [{ type: 'tool_result', content: 'RESULT' }] } as unknown as ProviderMessage,
    ]);
    expect(out).toContain('tool_call Read');
    expect(out).toContain('hi');
    expect(out).toContain('tool_result: RESULT');
  });

  test('空文本消息被跳过', () => {
    const out = renderDeterministicSummary([{ role: 'user', content: '   ' } as ProviderMessage]);
    expect(out.trim()).toBe(DETERMINISTIC_SUMMARY_HEADER); // 只剩 header
  });

  test('jsonish 循环引用 → {}(不抛)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = renderDeterministicSummary([
      { role: 'assistant', content: [{ type: 'tool_use', name: 'X', input: circular }] } as unknown as ProviderMessage,
    ]);
    expect(out).toContain('tool_call X {}');
  });

  test('非 user/assistant 角色 → 原样文本', () => {
    const out = renderDeterministicSummary([{ role: 'system', content: 'sys note' } as unknown as ProviderMessage]);
    expect(out).toContain('sys note');
    expect(out).not.toContain('<previous_');
  });
});

// ─── L1 deterministicCompact 全分支 ───────────────────────────────────────────
describe('deterministicCompact 分类全分支', () => {
  test('media:type=audio/video(无 mime)', () => {
    const r = deterministicCompact([
      { role: 'user', content: [{ type: 'audio' }, { type: 'video' }] },
    ]);
    expect((r.messages[0] as any).content[0]).toEqual({ type: 'text', text: OMIT_MEDIA });
    expect((r.messages[0] as any).content[1]).toEqual({ type: 'text', text: OMIT_MEDIA });
  });

  test('media:非 text 二进制 mime', () => {
    const r = deterministicCompact([
      { role: 'user', content: [{ type: 'blob', mimeType: 'application/octet-stream', data: 'xxxx' }] },
    ]);
    expect((r.messages[0] as any).content[0].text).toBe(OMIT_MEDIA);
  });

  test('text/* mime 不剥', () => {
    const block = { type: 'doc', mimeType: 'text/plain', text: 'keep' };
    const r = deterministicCompact([{ role: 'user', content: [block] }]);
    expect((r.messages[0] as any).content[0]).toEqual(block);
    expect(r.stripped).toBe(0);
  });

  test('tool_use 大参数 touched 返回新对象', () => {
    const r = deterministicCompact([
      { role: 'assistant', content: [{ type: 'tool_use', name: 'W', input: { content: 'big', x: 1 } }] },
    ]);
    expect((r.messages[0] as any).content[0].input.content).toBe(OMIT_ARG);
    expect((r.messages[0] as any).content[0].input.x).toBe(1);
    expect(r.stripped).toBe(1);
  });

  test('tool_use 无大字段 → 不动', () => {
    const block = { type: 'tool_use', name: 'W', input: { x: 1 } };
    const r = deterministicCompact([{ role: 'assistant', content: [block] }]);
    expect(r.stripped).toBe(0);
  });

  test('compactableToolNames 限定:不在白名单的 tool_result 不剥', () => {
    const r = deterministicCompact(
      [
        { role: 'user', content: [{ type: 'tool_result', name: 'Read', content: 'a'.repeat(1000) }] },
        { role: 'tool', toolName: 'Bash', content: 'b'.repeat(1000) },
      ],
      { compactableToolNames: ['Read'] },
    );
    expect((r.messages[0] as any).content[0].content).toBe(OMIT_TOOL_RESULT); // Read 剥
    expect((r.messages[1] as any).content).toBe('b'.repeat(1000)); // Bash 不在白名单 → 不剥
  });

  test('role:tool 已是占位 → 幂等不重复剥', () => {
    const r = deterministicCompact([{ role: 'tool', content: OMIT_TOOL_RESULT }]);
    expect(r.stripped).toBe(0);
  });

  test('image block 已是占位文本 → 不再处理(幂等)', () => {
    const r = deterministicCompact([{ role: 'user', content: [{ type: 'text', text: OMIT_IMAGE }] }]);
    expect(r.stripped).toBe(0);
  });

  test('非对象消息 / 字符串 content 放过', () => {
    const r = deterministicCompact([{ role: 'user', content: 'plain' }, 42 as unknown]);
    expect(r.stripped).toBe(0);
  });
});

// ─── micro-compaction 边界 ────────────────────────────────────────────────────
describe('micro-compaction 边界', () => {
  const now = 10_000_000;
  test('字符串时间戳解析 + 清旧 tool_result 块', () => {
    const oldTs = new Date(now - 90 * 60_000).toISOString(); // 90min 前(> 60min gap)
    const msgs = [
      { role: 'assistant', timestamp: oldTs, content: [{ type: 'text', text: 'a' }] },
      ...Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: [{ type: 'tool_result', content: `r${i}` }] })),
    ];
    const out = microCompact(msgs, { now, keepRecent: 20 });
    // 最旧的若干 tool_result 被清(25-20=5 条)
    const cleared = out.filter((m: any) => Array.isArray(m.content) && m.content[0]?.content === CLEARED_TOOL_PLACEHOLDER);
    expect(cleared.length).toBe(5);
  });

  test('gap 未到 → 同引用 no-op', () => {
    const msgs = [{ role: 'assistant', timestamp: now - 1000, content: [] }, { role: 'user', content: [{ type: 'tool_result', content: 'x' }] }];
    const out = microCompact(msgs, { now, keepRecent: 0 });
    expect(out.length).toBe(msgs.length);
  });

  test('无 assistant 时间戳 → 跳过', () => {
    const out = microCompact([{ role: 'assistant', content: [] }], { now });
    expect(out.length).toBe(1);
  });
});

// ─── makeProviderSummarize(V2 摘要器的流式基元)──────────────────────────────
describe('provider-backed compaction', () => {
  const fakeProvider: LLMProvider = {
    api: 'stub',
    async *stream(): AsyncGenerator<ProviderStreamEvent> {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '<summary>done</summary>' }] }, usage: EMPTY_USAGE as Usage, stopReason: 'end_turn' };
    },
  };

  test('makeProviderSummarize 拼接消息并抽文本', async () => {
    const sum = makeProviderSummarize(fakeProvider, 'm', 'full');
    const text = await sum([{ role: 'user', content: 'hi' }] as any);
    expect(text).toContain('done');
  });
});

// ─── runCompaction 边界 ───────────────────────────────────────────────────────
describe('runCompaction 边界', () => {
  test('空消息 → 抛', async () => {
    await expect(runCompaction(pin({ messages: [] }))).rejects.toThrow();
  });

  test('messagesToKeep 超量 → 至少压 1 条(不抛)', async () => {
    const r = await runCompaction(pin({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], messagesToKeep: 999 }));
    expect(r.coveredFrom).toBe(0);
  });

  test('孤儿 tool_result 边界回退:carve 不以 tool_result 起尾', async () => {
    const msgs: ProviderMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'X', input: {} }] } as unknown as ProviderMessage,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] } as unknown as ProviderMessage,
    ];
    // keep=1 本会把 tool_result 留作尾首(孤儿:其 tool_use 已被摘走)→ 边界回退 upTo 2→1,
    // 只压 index 0,tool_use+tool_result 对完整留在尾部(尾首是 assistant,非孤儿)。
    const r = await runCompaction(pin({ messages: msgs, messagesToKeep: 1 }));
    expect(r.coveredTo).toBe(0); // 回退后只压第 1 条;成对的 tool_use/result 不被劈开
  });

  test('全图/全 tool 大上下文 → L1 短路 usedLLM=false', async () => {
    const summarize = mock(async () => '<summary>x</summary>');
    const msgs: ProviderMessage[] = Array.from({ length: 10 }, () => ({
      role: 'user', content: [{ type: 'image', source: { media_type: 'image/png', data: 'z'.repeat(40_000) } }],
    } as unknown as ProviderMessage));
    const r = await runCompaction(pin({ messages: msgs, summarize }));
    expect(r.usedLLM).toBe(false); // 图全剥光 → 够小 → 短路
    expect(summarize).toHaveBeenCalledTimes(0);
  });

  test('PTL 耗尽 → 抛(不死循环)', async () => {
    const huge = 'word '.repeat(40_000);
    const msgs: ProviderMessage[] = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: huge }));
    await expect(
      runCompaction(pin({ messages: msgs, summarize: async () => { throw new Error(`${PROMPT_TOO_LONG_MESSAGE} nope`); } })),
    ).rejects.toThrow();
  });
});

// ─── 极小窗口 ─────────────────────────────────────────────────────────────────
describe('极小窗口', () => {
  test('window<reserve → effective=0,sufficiency 阈=0,大内容不短路', async () => {
    const tiny = computeWatermarksFromModel({ contextWindow: 5_000 }); // reserve 20k > 5k → effective 0
    expect(tiny.effectiveWindow).toBe(0);
    const summarize = mock(async () => '<summary>x</summary>');
    const r = await runCompaction(pin({ marks: tiny, messages: [{ role: 'user', content: 'aaaa' }, { role: 'assistant', content: 'bbbb' }], summarize }));
    expect(r.usedLLM).toBe(true); // 阈=0,estimatedTokens>0 → 不短路 → 走 LLM
  });
});
