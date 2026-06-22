/**
 * Bun unit tests for createWindowTransport — postMessage-bound transport.
 * Uses two FakeWindow instances cross-wired peer-to-peer so we can exercise
 * the host↔plugin handshake without spinning up a real DOM.
 */
import { describe, it, expect } from 'bun:test';
import { createWindowTransport } from '../src/transport-window';

class FakeWindow {
  listeners = new Set<(e: MessageEvent) => void>();
  peer: FakeWindow | null = null;

  addEventListener(_type: string, fn: EventListener): void {
    this.listeners.add(fn as (e: MessageEvent) => void);
  }
  removeEventListener(_type: string, fn: EventListener): void {
    this.listeners.delete(fn as (e: MessageEvent) => void);
  }
  /** Browser semantics: target.postMessage delivers to *target*'s listeners.
   *  We're the target here. .source is the peer (the sender). */
  postMessage(data: unknown, _origin: string): void {
    queueMicrotask(() => {
      const event = { data, origin: 'http://test', source: this.peer } as unknown as MessageEvent;
      for (const l of this.listeners) l(event);
    });
  }
  /** Test helper: synthesize an inbound message with arbitrary source/origin
   *  to simulate spoofing without rewiring peers. */
  injectMessage(data: unknown, source: unknown, origin = 'http://test'): void {
    const event = { data, origin, source } as unknown as MessageEvent;
    for (const l of this.listeners) l(event);
  }
}

function makePair(): [FakeWindow, FakeWindow] {
  const a = new FakeWindow();
  const b = new FakeWindow();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

describe('createWindowTransport', () => {
  it('round-trips messages between two fake windows', async () => {
    const [hostWin, pluginWin] = makePair();
    const hostTransport = createWindowTransport({
      target: pluginWin as unknown as Window,
      targetOrigin: '*',
      expectedSource: () => pluginWin as unknown as Window,
      listenOn: hostWin as unknown as Window,
    });
    const pluginTransport = createWindowTransport({
      target: hostWin as unknown as Window,
      targetOrigin: '*',
      expectedSource: () => hostWin as unknown as Window,
      listenOn: pluginWin as unknown as Window,
    });

    const recvOnPlugin: unknown[] = [];
    const recvOnHost: unknown[] = [];
    pluginTransport.onMessage((m) => recvOnPlugin.push(m));
    hostTransport.onMessage((m) => recvOnHost.push(m));

    // Use real HostSdkEnvelope shapes — the union got narrowed to a fixed
    // discriminated set when the schema landed in @forgeax/types, and the
    // earlier `'hello'` / `'world'` placeholders no longer typecheck.
    // chat.post is the simplest envelope kind for round-trip mock.
    const fromHost = {
      v: 1 as const,
      id: 'h1',
      from: { kind: 'host' as const },
      kind: 'chat.post' as const,
      text: 'hello',
    };
    const fromPlugin = {
      v: 1 as const,
      id: 'p1',
      from: { kind: 'plugin' as const, pluginId: 'test-plugin' },
      kind: 'chat.post' as const,
      text: 'world',
    };
    hostTransport.post(fromHost);
    pluginTransport.post(fromPlugin);
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(recvOnPlugin).toEqual([fromHost]);
    expect(recvOnHost).toEqual([fromPlugin]);

    hostTransport.close();
    pluginTransport.close();
  });

  it('drops messages from unexpected sources', () => {
    const [hostWin, pluginWin] = makePair();
    const stranger = new FakeWindow();
    const t = createWindowTransport({
      target: pluginWin as unknown as Window,
      targetOrigin: '*',
      expectedSource: () => pluginWin as unknown as Window,
      listenOn: hostWin as unknown as Window,
    });
    const got: unknown[] = [];
    t.onMessage((m) => got.push(m));
    hostWin.injectMessage({ payload: 'spoof' }, stranger);
    expect(got).toEqual([]);
    // Sanity: an event from the *expected* source still lands.
    hostWin.injectMessage({ payload: 'real' }, pluginWin);
    expect(got).toEqual([{ payload: 'real' }]);
    t.close();
  });

  it('drops messages from unexpected origins', () => {
    const [hostWin, pluginWin] = makePair();
    const t = createWindowTransport({
      target: pluginWin as unknown as Window,
      targetOrigin: '*',
      expectedOrigin: 'http://test',
      expectedSource: () => pluginWin as unknown as Window,
      listenOn: hostWin as unknown as Window,
    });
    const got: unknown[] = [];
    t.onMessage((m) => got.push(m));
    hostWin.injectMessage({ x: 1 }, pluginWin, 'http://evil.example');
    expect(got).toEqual([]);
    hostWin.injectMessage({ x: 2 }, pluginWin, 'http://test');
    expect(got).toEqual([{ x: 2 }]);
    t.close();
  });

  it('stops delivering after close()', () => {
    const [hostWin, pluginWin] = makePair();
    const t = createWindowTransport({
      target: pluginWin as unknown as Window,
      targetOrigin: '*',
      expectedSource: () => pluginWin as unknown as Window,
      listenOn: hostWin as unknown as Window,
    });
    const got: unknown[] = [];
    t.onMessage((m) => got.push(m));
    t.close();
    hostWin.injectMessage({ a: 1 }, pluginWin);
    expect(got).toEqual([]);
  });
});
