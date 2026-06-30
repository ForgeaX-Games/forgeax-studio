/**
 * InProcessScheduler 单测 —— 用 fake spawnFn(吐预设事件的假子 agent)覆盖 HandoffSink 各 intent:
 *   - spawn_child fg → child_result(带收集到的事件)
 *   - spawn_child bg → ack,且后台结果可被 resume_target 取到
 *   - sleep timer → wakeup(短 ms / 真实 setTimeout)
 *   - sleep event → 订阅共享 bus,事件出现后 wakeup
 *   - abort → ack,且子 controller.abort() 被调用(子 run 据 signal 提前结束)
 */
import { describe, expect, test } from 'bun:test';
import type {
  CoreEvent,
  AgentSpec,
  EventBusAPI,
  EventFilter,
  EventHandler,
  Unsubscribe,
  HookControl,
} from '../src/index';

/** 本地最小 EventBus stub —— 仅为测 sleep-event 唤醒;避免 host 测试在运行时加载 core
 *  运行时(与 scheduler 源文件同策略:对 core 仅 type-only 依赖,保持 host 自洽)。 */
class EventBus implements EventBusAPI {
  private subs: Array<{ filter: EventFilter; handler: EventHandler }> = [];
  publish<E extends CoreEvent>(event: E): E {
    for (const s of [...this.subs]) {
      const match =
        typeof s.filter === 'function' ? s.filter(event) : s.filter === '*' || s.filter === event.type;
      if (match) s.handler(event, {} as HookControl);
    }
    return event;
  }
  subscribe(filter: EventFilter, handler: EventHandler): Unsubscribe {
    const entry = { filter, handler };
    this.subs.push(entry);
    return () => {
      this.subs = this.subs.filter((e) => e !== entry);
    };
  }
}
import { InProcessScheduler, type SpawnFn, type SpawnedAgent } from '../src/inject/in-process-scheduler';

/** 造一个吐 N 条预设事件后结束的假子 agent。 */
function fakeAgent(agentId: string, events: CoreEvent[]): SpawnedAgent {
  return {
    agentId,
    async *run() {
      for (const ev of events) yield ev;
    },
  };
}

const ev = (type: string, payload: unknown = null): CoreEvent => ({ type, payload, ts: 0 });

describe('InProcessScheduler', () => {
  test('构造器缺 spawnFn → 抛错(DI 必填)', () => {
    // @ts-expect-error 故意不传 spawnFn
    expect(() => new InProcessScheduler({})).toThrow(/spawnFn/);
  });

  test('spawn_child fg → child_result 带子 agent 全程事件', async () => {
    const spawnFn: SpawnFn = (spec) => fakeAgent(`child:${spec.type}`, [ev('a', 1), ev('b', 2)]);
    const sched = new InProcessScheduler({ spawnFn });
    const spec: AgentSpec = { type: 'worker' };

    const res = await sched.declare({ kind: 'spawn_child', spec, mode: 'fg' });

    expect(res.kind).toBe('child_result');
    if (res.kind !== 'child_result') throw new Error('expected child_result');
    expect(res.events.map((e) => e.type)).toEqual(['a', 'b']);
    expect(res.events[0].payload).toBe(1);
    expect(sched.getPhase('child:worker')).toBe('done');
  });

  test('spawnFn 工厂拿到 ctx(mode + parentId + tree 透传)', async () => {
    let seen: { mode?: string; parentId?: string } = {};
    const spawnFn: SpawnFn = (spec, ctx) => {
      seen = { mode: ctx.mode, parentId: ctx.parentId };
      return fakeAgent(`child:${spec.type}`, [ev('x')]);
    };
    const sched = new InProcessScheduler({ spawnFn, selfAgentId: 'parent-1' });
    await sched.declare({ kind: 'spawn_child', spec: { type: 'w' }, mode: 'fg' });
    expect(seen.mode).toBe('fg');
    expect(seen.parentId).toBe('parent-1');
  });

  test('spawn_child bg → ack;后台结果可被 resume_target 取到', async () => {
    // bg 子 agent:run 里先 await 一个 tick 再吐事件,确保 ack 时还没 done。
    const spawnFn: SpawnFn = (spec): SpawnedAgent => ({
      agentId: `bg:${spec.type}`,
      async *run() {
        await new Promise((r) => setTimeout(r, 5));
        yield ev('bg-done', 'payload');
      },
    });
    const sched = new InProcessScheduler({ spawnFn });

    const ack = await sched.declare({ kind: 'spawn_child', spec: { type: 'worker' }, mode: 'bg' });
    expect(ack.kind).toBe('ack');
    // bg 立即返回 ack 时,子还在 running。
    expect(sched.getPhase('bg:worker')).toBe('running');

    // resume_target await 其结果(后台跑完)→ child_result。
    const res = await sched.declare({ kind: 'resume_target', agentId: 'bg:worker' });
    expect(res.kind).toBe('child_result');
    if (res.kind !== 'child_result') throw new Error('expected child_result');
    expect(res.events.map((e) => e.type)).toEqual(['bg-done']);
    expect(res.events[0].payload).toBe('payload');
    expect(sched.getPhase('bg:worker')).toBe('done');
  });

  test('resume_target:已 done 的 bg 直接返回缓存结果', async () => {
    const spawnFn: SpawnFn = (spec) => fakeAgent(`bg:${spec.type}`, [ev('cached')]);
    const sched = new InProcessScheduler({ spawnFn });
    await sched.declare({ kind: 'spawn_child', spec: { type: 'w' }, mode: 'bg' });
    // 让后台 settle 完成。
    await new Promise((r) => setTimeout(r, 5));
    expect(sched.getPhase('bg:w')).toBe('done');

    const res = await sched.declare({ kind: 'resume_target', agentId: 'bg:w' });
    expect(res.kind).toBe('child_result');
    if (res.kind !== 'child_result') throw new Error('expected child_result');
    expect(res.events.map((e) => e.type)).toEqual(['cached']);
  });

  test('resume_target:目标不存在 → ack(不抛)', async () => {
    const spawnFn: SpawnFn = (spec) => fakeAgent(spec.type, []);
    const sched = new InProcessScheduler({ spawnFn });
    const res = await sched.declare({ kind: 'resume_target', agentId: 'nope' });
    expect(res.kind).toBe('ack');
  });

  test('sleep timer → wakeup(trigger.eventType=timer)', async () => {
    const spawnFn: SpawnFn = (spec) => fakeAgent(spec.type, []);
    const sched = new InProcessScheduler({ spawnFn });

    const t0 = Date.now();
    const res = await sched.declare({ kind: 'sleep', until: { kind: 'timer', ms: 20 } });
    const elapsed = Date.now() - t0;

    expect(res.kind).toBe('wakeup');
    if (res.kind !== 'wakeup') throw new Error('expected wakeup');
    expect(res.trigger.eventType).toBe('timer');
    expect(elapsed).toBeGreaterThanOrEqual(15); // 真实定时器到点才唤醒
  });

  test('sleep event → 订阅共享 bus,事件出现后 wakeup(带 payload)', async () => {
    const bus = new EventBus();
    const spawnFn: SpawnFn = (spec) => fakeAgent(spec.type, []);
    const sched = new InProcessScheduler({ spawnFn, bus });

    const sleepP = sched.declare({ kind: 'sleep', until: { kind: 'event', eventType: 'hmr.done' } });
    // 异步发事件唤醒。
    setTimeout(() => bus.publish(ev('hmr.done', { ok: true })), 5);

    const res = await sleepP;
    expect(res.kind).toBe('wakeup');
    if (res.kind !== 'wakeup') throw new Error('expected wakeup');
    expect(res.trigger.eventType).toBe('hmr.done');
    expect(res.trigger.payload).toEqual({ ok: true });
  });

  test('sleep event 无 bus → 退化为 ack(不 hang)', async () => {
    const spawnFn: SpawnFn = (spec) => fakeAgent(spec.type, []);
    const sched = new InProcessScheduler({ spawnFn }); // 无 bus
    const res = await sched.declare({ kind: 'sleep', until: { kind: 'event', eventType: 'x' } });
    expect(res.kind).toBe('ack');
  });

  test('abort → ack,且子 controller.abort() 被调用(子 run 据 signal 提前结束)', async () => {
    let abortedSignalSeen = false;
    // 子 run 跑一个长循环,直到 signal aborted。
    const spawnFn: SpawnFn = (spec): SpawnedAgent => ({
      agentId: `child:${spec.type}`,
      async *run(signal: AbortSignal) {
        for (let i = 0; i < 1000; i++) {
          if (signal.aborted) {
            abortedSignalSeen = true;
            return; // 据 signal 提前结束
          }
          await new Promise((r) => setTimeout(r, 5));
          yield ev(`tick-${i}`);
        }
      },
    });
    const sched = new InProcessScheduler({ spawnFn });

    // 起一个 bg 子(不阻塞),让它跑起来。
    await sched.declare({ kind: 'spawn_child', spec: { type: 'worker' }, mode: 'bg' });
    expect(sched.getPhase('child:worker')).toBe('running');

    // abort → 应 ack 并把 running 子标 aborted + 触发其 signal。
    const res = await sched.declare({ kind: 'abort', reason: 'user-cancel' });
    expect(res.kind).toBe('ack');
    expect(sched.getPhase('child:worker')).toBe('aborted');

    // 给子 run 一点时间观察到 signal。
    await new Promise((r) => setTimeout(r, 15));
    expect(abortedSignalSeen).toBe(true);
  });

  test('pop_self → ack(进程内 MVP 下父子由 fg-await / resume 直接取结果)', async () => {
    const spawnFn: SpawnFn = (spec) => fakeAgent(spec.type, []);
    const sched = new InProcessScheduler({ spawnFn });
    const res = await sched.declare({ kind: 'pop_self', result: { ok: 1 } });
    expect(res.kind).toBe('ack');
  });

  test('listAgents 反映注册表内容', async () => {
    const spawnFn: SpawnFn = (spec) => fakeAgent(`child:${spec.type}`, [ev('z')]);
    const sched = new InProcessScheduler({ spawnFn });
    await sched.declare({ kind: 'spawn_child', spec: { type: 'a' }, mode: 'fg' });
    await sched.declare({ kind: 'spawn_child', spec: { type: 'b' }, mode: 'fg' });
    expect(sched.listAgents().sort()).toEqual(['child:a', 'child:b']);
  });
});
