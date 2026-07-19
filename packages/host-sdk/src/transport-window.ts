/**
 * Window-bound Transport using postMessage.
 *
 * Used both:
 *   - on the host side (interface, iframe parent) — `target` = `iframe.contentWindow`,
 *     `expectedSource` = `() => iframe.contentWindow`
 *   - on the plugin side (inside the iframe) — `target` = `window.parent`,
 *     `expectedSource` = `() => window.parent`
 *
 * Origin policy:
 *   - `targetOrigin` is required. Pass `'*'` only in dev; production should
 *     pin to the embedded iframe's origin.
 *   - Inbound messages are filtered by `event.source === expectedSource()` AND
 *     (when set) `event.origin === expectedOrigin`. Anything else is ignored
 *     before we even hand the payload to RpcChannel — wrong-origin chatter is
 *     dropped silently here, malformed envelopes are dropped by the RPC
 *     layer's onInvalid hook.
 */
import type { Transport } from './transport';

export interface WindowTransportOptions {
  /** The window to post outgoing envelopes to. */
  target: Window;
  /** targetOrigin for postMessage. Use '*' only in dev. */
  targetOrigin: string;
  /** Origin we accept inbound messages from. Set to '*' to skip the check. */
  expectedOrigin?: string;
  /** Lazy getter so we can race iframe load. Must equal event.source. */
  expectedSource?: () => Window | null;
  /** The window to listen on. Defaults to globalThis.window. */
  listenOn?: Window;
}

export function createWindowTransport(opts: WindowTransportOptions): Transport {
  const listenOn = opts.listenOn ?? (globalThis as { window?: Window }).window;
  if (!listenOn) {
    throw new Error('createWindowTransport: no window available to listen on');
  }
  let closed = false;
  return {
    post(env) {
      if (closed) return;
      try {
        opts.target.postMessage(env, opts.targetOrigin);
      } catch {
        /* dead iframe — drop */
      }
    },
    onMessage(handler) {
      const listener = (e: MessageEvent) => {
        if (closed) return;
        if (opts.expectedOrigin && opts.expectedOrigin !== '*' && e.origin !== opts.expectedOrigin) {
          return;
        }
        if (opts.expectedSource) {
          const want = opts.expectedSource();
          if (want && e.source !== want) return;
        }
        handler(e.data);
      };
      listenOn.addEventListener('message', listener as EventListener);
      return () => listenOn.removeEventListener('message', listener as EventListener);
    },
    close() {
      closed = true;
    },
  };
}
