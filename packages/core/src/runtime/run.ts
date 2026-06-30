/**
 * runtime/run (Wave4 RUN) — the assembly entry (设计稿 §3 `core.run({config,store?,inject})`).
 *
 * Wires the native pieces into a ready CoreAgent: an EventBus, an EventStore
 * (in-memory default — §6.5 core 默认无状态), and the WAL connection. Returns the
 * agent + bus + store so the host can subscribe hooks and read the ledger.
 * Boundary: 仅 core 相对 import。
 */
import { CoreAgent, type CoreAgentOptions } from '../agent/agent';
import type { AgentContext } from '../agent/types';
import { EventBus } from '../events/event-bus';
import { InMemoryEventStore, connectStore } from '../history/event-store';
import { foldFromStore } from '../history/llm-fold-adapter';
import type { CoreEvent } from '../events/types';
import type { ProviderMessage } from '../provider/types';
import type { EventStore } from '../inject/types';
import type { PermissionRuleSet } from '../permission/rules';
import type { PermissionMode } from '../permission/engine';
import type { Unsubscribe } from '../events/types';
import type { AssembledCapabilities } from './assemble';

/** createAgent 可透传给 CoreAgent 的运行项(compaction/auto-memory/ask/thinking/steering 等)。 */
type AgentPassthrough = Pick<
  CoreAgentOptions,
  | 'compaction'
  | 'contextWindow'
  | 'retry'
  | 'autoMemory'
  | 'microCompact'
  | 'askUser'
  | 'thinking'
  | 'steeringSource'
  // ★ 多 agent 协作:handoff 调度接缝 + peer 消息收件箱(均可选,缺省维持单 agent)。
  | 'handoff'
  | 'inbox'
  // ★ v3/B 档 可观测性(trace+log)注入缝;缺省 → CoreAgent 兜底 NOOP_OBS(零行为变化)。
  | 'observability'
>;

export interface RunOptions extends AgentPassthrough {
  context: AgentContext;
  /** 不传 = in-memory(纯函数式,§6.5)。 */
  store?: EventStore;
  bus?: EventBus;
  rules?: Partial<PermissionRuleSet> | null;
  mode?: PermissionMode;
  globalCacheEnabled?: boolean;
  /** assembleCapabilities() 结果:把 tools/slots 合并进 context.config,disposers 透出供清理。
   *  注意:assemble 须用**同一个 bus**(plugins/hooks 订阅其上),故 host 先 new EventBus →
   *  assembleCapabilities({bus}) → createAgent({bus, capabilities})。 */
  capabilities?: AssembledCapabilities;
  /** 是否把 EventStore 接到 bus(WAL 持久化)。默认 true。
   *  注意:若 host 要 hook 的 block 阻止入 store,应传 false 自行在 hooks 之后
   *  调 `connectStore`(它必须注册在 blocking hook 之后,§6.3)。 */
  autoConnectStore?: boolean;
  /** 开机回放(resume/replay):true 时从 store.read() 读全量事件 → foldEvents 重建
   *  对话历史 → 作 CoreAgent.initialMessages seed(设计稿 §3.8.7)。仅 async
   *  `createAgentResumed` 消费(read 是 async iterable);同步 `createAgent` 不读 store。
   *  store 未实现 read / 空 store → seed 为空,等价于不回放。 */
  resume?: boolean;
}

export interface RunHandle {
  agent: CoreAgent;
  bus: EventBus;
  store: EventStore;
  /** 解除 WAL 订阅(autoConnectStore 时有效)。 */
  disconnectStore?: Unsubscribe;
  /** capabilities 的清理(plugin 解订阅 / MCP 关连接 / hooks 解绑);host 在退出/abort 时调。 */
  disposers?: Array<() => void | Promise<void>>;
}

/** 装配内核(共享路径)。`initialMessages` 为开机回放重建的历史 seed;同步路径不传(空)。
 *  resolve tools/slots 合并、CoreAgent 构造、WAL 连接都在这里,async/sync 入口共用。 */
function assembleHandle(opts: RunOptions, initialMessages?: ProviderMessage[]): RunHandle {
  const bus = opts.bus ?? new EventBus();
  const store = opts.store ?? new InMemoryEventStore();

  // 合并 assemble 的 tools/slots 进 context.config(去重:同名后者覆盖)。
  let context = opts.context;
  if (opts.capabilities) {
    const cfg = context.config;
    const toolByName = new Map(cfg.tools.map((t) => [t.name, t]));
    for (const t of opts.capabilities.tools) toolByName.set(t.name, t);
    const slotByName = new Map((cfg.systemPromptSlots ?? []).map((s) => [s.name, s]));
    for (const s of opts.capabilities.slots) slotByName.set(s.name, s);
    context = {
      ...context,
      config: { ...cfg, tools: [...toolByName.values()], systemPromptSlots: [...slotByName.values()] },
    };
  }

  const agent = new CoreAgent({
    context,
    bus,
    rules: opts.rules,
    mode: opts.mode,
    globalCacheEnabled: opts.globalCacheEnabled,
    compaction: opts.compaction,
    contextWindow: opts.contextWindow,
    retry: opts.retry,
    autoMemory: opts.autoMemory,
    microCompact: opts.microCompact,
    askUser: opts.askUser,
    thinking: opts.thinking,
    steeringSource: opts.steeringSource,
    // ★ 多 agent:handoff 调度器 + peer 收件箱(缺省 undefined → handoff_decision 维持 no-op)。
    handoff: opts.handoff,
    inbox: opts.inbox,
    // ★ v3/B 档:可观测性束(缺省 undefined → CoreAgent.run() 兜底 NOOP_OBS,零 span/log)。
    observability: opts.observability,
    // 回放 seed(置于 messages 最前;不传 = 空,纯函数式 §6.5)。
    initialMessages: initialMessages && initialMessages.length > 0 ? initialMessages : undefined,
  });
  let disconnectStore: Unsubscribe | undefined;
  if (opts.autoConnectStore !== false) {
    disconnectStore = connectStore(bus, store);
  }
  return { agent, bus, store, disconnectStore, disposers: opts.capabilities?.disposers };
}

/** 组装一个可跑的原生 agent。给了 capabilities 即把其 tools/slots 合并进 context。
 *  同步入口:**不读 store**(read 是 async),故不回放——要回放用 `createAgentResumed`。 */
export function createAgent(opts: RunOptions): RunHandle {
  return assembleHandle(opts);
}

/**
 * 组装并(可选)开机回放的异步入口(resume/replay)。
 *
 * `resume === true` 且 store 实现了 `read` 时:`for await` 读全量事件 → `foldFromStore`
 * 把事件流 fold 成对话历史 → 作 `initialMessages` seed 进 CoreAgent(设计稿 §3.8.7;
 * 事件流是真相 §6.1,messages 是 fold 派生)。read 在 connectStore 之前完成,故回放只
 * 看到此前已落盘的历史,不含本次 run 新写入的事件。
 *
 * 不 resume / store 无 read / 空 store → seed 为空,与 `createAgent` 等价(§6.5 无状态)。
 */
export async function createAgentResumed(opts: RunOptions): Promise<RunHandle> {
  let initialMessages: ProviderMessage[] | undefined;
  const store = opts.store;
  if (opts.resume && store?.read) {
    const events: CoreEvent[] = [];
    for await (const e of store.read()) events.push(e);
    initialMessages = foldFromStore(events);
  }
  return assembleHandle(opts, initialMessages);
}
