/**
 * InProcessScheduler —— forgeax-core `HandoffSink` 契约的进程内(in-process)MVP 调度器。
 *
 * core 只**声明意图**(`HandoffSink.declare(intent)` —— spawn_child / pop_self / sleep /
 * resume_target / abort),调度器**决定何时执行 / 唤醒**,并把结果折回给 core。所有子
 * agent 都在**同一进程内**跑(forgeax-core `--serve` 子进程内),没有 tmux / detached /
 * SSE 后端。
 *
 * 归属(R3 内核归一):本调度器**从 agent-host 搬进 core**——它只做「注册 / 起停 / 收集
 * 事件 / 唤醒」的状态机,依赖全是 core 类型,且消费方(forgeax-core `--serve`)在 core 内。
 * agent-host 不再持有它(断 host→core 依赖)。
 *
 * 设计原则:
 *   - **依赖注入**:scheduler 不知道怎么把 `AgentSpec` 变成可跑 CoreAgent —— 由构造器传入
 *     `spawnFn` 工厂。provider / 工具集 / model 一律由工厂闭包决定(零硬编码)。
 *   - **进程内**:fg 子 agent 同步跑到 done 收集事件;bg 子 agent 后台跑、结果存注册表;
 *     sleep timer 用 `setTimeout`;sleep event 订阅注入的共享 bus 等事件出现。
 *   - **无 core 侧超时**:host 永不 resolve 是 host 的 SLA 问题;本实现总会 resolve。
 *
 * Boundary: 仅 core 相对 type-only import(inject 类型 + events 类型)。
 */
import type {
  HandoffSink,
  HandoffIntent,
  HandoffResolution,
  AgentSpec,
  TreeAccess,
  WakeupTrigger,
  SleepCondition,
} from './types';
import type { CoreEvent, EventBusAPI } from '../events/types';

/** 一个被实例化、可跑的子 agent —— spawnFn 的返回。 */
export interface SpawnedAgent {
  /** 子 agent 的 id(scheduler 用它做注册表 key / resume_target 寻址)。 */
  agentId: string;
  /**
   * 跑子 agent loop,逐条吐出 `CoreEvent`。scheduler 会消费到流结束(= 子 done),
   * 把全程事件收集成 `events` 数组用作 `child_result`。
   * 传入的 `signal` 用于 abort:abort 时 scheduler 调用对应 controller.abort()。
   */
  run(signal: AbortSignal): AsyncIterable<CoreEvent>;
}

/** spawnFn 工厂的上下文 —— 让工厂能拿到拓扑 / 父子关系等(只读)。 */
export interface SpawnContext {
  /** 发起 spawn 的父 agent id(若已知)。 */
  parentId?: string;
  /** fg / bg —— 工厂可据此决定 model / budget 等(本 MVP 仅透传)。 */
  mode: 'fg' | 'bg';
  /** agent 树拓扑只读视图(若注入)。 */
  tree?: TreeAccess;
}

/**
 * 「把 AgentSpec 实例化成可跑 CoreAgent」的工厂。**核心注入点**。
 * 由构造器传入 —— scheduler 不碰 provider / 工具 / model,全在此闭包里决定。
 */
export type SpawnFn = (spec: AgentSpec, ctx: SpawnContext) => SpawnedAgent | Promise<SpawnedAgent>;

/** 注册表里一个 agent 的运行态(状态机:running → done | aborted)。 */
export type AgentPhase = 'running' | 'done' | 'aborted';

type RunState =
  | { phase: 'running'; controller: AbortController }
  | { phase: 'done'; events: CoreEvent[] }
  | { phase: 'aborted'; reason: string };

interface RegistryEntry {
  agentId: string;
  mode: 'fg' | 'bg';
  state: RunState;
  /** running → 完成后 resolve 出收集到的事件;resume_target 在结果就绪前 await 它。 */
  resultPromise: Promise<CoreEvent[]>;
}

export interface InProcessSchedulerOpts {
  /** **必填**:把 AgentSpec 实例化成可跑 CoreAgent 的工厂(DI 注入点)。 */
  spawnFn: SpawnFn;
  /** 可选:agent 树拓扑只读视图(透传给 spawnFn ctx,并用于 parentId 推断)。 */
  tree?: TreeAccess;
  /**
   * 可选:共享 EventBus —— `sleep:{kind:'event'}` 在此订阅等待某事件类型出现后唤醒。
   * 不注入时,event-sleep 退化为「立即 ack」(host SLA;调用方应注入 bus 才用 event-sleep)。
   */
  bus?: EventBusAPI;
  /** 可选:发起 declare 的 agent id —— 多数 intent(pop_self/sleep/abort)针对「自己」。 */
  selfAgentId?: string;
}

/**
 * 进程内 HandoffSink 调度器。一个实例服务「一个发起 declare 的 core agent」(它的 self),
 * 但其注册表可容纳该 agent 派生的多个子 agent(fg/bg)。
 */
export class InProcessScheduler implements HandoffSink {
  private readonly spawnFn: SpawnFn;
  private readonly tree?: TreeAccess;
  private readonly bus?: EventBusAPI;
  private readonly selfAgentId?: string;

  /** agentId → 运行态。 */
  private readonly registry = new Map<string, RegistryEntry>();

  constructor(opts: InProcessSchedulerOpts) {
    if (typeof opts.spawnFn !== 'function') {
      throw new Error('InProcessScheduler: spawnFn (factory) is required');
    }
    this.spawnFn = opts.spawnFn;
    this.tree = opts.tree;
    this.bus = opts.bus;
    this.selfAgentId = opts.selfAgentId;
  }

  /** core 声明意图 —— host 决定执行/唤醒,折回 resolution。 */
  async declare(intent: HandoffIntent): Promise<HandoffResolution> {
    switch (intent.kind) {
      case 'spawn_child':
        return this.handleSpawnChild(intent.spec, intent.mode);
      case 'resume_target':
        return this.handleResumeTarget(intent.agentId);
      case 'sleep':
        return this.handleSleep(intent.until);
      case 'abort':
        return this.handleAbort(intent.reason);
      case 'pop_self':
        // pop_self:当前 agent 自我弹栈(把 result 交还父)。进程内 MVP 下父子是直接 await
        // 关系(fg)或注册表取值(bg),scheduler 本身无需额外动作 —— 直接 ack,
        // 由父侧的 spawn_child(fg)await / resume_target(bg)拿结果。
        return { kind: 'ack' };
      default: {
        // 穷尽性兜底:未知 intent.kind 视为 ack(forward-compat,§4.2 shape stays open)。
        const _exhaustive: never = intent;
        void _exhaustive;
        return { kind: 'ack' };
      }
    }
  }

  // ─── spawn_child ─────────────────────────────────────────────────────────

  private async handleSpawnChild(spec: AgentSpec, mode: 'fg' | 'bg'): Promise<HandoffResolution> {
    const ctx: SpawnContext = { parentId: this.selfAgentId, mode, tree: this.tree };
    const spawned = await this.spawnFn(spec, ctx);
    const controller = new AbortController();

    // 收集子 agent 全程事件(跑到流结束 = 子 done)。
    const collect = this.runAndCollect(spawned, controller);

    const entry: RegistryEntry = {
      agentId: spawned.agentId,
      mode,
      state: { phase: 'running', controller },
      resultPromise: collect,
    };
    this.registry.set(spawned.agentId, entry);

    if (mode === 'fg') {
      // fg:同步跑到 done,收集事件,直接返回 child_result(父阻塞等子)。
      try {
        const events = await collect;
        this.settleDone(entry, events);
        return { kind: 'child_result', events };
      } catch (err) {
        // 子被 abort(或抛错)→ 标记 aborted,仍返回已收集的(空)事件,父不崩。
        this.settleAborted(entry, err);
        return { kind: 'child_result', events: [] };
      }
    }

    // bg:注册后台运行,立即 ack;完成后把结果存注册表供 resume_target / wakeup 取。
    void collect.then(
      (events) => this.settleDone(entry, events),
      (err) => this.settleAborted(entry, err),
    );
    return { kind: 'ack' };
  }

  /** 跑 spawned.run() 收集事件;abort 时 run 应据 signal 提前结束。 */
  private async runAndCollect(spawned: SpawnedAgent, controller: AbortController): Promise<CoreEvent[]> {
    const events: CoreEvent[] = [];
    for await (const ev of spawned.run(controller.signal)) {
      events.push(ev);
    }
    return events;
  }

  /** running → done(若已 settle 过则不覆盖,如先被 abort)。 */
  private settleDone(entry: RegistryEntry, events: CoreEvent[]): void {
    if (entry.state.phase === 'running') entry.state = { phase: 'done', events };
  }

  /** running → aborted。 */
  private settleAborted(entry: RegistryEntry, err: unknown): void {
    if (entry.state.phase === 'running') {
      entry.state = { phase: 'aborted', reason: String((err as Error)?.message ?? err) };
    }
  }

  // ─── resume_target ───────────────────────────────────────────────────────

  private async handleResumeTarget(agentId: string): Promise<HandoffResolution> {
    const entry = this.registry.get(agentId);
    if (!entry) {
      // 找不到目标:进程内 MVP 下无可恢复者 —— ack(不抛,父据空结果继续)。
      return { kind: 'ack' };
    }
    if (entry.state.phase === 'done') return { kind: 'child_result', events: entry.state.events };
    if (entry.state.phase === 'aborted') return { kind: 'child_result', events: [] };
    // 仍 running(bg 未完成)→ await 其结果(取/恢复)。
    try {
      const events = await entry.resultPromise;
      this.settleDone(entry, events);
      return { kind: 'child_result', events };
    } catch {
      return { kind: 'child_result', events: [] };
    }
  }

  // ─── sleep ───────────────────────────────────────────────────────────────

  private async handleSleep(until: SleepCondition): Promise<HandoffResolution> {
    if (until.kind === 'timer') {
      await new Promise<void>((resolve) => setTimeout(resolve, until.ms));
      const trigger: WakeupTrigger = { eventType: 'timer' };
      return { kind: 'wakeup', trigger };
    }
    // event:订阅注入的共享 bus,等待某事件类型出现后唤醒。
    if (!this.bus) {
      // 没有 bus 可订阅 → 无法自动唤醒(host SLA)。退化为 ack 而非 hang,避免父永久阻塞。
      return { kind: 'ack' };
    }
    const payload = await this.waitForEvent(until.eventType);
    const trigger: WakeupTrigger = { eventType: until.eventType, payload };
    return { kind: 'wakeup', trigger };
  }

  /** 订阅共享 bus,等到首个匹配 eventType 的事件,resolve 其 payload 后解订阅。 */
  private waitForEvent(eventType: string): Promise<unknown> {
    return new Promise<unknown>((resolve) => {
      const unsub = this.bus!.subscribe(eventType, (event) => {
        unsub();
        resolve(event.payload);
      });
    });
  }

  // ─── abort ───────────────────────────────────────────────────────────────

  private async handleAbort(reason: string): Promise<HandoffResolution> {
    // 终止目标 agent(s):MVP 下 abort「自己」语义 = 终止本 scheduler 注册表里所有在跑的 agent。
    for (const entry of this.registry.values()) {
      if (entry.state.phase === 'running') {
        entry.state.controller.abort(reason);
        entry.state = { phase: 'aborted', reason };
      }
    }
    return { kind: 'ack' };
  }

  // ─── 测试 / host 内省辅助 ───────────────────────────────────────────────

  /** 注册表里某 agent 的当前 phase(测试 / 内省用)。 */
  getPhase(agentId: string): AgentPhase | undefined {
    return this.registry.get(agentId)?.state.phase;
  }

  /** 当前注册的 agentId 列表(测试 / 内省用)。 */
  listAgents(): string[] {
    return [...this.registry.keys()];
  }
}
