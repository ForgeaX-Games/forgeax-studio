import { describe, expect, test } from 'bun:test';
import { foldEvents, type EventRange, type FoldAdapter } from '../src/history/ledger';
import type { CoreEvent } from '../src/events/types';

// Minimal test vocabulary: a "Message" event carries { id, text }; a
// "CompactionApplied" carries { id, range, summary }; "CompactionRevoked"
// carries { targetId }.
function msg(id: string, text: string): CoreEvent {
  return { type: 'Message', ts: 0, payload: { id, text } };
}
function applied(id: string, range: EventRange, summary: string): CoreEvent {
  return { type: 'CompactionApplied', ts: 0, payload: { id, range, summary } };
}
function revoked(targetId: string): CoreEvent {
  return { type: 'CompactionRevoked', ts: 0, payload: { targetId } };
}

const adapter: FoldAdapter<string> = {
  isMessage: (e) => e.type === 'Message',
  toMessage: (e) => (e.payload as { text: string }).text,
  eventId: (e) => String((e.payload as { id?: string }).id ?? ''),
  isCompactionApplied: (e) => e.type === 'CompactionApplied',
  isCompactionRevoked: (e) => e.type === 'CompactionRevoked',
  appliedRange: (e) => (e.payload as { range: EventRange }).range,
  appliedReplacement: (e) => (e.payload as { summary: string }).summary,
  revokedAppliedId: (e) => (e.payload as { targetId: string }).targetId,
};

describe('foldEvents', () => {
  test('no compaction → messages project through in order', () => {
    const events = [msg('1', 'hello'), msg('2', 'world')];
    expect(foldEvents(events, adapter)).toEqual(['hello', 'world']);
  });

  test('non-message events are skipped', () => {
    const events = [msg('1', 'a'), { type: 'noise', ts: 0, payload: {} }, msg('2', 'b')];
    expect(foldEvents(events, adapter)).toEqual(['a', 'b']);
  });

  test('byIndex range → replacement at first covered, skip rest', () => {
    // events[1..2] (msgs 2 and 3) compacted into "[summary]"
    const events = [
      msg('1', 'a'),
      msg('2', 'b'),
      msg('3', 'c'),
      msg('4', 'd'),
      applied('C', { kind: 'byIndex', from: 1, to: 2 }, '[summary]'),
    ];
    expect(foldEvents(events, adapter)).toEqual(['a', '[summary]', 'd']);
  });

  test('byEventId range', () => {
    const events = [
      msg('1', 'a'),
      msg('2', 'b'),
      msg('3', 'c'),
      applied('C', { kind: 'byEventId', ids: ['2', '3'] }, '[s]'),
    ];
    expect(foldEvents(events, adapter)).toEqual(['a', '[s]']);
  });

  test('revoked compaction → original messages restored', () => {
    const events = [
      msg('1', 'a'),
      msg('2', 'b'),
      applied('C', { kind: 'byEventId', ids: ['1', '2'] }, '[s]'),
      revoked('C'),
    ];
    expect(foldEvents(events, adapter)).toEqual(['a', 'b']);
  });

  test('overlapping ranges resolve last-wins', () => {
    const events = [
      msg('1', 'a'),
      msg('2', 'b'),
      msg('3', 'c'),
      applied('A', { kind: 'byEventId', ids: ['1', '2'] }, '[A]'),
      applied('B', { kind: 'byEventId', ids: ['2', '3'] }, '[B]'),
    ];
    // 1 covered by A only → [A]; 2 last-covered by B → [B]; 3 by B (already emitted) → skip
    expect(foldEvents(events, adapter)).toEqual(['[A]', '[B]']);
  });

  test('all range collapses everything to one replacement', () => {
    const events = [msg('1', 'a'), msg('2', 'b'), applied('C', { kind: 'all' }, '[everything]')];
    expect(foldEvents(events, adapter)).toEqual(['[everything]']);
  });
});
