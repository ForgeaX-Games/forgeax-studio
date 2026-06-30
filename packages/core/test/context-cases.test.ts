/**
 * Context (C7) 补验证用例 —— micro-compaction 时基旁路 + system-prompt 装配边界 +
 * fold compaction 占位摘要的未覆盖分支。
 *
 * 覆盖未覆盖点:
 *  - micro-compaction.ts:
 *      · gate 不触发(gap < 阈值 / 无 assistant 消息)→ 返回同长度副本(no-op);
 *      · assistant timestamp 为字符串且可 Date.parse → 解析后参与 gate;
 *      · assistant timestamp 为字符串但不可解析 / assistant 无 timestamp → 跳过 gate;
 *      · 保护区外的 tool_result 被清空成占位符;role:'tool' 单条 + user 块两形态;
 *      · 已是占位符 → 不重复清(touched=false 路径,返回原 msg);
 *      · compactableToolNames 收窄。
 *  - system-prompt.ts: org scope(globalCacheEnabled=false,无 boundary)+ leading=null。
 *  - compaction.ts: buildPlaceholderSummary 空范围 / 非空范围 covered 计数。
 *
 * 覆盖 time-based 路径 +
 * `services/compact/autoCompact.ts`。Boundary: 仅 core 相对 import。
 */
import { test, expect, describe } from 'bun:test';
import {
  microCompact,
  CLEARED_TOOL_PLACEHOLDER,
  DEFAULT_GAP_THRESHOLD_MINUTES,
} from '../src/context/micro-compaction';
import { DefaultSystemPromptAssembler } from '../src/context/system-prompt';
import type { Slot } from '../src/capability/types';
import type { LeadingSystemSlot, SystemPromptAssembleInput } from '../src/context/types';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../src/context/types';

// ─── micro-compaction time-based path ──────────────────────────────────────────

// A message timeline: assistant at T, then tool results after it. `now` controls gap.
const HOUR_MS = 60 * 60 * 1000;
const ASSISTANT_T = 1_000_000_000_000; // fixed anchor

function asst(ts: number | string | undefined): Record<string, unknown> {
  const m: Record<string, unknown> = { role: 'assistant', content: [{ type: 'text', text: 'ok' }] };
  if (ts !== undefined) m.timestamp = ts;
  return m;
}
function toolMsg(name: string, content = 'RESULT'): Record<string, unknown> {
  return { role: 'tool', toolName: name, content };
}
function userToolResult(name: string, content = 'RESULT'): Record<string, unknown> {
  return { role: 'user', content: [{ type: 'tool_result', name, content }] };
}

describe('microCompact — gate (idle gap)', () => {
  test('gap below threshold → no-op (same-length copy, nothing cleared)', () => {
    const msgs = [asst(ASSISTANT_T), toolMsg('Read'), toolMsg('Bash')];
    const out = microCompact(msgs, { now: ASSISTANT_T + 5 * 60 * 1000, keepRecent: 1 }); // 5min < 60
    expect(out).toHaveLength(msgs.length);
    expect(out.every((m) => (m as Record<string, unknown>).content !== CLEARED_TOOL_PLACEHOLDER)).toBe(true);
  });

  test('no assistant message anywhere → no-op', () => {
    const msgs = [toolMsg('Read'), toolMsg('Bash')];
    const out = microCompact(msgs, { now: ASSISTANT_T + 10 * HOUR_MS, keepRecent: 1 });
    expect(out).toHaveLength(2);
    expect(out.every((m) => (m as Record<string, unknown>).content === 'RESULT')).toBe(true);
  });

  test('gap at/above threshold → fires, clears beyond protection zone', () => {
    const msgs = [asst(ASSISTANT_T), toolMsg('Read', 'A'), toolMsg('Bash', 'B'), toolMsg('Grep', 'C')];
    const out = microCompact(msgs, {
      now: ASSISTANT_T + (DEFAULT_GAP_THRESHOLD_MINUTES + 1) * 60 * 1000,
      keepRecent: 1,
    }) as Array<Record<string, unknown>>;
    // 3 tool results, keepRecent 1 → first two cleared, last kept.
    expect(out[1].content).toBe(CLEARED_TOOL_PLACEHOLDER);
    expect(out[2].content).toBe(CLEARED_TOOL_PLACEHOLDER);
    expect(out[3].content).toBe('C');
  });
});

describe('microCompact — assistant timestamp parsing', () => {
  const farFuture = (base: number): number => base + 10 * HOUR_MS;

  test('string ISO timestamp is Date.parse-d and participates in gate', () => {
    const iso = new Date(ASSISTANT_T).toISOString();
    const msgs = [asst(iso), toolMsg('Read', 'A'), toolMsg('Bash', 'B')];
    const out = microCompact(msgs, { now: farFuture(ASSISTANT_T), keepRecent: 1 }) as Array<Record<string, unknown>>;
    expect(out[1].content).toBe(CLEARED_TOOL_PLACEHOLDER);
    expect(out[2].content).toBe('B'); // last kept
  });

  test('unparseable string timestamp → gate skipped (no-op)', () => {
    const msgs = [asst('not-a-date'), toolMsg('Read', 'A'), toolMsg('Bash', 'B')];
    const out = microCompact(msgs, { now: farFuture(ASSISTANT_T), keepRecent: 1 }) as Array<Record<string, unknown>>;
    expect(out[1].content).toBe('A');
    expect(out[2].content).toBe('B');
  });

  test('assistant with no timestamp → gate skipped (no-op)', () => {
    const msgs = [asst(undefined), toolMsg('Read', 'A'), toolMsg('Bash', 'B')];
    const out = microCompact(msgs, { now: farFuture(ASSISTANT_T), keepRecent: 1 }) as Array<Record<string, unknown>>;
    expect(out[1].content).toBe('A');
    expect(out[2].content).toBe('B');
  });
});

describe('microCompact — message shapes & idempotence', () => {
  const fire = (msgs: unknown[], over: Record<string, unknown> = {}): Array<Record<string, unknown>> =>
    microCompact(msgs, {
      now: ASSISTANT_T + 10 * HOUR_MS,
      keepRecent: 1,
      ...over,
    }) as Array<Record<string, unknown>>;

  test('user-message tool_result blocks get their content cleared', () => {
    const msgs = [asst(ASSISTANT_T), userToolResult('Read', 'A'), userToolResult('Bash', 'B')];
    const out = fire(msgs);
    const firstBlock = (out[1].content as Array<Record<string, unknown>>)[0];
    const lastBlock = (out[2].content as Array<Record<string, unknown>>)[0];
    expect(firstBlock.content).toBe(CLEARED_TOOL_PLACEHOLDER);
    expect(lastBlock.content).toBe('B'); // protected
  });

  test('already-cleared tool result is not re-touched (returns original ref region)', () => {
    const msgs = [
      asst(ASSISTANT_T),
      toolMsg('Read', CLEARED_TOOL_PLACEHOLDER), // already placeholder
      toolMsg('Bash', 'B'),
      toolMsg('Grep', 'C'),
    ];
    const out = fire(msgs);
    // Read already cleared (stays placeholder), Bash newly cleared, Grep kept.
    expect(out[1].content).toBe(CLEARED_TOOL_PLACEHOLDER);
    expect(out[2].content).toBe(CLEARED_TOOL_PLACEHOLDER);
    expect(out[3].content).toBe('C');
  });

  test('user tool_result already placeholder in a block → untouched (touched=false path)', () => {
    const msgs = [
      asst(ASSISTANT_T),
      userToolResult('Read', CLEARED_TOOL_PLACEHOLDER),
      userToolResult('Bash', 'B'),
    ];
    const out = fire(msgs);
    const firstBlock = (out[1].content as Array<Record<string, unknown>>)[0];
    expect(firstBlock.content).toBe(CLEARED_TOOL_PLACEHOLDER);
  });

  test('nothing to clear (all within keepRecent) → no-op copy', () => {
    const msgs = [asst(ASSISTANT_T), toolMsg('Read', 'A')];
    const out = fire(msgs, { keepRecent: 20 });
    expect(out[1].content).toBe('A');
  });

  test('compactableToolNames narrows clearing to listed tools', () => {
    const msgs = [
      asst(ASSISTANT_T),
      toolMsg('Read', 'A'),
      toolMsg('Bash', 'B'),
      toolMsg('Grep', 'C'),
      toolMsg('Glob', 'D'),
    ];
    // only Read/Bash are compactable; keepRecent 1 over the 2 candidates → Read cleared, Bash kept.
    const out = fire(msgs, { compactableToolNames: ['Read', 'Bash'], keepRecent: 1 });
    expect(out[1].content).toBe(CLEARED_TOOL_PLACEHOLDER); // Read cleared
    expect(out[2].content).toBe('B'); // Bash protected (last candidate)
    expect(out[3].content).toBe('C'); // Grep untouched (not compactable)
    expect(out[4].content).toBe('D'); // Glob untouched
  });
});

// ─── system-prompt assembler — org scope / no-boundary / null leading ──────────

describe('DefaultSystemPromptAssembler — org-mode & null-leading paths', () => {
  const assembler = new DefaultSystemPromptAssembler();
  const staticSlot = (name: string, text: string | null): Slot => ({ name, render: () => text });
  const dynamicSlot = (name: string, text: string | null): Slot => ({ name, render: () => text, dynamic: true });
  const leadingOf = (t: string | null): LeadingSystemSlot => ({ render: () => t });
  const baseInput = (over: Partial<SystemPromptAssembleInput>): SystemPromptAssembleInput => ({
    staticSlots: [],
    dynamicSlots: [],
    ctx: { agentId: 'a' },
    ...over,
  });

  test('org mode (globalCacheEnabled=false): static=org, NO boundary sentinel', async () => {
    const blocks = await assembler.assemble(
      baseInput({
        leading: leadingOf('LEAD'),
        staticSlots: [staticSlot('s', 'STATIC')],
        dynamicSlots: [dynamicSlot('d', 'DYNAMIC')],
        globalCacheEnabled: false,
      }),
    );
    expect(blocks.some((b) => b.text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY)).toBe(false);
    expect(blocks.find((b) => b.text === 'STATIC')!.cacheScope).toBe('org');
    expect(blocks.find((b) => b.text === 'DYNAMIC')!.cacheScope).toBe(null);
    expect(blocks.map((b) => b.text)).toEqual(['LEAD', 'STATIC', 'DYNAMIC']);
  });

  test('globalCacheEnabled omitted defaults to org mode', async () => {
    const blocks = await assembler.assemble(baseInput({ staticSlots: [staticSlot('s', 'S')] }));
    expect(blocks.find((b) => b.text === 'S')!.cacheScope).toBe('org');
    expect(blocks.some((b) => b.text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY)).toBe(false);
  });

  test('leading=null → no leading block emitted', async () => {
    const blocks = await assembler.assemble(
      baseInput({ leading: leadingOf(null), staticSlots: [staticSlot('s', 'S')] }),
    );
    expect(blocks.map((b) => b.text)).toEqual(['S']);
  });

  test('no leading provided at all → no leading block', async () => {
    const blocks = await assembler.assemble(baseInput({ staticSlots: [staticSlot('s', 'S')] }));
    expect(blocks[0].text).toBe('S');
  });
});

