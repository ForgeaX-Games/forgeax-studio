/**
 * Ledger fold — events stream → derived messages (设计稿 §3.8.7).
 *
 * The events stream is the source of truth (§6.1); messages are a derived view
 * computed by folding. Compaction is expressed as events (CompactionApplied /
 * CompactionRevoked), never by splicing the stream (§3.8.3): a compacted range
 * is replaced by its `replacement` at the range's first covered event and
 * skipped thereafter; revocation removes the applied range; events are never
 * deleted (§6.1).
 *
 * Payload-agnostic via `FoldAdapter<M>` so the F1 loop move specializes message
 * shapes (LLMMessage) without touching this algorithm.
 *
 * Range index semantics: `byIndex` is the position in the input `events` array.
 */
import type { CoreEvent } from '../events/types';

export type EventRange =
  | { kind: 'all' }
  | { kind: 'byIndex'; from: number; to: number }
  | { kind: 'byTimestamp'; from: number; to: number }
  | { kind: 'byEventId'; ids: string[] };

export interface FoldAdapter<M> {
  /** Is this event a conversation message (vs. a control/compaction event)? */
  isMessage(e: CoreEvent): boolean;
  /** Project a message event into a provider message. */
  toMessage(e: CoreEvent): M;
  /** Stable identity of any event (for byEventId ranges + revoke targeting). */
  eventId(e: CoreEvent): string;
  isCompactionApplied(e: CoreEvent): boolean;
  isCompactionRevoked(e: CoreEvent): boolean;
  /** Range covered by a CompactionApplied event. */
  appliedRange(e: CoreEvent): EventRange;
  /** Replacement message a CompactionApplied event installs. */
  appliedReplacement(e: CoreEvent): M;
  /** The CompactionApplied eventId a CompactionRevoked event targets. */
  revokedAppliedId(e: CoreEvent): string;
}

interface AppliedEntry<M> {
  id: string;
  range: EventRange;
  replacement: M;
  emitted: boolean;
}

function rangeCovers(range: EventRange, e: CoreEvent, idx: number, eventId: string): boolean {
  switch (range.kind) {
    case 'all':
      return true;
    case 'byIndex':
      return idx >= range.from && idx <= range.to;
    case 'byTimestamp':
      return e.ts >= range.from && e.ts <= range.to;
    case 'byEventId':
      return range.ids.includes(eventId);
  }
}

/**
 * Fold an event stream into derived messages.
 *
 * - Collect non-revoked CompactionApplied ranges (overlaps resolve last-wins:
 *   the latest applied range covering an event takes effect).
 * - Walk events in order: a covered message emits its range's replacement at the
 *   first covered position, and is skipped afterward; uncovered messages project
 *   via `toMessage`; non-message events are skipped.
 */
export function foldEvents<M>(events: CoreEvent[], adapter: FoldAdapter<M>): M[] {
  const revoked = new Set<string>();
  for (const e of events) {
    if (adapter.isCompactionRevoked(e)) revoked.add(adapter.revokedAppliedId(e));
  }

  const applied: AppliedEntry<M>[] = [];
  for (const e of events) {
    if (!adapter.isCompactionApplied(e)) continue;
    const id = adapter.eventId(e);
    if (revoked.has(id)) continue;
    applied.push({ id, range: adapter.appliedRange(e), replacement: adapter.appliedReplacement(e), emitted: false });
  }

  const out: M[] = [];
  events.forEach((e, idx) => {
    if (!adapter.isMessage(e)) return;
    const id = adapter.eventId(e);

    // Last-wins: the latest applied range covering this event takes effect.
    let hit: AppliedEntry<M> | null = null;
    for (let k = applied.length - 1; k >= 0; k--) {
      if (rangeCovers(applied[k].range, e, idx, id)) {
        hit = applied[k];
        break;
      }
    }

    if (hit) {
      if (!hit.emitted) {
        out.push(hit.replacement);
        hit.emitted = true;
      }
      return; // inside a compacted range → skip the original
    }
    out.push(adapter.toMessage(e));
  });

  return out;
}
