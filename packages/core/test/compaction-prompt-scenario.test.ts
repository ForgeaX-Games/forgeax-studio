/**
 * Stream D 验收:摘要 prompt scenario + 质量(#2/#3)。Cases D-U1..U9。
 * 见 docs/features/compaction-overhaul-verification.md §4。
 */
import { describe, test, expect } from 'bun:test';
import {
  getCompactPrompt,
  formatCompactSummary,
  getCompactUserSummaryMessage,
  truncateHeadForPTLRetry,
  makeProviderSummarize,
  LLMCompactionStrategy,
  MAX_PTL_RETRIES,
} from '../src/context/compaction-llm';
import { PROMPT_TOO_LONG_MESSAGE } from '../src/provider/types';

const NINE_SECTIONS = [
  '1. Primary Request and Intent',
  '2. Key Technical Concepts',
  '3. Files and Code Sections',
  '4. Errors and fixes',
  '5. Problem Solving',
  '6. All user messages',
  '7. Pending Tasks',
  '8. Current Work',
  '9. Optional Next Step',
];

describe('Stream D — prompt scenario + summary quality (#2/#3)', () => {
  test('D-U1 full:9 段 + no-tools guards', () => {
    const p = getCompactPrompt('full');
    for (const h of NINE_SECTIONS) expect(p).toContain(h);
    expect(p).toContain('Respond with TEXT ONLY');
    expect(p).toContain('REMINDER');
  });

  test('D-U2 partial:保旧压新措辞,异于 full', () => {
    const p = getCompactPrompt('partial');
    expect(p).toContain('RECENT portion');
    expect(p).toContain('kept intact');
    expect(p).not.toBe(getCompactPrompt('full'));
    for (const h of NINE_SECTIONS) expect(p).toContain(h); // 仍含 9 段骨架
  });

  test('D-U3 pre-message:预压场景模板', () => {
    const p = getCompactPrompt('pre-message');
    expect(p).toContain('NEW user message will follow');
    expect(p).not.toBe(getCompactPrompt('full'));
  });

  test('D-U4 customInstructions 追加;空白忽略', () => {
    expect(getCompactPrompt('full', 'focus on X')).toContain('Additional Instructions:\nfocus on X');
    expect(getCompactPrompt('full', '   ')).not.toContain('Additional Instructions:');
  });

  test('D-U5 摘要格式化 + 续接消息', () => {
    const raw = '<analysis>scratch</analysis><summary>did the thing</summary>';
    expect(formatCompactSummary(raw)).toBe('Summary:\ndid the thing');
    const msg = getCompactUserSummaryMessage(raw);
    expect(msg).toContain('This session is being continued');
    expect(msg).toContain('did the thing');
    expect(msg).not.toContain('scratch'); // analysis 被剥
  });

  test('D-U6 摘要失败(非 PTL)→ compact 抛错(catchable,供 E 回滚)', async () => {
    const s = new LLMCompactionStrategy({
      summarize: async () => {
        throw new Error('model exploded');
      },
    });
    await expect(s.compact([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }])).rejects.toThrow(
      'model exploded',
    );
  });

  test('D-U7 PTL 重试收敛(前2次 PTL,第3次成功)', async () => {
    let calls = 0;
    const s = new LLMCompactionStrategy({
      summarize: async () => {
        calls++;
        if (calls <= 2) throw new Error(`${PROMPT_TOO_LONG_MESSAGE} overflow`);
        return '<summary>ok</summary>';
      },
    });
    const msgs = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    const r = await s.compact(msgs);
    expect(calls).toBe(3);
    expect((r.replacement as any).content).toContain('ok');
  });

  test('D-U8 PTL 耗尽 → 放弃抛错(不死循环)', async () => {
    let calls = 0;
    const s = new LLMCompactionStrategy({
      summarize: async () => {
        calls++;
        throw new Error(`${PROMPT_TOO_LONG_MESSAGE} still too big`);
      },
    });
    const msgs = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    await expect(s.compact(msgs)).rejects.toThrow();
    expect(calls).toBeLessThanOrEqual(MAX_PTL_RETRIES + 1); // 不无限重试
  });

  test('D-U9 self-limit:makeProviderSummarize 用 scenario prompt + 无工具', async () => {
    const captured: any[] = [];
    const fakeProvider: any = {
      async *stream(req: any) {
        captured.push(req);
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '<summary>x</summary>' }] } };
      },
    };
    const sum = makeProviderSummarize(fakeProvider, 'claude-x', 'pre-message');
    await sum([{ role: 'user', content: 'hi' }] as any);
    expect(captured[0].tools).toEqual([]); // 无工具 → 不递归
    expect(captured[0].maxOutputTokens).toBeGreaterThan(0); // 有上限
    expect(captured[0].system[0].text).toContain('NEW user message will follow'); // pre-message 模板
  });
});
