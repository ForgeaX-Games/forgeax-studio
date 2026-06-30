/**
 * Phase C1 — agent-runtime contract tests. Drivers register, dispatch,
 * and surface health. The actual implementations land in C2 (forgeax
 * native) and C3 (cli-provider plugin loader).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  registerDriver,
  getDriver,
  listDrivers,
  unregisterDriver,
  bootDriver,
  shutdownDriver,
  isDriverBroken,
  getBrokenReason,
  cancelWithDeadline,
  withTurnTimeout,
  _resetDriverRegistryForTests,
  type Driver,
  type DriverChatStream,
  type ChatEvent,
} from '../src/driver';

function fakeDriver(id: string, opts: Partial<Driver> = {}): Driver {
  return {
    id,
    name: opts.name ?? id,
    selfContained: opts.selfContained ?? false,
    async chat() {
      const events = [{ kind: 'done' as const }];
      return {
        async *[Symbol.asyncIterator]() {
          for (const e of events) yield e;
        },
        async cancel() {},
      };
    },
    async health() {
      return { ok: true, name: id };
    },
    ...opts,
  };
}

beforeEach(() => {
  _resetDriverRegistryForTests();
});

describe('driver registry', () => {
  it('registerDriver / getDriver round-trip', () => {
    const d = fakeDriver('forgeax-native', { selfContained: true });
    registerDriver(d);
    expect(getDriver('forgeax-native')?.id).toBe('forgeax-native');
    expect(getDriver('forgeax-native')?.selfContained).toBe(true);
    expect(getDriver('missing')).toBeNull();
  });

  it('listDrivers returns every registered driver', () => {
    registerDriver(fakeDriver('a'));
    registerDriver(fakeDriver('b'));
    expect(listDrivers().map((d) => d.id).sort()).toEqual(['a', 'b']);
  });

  it('unregisterDriver removes a driver', () => {
    registerDriver(fakeDriver('a'));
    expect(unregisterDriver('a')).toBe(true);
    expect(getDriver('a')).toBeNull();
    expect(unregisterDriver('a')).toBe(false);
  });
});

describe('driver chat / health contract', () => {
  it('chat() streams events to completion', async () => {
    const events: string[] = [];
    const d = fakeDriver('x', {
      async chat() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { kind: 'token', text: 'hi' };
            yield { kind: 'token', text: ' there' };
            yield { kind: 'done' };
          },
          async cancel() {},
        };
      },
    });
    registerDriver(d);
    const stream = await d.chat(
      {
        instanceId: 'i1',
        thread: { id: 't1', cwd: '/tmp' },
        agent: {
          id: 'iori',
          definition: {
            id: 'iori',
            role: 'planner',
            card: { name: { zh: 'I' }, color: '#fff', avatar: '🤖' },
            personaFile: 'p.md',
            defaultLang: 'zh',
            multiInstance: false,
          },
          systemPrompt: '',
          defaultSkills: [],
        },
      },
      { text: 'hello' },
    );
    for await (const ev of stream) {
      if (ev.kind === 'token') events.push(ev.text);
    }
    expect(events).toEqual(['hi', ' there']);
  });

  it('health() reports per-driver status', async () => {
    const d = fakeDriver('h', {
      async health() {
        return { ok: false, name: 'h', detail: 'binary missing' };
      },
    });
    const h = await d.health();
    expect(h).toEqual({ ok: false, name: 'h', detail: 'binary missing' });
  });
});

describe('Doc 05 §7 — driver lifecycle', () => {
  it('bootDriver runs init() and returns null on success', async () => {
    let calls = 0;
    const d = fakeDriver('boot-ok', {
      async init() {
        calls += 1;
      },
    });
    const reason = await bootDriver(d);
    expect(reason).toBeNull();
    expect(calls).toBe(1);
    expect(isDriverBroken('boot-ok')).toBe(false);
    // Driver still routable.
    expect(getDriver('boot-ok')?.id).toBe('boot-ok');
  });

  it('bootDriver marks broken when init() rejects, retains slot', async () => {
    const d = fakeDriver('boot-bad', {
      async init() {
        throw new Error('binary missing');
      },
    });
    const reason = await bootDriver(d);
    expect(reason).toBe('binary missing');
    // Slot retained for the SettingsPanel red-badge UI.
    expect(getDriver('boot-bad')?.id).toBe('boot-bad');
    expect(isDriverBroken('boot-bad')).toBe(true);
    expect(getBrokenReason('boot-bad')).toBe('binary missing');
  });

  it('shutdownDriver invokes shutdown() and drops the slot', async () => {
    let down = 0;
    const d = fakeDriver('teardown', {
      async shutdown() {
        down += 1;
      },
    });
    registerDriver(d);
    await shutdownDriver('teardown');
    expect(down).toBe(1);
    expect(getDriver('teardown')).toBeNull();
  });

  it('shutdownDriver swallows errors but still drops the slot', async () => {
    const d = fakeDriver('teardown-throws', {
      async shutdown() {
        throw new Error('cleanup failed');
      },
    });
    registerDriver(d);
    await shutdownDriver('teardown-throws'); // must not reject
    expect(getDriver('teardown-throws')).toBeNull();
  });

  it('cancelWithDeadline returns forced=true when driver does not ack in time', async () => {
    const stream: DriverChatStream = {
      [Symbol.asyncIterator]() {
        return { next: async () => ({ value: undefined, done: true }) };
      },
      // Never resolves — simulates a hung subprocess.
      cancel: () => new Promise(() => undefined),
    };
    const out = await cancelWithDeadline(stream, 50);
    expect(out.forced).toBe(true);
  });

  it('cancelWithDeadline returns forced=false when driver acks promptly', async () => {
    const stream: DriverChatStream = {
      [Symbol.asyncIterator]() {
        return { next: async () => ({ value: undefined, done: true }) };
      },
      cancel: () => Promise.resolve(),
    };
    const out = await cancelWithDeadline(stream, 5_000);
    expect(out.forced).toBe(false);
  });

  it('withTurnTimeout synthesizes done=timeout when no done arrives', async () => {
    const slow: DriverChatStream = {
      cancel: () => Promise.resolve(),
      [Symbol.asyncIterator]() {
        // Hangs forever — the wrapper must still produce a done.
        return { next: () => new Promise<IteratorResult<ChatEvent>>(() => undefined) };
      },
    };
    const wrapped = withTurnTimeout(slow, 50);
    const out: ChatEvent[] = [];
    for await (const ev of wrapped) {
      out.push(ev);
      if (ev.kind === 'done') break;
    }
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ kind: 'done', reason: 'timeout' });
  });

  it('withTurnTimeout passes through normal completion', async () => {
    const events: ChatEvent[] = [
      { kind: 'token', text: 'hi' },
      { kind: 'done', reason: 'natural' },
    ];
    const stream: DriverChatStream = {
      cancel: () => Promise.resolve(),
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next(): Promise<IteratorResult<ChatEvent>> {
            if (i < events.length) return { value: events[i++], done: false };
            return { value: undefined, done: true };
          },
        };
      },
    };
    const wrapped = withTurnTimeout(stream, 5_000);
    const out: ChatEvent[] = [];
    for await (const ev of wrapped) out.push(ev);
    expect(out).toEqual(events);
  });
});
