/**
 * Reactive recovery helpers (C7) 单测 —— max_output_tokens 续跑 / PROMPT_TOO_LONG 识别 /
 * blocking 硬上限判定。覆盖反应式恢复语义。
 */
import { test, expect, describe } from 'bun:test';
import {
  shouldContinueOnMaxTokens,
  buildContinuationMessage,
  isPromptTooLong,
  isOverBlockingLimit,
  CONTINUATION_PROMPT,
} from '../src/context/reactive-recovery';
import { PROMPT_TOO_LONG_MESSAGE } from '../src/provider/types';
import { computeWatermarks } from '../src/context/watermarks';
import type { StopReason } from '../src/provider/types';

describe('shouldContinueOnMaxTokens', () => {
  test('max_tokens + 零 tool_use → 续跑(true)', () => {
    expect(shouldContinueOnMaxTokens('max_tokens', 0)).toBe(true);
  });

  test('max_tokens 但本轮有 tool_use → 不在此续(false)', () => {
    expect(shouldContinueOnMaxTokens('max_tokens', 1)).toBe(false);
    expect(shouldContinueOnMaxTokens('max_tokens', 3)).toBe(false);
  });

  test('非 max_tokens(零 tool_use)→ 不续(false)', () => {
    const others: StopReason[] = ['end_turn', 'tool_use', 'stop_sequence', 'refusal', 'model_context_window_exceeded', null];
    for (const r of others) expect(shouldContinueOnMaxTokens(r, 0)).toBe(false);
  });
});

describe('buildContinuationMessage', () => {
  test('产出 user 续条,content === CONTINUATION_PROMPT', () => {
    const m = buildContinuationMessage();
    expect(m.role).toBe('user');
    expect(m.content).toBe(CONTINUATION_PROMPT);
    expect(CONTINUATION_PROMPT).toBe('Please continue from where you left off.');
  });
});

describe('isPromptTooLong', () => {
  test('Error message 以 PROMPT_TOO_LONG_MESSAGE 开头 → true', () => {
    expect(isPromptTooLong(new Error(PROMPT_TOO_LONG_MESSAGE))).toBe(true);
  });

  test('开头匹配 + 附带 token 细节后段 → 仍 true', () => {
    expect(isPromptTooLong(new Error(`${PROMPT_TOO_LONG_MESSAGE} (tokens: 250000)`))).toBe(true);
  });

  test('不以该串开头(出现在中间)→ false', () => {
    expect(isPromptTooLong(new Error(`wrapped: ${PROMPT_TOO_LONG_MESSAGE}`))).toBe(false);
  });

  test('其它错误文案 → false', () => {
    expect(isPromptTooLong(new Error('some other failure'))).toBe(false);
  });

  test('非 Error(string / null / 对象)→ fail-closed false', () => {
    expect(isPromptTooLong(PROMPT_TOO_LONG_MESSAGE)).toBe(false);
    expect(isPromptTooLong(null)).toBe(false);
    expect(isPromptTooLong(undefined)).toBe(false);
    expect(isPromptTooLong({ message: PROMPT_TOO_LONG_MESSAGE })).toBe(false);
  });
});

describe('isOverBlockingLimit', () => {
  const marks = computeWatermarks(200_000); // effective=180k, blocking=177k

  test('tokenCount >= blockingLimit → true(含恰好相等)', () => {
    expect(isOverBlockingLimit(marks.blockingLimit, marks)).toBe(true);
    expect(isOverBlockingLimit(marks.blockingLimit + 1, marks)).toBe(true);
    expect(isOverBlockingLimit(199_999, marks)).toBe(true);
  });

  test('tokenCount < blockingLimit → false', () => {
    expect(isOverBlockingLimit(marks.blockingLimit - 1, marks)).toBe(false);
    expect(isOverBlockingLimit(0, marks)).toBe(false);
  });

  test('与 watermarks 三区配套:blocking = effective - 3k', () => {
    expect(marks.blockingLimit).toBe(marks.effectiveWindow - 3_000);
  });
});
