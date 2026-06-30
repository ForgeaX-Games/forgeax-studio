/**
 * History 补验证用例 —— InMemoryEventStore(WAL no-injection 默认)+ connectStore 接线。
 *
 * 覆盖 history/event-store.ts 未覆盖点:
 *   - InMemoryEventStore.read(from / limit / from+limit / 无 opts)的切片语义;
 *   - snapshot 拷贝(返回独立数组,不暴露内部引用);
 *   - connectStore:每条 published、非 blocked 事件按序入 store;blocked 事件
 *     (block 终止传播,store-append 订阅最后注册被天然跳过)不入 store;
 *   - connectStore:store.append 抛错被吞(rejected append 不破坏同步 publish)。
 *
 * message-log / WAL 也是「block 不落盘 + append 失败不阻断
 * 主链路」。Boundary: 仅 core 相对 import + node:。
 */
import { test, expect, describe } from 'bun:test';
import { InMemoryEventStore, connectStore } from '../src/history/event-store';
import { EventBus } from '../src/events/event-bus';
import type { CoreEvent } from '../src/events/types';
import type { EventStore } from '../src/inject/types';

// ─── helpers ─────────────────────────────────────────────────────────────────

function ev(type: string, n: number): CoreEvent {
  return { type, payload: { n }, ts: n };
}

async function collect(it: AsyncIterable<CoreEvent>): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ─── InMemoryEventStore.read — slice semantics ─────────────────────────────────

describe('InMemoryEventStore.read — from/limit slicing', () => {
  async function seeded(): Promise<InMemoryEventStore> {
    const s = new InMemoryEventStore();
    await s.append([ev('a', 0), ev('b', 1), ev('c', 2), ev('d', 3)]);
    return s;
  }

  test('no opts → all events in append order', async () => {
    const s = await seeded();
    const got = await collect(s.read());
    expect(got.map((e) => e.type)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('from offset → tail slice', async () => {
    const s = await seeded();
    const got = await collect(s.read({ from: 2 }));
    expect(got.map((e) => e.type)).toEqual(['c', 'd']);
  });

  test('limit only → head slice', async () => {
    const s = await seeded();
    const got = await collect(s.read({ limit: 2 }));
    expect(got.map((e) => e.type)).toEqual(['a', 'b']);
  });

  test('from + limit → windowed slice', async () => {
    const s = await seeded();
    const got = await collect(s.read({ from: 1, limit: 2 }));
    expect(got.map((e) => e.type)).toEqual(['b', 'c']);
  });

  test('non-numeric from (string id, unsupported) falls back to 0', async () => {
    const s = await seeded();
    const got = await collect(s.read({ from: 'some-id' }));
    expect(got.map((e) => e.type)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('from beyond length → empty', async () => {
    const s = await seeded();
    const got = await collect(s.read({ from: 99 }));
    expect(got).toEqual([]);
  });

  test('append is additive (multiple calls accumulate in order)', async () => {
    const s = new InMemoryEventStore();
    await s.append([ev('x', 0)]);
    await s.append([ev('y', 1), ev('z', 2)]);
    const got = await collect(s.read());
    expect(got.map((e) => e.type)).toEqual(['x', 'y', 'z']);
  });
});

// ─── snapshot — independent copy ───────────────────────────────────────────────

describe('InMemoryEventStore.snapshot', () => {
  test('returns the events in order', async () => {
    const s = new InMemoryEventStore();
    await s.append([ev('a', 0), ev('b', 1)]);
    expect(s.snapshot().map((e) => e.type)).toEqual(['a', 'b']);
  });

  test('returns a copy: mutating the snapshot does not affect the store', async () => {
    const s = new InMemoryEventStore();
    await s.append([ev('a', 0)]);
    const snap = s.snapshot();
    snap.push(ev('injected', 9));
    expect(s.snapshot().map((e) => e.type)).toEqual(['a']); // store unchanged
  });
});

// ─── connectStore — bus wiring ─────────────────────────────────────────────────

describe('connectStore — bus → store append', () => {
  test('published non-blocked events land in the store in order', async () => {
    const bus = new EventBus();
    const store = new InMemoryEventStore();
    connectStore(bus, store);

    bus.publish(ev('one', 0));
    bus.publish(ev('two', 1));
    await flush(); // append is fire-and-forget

    expect(store.snapshot().map((e) => e.type)).toEqual(['one', 'two']);
  });

  test('blocked events do NOT enter the store (store sub registered last is skipped)', async () => {
    const bus = new EventBus();
    const store = new InMemoryEventStore();
    // gate registered FIRST, blocks "secret"; store sub registered LAST via connectStore.
    bus.subscribe('*', (e, ctl) => {
      if (e.type === 'secret') ctl.block('redacted');
    });
    connectStore(bus, store);

    bus.publish(ev('public', 0));
    const blocked = bus.publish(ev('secret', 1));
    await flush();

    expect(blocked.blocked).toBe(true);
    expect(store.snapshot().map((e) => e.type)).toEqual(['public']);
  });

  test('unsubscribe handle stops further appends', async () => {
    const bus = new EventBus();
    const store = new InMemoryEventStore();
    const off = connectStore(bus, store);

    bus.publish(ev('before', 0));
    await flush();
    off();
    bus.publish(ev('after', 1));
    await flush();

    expect(store.snapshot().map((e) => e.type)).toEqual(['before']);
  });

  test('store.append rejection is swallowed — publish path stays intact', async () => {
    const bus = new EventBus();
    let calls = 0;
    const flaky: EventStore = {
      async append(): Promise<void> {
        calls++;
        throw new Error('disk full');
      },
    };
    // capture stderr so the swallowed error does not pollute test output.
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = (chunk: string) => {
      captured.push(String(chunk));
      return true;
    };
    try {
      connectStore(bus, flaky);
      // publish must NOT throw even though append rejects.
      const out = bus.publish(ev('boom', 0));
      expect(out.type).toBe('boom');
      await flush();
    } finally {
      process.stderr.write = origWrite;
    }
    expect(calls).toBe(1);
    expect(captured.join('')).toContain('append failed');
  });

  test('store.append that throws synchronously is also swallowed', async () => {
    const bus = new EventBus();
    const syncThrow: EventStore = {
      append(): Promise<void> {
        throw new Error('sync boom');
      },
    };
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      connectStore(bus, syncThrow);
      // A synchronous throw escapes Promise.resolve(store.append(...)), but the
      // EventBus catches subscriber errors → publish still does not throw.
      expect(() => bus.publish(ev('boom2', 0))).not.toThrow();
      await flush();
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
