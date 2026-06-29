/**
 * In-memory transport pair for tests. Two ports cross-wired:
 *   const [a, b] = createMockTransportPair();
 *   a.post(env)  -> b's onMessage handlers fire (next microtask)
 */
import type { HostSdkEnvelope } from '@forgeax/types';
import type { Transport } from './transport';

class MockPort implements Transport {
  private peer: MockPort | null = null;
  private handlers = new Set<(env: HostSdkEnvelope) => void>();
  private closed = false;

  setPeer(p: MockPort) { this.peer = p; }

  post(env: HostSdkEnvelope): void {
    if (this.closed) return;
    const peer = this.peer;
    if (!peer) return;
    // Async dispatch like real postMessage — gives the receiver a turn.
    queueMicrotask(() => {
      if (peer.closed) return;
      // Defensive copy via JSON: protects tests from "sender mutates obj after post" bugs.
      const cloned = JSON.parse(JSON.stringify(env)) as HostSdkEnvelope;
      for (const h of [...peer.handlers]) {
        try { h(cloned); } catch { /* tests assert via callback shape; swallow throws */ }
      }
    });
  }

  onMessage(handler: (env: HostSdkEnvelope) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.handlers.clear();
  }
}

export function createMockTransportPair(): [Transport, Transport] {
  const a = new MockPort();
  const b = new MockPort();
  a.setPeer(b);
  b.setPeer(a);
  return [a, b];
}
