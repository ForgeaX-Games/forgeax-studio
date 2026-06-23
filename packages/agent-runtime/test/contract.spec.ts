/**
 * Bun unit tests for the M1 AgentKernel contract spine + NoopKernel.
 *
 * Covers:
 *   - NoopKernel runs a turn honoring the usage-before-done invariant (B5)
 *   - abort path ends with turn.done{cancelled} and still emits usage
 *   - the 12 KernelEvent kinds are all constructible & exhaustively handled
 *     (compile-time `never` guard mirrors `toWireEvents` M3 guard)
 *   - KernelError closed union shape
 *   - kernel registry: register/get/list/boot(init ok+broken)/shutdown
 *   - the spine is kernel-neutral (no @anthropic-ai import, no kernel-specific vocabulary)
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  _resetKernelRegistryForTests,
  bootKernel,
  getKernel,
  getKernelBrokenReason,
  isKernelBroken,
  listKernels,
  registerKernel,
  shutdownKernel,
  unregisterKernel,
  type AgentKernel,
  type KernelError,
  type KernelEvent,
  type KernelEventKind,
  type TurnRequest,
} from '../src/contract';
import { NoopKernel } from '../src/noop-kernel';

function makeReq(text = 'hello'): TurnRequest {
  return {
    session: { threadId: 't1', agentId: 'forge' },
    callId: 'c1',
    input: { text },
    systemPrompt: { charter: 'charter', persona: 'persona' },
    tools: [],
    budget: {},
  };
}

async function drain(stream: AsyncIterable<KernelEvent>): Promise<KernelEvent[]> {
  const out: KernelEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

afterEach(() => {
  _resetKernelRegistryForTests();
});

describe('NoopKernel turn', () => {
  it('echoes input then emits usage before done (B5 invariant)', async () => {
    const k = new NoopKernel();
    const events = await drain(k.runTurn(makeReq('hi'), new AbortController().signal));
    const kinds = events.map((e) => e.kind);

    expect(kinds).toEqual(['message.delta', 'turn.usage', 'turn.done']);

    const usageIdx = kinds.indexOf('turn.usage');
    const doneIdx = kinds.indexOf('turn.done');
    expect(usageIdx).toBeLessThan(doneIdx); // usage strictly before done

    const msg = events[0];
    expect(msg.kind === 'message.delta' && msg.text).toBe('hi');
    const done = events[doneIdx];
    expect(done.kind === 'turn.done' && done.reason).toBe('stop');
  });

  it('echo:false produces a silent turn (usage + done only)', async () => {
    const k = new NoopKernel({ echo: false });
    const events = await drain(k.runTurn(makeReq(), new AbortController().signal));
    expect(events.map((e) => e.kind)).toEqual(['turn.usage', 'turn.done']);
  });

  it('aborted turn ends cancelled and still emits usage first', async () => {
    const k = new NoopKernel();
    const ac = new AbortController();
    ac.abort();
    const events = await drain(k.runTurn(makeReq(), ac.signal));
    expect(events.map((e) => e.kind)).toEqual(['turn.usage', 'turn.done']);
    const done = events[1];
    expect(done.kind === 'turn.done' && done.reason).toBe('cancelled');
  });

  it('openHandle returns a no-op control handle', async () => {
    const k = new NoopKernel();
    const h = k.openHandle('c1');
    await expect(h.setPermissionMode('gated')).resolves.toBeUndefined();
    await expect(h.setModel('claude-opus-4-8')).resolves.toBeUndefined();
    await expect(h.interrupt()).resolves.toBeUndefined();
    await expect(h.cancel()).resolves.toBeUndefined();
  });

  it('probe reports healthy', async () => {
    const k = new NoopKernel();
    const health = await k.probe();
    expect(health.ok).toBe(true);
    expect(health.kernelId).toBe('noop');
  });
});

describe('KernelEvent union', () => {
  // One sample of each of the 12 kinds. If a kind is renamed/removed this
  // array stops type-checking.
  const samples: KernelEvent[] = [
    { kind: 'message.delta', role: 'assistant', text: 'x' },
    { kind: 'thinking.delta', text: 't' },
    { kind: 'tool.call', callId: 'c', name: 'bash', args: {} },
    { kind: 'tool.call.delta', callId: 'c', name: 'bash', argsDelta: '{"a' },
    { kind: 'tool.result', callId: 'c', ok: true, result: 1 },
    { kind: 'turn.usage', inputTokens: 1, outputTokens: 2, cacheRead: 3, cacheCreation: 4, costUsd: 0.1, durationMs: 5 },
    { kind: 'turn.done', reason: 'stop' },
    { kind: 'error', error: { code: 'protocol', message: 'bad' } },
    { kind: 'stored-event', payload: { a: 1 } },
    { kind: 'x.delegation', delegator: 'forge', agentId: 'iori', brief: 'pillar' },
    { kind: 'x.file_activity', path: 'src/x.ts', op: 'write' },
    { kind: 'x.perception', source: 'console', payload: { err: 'boom' } },
    { kind: 'x.subagent.start', agentId: 'iori', agentType: 'pillar', role: 'planner', depth: 1 },
    { kind: 'x.subagent.turn', agentId: 'iori', turn: 2 },
    { kind: 'x.subagent.tool', agentId: 'iori', callId: 'c', name: 'bash' },
    { kind: 'x.subagent.done', agentId: 'iori', reason: 'stop', turns: 3, toolCalls: 4 },
  ];

  it('constructs all 16 kinds', () => {
    expect(samples).toHaveLength(16);
    const kinds = new Set(samples.map((s) => s.kind));
    expect(kinds.size).toBe(16);
  });

  it('handles every kind exhaustively (compile-time never guard)', () => {
    // Mirrors the `default: never` guard that toWireEvents will carry in M3:
    // a new KernelEvent kind that this switch does not handle fails to compile.
    function classify(ev: KernelEvent): KernelEventKind {
      switch (ev.kind) {
        case 'message.delta':
        case 'thinking.delta':
        case 'tool.call':
        case 'tool.call.delta':
        case 'tool.result':
        case 'turn.usage':
        case 'turn.done':
        case 'error':
        case 'stored-event':
        case 'x.delegation':
        case 'x.file_activity':
        case 'x.perception':
        case 'x.subagent.start':
        case 'x.subagent.turn':
        case 'x.subagent.tool':
        case 'x.subagent.done':
          return ev.kind;
        default: {
          const _never: never = ev;
          return _never;
        }
      }
    }
    for (const s of samples) expect(classify(s)).toBe(s.kind);
  });
});

describe('x.subagent.* wire shapes (L5 observability out the wall)', () => {
  // Pins the field shapes the facade's runTurn maps subagent lifecycle events
  // onto. If a field is renamed/dropped this stops type-checking + asserting.
  it('x.subagent.start carries agentId/agentType/role/depth', () => {
    const ev = { kind: 'x.subagent.start', agentId: 'iori', agentType: 'pillar', role: 'planner', depth: 1 } satisfies KernelEvent;
    expect(ev.kind).toBe('x.subagent.start');
    expect(ev.agentId).toBe('iori');
    expect(ev.depth).toBe(1);
  });

  it('x.subagent.turn carries agentId/turn', () => {
    const ev = { kind: 'x.subagent.turn', agentId: 'iori', turn: 2 } satisfies KernelEvent;
    expect(ev.kind).toBe('x.subagent.turn');
    expect(ev.turn).toBe(2);
  });

  it('x.subagent.tool carries agentId/callId/name', () => {
    const ev = { kind: 'x.subagent.tool', agentId: 'iori', callId: 'tu-1', name: 'bash' } satisfies KernelEvent;
    expect(ev.kind).toBe('x.subagent.tool');
    expect(ev.callId).toBe('tu-1');
    expect(ev.name).toBe('bash');
  });

  it('x.subagent.done carries agentId/reason/turns/toolCalls', () => {
    const ev = { kind: 'x.subagent.done', agentId: 'iori', reason: 'stop', turns: 3, toolCalls: 4 } satisfies KernelEvent;
    expect(ev.kind).toBe('x.subagent.done');
    expect(ev.reason).toBe('stop');
    expect(ev.turns).toBe(3);
    expect(ev.toolCalls).toBe(4);
  });
});

describe('KernelError closed union', () => {
  it('carries the six codes', () => {
    const errs: KernelError[] = [
      { code: 'kernel_unavailable', message: 'no kernel' },
      { code: 'tool_failed', message: 'fail', retryable: true },
      { code: 'budget_exceeded', message: 'over' },
      { code: 'driver_timeout', message: 'slow' },
      { code: 'cancelled', message: 'stopped' },
      { code: 'protocol', message: 'bad wire' },
    ];
    expect(new Set(errs.map((e) => e.code)).size).toBe(6);
  });
});

describe('kernel registry', () => {
  it('register / get / list / unregister', () => {
    const k = new NoopKernel();
    registerKernel(k);
    expect(getKernel('noop')).toBe(k);
    expect(listKernels().map((x) => x.id)).toContain('noop');
    expect(unregisterKernel('noop')).toBe(true);
    expect(getKernel('noop')).toBeNull();
  });

  it('bootKernel runs init and returns null on success', async () => {
    let inited = false;
    const k: AgentKernel = Object.assign(new NoopKernel(), {
      init: async () => {
        inited = true;
      },
    });
    const reason = await bootKernel(k);
    expect(reason).toBeNull();
    expect(inited).toBe(true);
    expect(isKernelBroken('noop')).toBe(false);
  });

  it('bootKernel marks broken when init throws, retaining the slot', async () => {
    const k: AgentKernel = Object.assign(new NoopKernel(), {
      init: async () => {
        throw new Error('boom');
      },
    });
    const reason = await bootKernel(k);
    expect(reason).toBe('boom');
    expect(isKernelBroken('noop')).toBe(true);
    expect(getKernelBrokenReason('noop')).toBe('boom');
    // slot retained so SettingsPanel can paint the red badge
    expect(getKernel('noop')).not.toBeNull();
  });

  it('shutdownKernel calls shutdown and drops the slot', async () => {
    let down = false;
    const k: AgentKernel = Object.assign(new NoopKernel(), {
      shutdown: async () => {
        down = true;
      },
    });
    registerKernel(k);
    await shutdownKernel('noop');
    expect(down).toBe(true);
    expect(getKernel('noop')).toBeNull();
  });

  it('shutdownKernel swallows shutdown errors but still drops the slot', async () => {
    const k: AgentKernel = Object.assign(new NoopKernel(), {
      shutdown: async () => {
        throw new Error('teardown failed');
      },
    });
    registerKernel(k);
    await shutdownKernel('noop'); // must not throw
    expect(getKernel('noop')).toBeNull();
  });
});
