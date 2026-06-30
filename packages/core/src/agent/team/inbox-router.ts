/**
 * inbox-router —— team mailbox「一信道两平面」的消费侧分流(设计 §13.1#3)。
 *
 * 一块 mailbox 同时承载两个平面,本文件按 `TeamMessage.kind` 把它们分开:
 *   - **数据面**(`text`):合成 `ProviderMessage`(user 轮),返回给 host 注入的
 *     `CoreAgentOptions.inbox` 接缝 —— 即 agent.ts:758 既有 drain 机制,进 LLM 下一回合输入。
 *   - **控制面**(其余 7 种):经 `onControl(msg)` 派进 handler,**绝不**进数据面返回值。
 *
 * ★ AC-08 铁律(plan-strategy D-2 读法 A):数据面复用 agent.ts:758 既有 `this.o.inbox`
 *   接缝——本文件产的 `inbox` 闭包由 **host**(cli/peer.ts)挂到 agent opts,**不改 agent.ts
 *   的 queryLoop**。控制面是独立于 `this.o.inbox` 的第二条路径(在闭包内部 drain 时分流,
 *   控制面消息被 `onControl` 消费、不进返回数组),同样不碰 queryLoop。
 *
 * ★ AC-01 应用点:`routeTeamMessage` 的穷尽 `switch(msg.kind)` —— 每个 case 内 `msg` 被
 *   TS narrow 到对应成员(无 `as` 断言),`default` 命中 `const _never: never = msg`
 *   (TeamMessage 漏成员 / 新增未处理成员 → **编译失败**)。这是 8 成员 union 类型安全的兑现处。
 *
 * Boundary: 仅 core 相对 type-only import(team-message + provider 类型 + inject mailbox)。
 */
import type {
  TeamMessage,
  TextMessage,
  IdleNotificationMessage,
  PermissionRequestMessage,
  PermissionResponseMessage,
  PlanApprovalMessage,
  ShutdownMessage,
  TaskAssignmentMessage,
  ModeSetMessage,
} from './team-message';
import type { ProviderMessage } from '../../provider/types';
import type { Mailbox } from '../../inject/in-process-teammate-executor';

/** 控制面消息的 handler 集合(全可选;缺省 → 该 kind best-effort 落到通用 `onControl`)。
 *  本轮(M2)只断言「控制面进 handler、不进数据面」;各 handler 的业务分发是后续阶段的事。 */
export interface ControlPlaneHandlers {
  /** 通用兜底:任何控制面消息都先经此(captured / 可观测)。 */
  onControl?: (msg: TeamMessage) => void;
  onIdleNotification?: (msg: IdleNotificationMessage) => void;
  onPermissionRequest?: (msg: PermissionRequestMessage) => void;
  onPermissionResponse?: (msg: PermissionResponseMessage) => void;
  onPlanApproval?: (msg: PlanApprovalMessage) => void;
  onShutdown?: (msg: ShutdownMessage) => void;
  onTaskAssignment?: (msg: TaskAssignmentMessage) => void;
  onModeSet?: (msg: ModeSetMessage) => void;
}

/** 一条 text 数据面消息合成 user 轮 ProviderMessage(对照 cc attachment 注入)。
 *  带 `from` 前缀,让模型知道是谁投来的(寻址可见性)。 */
function textToProviderMessage(msg: TextMessage): ProviderMessage {
  const prefix = msg.from ? `[message from ${msg.from}] ` : '';
  return { role: 'user', content: `${prefix}${msg.text}` };
}

/**
 * 路由一条 TeamMessage —— AC-01 穷尽 switch 应用点。
 *   - 数据面 `text`:返回合成的 ProviderMessage(进 LLM)。
 *   - 控制面其余 7 种:派进 handler,返回 `null`(不进数据面)。
 * `default` 的 `never` 守卫保证 union 漏成员则编译失败。
 */
export function routeTeamMessage(msg: TeamMessage, handlers: ControlPlaneHandlers): ProviderMessage | null {
  switch (msg.kind) {
    case 'text':
      // 数据面:唯一进 LLM 的 kind。
      return textToProviderMessage(msg);
    case 'idle_notification':
      handlers.onControl?.(msg);
      handlers.onIdleNotification?.(msg);
      return null;
    case 'permission_request':
      handlers.onControl?.(msg);
      handlers.onPermissionRequest?.(msg);
      return null;
    case 'permission_response':
      handlers.onControl?.(msg);
      handlers.onPermissionResponse?.(msg);
      return null;
    case 'plan_approval':
      handlers.onControl?.(msg);
      handlers.onPlanApproval?.(msg);
      return null;
    case 'shutdown':
      handlers.onControl?.(msg);
      handlers.onShutdown?.(msg);
      return null;
    case 'task_assignment':
      handlers.onControl?.(msg);
      handlers.onTaskAssignment?.(msg);
      return null;
    case 'mode_set':
      handlers.onControl?.(msg);
      handlers.onModeSet?.(msg);
      return null;
    default: {
      // AC-01:穷尽守卫 —— TeamMessage 漏成员 / 新增未处理成员则此处编译失败。
      const _never: never = msg;
      void _never;
      return null;
    }
  }
}

export interface BuildInboxClosureOpts extends ControlPlaneHandlers {
  /** 本成员 id(从 mailbox 里 drain 投给「自己」的消息)。 */
  self: string;
  /** 共享 mailbox(InProcessTeammateExecutor.mailbox)。 */
  mailbox: Pick<Mailbox, 'drain'>;
}

/**
 * 构造 `inbox: () => ProviderMessage[]` 闭包 —— host(cli/peer.ts)把它挂到子 agent 的
 * `CoreAgentOptions.inbox`,agent.ts:758 每 turn 顶部 drain 一次。
 *
 * 闭包语义:drain 本成员 mailbox → 逐条经 `routeTeamMessage` 分流 → text 收进返回数组、
 * 控制面落 handler。返回的全是数据面 ProviderMessage(控制面已被 handler 吃掉,不污染 LLM)。
 */
export function buildInboxClosure(opts: BuildInboxClosureOpts): () => ProviderMessage[] {
  const { self, mailbox, ...handlers } = opts;
  return () => {
    const drained = mailbox.drain(self);
    if (drained.length === 0) return [];
    const out: ProviderMessage[] = [];
    for (const msg of drained) {
      const pm = routeTeamMessage(msg, handlers);
      if (pm) out.push(pm);
    }
    return out;
  };
}
