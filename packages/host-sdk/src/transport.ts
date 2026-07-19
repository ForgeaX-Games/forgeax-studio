/**
 * Abstract transport — anything that can post + receive HostSdkEnvelope objects.
 *
 * Real-world impl in `transport-window.ts` wraps window.postMessage; the
 * `transport-mock.ts` impl wires two ports together for tests; future SharedWorker
 * or BroadcastChannel impls can plug in the same shape.
 */
import type { HostSdkEnvelope } from '@forgeax/types';

export interface Transport {
  /** Send one envelope. May throw synchronously if the underlying channel is dead. */
  post(env: HostSdkEnvelope): void;
  /** Subscribe to inbound envelopes. Returns an unsubscribe fn. */
  onMessage(handler: (env: HostSdkEnvelope) => void): () => void;
  /** Free resources. After close(), post()/onMessage() are no-ops. */
  close(): void;
}
