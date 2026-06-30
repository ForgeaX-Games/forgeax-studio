/**
 * Stream C 验收:L1 确定性层 + 剥离 + sufficiency(#4/#5/#12)。Cases C-U1..U9。
 * 见 docs/features/compaction-overhaul-verification.md §3。
 */
import { describe, test, expect } from 'bun:test';
import {
  deterministicCompact,
  estimateTokens,
  isSufficient,
  OMIT_IMAGE,
  OMIT_MEDIA,
  OMIT_TOOL_RESULT,
  OMIT_ARG,
} from '../src/context/deterministic-compact';

const bigText = 'x'.repeat(4000); // ~1000 tok

describe('Stream C — deterministic L1 (#4/#5/#12)', () => {
  test('C-U1 剥图片 → 占位,token 下降', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'image', source: { media_type: 'image/png', data: bigText } }] },
    ];
    const before = estimateTokens(msgs);
    const r = deterministicCompact(msgs);
    expect(r.stripped).toBe(1);
    expect((r.messages[0] as any).content[0]).toEqual({ type: 'text', text: OMIT_IMAGE });
    expect(r.estimatedTokens).toBeLessThan(before);
  });

  test('C-U2 omit tool_result;role:tool 单条', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', name: 'Read', content: bigText }] },
      { role: 'tool', toolName: 'Bash', content: bigText },
    ];
    const r = deterministicCompact(msgs);
    expect((r.messages[0] as any).content[0].content).toBe(OMIT_TOOL_RESULT);
    expect((r.messages[1] as any).content).toBe(OMIT_TOOL_RESULT);
    expect(r.stripped).toBe(2);
  });

  test('C-U3 omit 大参数字段', () => {
    const msgs = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Write', input: { path: 'a.ts', content: bigText, mode: 'w' } }],
      },
    ];
    const r = deterministicCompact(msgs);
    const input = (r.messages[0] as any).content[0].input;
    expect(input.content).toBe(OMIT_ARG);
    expect(input.path).toBe('a.ts'); // 非大字段保留
    expect(input.mode).toBe('w');
  });

  test('C-U4 保护区 keepRecent 不剥', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', content: bigText }] }, // 旧 → 剥
      { role: 'user', content: [{ type: 'tool_result', content: bigText }] }, // 保护 → 不剥
    ];
    const r = deterministicCompact(msgs, { keepRecent: 1 });
    expect((r.messages[0] as any).content[0].content).toBe(OMIT_TOOL_RESULT);
    expect((r.messages[1] as any).content[0].content).toBe(bigText); // 原样
    expect(r.stripped).toBe(1);
  });

  test('C-U5 多媒体识别(audio/video/binary)', () => {
    const msgs = [
      { role: 'user', content: [
        { type: 'audio', source: { media_type: 'audio/mp3', data: bigText } },
        { type: 'document', source: { media_type: 'application/pdf', data: bigText } },
      ] },
    ];
    const r = deterministicCompact(msgs);
    expect((r.messages[0] as any).content[0]).toEqual({ type: 'text', text: OMIT_MEDIA });
    expect((r.messages[0] as any).content[1]).toEqual({ type: 'text', text: OMIT_MEDIA });
  });

  test('C-U6/C-U7 sufficiency 判定', () => {
    expect(isSufficient(100, 180_000, 0.15)).toBe(true); // 100 ≤ 27000
    expect(isSufficient(30_000, 180_000, 0.15)).toBe(false); // 30000 > 27000
  });

  test('C-U8 无可剥 → 同引用 no-op', () => {
    const msgs = [{ role: 'user', content: 'hello' }];
    const r = deterministicCompact(msgs);
    expect(r.stripped).toBe(0);
    expect(r.messages).toBe(msgs as any); // 同引用
  });

  test('C-U9 纯函数:同 input 同结果,不改入参', () => {
    const msgs = [{ role: 'user', content: [{ type: 'tool_result', content: bigText }] }];
    const snapshot = JSON.stringify(msgs);
    const a = deterministicCompact(msgs);
    const b = deterministicCompact(msgs);
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
    expect(JSON.stringify(msgs)).toBe(snapshot); // 入参未被改
  });
});
