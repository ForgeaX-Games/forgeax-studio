/**
 * Core single-agent event bus types (设计稿 core-layer-spec §3.2).
 *
 * This is the SINGLE-AGENT hook bus — `publish` is synchronous, subscribers run
 * serially in registration order, and a hook may `block` (terminate propagation;
 * event must NOT enter the EventStore, §6.3) or `modify` (patch the payload for
 * later subscribers). It deliberately differs from forgeax-cli's `core/event-bus.ts`,
 * which is the MULTI-AGENT session bus (observer broadcast + per-agent handoff
 * queue routing) and stays in the host (§1). We reuse cli's proven block/sync
 * design and add the `modify` channel the spec requires.
 *
 * `CoreEvent` is payload-agnostic on purpose: the F1 connected-component move
 * (agent loop + its `Event`/`LLMMessage` vocabulary) specializes the payloads
 * without re-shaping the bus.
 */

/** A core runtime event. `type` is the discriminator; `ts` orders the stream;
 *  `blocked`/`blockReason` are bus-managed (set when a hook calls `block`). */
export interface CoreEvent<T = unknown> {
  type: string;
  payload: T;
  ts: number;
  /** Originating agent id / subsystem tag. */
  source?: string;
  /** Bus-managed — true after a hook blocked this event (mirrors cli `isBlocked`). */
  blocked?: boolean;
  /** Bus-managed — reason passed to `block(reason)`. */
  blockReason?: string;
}

/** Per-publish control handed to each subscriber (设计稿 §3.2.1). */
export interface HookControl {
  /** Terminate publish: later subscribers don't run, and the event must not be
   *  persisted (a store-append subscriber registered last is simply skipped). */
  block(reason?: string): void;
  /** Merge a shallow patch into the in-flight event; later subscribers see it.
   *  Returns the merged event. No deep merge. */
  modify(patch: Partial<CoreEvent>): CoreEvent;
}

/** A subscriber. May return a replacement event (equivalent to `ctl.modify`). */
export type EventHandler = (event: CoreEvent, ctl: HookControl) => void | CoreEvent;

export type Unsubscribe = () => void;

/** Subscribe filter: an exact `type` string, `"*"` for all, or a predicate. */
export type EventFilter = string | ((event: CoreEvent) => boolean);

export interface EventBusAPI {
  /** Synchronous. Runs subscribers serially in registration order; returns the
   *  (possibly modified / blocked-flagged) event. */
  publish<E extends CoreEvent>(event: E): E;
  /** Register a subscriber. Registration order = execution order (§6.13). */
  subscribe(filter: EventFilter, handler: EventHandler): Unsubscribe;
}
