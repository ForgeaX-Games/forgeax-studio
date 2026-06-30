/**
 * EventStore default + bus wiring (设计稿 §4.1 / §6.3 / §6.5).
 *
 * The `EventStore` interface itself is an injection point (declared in
 * `inject/types.ts`) — the host provides a durable WAL impl. core ships an
 * in-memory default so it runs as a pure function when no store is injected
 * (§6.5: core 默认无状态).
 */
import type { EventStore, ReadOpts } from '../inject/types';
import type { CoreEvent, EventBusAPI, Unsubscribe } from '../events/types';

/** In-memory EventStore — the no-injection default. */
export class InMemoryEventStore implements EventStore {
  private readonly events: CoreEvent[] = [];

  async append(events: CoreEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async *read(opts?: ReadOpts): AsyncIterable<CoreEvent> {
    const start = typeof opts?.from === 'number' ? opts.from : 0;
    const slice = this.events.slice(start, opts?.limit ? start + opts.limit : undefined);
    for (const e of slice) yield e;
  }

  /** Synchronous snapshot for fold / tests. */
  snapshot(): CoreEvent[] {
    return [...this.events];
  }
}

/**
 * Wire an EventStore to an EventBus so every published, non-blocked event is
 * appended in order. MUST be registered LAST: `block` stops propagation before
 * reaching this subscriber, so blocked events never enter the store (§6.3).
 *
 * Returns an unsubscribe handle.
 */
export function connectStore(bus: EventBusAPI, store: EventStore): Unsubscribe {
  return bus.subscribe('*', (event) => {
    // append is fire-and-forget at the bus boundary; durability is the host's
    // SLA (§4.1). A rejected append must not break the synchronous publish path.
    void Promise.resolve(store.append([event])).catch((err: unknown) => {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`[forgeax-core/event-store] append failed for "${event.type}": ${msg}\n`);
    });
  });
}
