/**
 * Wave 0 contract-freeze tests — verify the frozen seams behave as specified.
 * These are intentionally light (contracts are mostly types); they pin the
 * runtime helpers (buildTool defaults, mergeUsage accumulation, event catalog,
 * memory budget) that the parallel team builds against.
 */
import { test, expect, describe } from 'bun:test';
import { buildTool, type ToolContext } from '../src/capability/types';
import { mergeUsage, EMPTY_USAGE, FallbackTriggeredError } from '../src/provider/types';
import { CoreEventType, isCleanTerminal, STAGE_EVENT } from '../src/events/events';
import { MEMORY_BUDGET, MEMORY_SEARCH_TOOL, REMEMBER_TOOL } from '../src/capability/memory-seam';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../src/context/types';

describe('C2 capability ABI — buildTool fail-closed defaults', () => {
  const tool = buildTool({
    name: 'echo',
    call: async (input: { x: number }) => ({ data: input.x }),
    mapResult: (out, id) => ({ type: 'tool.result', payload: { id, out }, ts: 0 }),
    maxResultSizeChars: 1000,
  });

  test('defaults are fail-closed (not concurrency-safe / not read-only)', () => {
    expect(tool.isConcurrencySafe({ x: 1 })).toBe(false);
    expect(tool.isReadOnly({ x: 1 })).toBe(false);
    expect(tool.isEnabled()).toBe(true);
  });

  test('default checkPermissions allows with passthrough input', async () => {
    const ctx = { signal: new AbortController().signal } as ToolContext;
    const r = await tool.checkPermissions({ x: 1 }, ctx);
    expect(r.behavior).toBe('allow');
    expect(r.updatedInput).toEqual({ x: 1 });
  });

  test('explicit overrides win over defaults', () => {
    const safe = buildTool({
      name: 'read',
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      call: async () => ({ data: null }),
      mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0 }),
      maxResultSizeChars: Infinity,
    });
    expect(safe.isConcurrencySafe(undefined)).toBe(true);
    expect(safe.isReadOnly(undefined)).toBe(true);
  });
});

describe('C4 provider — usage accumulation', () => {
  test('input/cache only overwritten when > 0; output takes latest', () => {
    let u = EMPTY_USAGE;
    u = mergeUsage(u, { inputTokens: 100, cacheReadInputTokens: 50, outputTokens: 5 });
    expect(u.inputTokens).toBe(100);
    expect(u.cacheReadInputTokens).toBe(50);
    // message_delta sends input/cache as 0 → must NOT clobber the real values
    u = mergeUsage(u, { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 42 });
    expect(u.inputTokens).toBe(100);
    expect(u.cacheReadInputTokens).toBe(50);
    expect(u.outputTokens).toBe(42);
  });

  test('FallbackTriggeredError carries both models', () => {
    const e = new FallbackTriggeredError('opus', 'sonnet');
    expect(e.originalModel).toBe('opus');
    expect(e.fallbackModel).toBe('sonnet');
    expect(e.name).toBe('FallbackTriggeredError');
  });
});

describe('C1 event catalog — rebirth events present + clean terminal', () => {
  test('three rebirth events exist (数字生命 seam)', () => {
    expect(CoreEventType.SoulPackLoaded).toBe('soul.pack_loaded');
    expect(CoreEventType.RebirthInitiated).toBe('soul.rebirth_initiated');
    expect(CoreEventType.IdentityProjected).toBe('soul.identity_projected');
  });
  test('only "completed" is a clean terminal', () => {
    expect(isCleanTerminal('completed')).toBe(true);
    expect(isCleanTerminal('max_turns')).toBe(false);
    expect(isCleanTerminal('aborted_streaming')).toBe(false);
  });
  test('every loop stage maps to an event name', () => {
    for (const ev of Object.values(STAGE_EVENT)) expect(typeof ev).toBe('string');
  });
});

describe('C8 memory seam — budget + tool names', () => {
  test('tool name constants', () => {
    expect(MEMORY_SEARCH_TOOL).toBe('memory_search');
    expect(REMEMBER_TOOL).toBe('remember');
  });
  test('injection budget matches expected caps', () => {
    expect(MEMORY_BUDGET.perTurnMaxFiles).toBe(5);
    expect(MEMORY_BUDGET.sessionMaxBytes).toBe(60_000);
  });
});

describe('C7 system-prompt — dynamic boundary sentinel', () => {
  test('boundary sentinel is stable', () => {
    expect(SYSTEM_PROMPT_DYNAMIC_BOUNDARY).toBe('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
  });
});
