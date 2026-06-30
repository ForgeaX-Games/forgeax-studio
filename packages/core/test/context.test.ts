/**
 * CTX (C7) tests — system-prompt assembly + watermarks + fold compaction.
 *
 * Covers: assemble segment order (leading → static → BOUNDARY → dynamic),
 * boundary position + presence gated by globalCacheEnabled, leading-first +
 * byte stability, cacheScope annotation; computeWatermarks arithmetic;
 * FoldCompactionStrategy.shouldCompact threshold; compact() covered range.
 */
import { test, expect, describe } from 'bun:test';
import type { Slot } from '../src/capability/types';
import type { LeadingSystemSlot, SystemPromptAssembleInput, Watermarks } from '../src/context/types';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../src/context/types';
import { DefaultSystemPromptAssembler } from '../src/context/system-prompt';
import { computeWatermarks } from '../src/context/watermarks';

// ─── helpers ─────────────────────────────────────────────────────────────────

function staticSlot(name: string, text: string | null): Slot {
  return { name, render: () => text, cacheScope: undefined };
}
function dynamicSlot(name: string, text: string | null): Slot {
  return { name, render: () => text, dynamic: true };
}
const leadingOf = (text: string | null): LeadingSystemSlot => ({ render: () => text });

function baseInput(over: Partial<SystemPromptAssembleInput> = {}): SystemPromptAssembleInput {
  return {
    staticSlots: [],
    dynamicSlots: [],
    ctx: { agentId: 'a1' },
    ...over,
  };
}

const assembler = new DefaultSystemPromptAssembler();

// ─── system-prompt assembly ──────────────────────────────────────────────────

describe('C7 system-prompt assembler — segment order & cache scope', () => {
  test('order: leading first → static → BOUNDARY → dynamic (global mode)', async () => {
    const blocks = await assembler.assemble(
      baseInput({
        leading: leadingOf('SOUL+PREAMBLE'),
        staticSlots: [staticSlot('s1', 'STATIC_A'), staticSlot('s2', 'STATIC_B')],
        dynamicSlots: [dynamicSlot('d1', 'DYNAMIC_A')],
        globalCacheEnabled: true,
      }),
    );
    const texts = blocks.map((b) => b.text);
    expect(texts).toEqual([
      'SOUL+PREAMBLE',
      'STATIC_A',
      'STATIC_B',
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      'DYNAMIC_A',
    ]);
  });

  test('leading is byte-stable at index 0 (cache prefix anchor)', async () => {
    const leadingText = 'STABLE_LEADING_ANCHOR (host-injected, byte-stable).';
    const blocks = await assembler.assemble(
      baseInput({ leading: leadingOf(leadingText), staticSlots: [staticSlot('s', 'X')], globalCacheEnabled: true }),
    );
    expect(blocks[0].text).toBe(leadingText);
    expect(blocks[0].cacheScope).toBe(null);
  });

  test('static slots get global scope in global mode, org scope otherwise', async () => {
    const globalBlocks = await assembler.assemble(
      baseInput({ staticSlots: [staticSlot('s', 'STATIC')], globalCacheEnabled: true }),
    );
    expect(globalBlocks.find((b) => b.text === 'STATIC')!.cacheScope).toBe('global');

    const orgBlocks = await assembler.assemble(
      baseInput({ staticSlots: [staticSlot('s', 'STATIC')], globalCacheEnabled: false }),
    );
    expect(orgBlocks.find((b) => b.text === 'STATIC')!.cacheScope).toBe('org');
  });

  test('slot.cacheScope override is respected over the default static scope', async () => {
    const pinned: Slot = { name: 'p', render: () => 'PINNED', cacheScope: 'org' };
    const blocks = await assembler.assemble(
      baseInput({ staticSlots: [pinned], globalCacheEnabled: true }),
    );
    expect(blocks.find((b) => b.text === 'PINNED')!.cacheScope).toBe('org');
  });

  test('dynamic slots are never cached (cacheScope=null) and sit after boundary', async () => {
    const blocks = await assembler.assemble(
      baseInput({
        staticSlots: [staticSlot('s', 'STATIC')],
        dynamicSlots: [dynamicSlot('d', 'DYNAMIC')],
        globalCacheEnabled: true,
      }),
    );
    const boundaryIdx = blocks.findIndex((b) => b.text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    const dynIdx = blocks.findIndex((b) => b.text === 'DYNAMIC');
    expect(dynIdx).toBeGreaterThan(boundaryIdx);
    expect(blocks[dynIdx].cacheScope).toBe(null);
  });

  test('boundary sentinel omitted when global cache disabled', async () => {
    const blocks = await assembler.assemble(
      baseInput({
        staticSlots: [staticSlot('s', 'STATIC')],
        dynamicSlots: [dynamicSlot('d', 'DYNAMIC')],
        globalCacheEnabled: false,
      }),
    );
    expect(blocks.some((b) => b.text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY)).toBe(false);
    // order still leading? → static → dynamic
    expect(blocks.map((b) => b.text)).toEqual(['STATIC', 'DYNAMIC']);
  });

  test('null / empty slot renders are dropped; no leading → no leading block', async () => {
    const blocks = await assembler.assemble(
      baseInput({
        leading: leadingOf(null),
        staticSlots: [staticSlot('s1', null), staticSlot('s2', ''), staticSlot('s3', 'KEEP')],
        globalCacheEnabled: false,
      }),
    );
    expect(blocks.map((b) => b.text)).toEqual(['KEEP']);
  });

  test('every block is a text block', async () => {
    const blocks = await assembler.assemble(
      baseInput({ leading: leadingOf('L'), staticSlots: [staticSlot('s', 'S')], globalCacheEnabled: true }),
    );
    for (const b of blocks) expect(b.type).toBe('text');
  });
});

// ─── watermarks ──────────────────────────────────────────────────────────────

describe('C7 computeWatermarks — autoCompact arithmetic', () => {
  test('200k window → effective/auto/warning/blocking', () => {
    const w = computeWatermarks(200_000);
    expect(w.effectiveWindow).toBe(180_000); // 200k - 20k
    expect(w.autoCompactThreshold).toBe(167_000); // effective - 13k
    expect(w.warningThreshold).toBe(160_000); // effective - 20k
    expect(w.blockingLimit).toBe(177_000); // effective - 3k
  });

  test('relative buffers hold for any window size', () => {
    const window = 100_000;
    const w: Watermarks = computeWatermarks(window);
    expect(w.effectiveWindow).toBe(window - 20_000);
    expect(w.effectiveWindow - w.autoCompactThreshold).toBe(13_000);
    expect(w.effectiveWindow - w.warningThreshold).toBe(20_000);
    expect(w.effectiveWindow - w.blockingLimit).toBe(3_000);
  });
});

