/**
 * EventBus — synchronous single-agent hook bus (设计稿 §3.2).
 *
 * Invariants:
 *  - `publish` is synchronous; subscribers run serially in registration order
 *    (§6.13). The event each subscriber sees reflects all prior `modify`s.
 *  - `block` terminates propagation immediately (§6.2); a subscriber registered
 *    after the blocking hook does not run — so `connectStore` (registered last)
 *    is naturally skipped, satisfying "blocked events do not enter the store"
 *    (§6.3).
 *  - Subscriber errors are swallowed (written to stderr) so one bad hook can't
 *    break the turn — reused from cli `core/event-bus.ts`.
 */
import type { CoreEvent, EventBusAPI, EventFilter, EventHandler, HookControl, Unsubscribe } from './types';

interface Sub {
  filter: EventFilter;
  handler: EventHandler;
}

function matches(filter: EventFilter, event: CoreEvent): boolean {
  if (filter === '*') return true;
  if (typeof filter === 'function') return filter(event);
  return event.type === filter;
}

export class EventBus implements EventBusAPI {
  private readonly subs: Sub[] = [];

  subscribe(filter: EventFilter, handler: EventHandler): Unsubscribe {
    const sub: Sub = { filter, handler };
    this.subs.push(sub);
    return () => {
      const i = this.subs.indexOf(sub);
      if (i >= 0) this.subs.splice(i, 1);
    };
  }

  publish<E extends CoreEvent>(event: E): E {
    let current: CoreEvent = event;
    const ctl: HookControl = {
      block(reason?: string): void {
        current = { ...current, blocked: true, blockReason: reason };
      },
      modify(patch: Partial<CoreEvent>): CoreEvent {
        current = { ...current, ...patch };
        return current;
      },
    };

    // Snapshot subscriber list so subscribe/unsubscribe during dispatch is safe.
    for (const sub of [...this.subs]) {
      if (!matches(sub.filter, current)) continue;
      let returned: void | CoreEvent;
      try {
        returned = sub.handler(current, ctl);
      } catch (err) {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        process.stderr.write(`[forgeax-core/event-bus] subscriber error on "${current.type}": ${msg}\n`);
        continue;
      }
      if (returned) current = returned;
      if (current.blocked) break; // §6.3: stop propagation, do not reach store-append
    }

    return current as E;
  }
}
