/**
 * Builtin multi-agent collaboration tools (②) — `SendMessage` + `Handoff`.
 *
 * 两块「多 agent 协作」缝:
 *   1. **SendMessage**:给模型一个往同伴 agent 发点对点消息的工具。
 *      - **team 形态(executor 注入)**:经注入的 `TeammateExecutor.sendMessage` **真投递**
 *        进目标成员 mailbox(数据面 text 平面),`delivered` 据目标在册(`isActive`)判定。
 *        寻址(§13.1#7 / D-7):`to=name` → 该成员;`to='*'` → **显式**广播给同 team 其余
 *        成员;`to='coordinator'` → coordinator;**`to` 缺省 → 路由到父/coordinator,
 *        二者皆未知则返回 `delivered:false` 结构化报错 —— 绝不默认广播**(显式失败 > 静默)。
 *      - **退化形态(无 executor)**:退回往注入的 EventBus publish 一条 `agent.message`
 *        事件,由 host 路由(旧路径,保留以不回归)。bus 也无 → `delivered:false` 明确错误
 *        (绝不静默丢)。executor 注入时仍 best-effort 旁路 publish 一条 `agent.message`
 *        作可观测,不影响投递判定。
 *   2. **Handoff**:给模型一个发出 handoff 意图的工具(spawn_child / pop_self / sleep /
 *      resume_target / abort)。core 的 loop 在 handoff_decision 阶段读取该工具结果里的
 *      intent,再 `await HandoffSink.declare(intent)` 交给 host 调度器裁决。Handoff 工具
 *      本身**不**直接调 sink——它只把意图打进结果 payload,保持工具纯净 + 让 loop 单点管控
 *      控制流(对齐 §4.2 HandoffSink:core 声明意图,host 决定何时执行/唤醒)。
 *
 * Boundary: 仅 import core-local 契约。
 */
import type { CoreEvent } from '../../events/types';
import type { EventBusAPI } from '../../events/types';
import { CoreEventType } from '../../events/events';
import type { HandoffIntent, AgentSpec, SleepCondition, TeammateExecutor } from '../../inject/types';
import type { TeamMessage } from '../../agent/team/team-message';
import { buildTool, type AgentTool, type ToolContext } from '../types';

// ─── SendMessage ────────────────────────────────────────────────────────────

export interface SendMessageInput {
  /** 目标成员名。`'*'` = 显式广播;`'coordinator'` = coordinator;缺省 → 路由父/coordinator
   *  或结构化报错(**绝不默认广播**,§13.1#7 / D-7)。 */
  to?: string;
  /** 消息体(文本或结构化对象)。 */
  content: unknown;
  /** 可选:关联上一条消息(线程化)。 */
  replyTo?: string;
}

export interface SendMessageOutput {
  delivered: boolean;
  to?: string;
  message?: string;
}

export interface SendMessageOptions {
  /** 注入的多 agent 总线;缺省时退回 `ToolContext.bus`(host 在 toolContext 上挂)。 */
  bus?: EventBusAPI;
  /** team 投递接缝:注入后 SendMessage 经它真投递进目标 mailbox(数据面 text 平面)。
   *  缺省 → 退回 bus publish(旧路径,§9 Graceful Degradation:无 executor 不崩)。 */
  executor?: TeammateExecutor;
  /** coordinator 成员名(`to='coordinator'` / `to` 缺省时的寻址目标)。 */
  coordinatorId?: string;
  /** 本 agent 的父成员名(`to` 缺省时优先路由到父;无父则退 coordinator)。 */
  parentId?: string;
}

/**
 * 从 ToolContext 取多 agent 总线:显式 opts.bus 优先,否则取 host 挂在 ctx 上的 `bus`。
 * 两处皆无 → null(call 返回明确错误)。
 */
function resolveBus(opts: SendMessageOptions, ctx: ToolContext): EventBusAPI | null {
  if (opts.bus) return opts.bus;
  const fromCtx = (ctx as { bus?: unknown }).bus;
  if (fromCtx && typeof (fromCtx as EventBusAPI).publish === 'function') return fromCtx as EventBusAPI;
  return null;
}

/** `content` 规整成数据面 TeamMessage 的 text(对象 → JSON 串)。 */
function contentToText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/**
 * 解析 `to` 缺省寻址(§13.1#7 / D-7):返回最终目标名,或 `null` 表示「无可路由目标」
 * (调用方据此返回 delivered:false 结构化报错,**不**默认广播)。`'*'` 原样返回(广播标记)。
 */
function resolveTarget(to: string | undefined, opts: SendMessageOptions): string | null {
  if (to === '*') return '*'; // 显式广播。
  if (to === 'coordinator') return opts.coordinatorId ?? null;
  if (typeof to === 'string' && to.length > 0) return to; // to=name。
  // to 缺省:优先父,退 coordinator;二者皆未知 → null(结构化报错,不广播)。
  return opts.parentId ?? opts.coordinatorId ?? null;
}

export function sendMessageTool(opts: SendMessageOptions = {}): AgentTool<SendMessageInput, SendMessageOutput> {
  return buildTool<SendMessageInput, SendMessageOutput>({
    name: 'SendMessage',
    aliases: ['send_message'],
    searchHint: 'send a message to another agent (peer name / coordinator / explicit * broadcast)',
    inputJSONSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description:
            "Target member name. '*' = explicit broadcast to other team members; 'coordinator' = the team coordinator; omitted = route to parent/coordinator (never silently broadcasts).",
        },
        content: { description: 'Message body — text or a structured object.' },
        replyTo: { type: 'string', description: 'Optional id of the message this replies to.' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    maxResultSizeChars: 4_000,
    // 发消息有外部副作用(进 mailbox / 总线),保守不并发安全;非只读。
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    async call(input, ctx): Promise<{ data: SendMessageOutput }> {
      const from = ctx.agentId ?? '';
      const bus = resolveBus(opts, ctx);

      // ── team 形态:executor 真投递进目标 mailbox(数据面 text 平面)──────────────
      if (opts.executor) {
        const target = resolveTarget(input.to, opts);
        if (!target) {
          // to 缺省且无父/coordinator 可路由 → 结构化报错(绝不默认广播,AC-13 / D-7)。
          return {
            data: {
              delivered: false,
              to: input.to,
              message:
                "no target resolved: 'to' omitted and no parent/coordinator known. Pass an explicit member name, 'coordinator', or '*' to broadcast.",
            },
          };
        }
        const text = contentToText(input.content);
        if (target === '*') {
          // 显式广播:投给所有在册成员(除自己)。delivered = 至少投到一个。
          const members = opts.executor.listMembers ? opts.executor.listMembers() : [];
          const peers = members.filter((m) => m !== from);
          if (peers.length === 0) {
            return { data: { delivered: false, to: '*', message: 'no other team members to broadcast to' } };
          }
          for (const peer of peers) {
            const msg: TeamMessage = { kind: 'text', from, to: peer, text };
            await opts.executor.sendMessage(peer, msg);
          }
          if (bus) publishObservability(bus, from, '*', input.content, input.replyTo);
          return { data: { delivered: true, to: '*' } };
        }
        // 点对点:目标须在册(isActive),否则 delivered:false 结构化(投不达,AC-13)。
        if (!opts.executor.isActive(target)) {
          return {
            data: {
              delivered: false,
              to: target,
              message: `target '${target}' is not an active team member (unknown or terminated).`,
            },
          };
        }
        const msg: TeamMessage = { kind: 'text', from, to: target, text };
        await opts.executor.sendMessage(target, msg);
        if (bus) publishObservability(bus, from, target, input.content, input.replyTo);
        return { data: { delivered: true, to: target } };
      }

      // ── 退化形态:无 executor → 旧 bus publish 路径(host 路由)。bus 也无 → 明确错误 ──
      if (!bus) {
        return { data: { delivered: false, to: input.to, message: 'no message bus available' } };
      }
      bus.publish({
        type: CoreEventType.AgentMessage,
        payload: { from, to: input.to, content: input.content, replyTo: input.replyTo },
        ts: Date.now(),
        source: from,
      } as CoreEvent);
      return { data: { delivered: true, to: input.to } };
    },
    mapResult: (o, id): CoreEvent => ({
      type: CoreEventType.ToolCallResult,
      payload: {
        toolUseId: id,
        isError: !o.delivered,
        result: o.delivered
          ? `Message sent${o.to ? ` to ${o.to}` : ''}.`
          : `Message not sent: ${o.message ?? 'unknown reason'}`,
      },
      ts: Date.now(),
    }),
  });
}

/** executor 真投递后旁路 publish 一条 `agent.message`(可观测;不影响投递判定)。 */
function publishObservability(
  bus: EventBusAPI,
  from: string,
  to: string,
  content: unknown,
  replyTo: string | undefined,
): void {
  bus.publish({
    type: CoreEventType.AgentMessage,
    payload: { from, to, content, replyTo },
    ts: Date.now(),
    source: from,
  } as CoreEvent);
}

// ─── Handoff ─────────────────────────────────────────────────────────────────

export interface HandoffInput {
  /** 意图类型(对齐 inject HandoffIntent.kind)。 */
  kind: 'spawn_child' | 'pop_self' | 'sleep' | 'resume_target' | 'abort';
  /** spawn_child:子 agent 规格。 */
  spec?: AgentSpec;
  /** spawn_child:fg(前台,父等子结果)/ bg(后台,父续跑)。缺省 fg。 */
  mode?: 'fg' | 'bg';
  /** pop_self:返回给父/调度器的结果。 */
  result?: unknown;
  /** sleep:唤醒条件(event/timer)。 */
  until?: SleepCondition;
  /** resume_target:要恢复的目标 agentId。 */
  agentId?: string;
  /** abort:中止原因。 */
  reason?: string;
}

/**
 * Handoff 工具结果 payload 上携带的标记键 —— loop 据此从结果里取出 intent。
 * 取此名以避免与一般工具结果字段撞车。
 */
export const HANDOFF_INTENT_KEY = '__handoffIntent' as const;

export interface HandoffOutput {
  accepted: boolean;
  intent?: HandoffIntent;
  message?: string;
}

/** 把工具输入规整成一条合法 HandoffIntent;字段缺失/类型错 → null(call 返回拒绝)。 */
export function normalizeHandoffIntent(input: HandoffInput): HandoffIntent | null {
  switch (input.kind) {
    case 'spawn_child':
      if (!input.spec || typeof input.spec !== 'object') return null;
      return { kind: 'spawn_child', spec: input.spec, mode: input.mode === 'bg' ? 'bg' : 'fg' };
    case 'pop_self':
      return { kind: 'pop_self', result: input.result };
    case 'sleep':
      if (!input.until || typeof input.until !== 'object') return null;
      return { kind: 'sleep', until: input.until };
    case 'resume_target':
      if (typeof input.agentId !== 'string' || input.agentId.length === 0) return null;
      return { kind: 'resume_target', agentId: input.agentId };
    case 'abort':
      return { kind: 'abort', reason: typeof input.reason === 'string' ? input.reason : '' };
    default:
      return null;
  }
}

export function handoffTool(): AgentTool<HandoffInput, HandoffOutput> {
  return buildTool<HandoffInput, HandoffOutput>({
    name: 'Handoff',
    aliases: ['handoff'],
    searchHint: 'hand off control: spawn a child agent, pop self, sleep, resume a target, or abort',
    inputJSONSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['spawn_child', 'pop_self', 'sleep', 'resume_target', 'abort'],
          description: 'The handoff intent kind.',
        },
        spec: { type: 'object', description: 'spawn_child: the child agent spec (type/cwd/requirement/...).' },
        mode: { type: 'string', enum: ['fg', 'bg'], description: 'spawn_child: foreground (await child) or background.' },
        result: { description: 'pop_self: the result to return to the parent/scheduler.' },
        until: { type: 'object', description: 'sleep: the wakeup condition (event/timer).' },
        agentId: { type: 'string', description: 'resume_target: the agent id to resume.' },
        reason: { type: 'string', description: 'abort: the reason for aborting.' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    maxResultSizeChars: Infinity,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    async call(input): Promise<{ data: HandoffOutput }> {
      const intent = normalizeHandoffIntent(input);
      if (!intent) {
        return { data: { accepted: false, message: `invalid handoff intent for kind=${input.kind}` } };
      }
      return { data: { accepted: true, intent } };
    },
    // intent 打进结果 payload 的专用键,loop 在 handoff_decision 阶段取出并 declare。
    mapResult: (o, id): CoreEvent => ({
      type: CoreEventType.ToolCallResult,
      payload: {
        toolUseId: id,
        isError: !o.accepted,
        result: o.accepted
          ? `Handoff intent (${o.intent?.kind}) recorded; awaiting scheduler.`
          : `Handoff rejected: ${o.message ?? 'invalid intent'}`,
        ...(o.accepted && o.intent ? { [HANDOFF_INTENT_KEY]: o.intent } : {}),
      },
      ts: Date.now(),
    }),
  });
}

/** 多 agent 协作工具聚合包(builtin 层):SendMessage + Handoff。 */
export function messageToolsPack(opts: SendMessageOptions = {}) {
  return {
    name: 'message-tools',
    layer: 'builtin' as const,
    tools: [sendMessageTool(opts), handoffTool()],
  };
}
