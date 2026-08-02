import { describe, expect, test } from 'bun:test';
import {
  NPC_PROTOCOL_VERSION,
  NpcClient,
  type NpcClock,
  type NpcDecision,
  type PerceptionSnapshot,
} from '../src';

const snapshot: PerceptionSnapshot = {
  v: NPC_PROTOCOL_VERSION,
  eventId: 'e1',
  game: 'demo',
  npcId: 'guide',
  t: 1,
  trigger: 'heartbeat',
  self: { pos: { x: 0, y: 0 }, activity: 'idle' },
  nearby: [],
  events: [],
  affordances: [{ action: 'idle' }],
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function session(epoch = 1) {
  return {
    ok: true,
    sessionId: 's',
    token: 'test-token-000000',
    epoch,
    expiresAt: Date.now() + 10_000,
    loaded: [{ npcId: 'guide', soulId: 'demo.guide', trustTier: 'own' }],
    wsUrl: '/api/npc/ws',
  };
}

function decision(seq = 1): NpcDecision {
  return { v: NPC_PROTOCOL_VERSION, npcId: 'guide', seq, intent: { action: 'idle', ttlSec: 10 } };
}

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  readonly #listeners = new Map<string, Array<{ listener: (event: any) => void; once: boolean }>>();

  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push({ listener, once: options?.once === true });
    this.#listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open', {});
  }

  message(data: unknown): void {
    this.emit('message', { data });
  }

  error(): void {
    this.emit('error', {});
  }

  emit(type: string, event: any): void {
    const listeners = this.#listeners.get(type) ?? [];
    this.#listeners.set(type, listeners.filter((entry) => !entry.once));
    for (const { listener } of listeners) listener(event);
  }
}

class FakeClock implements NpcClock {
  time = 0;
  #nextId = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  now(): number { return this.time; }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void { this.#timers.delete(handle as number); }

  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    while (true) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.time = due[1].at;
      this.#timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
    }
    this.time = end;
    await Promise.resolve();
  }
}

function socketFactory() {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: (() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    }) satisfies (url: string) => WebSocket,
  };
}

async function openSocket(client: NpcClient, sockets: FakeSocket[], index = 0): Promise<FakeSocket> {
  const opening = client.connectWebSocket();
  for (let i = 0; i < 20 && !sockets[index]; i++) await Promise.resolve();
  const socket = sockets[index]!;
  socket.open();
  await opening;
  return socket;
}

describe('NpcClient', () => {
  test('sends explicit NPC-to-Soul bindings when the game declares them', async () => {
    let sessionBody: unknown;
    const client = new NpcClient({
      game: 'demo',
      npcIds: ['guide'],
      npcs: [{ npcId: 'guide', soulId: 'demo.guide' }],
      fetcher: (async (url, init) => {
        if (String(url).endsWith('/session')) {
          sessionBody = JSON.parse(String(init?.body));
          return json(session());
        }
        return json({ ok: true, epoch: 1, decision: decision(1) });
      }) as typeof fetch,
    });

    await client.decide(snapshot);
    expect(sessionBody).toEqual({
      game: 'demo',
      npcIds: ['guide'],
      npcs: [{ npcId: 'guide', soulId: 'demo.guide' }],
    });
  });

  test('establishes a capability session and drops duplicate decisions', async () => {
    let chatCalls = 0;
    const client = new NpcClient({
      game: 'demo', npcIds: ['guide'],
      fetcher: (async (url) => {
        if (String(url).endsWith('/session')) return json(session());
        chatCalls++;
        return json({ ok: true, epoch: 1, decision: decision(1) });
      }) as typeof fetch,
    });
    expect((await client.decide(snapshot))?.seq).toBe(1);
    expect(await client.decide({ ...snapshot, eventId: 'e2' })).toBeUndefined();
    expect(chatCalls).toBe(2);
  });

  test('dedupes duplicate in-flight eventId submissions', async () => {
    let chatCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = new NpcClient({
      game: 'demo', npcIds: ['guide'],
      fetcher: (async (url) => {
        if (String(url).endsWith('/session')) return json(session());
        chatCalls++;
        await gate;
        return json({ ok: true, epoch: 1, decision: decision(1) });
      }) as typeof fetch,
    });

    const first = client.decide(snapshot);
    const second = client.decide(snapshot);
    expect(client.isThinking(snapshot.eventId)).toBe(true);
    release();
    expect(await first).toEqual(decision(1));
    expect(await second).toEqual(decision(1));
    expect(chatCalls).toBe(1);
    expect(client.isThinking()).toBe(false);
  });

  test('rejects memory operation leakage and degrades through onFallback', async () => {
    let fallback = '';
    const client = new NpcClient({
      game: 'demo', npcIds: ['guide'], onFallback: (_snapshot, error) => { fallback = error.message; },
      fetcher: (async (url) => String(url).endsWith('/session')
        ? json(session())
        : json({ ok: true, epoch: 1, decision: { v: 1, npcId: 'guide', seq: 1, memoryOps: [] } })) as typeof fetch,
    });
    expect(await client.decide(snapshot)).toBeUndefined();
    expect(fallback).toContain('Unrecognized key');
  });

  test('falls back on the 6s default timeout path', async () => {
    let fallback = '';
    let resolveFetch!: (value: Response) => void;
    const client = new NpcClient({
      game: 'demo', npcIds: ['guide'], onFallback: (_snapshot, error) => { fallback = error.message; },
      fetcher: (async (url, init) => {
        if (String(url).endsWith('/session')) return json(session());
        return await new Promise<Response>((resolve) => {
          resolveFetch = resolve;
          init?.signal?.addEventListener('abort', () => {
            resolve(json({ ok: false, error: init.signal?.reason?.message ?? 'aborted' }, 504));
          }, { once: true });
        });
      }) as typeof fetch,
    });

    expect(await client.decide(snapshot, 1)).toBeUndefined();
    expect(fallback).toBe('NPC decision timeout');
    resolveFetch(json({ ok: true }));
  });

  test('uses permanent pure-static fallback after session connect fails', async () => {
    let sessionCalls = 0;
    const fallbacks: string[] = [];
    const client = new NpcClient({
      game: 'demo', npcIds: ['guide'], onFallback: (_snapshot, error) => { fallbacks.push(error.message); },
      fetcher: (async () => {
        sessionCalls++;
        return json({ ok: false, error: 'Brain unavailable' }, 503);
      }) as unknown as typeof fetch,
    });

    expect(await client.decide(snapshot)).toBeUndefined();
    expect(await client.decide({ ...snapshot, eventId: 'e2' })).toBeUndefined();
    expect(sessionCalls).toBe(1);
    expect(fallbacks).toEqual(['Brain unavailable', 'Brain unavailable']);
  });

  test('speaks canonical snapshot, resume, and session_ready websocket frames', async () => {
    const sockets = socketFactory();
    const client = new NpcClient({
      game: 'demo', npcIds: ['guide'], webSocketFactory: sockets.factory,
      fetcher: (async (url) => String(url).endsWith('/session') ? json(session()) : json({ ok: true })) as typeof fetch,
    });

    await openSocket(client, sockets.sockets);
    sockets.sockets[0]!.message(JSON.stringify({
      type: 'session_ready', v: 1, eventId: 'ready-1', epoch: 1, seq: 1, sessionId: 's', resumeToken: 'resume-token',
    }));
    await client.sendSnapshot(snapshot);
    const sentSnapshot = JSON.parse(sockets.sockets[0]!.sent.at(-1)!);
    expect(sentSnapshot.type).toBe('snapshot');
    expect(sentSnapshot.eventId).toBe(snapshot.eventId);
    expect(sentSnapshot.snapshot.affordances).toEqual(snapshot.affordances);
    expect(sentSnapshot.ack).toBe(1);

    sockets.sockets[0]!.close();
    const reopening = client.connectWebSocket();
    for (let i = 0; i < 20 && !sockets.sockets[1]; i++) await Promise.resolve();
    sockets.sockets[1]!.open();
    await reopening;
    const resume = JSON.parse(sockets.sockets[1]!.sent[0]!);
    expect(resume).toMatchObject({
      type: 'resume',
      sessionId: 's',
      resume: { ack: 1, fromSeq: 2, lastDecisionSeq: {}, token: 'resume-token' },
    });
  });

  test('drops invalid wire frames, stale wire seq, stale decision seq, and memoryOps frames', async () => {
    const accepted: NpcDecision[] = [];
    const sockets = socketFactory();
    const client = new NpcClient({
      game: 'demo', npcIds: ['guide'], webSocketFactory: sockets.factory, onDecision: (value) => accepted.push(value),
      fetcher: (async (url) => String(url).endsWith('/session') ? json(session()) : json({ ok: true })) as typeof fetch,
    });

    await openSocket(client, sockets.sockets);
    sockets.sockets[0]!.message(JSON.stringify({ type: 'hello', v: 1, eventId: 'old', epoch: 1, seq: 1, sessionId: 's' }));
    sockets.sockets[0]!.message(JSON.stringify({
      type: 'decision', v: 1, eventId: 'd1', epoch: 1, seq: 2,
      decision: { ...decision(1), memoryOps: [] },
    }));
    sockets.sockets[0]!.message(JSON.stringify({ type: 'decision', v: 1, eventId: 'd2', epoch: 1, seq: 2, decision: decision(1) }));
    sockets.sockets[0]!.message(JSON.stringify({ type: 'decision', v: 1, eventId: 'd3', epoch: 1, seq: 3, decision: decision(1) }));
    sockets.sockets[0]!.message(JSON.stringify({ type: 'decision', v: 1, eventId: 'd4', epoch: 1, seq: 4, decision: decision(2) }));

    expect(accepted.map((value) => value.seq)).toEqual([1, 2]);
  });

  test('uses one authoritative episode-end transport when websocket is open', async () => {
    const sockets = socketFactory();
    let ended = false;
    const client = new NpcClient({
      game: 'demo', npcIds: ['guide'], webSocketFactory: sockets.factory,
      fetcher: (async (url) => {
        if (String(url).endsWith('/session')) return json(session());
        if (String(url).endsWith('/episode-end')) {
          ended = true;
          return json({ ok: true });
        }
        return json({ ok: true });
      }) as typeof fetch,
    });

    await openSocket(client, sockets.sockets);
    await client.endEpisode();
    expect(ended).toBe(false);
    expect(JSON.parse(sockets.sockets[0]!.sent[0]!)).toMatchObject({ type: 'episode_end', sessionId: 's' });
  });

  test('uses HTTP episode-end when no websocket is open', async () => {
    let ended = false;
    const client = new NpcClient({
      game: 'demo',
      npcIds: ['guide'],
      fetcher: (async (url) => {
        if (String(url).endsWith('/session')) return json(session());
        if (String(url).endsWith('/episode-end')) ended = true;
        return json({ ok: true });
      }) as typeof fetch,
    });
    await client.connect();
    await client.endEpisode();
    expect(ended).toBe(true);
  });

  test('sends deployment-C auth only while minting the session capability', async () => {
    const authorizations: Array<string | null> = [];
    const client = new NpcClient({
      game: 'demo',
      npcIds: ['guide'],
      authToken: 'service-secret',
      fetcher: (async (url, init) => {
        authorizations.push(new Headers(init?.headers).get('authorization'));
        return String(url).endsWith('/session')
          ? json(session())
          : json({ ok: true, epoch: 1, decision: decision(1) });
      }) as typeof fetch,
    });
    await client.decide(snapshot);
    expect(authorizations).toEqual(['Bearer service-secret', 'Bearer test-token-000000']);
  });

  test('sends attach, detach, and snapshot batches and accepts decision and budget batches', async () => {
    const sockets = socketFactory();
    const accepted: NpcDecision[] = [];
    const budgets: unknown[] = [];
    const client = new NpcClient({
      game: 'demo',
      npcIds: ['guide'],
      webSocketFactory: sockets.factory,
      onDecision: (value) => accepted.push(value),
      onBudget: (value) => budgets.push(value),
      fetcher: (async (url) => String(url).endsWith('/session') ? json(session()) : json({ ok: true })) as typeof fetch,
    });

    const socket = await openSocket(client, sockets.sockets);
    await client.attach('merchant', undefined, { soulId: 'demo.merchant' });
    await client.sendSnapshots([
      snapshot,
      { ...snapshot, npcId: 'merchant', eventId: 'merchant-event' },
    ]);
    await client.detach('merchant');

    expect(socket.sent.map((raw) => JSON.parse(raw).type)).toEqual(['attach', 'snapshots', 'detach']);
    socket.message(JSON.stringify({
      type: 'decisions',
      v: 1,
      eventId: 'batch-result',
      epoch: 1,
      seq: 1,
      decisions: [decision(1), { ...decision(1), npcId: 'merchant' }],
    }));
    socket.message(JSON.stringify({
      type: 'budget',
      v: 1,
      eventId: 'budget-1',
      epoch: 1,
      seq: 2,
      budget: { limit: 60, used: 2, remaining: 58 },
    }));

    expect(accepted.map((value) => value.npcId)).toEqual(['guide', 'merchant']);
    expect(budgets).toEqual([{ limit: 60, used: 2, remaining: 58 }]);
  });

  test('uses the canonical resume payload on HTTP resume', async () => {
    let resumeBody: unknown;
    const client = new NpcClient({
      game: 'demo',
      npcIds: ['guide'],
      fetcher: (async (url, init) => {
        if (String(url).endsWith('/session')) return json(session());
        resumeBody = JSON.parse(String(init?.body));
        return json({ ok: true, epoch: 1, reset: false, decisions: [] });
      }) as typeof fetch,
    });
    await client.connect();
    expect(await client.resume()).toEqual({ reset: false });
    expect(resumeBody).toEqual({
      epoch: 1,
      resume: { ack: 0, fromSeq: 1, lastDecisionSeq: {} },
    });
  });

  test('TTL helpers never block the local Body fallback', () => {
    const client = new NpcClient({ game: 'demo', npcIds: ['guide'], now: () => 20_001 });
    expect(client.intentExpired(10_000, { v: 1, npcId: 'guide', seq: 1, intent: { action: 'idle', ttlSec: 10 } })).toBe(true);
  });

  test('automatically expires intents and paces utterances with a fake clock', async () => {
    const clock = new FakeClock();
    const expired: string[] = [];
    const spoken: string[] = [];
    const client = new NpcClient({
      game: 'demo', npcIds: ['guide'], clock, utterancePaceMs: 100,
      onIntentExpired: (npcId) => expired.push(npcId),
      onUtteranceLine: (_npcId, line) => spoken.push(line),
      fetcher: (async (url) => String(url).endsWith('/session')
        ? json({ ...session(), expiresAt: 10_000 })
        : json({
          ok: true, epoch: 1,
          decision: {
            ...decision(1), intent: { action: 'idle', ttlSec: 1 },
            utterance: { lines: ['one', 'two', 'three'] },
          },
        })) as typeof fetch,
    });

    await client.decide(snapshot);
    expect(client.currentIntent('guide')?.action).toBe('idle');
    expect(spoken).toEqual(['one']);
    await clock.advance(200);
    expect(spoken).toEqual(['one', 'two', 'three']);
    await clock.advance(800);
    expect(client.currentIntent('guide')).toBeUndefined();
    expect(expired).toEqual(['guide']);
  });

  test('reconnects with bounded backoff, resumes, and emits heartbeats', async () => {
    const clock = new FakeClock();
    const sockets = socketFactory();
    const client = new NpcClient({
      game: 'demo', npcIds: ['guide'], clock, webSocketFactory: sockets.factory,
      reconnect: { initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 2 }, heartbeatMs: 50,
      fetcher: (async (url) => String(url).endsWith('/session')
        ? json({ ...session(), expiresAt: 10_000 })
        : json({ ok: true })) as typeof fetch,
    });

    await openSocket(client, sockets.sockets);
    sockets.sockets[0]!.message(JSON.stringify({
      type: 'session_ready', v: 1, eventId: 'ready', epoch: 1, seq: 1, sessionId: 's', resumeToken: 'r',
    }));
    sockets.sockets[0]!.close();
    await clock.advance(10);
    expect(sockets.sockets).toHaveLength(2);
    sockets.sockets[1]!.open();
    await Promise.resolve();
    expect(JSON.parse(sockets.sockets[1]!.sent[0]!)).toMatchObject({
      type: 'resume',
      resume: { ack: 1, fromSeq: 2, lastDecisionSeq: {}, token: 'r' },
    });
    await clock.advance(50);
    expect(JSON.parse(sockets.sockets[1]!.sent.at(-1)!)).toMatchObject({ type: 'heartbeat', ack: 1 });
    client.disconnect();
  });

  test('declares generic affordances, feeds emotion back, and dedupes by full event scope', async () => {
    const requests: PerceptionSnapshot[] = [];
    const client = new NpcClient({
      game: 'demo', npcIds: ['guide'], playerId: 'p1',
      fetcher: (async (url, init) => {
        if (String(url).endsWith('/session')) return json(session());
        requests.push(JSON.parse(String(init?.body)));
        return json({
          ok: true, epoch: 1,
          decision: { ...decision(requests.length), emotion: { mood: 'warm', towards: { p1: 0.5 } } },
        });
      }) as typeof fetch,
    });
    client.declareAffordances('guide', [{ action: 'custom_action' }]);

    await client.decide({ ...snapshot, playerId: 'p1' });
    await client.decide({ ...snapshot, eventId: 'e2', playerId: 'p1' });
    expect(requests[0]!.affordances).toEqual([{ action: 'custom_action' }]);
    expect(requests[1]!.self.mood).toBe('warm');
    expect(requests[1]!.recentEvents).toContain('emotion:p1:0.5');
    expect(await client.decide({ ...snapshot, playerId: 'p1' })).toBeUndefined();
    expect(requests).toHaveLength(2);
  });

  test('honors decision batch budgets and prioritizes spotlight NPCs', async () => {
    const seen: string[] = [];
    const client = new NpcClient({
      game: 'demo', npcIds: ['guide', 'merchant'],
      fetcher: (async (url, init) => {
        if (String(url).endsWith('/session')) return json(session());
        const body = JSON.parse(String(init?.body)) as PerceptionSnapshot;
        seen.push(body.npcId);
        return json({ ok: true, epoch: 1, decision: { ...decision(seen.length), npcId: body.npcId } });
      }) as typeof fetch,
    });
    client.promote('merchant');
    await client.decideBatch([
      snapshot,
      { ...snapshot, npcId: 'merchant', eventId: 'merchant-event' },
    ], { maxDecisions: 1, maxConcurrent: 1 });
    expect(seen).toEqual(['merchant']);
  });

  test('supports the PRD static connect and per-NPC callback API', async () => {
    const client = await NpcClient.connect({
      game: 'demo',
      npcIds: ['guide'],
      webSocketFactory: () => { throw new Error('WS unavailable'); },
      fetcher: (async (url) => String(url).endsWith('/session')
        ? json(session())
        : json({ ok: true, epoch: 1, decision: decision(1) })) as typeof fetch,
    });
    const accepted: number[] = [];
    client.onDecision('guide', (value) => accepted.push(value.seq));
    await client.decide(snapshot);
    expect(accepted).toEqual([1]);
  });

  test('keeps low-frequency sampling cadence inside tick', async () => {
    let chatCalls = 0;
    const client = new NpcClient({
      game: 'demo',
      npcIds: ['guide'],
      samplingIntervalMs: 1_000,
      webSocketFactory: () => { throw new Error('WS unavailable'); },
      fetcher: (async (url) => {
        if (String(url).endsWith('/session')) return json(session());
        chatCalls++;
        return json({ ok: true, epoch: 1, decision: decision(chatCalls) });
      }) as typeof fetch,
    });
    client.tick(0.5, () => snapshot);
    await Promise.resolve();
    expect(chatCalls).toBe(0);
    client.tick(0.5, () => snapshot);
    for (let index = 0; index < 20 && chatCalls === 0; index++) await Promise.resolve();
    expect(chatCalls).toBe(1);
  });

  test('samples only explicit spotlight NPCs while ambient and offstage stay Body-only', async () => {
    const sampled: string[] = [];
    const client = new NpcClient({
      game: 'demo',
      npcIds: ['guide', 'merchant', 'crowd'],
      samplingIntervalMs: 1,
      webSocketFactory: () => { throw new Error('WS unavailable'); },
      fetcher: (async (url) => String(url).endsWith('/session')
        ? json(session())
        : json({ ok: true, epoch: 1, decision: decision(1) })) as typeof fetch,
    });
    client.setLod('merchant', 'ambient');
    client.setLod('crowd', 'offstage');
    expect(client.lod('guide')).toBe('spotlight');
    expect(client.lod('merchant')).toBe('ambient');
    expect(client.lod('crowd')).toBe('offstage');
    await client.sampleWorld((npcId) => {
      sampled.push(npcId);
      return { ...snapshot, npcId, eventId: `sample-${npcId}` };
    });
    expect(sampled).toEqual(['guide']);
  });

  test('maps the explicit M0 fallback response to game fallback hooks', async () => {
    const reasons: string[] = [];
    const client = new NpcClient({
      game: 'demo',
      npcIds: ['guide'],
      fetcher: (async (url) => String(url).endsWith('/session')
        ? json(session())
        : json({ ok: true, epoch: 1, fallback: true, reason: 'budget_skip' })) as typeof fetch,
    });
    client.onFallback('guide', (error) => reasons.push(error.message));
    expect(await client.decide(snapshot)).toBeUndefined();
    expect(reasons).toEqual(['budget_skip']);
  });
});
