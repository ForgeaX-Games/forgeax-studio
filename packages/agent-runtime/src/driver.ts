/**
 * Driver contract — each cli-provider implementation (codex / cursor /
 * forgeax-native) ships one. The runtime owns the
 * Session lifecycle; the driver owns "send these messages, stream
 * tokens back, surface tool calls."
 *
 * This is the C1 lock-in shape. Existing cli daemon code in
 * `packages/cli/src/instance/` will be re-cast to fit this in C2/C3.
 */
import type { Session } from './session';

export interface ChatTurnRequest {
  /** User text or rich content. Drivers that don't speak rich content
   *  should fall back to the .text field. */
  text: string;
  /** Optional structured attachments — image refs, files, etc. The
   *  shape stays open; drivers MUST tolerate unknown keys (forward-compat). */
  attachments?: Array<Record<string, unknown>>;
  /** Per-turn abort signal. Drivers must propagate to underlying fetch. */
  signal?: AbortSignal;
}

export type ChatEvent =
  | { kind: 'token'; text: string }
  | { kind: 'tool-call'; id: string; name: string; args: unknown }
  | { kind: 'tool-result'; id: string; result: unknown }
  | { kind: 'usage'; promptTokens?: number; completionTokens?: number; totalTokens?: number }
  | { kind: 'error'; message: string; recoverable: boolean }
  | { kind: 'done'; reason?: string };

export interface DriverChatStream {
  /** AsyncIterable of chat events. Closes when the turn is done. */
  [Symbol.asyncIterator](): AsyncIterator<ChatEvent>;
  /** Force cancellation outside the AbortSignal path. */
  cancel(): Promise<void>;
}

export interface DriverHealth {
  ok: boolean;
  /** `name` matches the Driver's `id`. */
  name: string;
  /** Free-form details for the SettingsPanel `CLI Providers` row.
   *  Examples: "cli version 2.1.4", "litellm proxy reachable". */
  detail?: string;
}

export interface Driver {
  /** Stable id (matches plugin id when shipped as plugin). */
  id: string;
  /** Display label for the SettingsPanel · CLI Providers list. */
  name: string;
  /** True if the driver can run without any external CLI binary. The
   *  forgeax-native driver returns true; codex/cursor false. */
  selfContained: boolean;
  /** Doc 05 §7 — optional one-shot init. Called once at registration via
   *  `bootDriver()`; throwing/rejecting marks the driver `broken`, the
   *  registry retains the metadata so SettingsPanel can paint a red badge,
   *  and any agent that resolves to it gets a graceful boot warning instead
   *  of routing the turn. Drivers that need no init may omit. */
  init?(): Promise<void>;
  /** Doc 05 §7 — optional teardown. Called from `shutdownDriver()` /
   *  `_resetDriverRegistryForTests()`. Drivers that hold subprocess handles
   *  should kill them here. Errors are swallowed; the registry slot still
   *  goes away. */
  shutdown?(): Promise<void>;
  /** Open a chat turn. Driver returns a stream of ChatEvents.
   *  Must propagate `req.signal` aborts. */
  chat(session: Session, req: ChatTurnRequest): Promise<DriverChatStream>;
  /** Lightweight readiness probe — invoked by SettingsPanel and `/api/cli`
   *  health endpoint. Should not raise; map failure to `{ok:false, detail}`. */
  health(): Promise<DriverHealth>;
}

// ─── In-process driver registry ─────────────────────────────────────
// The server registers drivers at boot (forgeax-native first; the rest
// load via cli-provider KindLoader in C3). This module owns the map so
// every consumer (sessions, /api/cli, SettingsPanel) reads the same
// snapshot.

interface DriverSlot {
  driver: Driver;
  /** Doc 05 §7 — when `init()` rejects, the slot stays so SettingsPanel can
   *  paint a red badge with the reason; routing must consult `isDriverBroken`
   *  before dispatching. */
  brokenReason?: string;
}

const _drivers = new Map<string, DriverSlot>();

export function registerDriver(d: Driver): void {
  _drivers.set(d.id, { driver: d });
}

export function unregisterDriver(id: string): boolean {
  return _drivers.delete(id);
}

export function getDriver(id: string): Driver | null {
  return _drivers.get(id)?.driver ?? null;
}

export function listDrivers(): Driver[] {
  return Array.from(_drivers.values()).map((s) => s.driver);
}

/** Doc 05 §7 — boot a driver: run `init()` if present, mark broken on
 *  failure. Returns the broken reason on failure, null on success. Always
 *  registers the driver first so SettingsPanel can render the row even when
 *  init fails. */
export async function bootDriver(d: Driver): Promise<string | null> {
  registerDriver(d);
  if (!d.init) return null;
  try {
    await d.init();
    return null;
  } catch (e) {
    const reason = (e as Error).message ?? String(e);
    const slot = _drivers.get(d.id);
    if (slot) slot.brokenReason = reason;
    return reason;
  }
}

/** Doc 05 §7 — call shutdown() if present, swallow errors, drop the slot. */
export async function shutdownDriver(id: string): Promise<void> {
  const slot = _drivers.get(id);
  if (!slot) return;
  try {
    await slot.driver.shutdown?.();
  } catch {
    // intentionally swallowed — registry must always release the slot
  }
  _drivers.delete(id);
}

/** Doc 05 §7 — broken state query. Routing layers must check this before
 *  dispatching a chat turn. */
export function isDriverBroken(id: string): boolean {
  return Boolean(_drivers.get(id)?.brokenReason);
}

export function getBrokenReason(id: string): string | null {
  return _drivers.get(id)?.brokenReason ?? null;
}

/** Doc 05 §7 — `cancel` 不响应 → 8s 后 force kill. Wraps a stream's
 *  `cancel()` with a deadline; if the driver doesn't ack within `forceMs`
 *  we resolve and let the caller move on. The driver-side actual force-kill
 *  (e.g. `child.kill('SIGKILL')`) is implementation-specific; this helper
 *  only bounds the host-side wait so the UI doesn't hang. */
export async function cancelWithDeadline(
  stream: DriverChatStream,
  forceMs = 8_000,
): Promise<{ forced: boolean }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const forced = new Promise<{ forced: true }>((resolve) => {
    timer = setTimeout(() => resolve({ forced: true }), forceMs);
  });
  const acked = stream.cancel().then(() => ({ forced: false }));
  const winner = await Promise.race([acked, forced]);
  if (timer) clearTimeout(timer);
  return winner;
}

/** Doc 05 §7 — driver 不返回 `done` event | TurnAccumulator timeout 60s, 自合
 *  done. Wraps a DriverChatStream so consumers always observe a terminal
 *  event within `timeoutMs`. The original stream's iterator is drained in
 *  the background; if no `done`/`error` arrives in time we synthesize a
 *  `done` with reason='timeout'. */
export function withTurnTimeout(
  stream: DriverChatStream,
  timeoutMs = 60_000,
): DriverChatStream {
  return {
    cancel: () => stream.cancel(),
    [Symbol.asyncIterator]() {
      const inner = stream[Symbol.asyncIterator]();
      let timedOut = false;
      let finished = false;
      return {
        async next() {
          if (finished) return { value: undefined, done: true };
          let timer: ReturnType<typeof setTimeout> | null = null;
          const timeout = new Promise<{ value: ChatEvent; done: false }>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve({ value: { kind: 'done', reason: 'timeout' }, done: false });
            }, timeoutMs);
          });
          const winner = await Promise.race([inner.next(), timeout]);
          if (timer) clearTimeout(timer);
          if (timedOut) {
            finished = true;
            // Best-effort cancel — caller already saw a synthetic done.
            void stream.cancel().catch(() => undefined);
            return { value: { kind: 'done', reason: 'timeout' } as ChatEvent, done: false };
          }
          if (winner.done) finished = true;
          else if (winner.value.kind === 'done' || winner.value.kind === 'error') finished = true;
          return winner;
        },
        async return() {
          finished = true;
          await inner.return?.();
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/** Test helper — reset the driver registry between cases. Calls shutdown()
 *  on each slot best-effort. */
export function _resetDriverRegistryForTests(): void {
  for (const slot of _drivers.values()) {
    try {
      void slot.driver.shutdown?.();
    } catch {
      // swallow
    }
  }
  _drivers.clear();
}
