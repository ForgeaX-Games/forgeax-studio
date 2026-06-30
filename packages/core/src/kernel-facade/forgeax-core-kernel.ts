/**
 * ForgeaxCoreKernel (Wave4 FACADE, K10/K11) — implements the C6 `AgentKernel`
 * contract as a THIN shell over the native CoreAgent.
 *
 * 设计稿: 最终实现方案 §7 (facade 是薄壳：把 TurnRequest 翻成原生 Agent.run 的输入、
 * 把 AgentEvent 翻成 KernelEvent;原生 API 才是主面)。这是第三内核 'forgeax-core'
 * (contract.ts 的 drop-in 槽),消费 host-owned `TurnRequest.history` 作权威上下文。
 *
 * Boundary: 仅 import @forgeax/agent-runtime(契约) + core 相对。不引 cli/外部内核/SDK。
 */
import type {
  AgentKernel,
  KernelCapabilities,
  KernelEvent,
  KernelHealth,
  ModelRef,
  PermissionMode,
  TurnDoneReason,
  TurnHandle,
  TurnMessage,
  TurnRequest,
} from '@forgeax/agent-runtime/contract';
import { CoreAgent } from '../agent/agent';
import type { AgentContext, AgentEvent, TerminalReason } from '../agent/types';
import type { AgentTool } from '../capability/types';
import { buildTool } from '../capability/types';
import type { LLMProvider, ProviderMessage, ProviderRequest, ProviderStreamEvent } from '../provider/types';
import { makeProviderCompactSummarize } from '../context/compaction-llm';
import { microCompact } from '../context/micro-compaction';
import { contextWindowForModel } from '../context/model-window';
import { makeTaskTool } from '../agent/subagent';
import type { SubagentRegistry } from '../agent/subagent-registry';
import { handoffTool } from '../capability/builtin-tools/message-tools';
import { exitPlanModeTool } from '../capability/builtin-tools/plan-tools';
import type { PermissionMode as NativePermissionMode } from '../permission/engine';
import type { PermissionRuleSet } from '../permission/rules';
import type { AskUserFn } from '../agent/dispatch';
import type { ServerRequestDeps } from '../capability/mcp/server-requests';
import type { TokenProvider } from '../capability/mcp/auth';
import type { HandoffSink, AskQuestionFn } from '../inject/types';
import type { Observability } from '../observability/contract';
import { NOOP_OBS, parentContextFromTraceparent } from '../observability/contract';
import { cacheHitRate, promptTokens } from '../observability/usage';
import { readFileSync } from 'node:fs';
import { imageBlockFromAttachment as buildImageBlockFromAttachment } from '../capability/image-block';

/** 把 `TurnRequest.input.attachments` 里的图片项组成 Anthropic image content block。
 *  逻辑下沉到共享 helper(`capability/image-block.ts`),read_file(011)与此处共用。
 *  这里只注入「host 路径读盘」(serve 子进程同盘可同步读 → 大图走引用不撑爆 wire)。
 *  非图片 / 无数据的项静默跳过(forward-compat)。 */
function imageBlockFromAttachment(att: Record<string, unknown>): Record<string, unknown> | null {
  const block = buildImageBlockFromAttachment(att, (path) => readFileSync(path));
  return block as Record<string, unknown> | null;
}

/** 组 user 消息 payload:无图 → 纯文本字符串(零回归);有图 → content 数组 [text, image…]。 */
function buildUserPayload(
  text: string,
  attachments: TurnRequest['input']['attachments'],
): string | Array<Record<string, unknown>> {
  if (!attachments || attachments.length === 0) return text;
  const blocks: Array<Record<string, unknown>> = [];
  for (const att of attachments) {
    const block = imageBlockFromAttachment(att);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0) return text; // 附件都无法解析 → 退回纯文本
  return [{ type: 'text', text }, ...blocks];
}

/** 每轮 handoff 工厂的上下文 —— 让 host 用**本轮的** provider/model/工具建调度器,
 *  使被 spawn 的子 agent 拿到与父同源的 host 工具(经 executeTool 桥回主机)。 */
export interface TurnHandoffCtx {
  provider: LLMProvider;
  model: string;
  /** 本轮 host 工具(已 wrap;不含 Task/Handoff)——子 agent 的工具集应取此,防递归。 */
  tools: AgentTool[];
}

/** handoff 注入:可给定**固定** HandoffSink,或给一个**每轮工厂**(推荐:子 agent 需本轮工具)。
 *  返回 undefined = 本轮不启用 handoff(维持单 agent)。 */
export type HandoffProvider = HandoffSink | ((ctx: TurnHandoffCtx) => HandoffSink | undefined);

/** host-tool 执行缝(K11):facade 不自己执行工具,委托 host(对齐合订方案 §5 方案 A
 *  的 `POST /:sid/kernel-tool` 桥)。`agentId` = 本轮真实 agent(委派轮里即被委派方,
 *  如 mochi),供 host 桥按真实身份求 trustTier / 弹权限卡 / 选执行 context;缺省回落主 agent。 */
export type ExecuteToolFn = (name: string, args: unknown, sid?: string, agentId?: string) => Promise<unknown>;

export interface ForgeaxCoreKernelOptions {
  /** 注入 provider(per-session baseUrl+token 经 ConfigSource;支持 M4)。 */
  provider: LLMProvider;
  /** host-tool 执行桥。 */
  executeTool: ExecuteToolFn;
  /** 初始权限模式(engine 原生;缺省 'default')。`setPermissionMode` 运行中可改活 agent。 */
  initialMode?: NativePermissionMode;
  /** host 注入的权限规则集(deny/ask/allow);透传给每轮 CoreAgent,使 facade 驱动的轮也尊规则。 */
  rules?: Partial<PermissionRuleSet> | null;
  /** 交互式权限回路('ask' 判定时咨询 host);缺省 → 'ask' fail-closed deny。 */
  askUser?: AskUserFn;
  /**
   * 008 结构化提问接缝(AskUserQuestion 工具用)。区别于权限 `askUser`(yes/no):
   * 这里是**结构化多选问题**消歧(选方案 A/B、确认需求)。注入后 facade 把它挂到每轮
   * 的 `toolContext.askQuestion`,工具经 ctx 取用并把 questions 转给 host;host 决定
   * 怎么弹给用户 —— 复用现有 permission **card-pop** 的 EventBus→WS 信道(提问与审批
   * 同信道、不同 payload),由 serve→Studio 收集用户选择后 resolve。**缺省不注入 →
   * AskUserQuestion 调用时优雅降级(回灌 unsupported,不断流)**。
   */
  askQuestion?: AskQuestionFn;
  /** 额外注入的 toolContext(IO 能力)。本进程内本地工具(localToolImpls)经此取 sandboxFs/terminal。 */
  toolContext?: Record<string, unknown>;
  /** ★ 可观测性(trace+log)注入缝。serve.ts 经 `makeNodeObservability({send:rpcSend})` 造,
   *  透传给每轮 `new CoreAgent({...observability})` + 挂进 toolContext(工具侧 trace)。
   *  缺省 → CoreAgent 兜底 NOOP_OBS,零行为变化。见 observability/contract.ts。 */
  observability?: Observability;
  /**
   * 本地工具实现表(B 路径,host=serve 注入):name → core builtin `AgentTool`。
   * 当 `ToolSpec.delivery==='local'` 且这里有同名实现时,wrapTools 用它**在本进程内直跑**
   * (经 toolContext.sandboxFs),不回宿主;否则 fail-safe 落回 executeTool 桥(=host 路径)。
   * 缺省不注入 → 所有工具走 host 桥(现状 A,零行为变化)。kernel-facade 不 import cli/io,
   * 实现由 HOST 层(serve.ts)装配后注入(保边界:机制层不碰 node:fs)。
   */
  localToolImpls?: AgentTool[];
  /** thinking(扩展思考)配置;给了即对每轮请求开启,并吐 thinking.delta。 */
  thinking?: ProviderRequest['thinking'];
  /**
   * MCP server→client 反向请求(elicitation/sampling/roots)的 host handler 集合(M4)。
   *
   * facade 自身**不装配 MCP client**(它只把 host 声明的工具经 `executeTool` 桥转发),
   * 故这里只是一个**存储接缝**:host 在 facade 外部用 core 的 `InProcessMCPClient` /
   * `resolveMcpClient` 接 MCP 时,可经 {@link ForgeaxCoreKernel.serverRequestDeps}
   * 取回本对象传给 `new InProcessMCPClient(server, transport, deps)`。core 不在内部
   * 调用它(避免凭空发明 MCP 装配流水线)。
   */
  serverRequestDeps?: ServerRequestDeps;
  /**
   * MCP 鉴权 token 提供方(M3)。同 {@link serverRequestDeps},仅作**存储接缝**:host
   * 在 facade 外装配 MCP client 时,可经 {@link ForgeaxCoreKernel.tokenProvider} 取回
   * 传给 `resolveMcpClient(..., { tokenProvider })` / `new FetchMCPClient(..., { tokenProvider })`。
   */
  tokenProvider?: TokenProvider;
  /**
   * ★ 多 agent 协作:handoff 调度接缝(forgeax-core 专属,**不在 AgentKernel 契约上**)。
   * 注入后,模型经 `Handoff` 工具发出的意图会在每轮 CoreAgent 的 handoff_decision 阶段
   * 经 `declare(intent)` 交给 host 调度器(如 agent-host 的 `InProcessScheduler`),据此
   * spawn 子 agent / 挂起 / 唤醒。**缺省不注入 → 维持单 agent(零行为变化)**。
   *
   * 说明:此能力仅在 'forgeax-core' 内核激活时可用;rented(外部)内核是
   * 子进程 CLI,不暴露此控制面,故 peer 多 agent 不跨内核——这是既定取舍(方案 A),
   * facade 把它作为**自身构造选项**而非契约特性,从不要求其它内核实现。
   *
   * 形态:可给固定 `HandoffSink`,或给**每轮工厂** `(ctx)=>HandoffSink`(推荐,见
   * {@link TurnHandoffCtx})。注入后,facade 会额外把内建 `Handoff` 工具加进模型工具集,
   * 使模型能发起意图;否则模型无从触发 handoff(即便注了 sink 也不会动)。
   */
  handoff?: HandoffProvider;
  /**
   * ★ P0 registry 接缝(additive):subagent 类型注册表。注入后,facade 把它连同
   * `allTools`(本轮 host 工具)传给 `makeTaskTool`,使子 agent 按 `subagent_type`
   * 做**按类型工具过滤 / system / model / maxTurns / budget** 解析(此时**不再**传
   * `resolveTools: () => hostTools`,让 registry 的 `allowedTools` 过滤器生效)。
   *
   * **缺省 ⇒ 维持现状 byte-for-byte**:沿用今日的 `resolveTools`/`resolveSystem`
   * 兜底(子拿全量 host 工具、固定 system 文案),零行为变化。
   */
  subagentRegistry?: SubagentRegistry;
}

/** 契约中立 PermissionMode → engine 原生 PermissionMode(facade 翻译;spine 不说内核私有词汇)。
 *  gated→default · autoEdits→acceptEdits · planning→plan · unrestricted→bypassPermissions。
 *  越界值 → default(fail-safe,最严的标准把闸)。 */
export function translateNeutral(m: PermissionMode): NativePermissionMode {
  switch (m) {
    case 'gated':
      return 'default';
    case 'autoEdits':
      return 'acceptEdits';
    case 'planning':
      return 'plan';
    case 'unrestricted':
      return 'bypassPermissions';
    default:
      return 'default';
  }
}

const CAPS: KernelCapabilities = {
  streaming: true,
  // 底层 CoreAgent 支持扩展思考(provider 已通),facade 透传并吐 thinking.delta。
  thinking: true,
  toolCalls: true,
  // facade 走「轮间」语义(midTurnInject=false);原生 Agent API 经 steeringSource 支持回合中插话。
  midTurnInject: false,
};

/** terminal reason → 契约 TurnDoneReason。 */
function mapReason(r: TerminalReason): TurnDoneReason {
  switch (r) {
    case 'completed':
      return 'stop';
    case 'max_turns':
      return 'max_turns';
    case 'aborted_streaming':
    case 'aborted_tools':
      return 'cancelled';
    case 'model_error':
    case 'unrecoverable_tool_error':
    case 'prompt_too_long':
    case 'blocking_limit':
    case 'image_error':
      return 'error';
    // stop-hook / hook 收尾:模型本欲停,被 hook 拦下后达上限而终止——非错误,作正常停。
    case 'stop_hook_prevented':
    case 'hook_stopped':
      return 'stop';
    default:
      return 'stop';
  }
}

/** TurnRequest.history(契约中立形) → ProviderMessage[]。 */
function mapHistory(history: TurnMessage[] | undefined): ProviderMessage[] {
  if (!history) return [];
  const out: ProviderMessage[] = [];
  for (const m of history) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') out.push({ role: 'assistant', content: m.content });
    else
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.callId, content: m.result, is_error: !m.ok }],
      });
  }
  return out;
}

/** 从 assistant AgentEvent 抽文本(message.delta 用)。 */
function assistantText(message: { payload?: unknown }): string {
  const content = (message.payload as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/** subagent 生命周期回调 payload(SubagentDeps.onSubagentEvent 的事件形)。 */
type SubEvent = {
  type: string;
  agentId: string;
  agentType?: string;
  role?: string;
  depth?: number;
  turn?: number;
  toolName?: string;
  toolUseId?: string;
  reason?: string;
  turns?: number;
  toolCalls?: number;
};

/**
 * L5:把 `onSubagentEvent` 回调事件映射成 `x.subagent.*` KernelEvent(出墙观测)。
 * 未知 type 返回 null(被丢弃)。字段对齐 SHARED CONTRACT。
 */
function subEventToKernel(ev: SubEvent): KernelEvent | null {
  switch (ev.type) {
    case 'subagent.start':
      return {
        kind: 'x.subagent.start',
        agentId: ev.agentId,
        agentType: ev.agentType,
        role: ev.role,
        depth: ev.depth ?? 0,
      };
    case 'subagent.turn':
      return { kind: 'x.subagent.turn', agentId: ev.agentId, turn: ev.turn ?? 0 };
    case 'subagent.tool_call':
      return { kind: 'x.subagent.tool', agentId: ev.agentId, callId: ev.toolUseId ?? '', name: ev.toolName ?? '' };
    case 'subagent.stop':
      return {
        kind: 'x.subagent.done',
        agentId: ev.agentId,
        reason: ev.reason ?? 'completed',
        turns: ev.turns ?? 0,
        toolCalls: ev.toolCalls ?? 0,
      };
    default:
      return null;
  }
}

export class ForgeaxCoreKernel implements AgentKernel {
  readonly id = 'forgeax-core' as const;
  readonly capabilities = CAPS;
  private readonly o: ForgeaxCoreKernelOptions;
  private readonly handles = new Map<string, CoreAgent>();
  /** 当前权限模式(engine 原生)。新轮 CoreAgent 以此构造;`setPermissionMode` 经
   *  translateNeutral 改活 agent 并存这里,使无 live handle 时新轮也带上新模式。 */
  private currentMode: NativePermissionMode;
  /** 当前模型(控制面 `setModel` 覆盖)。设了即**取代** req.model 作为新轮 + 活 agent 的
   *  权威模型源(与 currentMode 同语义:控制面 override 持久,直到再次 setModel)。 */
  private currentModel: string | undefined;

  /**
   * MCP server→client 反向请求 handler(M4 存储接缝;facade 不自调用)。host 在外部
   * 装配 MCP client 时取回传给 `InProcessMCPClient(server, transport, deps)`。
   */
  get serverRequestDeps(): ServerRequestDeps | undefined {
    return this.o.serverRequestDeps;
  }

  /**
   * MCP 鉴权 token 提供方(M3 存储接缝;facade 不自调用)。host 在外部装配 MCP client
   * 时取回传给 `resolveMcpClient(..., { tokenProvider })`。
   */
  get tokenProvider(): TokenProvider | undefined {
    return this.o.tokenProvider;
  }

  constructor(opts: ForgeaxCoreKernelOptions) {
    this.o = opts;
    this.currentMode = opts.initialMode ?? 'default';
  }

  /** ToolSpec → AgentTool,call 委托 host-tool 桥(K11)。 */
  private wrapTools(req: TurnRequest): AgentTool[] {
    const sid = req.hostSessionId as string | undefined;
    // 本轮真实 agent —— 透给 host 桥(委派轮里即被委派方,如 mochi);丢了会让权限卡错记到主 agent。
    const agentId = req.session?.agentId;
    // 本地实现表(B 路径):name → core builtin AgentTool(host=serve 注入)。
    const localByName = new Map((this.o.localToolImpls ?? []).map((t) => [t.name, t]));
    return req.tools.map((spec) => {
      // delivery==='local' 且有同名本地实现 → 本进程内直跑(经 ctx.sandboxFs,不回宿主)。
      //   拿不到本地实现 → fail-safe 落回下方 host 桥(永不因缺实现而失能)。
      if (spec.delivery === 'local') {
        const impl = localByName.get(spec.name);
        if (impl) return impl;
      }
      // 'host'/缺省 → executeTool 桥回宿主(现状 A;host 复跑 checkKernelTool 把闸)。
      return buildTool({
        name: spec.name,
        // host 在 ToolSpec.description 给了模型可读描述(compose-turn-request),
        // 必须透传到 AgentTool,否则 wire tools[] 没 description,模型只能靠名字猜。
        ...(spec.description ? { description: spec.description } : {}),
        inputJSONSchema: spec.inputSchema ?? {},
        call: async (input: unknown) => ({ data: await this.o.executeTool(spec.name, input, sid, agentId) }),
        mapResult: (data, id) => ({ type: 'tool.result', payload: { callId: id, ok: true, result: data }, ts: 0 }),
        maxResultSizeChars: Infinity,
      });
    });
  }

  async *runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
    // ★ v3/B 档 可观测性:本轮 ROOT span(parent 默认 none —— turn 是一棵新树的根,正确)。
    //   sid/agentId 在入口即在作用域 → 直接盖 attribute(不走 baggage/onStart 桥,A.2-N3)。
    //   缺省 obs=NOOP_OBS → noop tracer 不出 span、noop logger 不出 log,零行为变化(§9 降级)。
    const obs = this.o.observability ?? NOOP_OBS;
    const sid = (req.hostSessionId as string | undefined) ?? req.session?.agentId ?? 'unknown';
    const turnAgentId = req.session?.agentId ?? 'unknown';
    // 全链路:若 host/浏览器经 `req.traceparent` 传来上游 span,kernel.turn 挂成它的 child
    //   (显式 parent,不读 active-context);缺省 undefined → 自建 root(零行为变化)。
    const parentCtx = parentContextFromTraceparent(req.traceparent);
    const turnSpan = obs.tracer.startSpan('kernel.turn', { attributes: { sid, agentId: turnAgentId } }, parentCtx);
    const turnSpanCtx = turnSpan.spanContext();
    // span-bound child logger:其后每条 record 天生带 traceId/spanId/sid/agentId(child bindings),
    //   reporter 不调 getActiveSpan()(W1)。下传给 toolContext.observability 供工具自 trace。
    const turnLogger = obs.logger.child({
      traceId: turnSpanCtx.traceId,
      spanId: turnSpanCtx.spanId,
      sid,
      agentId: turnAgentId,
    });
    turnLogger.info('kernel.turn start', { model: this.currentModel ?? req.model });
    let turnStatus: 'ok' | 'error' = 'ok';
    // 诊断维度(hoist 到外层 finally 可见):token 用量累计 + 本轮结束原因。
    const usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 };
    let lastReason: ReturnType<typeof mapReason> | undefined;
    try {
    // system: charter+persona 作稳定缓存前缀(static slots);dynamicSuffix 进 user 末尾,
    // 绝不进 system(保前缀 cache 稳定,对齐 §7 / ComposedPrompt 注释)。
    const sp = req.systemPrompt;
    // 控制面 setModel 覆盖优先(持久),否则本轮 req.model,再否则默认。
    const model = this.currentModel ?? req.model ?? 'claude-opus-4-8';
    // P0:TurnRequest.permissionMode → 本轮起始模式(免一次 setPermissionMode 往返)。
    //   控制面 setPermissionMode 仍可中途再改;此处把 req 的初始模式落到 currentMode。
    if (req.permissionMode) this.currentMode = translateNeutral(req.permissionMode);
    const hostTools = this.wrapTools(req);
    // ★ L5 observability:本轮 FIFO 队列,缓冲子 agent 生命周期回调投射出的 KernelEvent。
    //   onSubagentEvent 在 Task 工具 await 期间(即 agent.run 两次 yield 之间)同步推入,
    //   逐轮 drain 即可保 start→turn→tool→done 顺序排在父 tool.result 之前。
    const subQueue: KernelEvent[] = [];
    // ★ subagent:facade 注入原生 Task,使 forgeax-core 作内环驱动聊天时也能派子 agent。
    //   子 agent 跑在 forgeax-core 内(隔离上下文,自压缩),子工具 = host 工具(经同一桥),
    //   **不含 Task**(防递归):Task 是内核内建子 agent 工具,非 host 声明。
    //   ★ P0 registry 接缝:注入 subagentRegistry 时改走 registry + allTools(按类型过滤工具);
    //   缺省维持今日的 resolveTools/resolveSystem 兜底(零行为变化)。
    const registry = this.o.subagentRegistry;
    // 008:把 host 的 askQuestion 接缝挂到每轮 toolContext(AskUserQuestion 工具经 ctx 取用);
    //   缺省不挂 → 工具优雅降级。父/子 agent 共用同一 toolContext(子继承提问能力)。
    const toolContext: Record<string, unknown> = {
      ...(this.o.toolContext ?? {}),
      ...(this.o.askQuestion ? { askQuestion: this.o.askQuestion } : {}),
      // ★ v3/B 档:工具自 trace 用的能力束 —— tracer 原样,logger 用本轮 span-bound child,
      //   工具经此建子 span(显式认 parent)/出带 traceId 的 log,不押 active-context。
      observability: { tracer: obs.tracer, logger: turnLogger } satisfies Observability,
    };
    const taskTool = makeTaskTool({
      provider: this.o.provider,
      model,
      ...(registry
        ? { registry, allTools: hostTools }
        : {
            resolveTools: () => hostTools,
            resolveSystem: (t) =>
              `You are a ${t ?? 'general'} subagent. Do the task and report the result concisely.`,
          }),
      toolContext,
      // ★ ISSUE-1:子 agent 自压缩走 Compaction V2(比例水位 + 有序闸 + 三层管线 + 重挂)。
      compactionV2: { summarize: makeProviderCompactSummarize(this.o.provider, model) },
      contextWindow: contextWindowForModel(model),
      maxTurns: req.budget.maxTurns ?? 20,
      // ★ L5:子生命周期回调 → KernelEvent → subQueue。缺省路径(无子派发)永不触发,零回归。
      onSubagentEvent: (ev) => {
        const k = subEventToKernel(ev);
        if (k) subQueue.push(k);
      },
    });
    // ★ peer 多 agent:每轮解析 handoff sink(工厂拿本轮 provider/model/host 工具,
    //   使被 spawn 的子 agent 用同源 host 工具)。注入了 sink 才把 Handoff 工具加进模型
    //   工具集 —— 否则模型无从触发,即便注了 sink 也维持单 agent(零行为变化)。
    const handoffSink =
      typeof this.o.handoff === 'function'
        ? this.o.handoff({ provider: this.o.provider, model, tools: hostTools })
        : this.o.handoff;
    // plan 模式:把 ExitPlanMode 工具加进模型工具集(只在 plan 下可见——它是退出 plan 的唯一缝)。
    const planTools = this.currentMode === 'plan' ? [exitPlanModeTool()] : [];
    const tools = handoffSink
      ? [...hostTools, taskTool, handoffTool(), ...planTools]
      : [...hostTools, taskTool, ...planTools];
    const context: AgentContext = {
      agentId: req.session.agentId,
      provider: this.o.provider,
      config: {
        systemPromptSlots: [
          { name: 'charter', render: () => sp.charter, cacheScope: 'global' },
          { name: 'persona', render: () => sp.persona, cacheScope: 'global' },
        ],
        model,
        tools,
        maxTurns: req.budget.maxTurns,
      },
      toolContext,
    };

    const agent = new CoreAgent({
      context,
      globalCacheEnabled: true,
      // ★ WS-C:把权限模式 / 规则 / askUser 透传给每轮 CoreAgent,使 facade 驱动的轮也
      //   honor 注入规则、并让 setPermissionMode 改活 agent 真生效(dispatch 读 currentMode)。
      mode: this.currentMode,
      ...(this.o.rules !== undefined ? { rules: this.o.rules } : {}),
      ...(this.o.askUser ? { askUser: this.o.askUser } : {}),
      // F6 生产路径也开压缩(auto + micro);长会话不至于撑爆上下文。
      // ★ ISSUE-1:主轮自压缩走 Compaction V2(替换 legacy makeProviderCompaction)。
      compactionV2: { summarize: makeProviderCompactSummarize(this.o.provider, context.config.model) },
      microCompact: (msgs) => microCompact(msgs, { now: Date.now() }),
      contextWindow: contextWindowForModel(context.config.model),
      ...(this.o.thinking ? { thinking: this.o.thinking } : {}),
      // ★ peer 多 agent:解析出 sink 才接;缺省 → handoff_decision 维持 no-op(单 agent)。
      ...(handoffSink ? { handoff: handoffSink } : {}),
      // ★ v3/B 档:把可观测性束 + 本轮 root span 显式下传 —— CoreAgent.run() 把 agent.run span
      //   建成 turnSpan 的 explicit child(并发多轮父子树不串,B2)。缺省 NOOP_OBS → 不出 span。
      observability: obs,
      parentSpan: turnSpan,
    });
    if (req.callId) this.handles.set(req.callId, agent);

    const userText = sp.dynamicSuffix ? `${req.input.text}\n\n${sp.dynamicSuffix}` : req.input.text;
    // 多模态:有图片附件时,user 消息 payload 升级为 content 数组([text, image…]),
    //   否则保持纯字符串(零回归)。content 数组经 agent.run(:567 content=payload)
    //   原样落到 provider(anthropic.ts:62 透传)→ 模型收到图。
    const userPayload = buildUserPayload(userText, req.input.attachments);
    let usageEmitted = false;

    const emitUsage = (): KernelEvent => ({
      kind: 'turn.usage',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheRead: usage.cacheRead,
      cacheCreation: usage.cacheCreation,
    });

    try {
      for await (const ev of agent.run({
        input: { type: 'user', payload: userPayload, ts: 0 },
        history: mapHistory(req.history),
        signal,
      })) {
        const k = this.translate(ev, usage);
        if (k) yield k;
        // ★ L5:逐轮 drain 子 agent 事件队列。子事件在父 Task 工具 await 期间同步推入
        //   (即两次 agent.run yield 之间),逐轮 drain 保 start→turn→tool→done 顺序排在
        //   父 tool.result 之前。
        while (subQueue.length) {
          const s = subQueue.shift();
          if (s) yield s;
        }
        if (ev.type === 'done') {
          // 收尾前再 drain 一次,确保 done 阶段才推入的子事件不被漏掉。
          while (subQueue.length) {
            const s = subQueue.shift();
            if (s) yield s;
          }
          // B5 不变量:turn.usage 必在 turn.done 之前。
          yield emitUsage();
          usageEmitted = true;
          lastReason = mapReason(ev.terminal.reason);
          yield { kind: 'turn.done', reason: lastReason };
        }
      }
      // ★ L5:loop 结束后兜底 drain,防最后一批子事件随循环退出被丢弃。
      while (subQueue.length) {
        const s = subQueue.shift();
        if (s) yield s;
      }
    } finally {
      if (req.callId) this.handles.delete(req.callId);
    }
    // 防御:run 未吐 done(异常路径)也保证 usage-before 缺失不发生。
    if (!usageEmitted) {
      yield emitUsage();
      lastReason = signal.aborted ? 'cancelled' : 'error';
      yield { kind: 'turn.done', reason: lastReason };
    }
    } catch (e) {
      // ★ v3/B 档:本轮任意未捕获异常 → 标 turnSpan error 并上抛(finally 收尾 span)。
      turnStatus = 'error';
      const msg = e instanceof Error ? e.message : String(e);
      try { turnSpan.recordException(e instanceof Error ? e : new Error(msg)); } catch { /* noop tracer 可能无此 API */ }
      turnLogger.error('kernel.turn error', { error: msg });
      throw e;
    } finally {
      // SpanStatusCode: 1=OK / 2=ERROR(字面量,避免 import SDK 常量;仅 @opentelemetry/api 的 trace)。
      turnSpan.setStatus({ code: turnStatus === 'ok' ? 1 : 2 });
      // ★ 诊断维度:把「烧了多少 token / 为何结束 / 用哪个模型」盖到 span + done log,
      //   排查时无需翻多条事件,从这一行即读出本轮全貌。setAttribute 在 noop tracer 下可能无 → 容错。
      const doneModel = this.currentModel ?? req.model ?? 'unknown';
      // 缓存命中率/提示词总量(派生指标,直接落 trace 免下游再算;口径见 observability/usage)。
      const prompt = promptTokens(usage);
      const hitRate = cacheHitRate(usage);
      try {
        turnSpan.setAttribute('usage.input', usage.inputTokens);
        turnSpan.setAttribute('usage.output', usage.outputTokens);
        turnSpan.setAttribute('usage.cacheRead', usage.cacheRead);
        turnSpan.setAttribute('usage.cacheCreation', usage.cacheCreation);
        turnSpan.setAttribute('usage.promptTokens', prompt);
        turnSpan.setAttribute('usage.cacheHitRate', hitRate);
        turnSpan.setAttribute('model', doneModel);
        if (lastReason) turnSpan.setAttribute('reason', lastReason);
      } catch { /* noop tracer 无 setAttribute */ }
      turnLogger.info('kernel.turn done', {
        status: turnStatus,
        reason: lastReason ?? 'unknown',
        model: doneModel,
        usage: { ...usage, promptTokens: prompt, cacheHitRate: hitRate },
      });
      turnSpan.end();
    }
  }

  /** AgentEvent → KernelEvent(累计 usage 副作用)。返回 null = 不映射(内部阶段事件)。 */
  private translate(ev: AgentEvent, usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheCreation: number }): KernelEvent | null {
    switch (ev.type) {
      case 'assistant': {
        const text = assistantText(ev.message);
        return text ? { kind: 'message.delta', role: 'assistant', text } : null;
      }
      case 'tool_call':
        return { kind: 'tool.call', callId: ev.toolUseId, name: ev.toolName, args: ev.input };
      case 'tool_result': {
        const p = ev.result.payload as { ok?: boolean; result?: unknown; isError?: boolean; message?: string };
        const ok = p.ok ?? !p.isError;
        // 非 ok 时带上 dispatch 写入的人类可读拒因/错误(errorEvent.message,含 plan 只读拒因)。
        return { kind: 'tool.result', callId: ev.toolUseId, ok, result: p.result, ...(ok ? {} : { error: p.message }) };
      }

      case 'stream': {
        const se = ev.event as ProviderStreamEvent;
        if (se.type === 'message_delta' && se.usage) {
          usage.outputTokens = se.usage.outputTokens ?? usage.outputTokens;
          usage.inputTokens = se.usage.inputTokens ?? usage.inputTokens;
          usage.cacheRead = se.usage.cacheReadInputTokens ?? usage.cacheRead;
          usage.cacheCreation = se.usage.cacheCreationInputTokens ?? usage.cacheCreation;
        }
        // 扩展思考增量 → thinking.delta(契约事件)。
        if (se.type === 'content_block_delta') {
          const d = se.delta as { type?: string; thinking?: string } | undefined;
          if (d && (d.type === 'thinking_delta' || typeof d.thinking === 'string') && d.thinking) {
            return { kind: 'thinking.delta', text: d.thinking };
          }
        }
        return null;
      }
      default:
        return null;
    }
  }

  openHandle(callId: string): TurnHandle {
    const agent = this.handles.get(callId);
    const setMode = (mode: PermissionMode): void => {
      const native = translateNeutral(mode);
      // 存到 kernel(让无 live handle / 下一轮新 agent 也带上),并改活当前 agent(本轮即生效)。
      this.currentMode = native;
      agent?.setMode(native);
    };
    // 与 setMode 同语义的外层箭头闭包(捕获 kernel 的 this;返回对象里的方法 this 是 TurnHandle)。
    const setModelFn = (model: ModelRef): void => {
      this.currentModel = model;
      agent?.setModel(model);
    };
    return {
      async setPermissionMode(mode: PermissionMode): Promise<void> {
        setMode(mode);
      },
      async setModel(model: ModelRef): Promise<void> {
        setModelFn(model);
      },
      async interrupt(): Promise<void> {
        agent?.abort('interrupt');
      },
      async cancel(): Promise<void> {
        agent?.abort('cancel');
      },
    };
  }

  async probe(): Promise<KernelHealth> {
    return { ok: true, kernelId: this.id, detail: 'forgeax-core native kernel' };
  }
}
