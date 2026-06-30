/**
 * CTX extras tests — dynamic-reminder slot + system-snapshot diff.
 *
 * Covers:
 *  - dynamic-reminder: null get() → slot skips (render null); value → wrapped in
 *    <system-reminder>; whitespace-only → dropped; slot is dynamic + cacheScope null.
 *  - wrapSystemReminder: tag wrapping + empty/whitespace passthrough.
 *  - system-snapshot: replay folds named blocks; diff stable when unchanged,
 *    reports which block changed (text / cacheScope), and removed blocks.
 */
import { test, expect, describe } from 'bun:test';
import type { SlotContext } from '../src/capability/types';
import type { SystemBlock } from '../src/provider/types';
import { makeDynamicReminderSlot, wrapSystemReminder } from '../src/context/dynamic-reminder';
import type { NamedSystemBlock } from '../src/context/system-snapshot';
import { replaySystemSnapshot, diffSystemBlocks } from '../src/context/system-snapshot';

const ctx: SlotContext = { agentId: 'a1' };
const named = (name: string, text: string, cacheScope?: SystemBlock['cacheScope']): NamedSystemBlock => ({
  name,
  block: { type: 'text', text, cacheScope },
});

// ─── dynamic-reminder ──────────────────────────────────────────────────────────

describe('makeDynamicReminderSlot — dynamic, boundary-后 reminder', () => {
  test('slot is dynamic and never cached (cacheScope=null)', () => {
    const slot = makeDynamicReminderSlot(() => null);
    expect(slot.name).toBe('dynamic-reminder');
    expect(slot.dynamic).toBe(true);
    expect(slot.cacheScope).toBe(null);
  });

  test('get() returns null → render skips (null)', () => {
    const slot = makeDynamicReminderSlot(() => null);
    expect(slot.render(ctx)).toBe(null);
  });

  test('get() returns text → render wraps it in <system-reminder>', () => {
    const slot = makeDynamicReminderSlot(() => 'plan mode is on');
    const out = slot.render(ctx);
    expect(out).toBe('<system-reminder>\nplan mode is on\n</system-reminder>');
  });

  test('get() returns whitespace-only → render drops it (null)', () => {
    const slot = makeDynamicReminderSlot(() => '   \n  ');
    expect(slot.render(ctx)).toBe(null);
  });

  test('get() is re-pulled each render (dynamic)', () => {
    let value: string | null = null;
    const slot = makeDynamicReminderSlot(() => value);
    expect(slot.render(ctx)).toBe(null);
    value = 'now active';
    expect(slot.render(ctx)).toBe('<system-reminder>\nnow active\n</system-reminder>');
  });
});

describe('wrapSystemReminder', () => {
  test('wraps non-empty text with trimmed body', () => {
    expect(wrapSystemReminder('  hello  ')).toBe('<system-reminder>\nhello\n</system-reminder>');
  });
  test('empty / whitespace returns empty (caller drops)', () => {
    expect(wrapSystemReminder('')).toBe('');
    expect(wrapSystemReminder('   ')).toBe('');
  });
});

// ─── system-snapshot ───────────────────────────────────────────────────────────

describe('replaySystemSnapshot — fold named blocks', () => {
  test('folds into Map keyed by name, last write wins', () => {
    const snap = replaySystemSnapshot([
      named('soul', 'IDENTITY', 'global'),
      named('memory', 'MEM_A'),
      named('memory', 'MEM_B'),
    ]);
    expect(snap.size).toBe(2);
    expect(snap.get('soul')).toEqual({ text: 'IDENTITY', cacheScope: 'global' });
    expect(snap.get('memory')!.text).toBe('MEM_B');
  });
});

describe('diffSystemBlocks — cache stability across two assemblies', () => {
  test('no change → stable, empty changed/removed (cache holds)', () => {
    const prev = replaySystemSnapshot([named('soul', 'IDENTITY', 'global'), named('mem', 'MEM')]);
    const next = replaySystemSnapshot([named('soul', 'IDENTITY', 'global'), named('mem', 'MEM')]);
    const diff = diffSystemBlocks(prev, next);
    expect(diff.stable).toBe(true);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  test('text change → reports which block changed, not stable', () => {
    const prev = replaySystemSnapshot([named('soul', 'IDENTITY'), named('mem', 'MEM_A')]);
    const next = replaySystemSnapshot([named('soul', 'IDENTITY'), named('mem', 'MEM_B')]);
    const diff = diffSystemBlocks(prev, next);
    expect(diff.stable).toBe(false);
    expect(diff.changed).toEqual(['mem']);
    expect(diff.removed).toEqual([]);
  });

  test('cacheScope change alone counts as changed', () => {
    const prev = replaySystemSnapshot([named('s', 'SAME', 'global')]);
    const next = replaySystemSnapshot([named('s', 'SAME', 'org')]);
    const diff = diffSystemBlocks(prev, next);
    expect(diff.stable).toBe(false);
    expect(diff.changed).toEqual(['s']);
  });

  test('new block in next → changed; missing block → removed', () => {
    const prev = replaySystemSnapshot([named('a', 'A'), named('gone', 'G')]);
    const next = replaySystemSnapshot([named('a', 'A'), named('b', 'B')]);
    const diff = diffSystemBlocks(prev, next);
    expect(diff.stable).toBe(false);
    expect(diff.changed).toEqual(['b']);
    expect(diff.removed).toEqual(['gone']);
  });

  test('does not mutate inputs', () => {
    const prev = replaySystemSnapshot([named('x', 'X')]);
    const next = replaySystemSnapshot([named('y', 'Y')]);
    diffSystemBlocks(prev, next);
    expect([...prev.keys()]).toEqual(['x']);
    expect([...next.keys()]).toEqual(['y']);
  });
});
