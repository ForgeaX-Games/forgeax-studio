/**
 * Bun unit tests for @forgeax/host-sdk · A2 验收必跑.
 * Covers: handshake roundtrip · tool.call success+error · surface expose+dispatch · timeout · invalid envelope drop · close cleanup.
 */
import { describe, it, expect } from 'bun:test';
import { createHost, createPluginPort, createMockTransportPair, RpcChannel } from '../src/index';

function pair(initial?: Parameters<typeof createPluginPort>[0]['initial']) {
  const [hostT, pluginT] = createMockTransportPair();
  const port = createPluginPort({
    pluginId: '@forgeax-plugin/test',
    transport: hostT,
    initial,
  });
  const host = createHost({
    pluginId: '@forgeax-plugin/test',
    transport: pluginT,
  });
  return { port, host };
}

describe('handshake', () => {
  it('plugin handshake() resolves with host initial state', async () => {
    const { port, host } = pair({ locale: 'en', theme: 'light', sessionId: 's1' });
    const r = await host.handshake();
    expect(r.kind).toBe('handshake.response');
    expect(r.protocol).toBe(1);
    expect(r.locale).toBe('en');
    expect(r.theme).toBe('light');
    expect(r.ctx?.sessionId).toBe('s1');
    port.close(); host.close();
  });
});

describe('tool.call', () => {
  it('round-trips a successful result', async () => {
    const { port, host } = pair();
    port.onToolCall(async (call) => {
      expect(call.toolId).toBe('character:list');
      return { ok: true, result: { items: ['fox'] } };
    });
    const r = await host.tool.call({
      toolId: 'character:list',
      args: { slug: 'mini-gta' },
      caller: { kind: 'ai' },
    });
    expect(r).toEqual({ ok: true, result: { items: ['fox'] } });
    port.close(); host.close();
  });

  it('round-trips a thrown error as ok:false', async () => {
    const { port, host } = pair();
    port.onToolCall(async () => { throw new Error('boom'); });
    const r = await host.tool.call({
      toolId: 't',
      args: {},
      caller: { kind: 'ai' },
    });
    expect(r).toEqual({ ok: false, error: 'boom' });
    port.close(); host.close();
  });

  it('rejects on timeout when no handler is registered', async () => {
    const { port, host } = pair();
    // No onToolCall handler — host's call will time out.
    let caught: Error | null = null;
    try {
      await host.tool.call({ toolId: 't', args: {}, caller: { kind: 'ai' } }, 30);
    } catch (e) { caught = e as Error; }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/timeout/);
    port.close(); host.close();
  });
});

describe('surface', () => {
  it('expose → host subscribe roundtrip', async () => {
    const { port, host } = pair();
    let received: unknown = null;
    port.surface.subscribe((s) => { received = s; });
    host.surface.expose('wb-test', {
      actions: [
        { id: 'character:list', label: '列表', args: { slug: 'g1' } },
      ],
      snapshot: { selected: null },
    });
    // Wait one microtask for delivery.
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(received).toBeTruthy();
    expect((received as { surfaceId: string }).surfaceId).toBe('wb-test');
    expect((received as { actions: unknown[] }).actions).toHaveLength(1);
    port.close(); host.close();
  });

  it('dispatch → onDispatch → ack roundtrip', async () => {
    const { port, host } = pair();
    host.surface.onDispatch(({ surfaceId, actionId, args }) => {
      return { surfaceId, actionId, echo: args };
    });
    const r = await port.surface.dispatch('wb-test', 'reload', { slug: 'g1' });
    expect(r.ok).toBe(true);
    expect((r.result as { echo: { slug: string } }).echo.slug).toBe('g1');
    port.close(); host.close();
  });

  it('dispatch surfaces handler errors as ok:false', async () => {
    const { port, host } = pair();
    host.surface.onDispatch(() => { throw new Error('nope'); });
    const r = await port.surface.dispatch('wb-test', 'fail');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('nope');
    port.close(); host.close();
  });
});

describe('chat.post', () => {
  it('plugin → host text delivery', async () => {
    const { port, host } = pair();
    let got: { text: string } | null = null;
    port.onChat((e) => { got = e; });
    host.chat.post('做个狐狸立绘', ['/tmp/ref.png']);
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(got).not.toBeNull();
    expect(got!.text).toBe('做个狐狸立绘');
    port.close(); host.close();
  });
});

describe('theme.changed', () => {
  it('host setTheme → plugin subscribers fire', async () => {
    const { port, host } = pair();
    let got: { theme?: string } | null = null;
    host.theme.subscribe((e) => { got = e; });
    port.setTheme({ theme: 'light' });
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(got).not.toBeNull();
    expect(got!.theme).toBe('light');
    port.close(); host.close();
  });
});

describe('ui.flash (Doc 07 §9.2 fx-ai-acting)', () => {
  it('host port.ui.flash → plugin onFlash subscribers fire', async () => {
    const { port, host } = pair();
    const fired: Array<{ surfaceId: string; actionId?: string; cause?: string; durationMs: number }> = [];
    host.ui.onFlash((e) => fired.push(e));
    port.ui.flash({ surfaceId: 'wb-test', actionId: 'character:list', cause: 'ai' });
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(fired.length).toBe(1);
    expect(fired[0].surfaceId).toBe('wb-test');
    expect(fired[0].actionId).toBe('character:list');
    expect(fired[0].cause).toBe('ai');
    // Default duration applied when host omits it.
    expect(fired[0].durationMs).toBe(1500);
    port.close(); host.close();
  });

  it('plugin host.ui.flashElement adds + removes fx-ai-acting class', async () => {
    if (typeof document === 'undefined') return;
    const { port, host } = pair();
    const el = document.createElement('div');
    document.body.appendChild(el);
    host.ui.flashElement(el, 30);
    expect(el.classList.contains('fx-ai-acting')).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(el.classList.contains('fx-ai-acting')).toBe(false);
    el.remove();
    port.close(); host.close();
  });
});

describe('invalid envelope handling', () => {
  it('drops malformed envelopes via onInvalid', async () => {
    const [a, b] = createMockTransportPair();
    const reasons: string[] = [];
    const ch = new RpcChannel({
      transport: a,
      self: { kind: 'host' },
      onInvalid: (_, r) => reasons.push(r),
    });
    // Cast around the type so we can post junk through the mock transport.
    (b as unknown as { post: (e: unknown) => void }).post({ kind: 'totally-bogus' });
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(reasons.length).toBeGreaterThan(0);
    ch.close();
  });
});

describe('close cleanup', () => {
  it('rejects in-flight requests when channel closes', async () => {
    const { port, host } = pair();
    // Start a tool.call but never reply, then close.
    const p = host.tool.call({ toolId: 't', args: {}, caller: { kind: 'ai' } }, 5000);
    host.close();
    let err: Error | null = null;
    try { await p; } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/closed/);
    port.close();
  });
});
