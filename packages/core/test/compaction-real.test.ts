/**
 * Real-compaction tests (C7).
 *
 * Covers:
 *  - LLMCompactionStrategy: covered range, summary message shape, messagesToKeep
 *    tail preservation, shouldCompact watermark gate, and PTL head-truncate retry
 *    (with a fake summarize that throws prompt-too-long then succeeds).
 *  - getCompactPrompt: 9-section template + custom instructions.
 *  - microCompact: gap trigger, keepRecent protection, cleared-content marker,
 *    no-op when gap under threshold.
 */
import { test, expect, describe } from 'bun:test';
import {
  LLMCompactionStrategy,
  getCompactPrompt,
  MAX_PTL_RETRIES,
  PTL_RETRY_MARKER,
} from '../src/context/compaction-llm';
import {
  microCompact,
  CLEARED_TOOL_PLACEHOLDER,
  DEFAULT_GAP_THRESHOLD_MINUTES,
} from '../src/context/micro-compaction';
import { computeWatermarks } from '../src/context/watermarks';
import { PROMPT_TOO_LONG_MESSAGE } from '../src/provider/types';

// ─── LLMCompactionStrategy ────────────────────────────────────────────────────

describe('C7 LLMCompactionStrategy', () => {
  const msgs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }));

  test('constructor rejects missing summarize', () => {
    // @ts-expect-error intentionally bad config
    expect(() => new LLMCompactionStrategy({})).toThrow(/summarize/);
  });

  test('shouldCompact gates on autoCompactThreshold', () => {
    const s = new LLMCompactionStrategy({ summarize: async () => 'x' });
    const marks = computeWatermarks(200_000);
    expect(s.shouldCompact(marks.autoCompactThreshold - 1, marks)).toBe(false);
    expect(s.shouldCompact(marks.autoCompactThreshold, marks)).toBe(true);
    expect(s.shouldCompact(marks.autoCompactThreshold + 5, marks)).toBe(true);
  });

  test('compact summarizes whole slice, covers [0..len-1]', async () => {
    let seen: readonly unknown[] = [];
    const s = new LLMCompactionStrategy({
      summarize: async (m) => {
        seen = m;
        return '<summary>did stuff</summary>';
      },
    });
    const input = msgs(6);
    const r = await s.compact(input);
    expect(seen.length).toBe(6);
    expect(r.coveredFrom).toBe(0);
    expect(r.coveredTo).toBe(5);
    const rep = r.replacement as { role: string; content: string; _coveredCount: number };
    expect(rep.role).toBe('user');
    expect(rep._coveredCount).toBe(6);
    // formatted summary unwrapped + continuation prefix present
    expect(rep.content).toContain('This session is being continued');
    expect(rep.content).toContain('did stuff');
    expect(rep.content).not.toContain('<summary>');
  });

  test('messagesToKeep preserves the tail (covered range stops before it)', async () => {
    let seenLen = -1;
    const s = new LLMCompactionStrategy({
      summarize: async (m) => {
        seenLen = m.length;
        return 'SUM';
      },
      messagesToKeep: 2,
    });
    const r = await s.compact(msgs(6));
    // last 2 preserved → summarize first 4, cover [0..3]
    expect(seenLen).toBe(4);
    expect(r.coveredFrom).toBe(0);
    expect(r.coveredTo).toBe(3);
  });

  test('transcriptPath surfaces in summary footer', async () => {
    const s = new LLMCompactionStrategy({
      summarize: async () => 'SUM',
      transcriptPath: '/tmp/transcript.jsonl',
    });
    const r = await s.compact(msgs(4));
    expect((r.replacement as { content: string }).content).toContain('/tmp/transcript.jsonl');
  });

  test('empty input throws', async () => {
    const s = new LLMCompactionStrategy({ summarize: async () => 'x' });
    await expect(s.compact([])).rejects.toThrow(/Not enough messages/);
  });

  test('PTL retry: head-truncates then succeeds, marker injected', async () => {
    const calls: Array<readonly unknown[]> = [];
    let throwsLeft = 2;
    const s = new LLMCompactionStrategy({
      summarize: async (m) => {
        calls.push(m);
        if (throwsLeft-- > 0) {
          throw new Error(`${PROMPT_TOO_LONG_MESSAGE}: way too big`);
        }
        return 'OK';
      },
    });
    const r = await s.compact(msgs(20));
    // first call full, then 2 truncated retries → 3 total
    expect(calls.length).toBe(3);
    expect(calls[0].length).toBe(20);
    // each retry shrinks and prepends the marker
    expect(calls[1].length).toBeLessThan(20);
    expect((calls[1][0] as { content: string }).content).toBe(PTL_RETRY_MARKER);
    expect(calls[2].length).toBeLessThan(calls[1].length);
    expect((r.replacement as { content: string }).content).toContain('OK');
  });

  test('PTL retry gives up after MAX_PTL_RETRIES', async () => {
    let n = 0;
    const s = new LLMCompactionStrategy({
      summarize: async () => {
        n++;
        throw new Error(`${PROMPT_TOO_LONG_MESSAGE}: still too big`);
      },
    });
    await expect(s.compact(msgs(40))).rejects.toThrow(PROMPT_TOO_LONG_MESSAGE);
    // 1 initial + MAX_PTL_RETRIES truncated attempts
    expect(n).toBe(1 + MAX_PTL_RETRIES);
  });

  test('non-PTL error propagates immediately (no retry)', async () => {
    let n = 0;
    const s = new LLMCompactionStrategy({
      summarize: async () => {
        n++;
        throw new Error('boom');
      },
    });
    await expect(s.compact(msgs(10))).rejects.toThrow('boom');
    expect(n).toBe(1);
  });
});

describe('C7 getCompactPrompt', () => {
  test('contains the 9 numbered sections + no-tools guards', () => {
    const p = getCompactPrompt();
    for (const head of [
      '1. Primary Request and Intent',
      '2. Key Technical Concepts',
      '3. Files and Code Sections',
      '4. Errors and fixes',
      '5. Problem Solving',
      '6. All user messages',
      '7. Pending Tasks',
      '8. Current Work',
      '9. Optional Next Step',
    ]) {
      expect(p).toContain(head);
    }
    expect(p).toContain('Respond with TEXT ONLY');
    expect(p).toContain('REMINDER');
  });

  test('appends custom instructions', () => {
    const p = getCompactPrompt('full', 'focus on typescript changes');
    expect(p).toContain('Additional Instructions:');
    expect(p).toContain('focus on typescript changes');
  });

  test('blank custom instructions are ignored', () => {
    expect(getCompactPrompt('full', '   ')).not.toContain('Additional Instructions:');
  });
});

// ─── microCompact ─────────────────────────────────────────────────────────────

describe('C7 microCompact', () => {
  const T0 = 1_000_000_000_000; // fixed base ms
  const minute = 60_000;

  // assistant msg with a timestamp + a series of tool messages
  function convo(toolCount: number, assistantTs: number) {
    const out: Array<Record<string, unknown>> = [
      { role: 'assistant', timestamp: assistantTs, content: [{ type: 'text', text: 'hi' }] },
    ];
    for (let i = 0; i < toolCount; i++) {
      out.push({ role: 'tool', toolName: 'Read', toolCallId: `t${i}`, content: `result-${i}` });
    }
    return out;
  }

  test('no-op when gap under threshold (returns same content)', () => {
    const input = convo(10, T0 - 5 * minute);
    const out = microCompact(input, { now: T0, keepRecent: 2 });
    // gap = 5min < 60min default → nothing cleared
    expect(out.every((m, i) => JSON.stringify(m) === JSON.stringify(input[i]))).toBe(true);
    expect(out.some((m) => (m as { content?: unknown }).content === CLEARED_TOOL_PLACEHOLDER)).toBe(
      false,
    );
  });

  test('gap over threshold clears all but keepRecent tool results', () => {
    const gap = (DEFAULT_GAP_THRESHOLD_MINUTES + 5) * minute;
    const input = convo(10, T0 - gap);
    const out = microCompact(input, { now: T0, keepRecent: 3 });
    const tools = out.filter((m) => (m as { role?: string }).role === 'tool') as Array<{
      content: unknown;
    }>;
    const clearedCount = tools.filter((t) => t.content === CLEARED_TOOL_PLACEHOLDER).length;
    const keptCount = tools.filter((t) => t.content !== CLEARED_TOOL_PLACEHOLDER).length;
    expect(clearedCount).toBe(7); // 10 - 3
    expect(keptCount).toBe(3);
    // the kept ones are the most recent
    expect((tools[tools.length - 1] as { content: string }).content).toBe('result-9');
    expect((tools[tools.length - 3] as { content: string }).content).toBe('result-7');
    // oldest is cleared
    expect((tools[0] as { content: string }).content).toBe(CLEARED_TOOL_PLACEHOLDER);
  });

  test('keepRecent floored at 1 (never clears everything)', () => {
    const gap = (DEFAULT_GAP_THRESHOLD_MINUTES + 1) * minute;
    const input = convo(4, T0 - gap);
    const out = microCompact(input, { now: T0, keepRecent: 0 });
    const tools = out.filter((m) => (m as { role?: string }).role === 'tool') as Array<{
      content: unknown;
    }>;
    const kept = tools.filter((t) => t.content !== CLEARED_TOOL_PLACEHOLDER);
    expect(kept.length).toBe(1);
    expect((kept[0] as { content: string }).content).toBe('result-3');
  });

  test('no assistant message → no-op', () => {
    const input = [
      { role: 'tool', content: 'a' },
      { role: 'tool', content: 'b' },
    ];
    const out = microCompact(input, { now: T0, keepRecent: 0 });
    expect(out).toEqual(input);
  });

  test('clears tool_result blocks inside user messages', () => {
    const gap = (DEFAULT_GAP_THRESHOLD_MINUTES + 1) * minute;
    const input: Array<Record<string, unknown>> = [
      { role: 'assistant', timestamp: T0 - gap, content: [] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'old' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'recent' }] },
    ];
    const out = microCompact(input, { now: T0, keepRecent: 1 });
    const block0 = (out[1] as { content: Array<{ content: string }> }).content[0];
    const block1 = (out[2] as { content: Array<{ content: string }> }).content[0];
    expect(block0.content).toBe(CLEARED_TOOL_PLACEHOLDER);
    expect(block1.content).toBe('recent');
  });

  test('compactableToolNames restricts clearing', () => {
    const gap = (DEFAULT_GAP_THRESHOLD_MINUTES + 1) * minute;
    const input: Array<Record<string, unknown>> = [
      { role: 'assistant', timestamp: T0 - gap, content: [] },
      { role: 'tool', toolName: 'Read', content: 'r0' },
      { role: 'tool', toolName: 'KeepMe', content: 'k0' },
      { role: 'tool', toolName: 'Read', content: 'r1' },
    ];
    const out = microCompact(input, {
      now: T0,
      keepRecent: 0,
      compactableToolNames: ['Read'],
    });
    const byName = (n: string) =>
      out.filter((m) => (m as { toolName?: string }).toolName === n) as Array<{ content: unknown }>;
    // KeepMe untouched even though gap fired
    expect(byName('KeepMe')[0].content).toBe('k0');
    // both Read cleared (keepRecent 0 floored to 1, but the 1 kept is the most
    // recent *Read* → r1 kept, r0 cleared)
    const reads = byName('Read');
    expect(reads[0].content).toBe(CLEARED_TOOL_PLACEHOLDER);
    expect(reads[1].content).toBe('r1');
  });
});
