/**
 * Settings-driven hook loader (②) — wire a settings-style hooks config onto the EventBus.
 *
 * 从一份 settings 形状的 hooks 配置
 *   { PreToolUse: [{ matcher, command }], PostToolUse: [...], Stop: [...] }
 * 把每条 hook 订阅到 core EventBus 对应事件上。命中时调注入的 **同步** `runHook`
 * 执行命令并拿决议(block/modify),回喂 `HookControl`。
 *
 * 为何 runHook 必须同步:core EventBus.publish 是同步串行(§6.2),pre-tool 的 block
 * 闸在 publish 返回后立即读 `event.blocked`。故命令执行须同步完成(host 用
 * `Bun.spawnSync` 实现)——core 本身不 spawn(boundary)。
 *
 * Boundary: 仅 import core-local 契约。
 */
import type { CoreEvent, EventBusAPI, Unsubscribe, HookControl } from '../../events/types';
import { CoreEventType } from '../../events/events';

/**
 * host 执行 hook 命令后的决议(hook 结构化输出)。
 *
 * 字段语义:
 *  - `block`/`reason`:阻断本事件传播(ctl.block),pre-tool 闸据此拒绝调用。
 *  - `modify`:对事件做 shallow patch(ctl.modify),后续订阅者可见。
 *  - `additionalContext`:要注入「下一轮 prompt」的附加上下文。loop 从 publish
 *    回执的 `event.additionalContext` 读出并拼进下轮提示。
 *  - `systemMessage`:要展示给用户/写进 system 通道的一段消息;loop 从回执
 *    `event.systemMessage` 读出。
 *  - `continue`:`false` = 请求 loop 停下(不再继续轮转)。落到回执的
 *    `event.continueLoop`(=false 时);loop 读到 `continueLoop===false` 即停。
 */
export interface HookDecision {
  /** true → ctl.block(reason)。 */
  block?: boolean;
  reason?: string;
  /** 对事件 payload 的修改(ctl.modify)。 */
  modify?: Partial<CoreEvent>;
  /** 注入到下一轮 prompt 的附加上下文(structured output `additionalContext`)。 */
  additionalContext?: string;
  /** 展示/写入 system 通道的一段消息(structured output `systemMessage`)。 */
  systemMessage?: string;
  /** false = 请求 loop 停止继续轮转(structured output `continue`)。 */
  continue?: boolean;
  /**
   * PreToolUse 权限三态(`hookSpecificOutput.permissionDecision`):
   *  - `allow` → 旁路权限引擎,直接放行该工具(免审批卡)。
   *  - `deny`  → 拒绝(等价 block;loadHooksFromSettings 会同时置 block)。
   *  - `ask`   → 强制走交互式审批(即便引擎判 allow 也要问)。
   * 仅 PreToolUse(ToolCallRequested)事件有意义;其余事件忽略。
   */
  permissionDecision?: 'allow' | 'deny' | 'ask';
}

/** host 注入的同步命令执行器(用 Bun.spawnSync 等)。返回决议或 void(=放行)。 */
export type HookCommandRunner = (command: string, event: CoreEvent) => HookDecision | void;

export interface HookMatcherEntry {
  /** 匹配器(对工具名做子串/正则匹配);省略=匹配该事件全部。 */
  matcher?: string;
  /** 要执行的命令。 */
  command: string;
}

/** settings 形状:事件名 → 匹配组。事件名支持 hook 别名或原始 CoreEventType 串。 */
export type HooksSettings = Record<string, HookMatcherEntry[]>;

/** hook 事件名 → core 事件类型。未列的名按原样当 CoreEventType 串处理。 */
const EVENT_ALIAS: Record<string, string> = {
  PreToolUse: CoreEventType.ToolCallRequested,
  PostToolUse: CoreEventType.ToolCallResult,
  // Stop 现在映射到专用 'stop' 事件(不再复用 TurnEnd)。
  Stop: CoreEventType.Stop,
  TurnStart: CoreEventType.TurnStart,
  TurnEnd: CoreEventType.TurnEnd,
  // ★ 生命周期事件别名。
  SessionStart: CoreEventType.SessionStart,
  SessionEnd: CoreEventType.SessionEnd,
  UserPromptSubmit: CoreEventType.UserPromptSubmit,
  PreCompact: CoreEventType.PreCompact,
  Notification: CoreEventType.Notification,
  SubagentStop: CoreEventType.SubagentStop,
};

function resolveEventType(name: string): string {
  return EVENT_ALIAS[name] ?? name;
}

/** 取事件上可被 matcher 匹配的字符串:
 *  - pre/post tool 事件 → `toolName`(matcher 对工具名做正则/子串);
 *  - PreCompact 事件 → `trigger`(`manual`/`auto` matcher)。 */
function eventMatchKey(event: CoreEvent): string | undefined {
  const p = event.payload as { toolName?: string; trigger?: string } | undefined;
  if (typeof p?.toolName === 'string') return p.toolName;
  // PreCompact:按压缩触发方式(auto/manual)匹配。
  if (event.type === CoreEventType.PreCompact && typeof p?.trigger === 'string') return p.trigger;
  return undefined;
}

function matcherHits(matcher: string | undefined, event: CoreEvent): boolean {
  if (!matcher) return true; // 无 matcher = 匹配该事件全部
  const key = eventMatchKey(event);
  if (key == null) return true; // 无可匹配键的事件:matcher 不再细分,直接命中
  try {
    return new RegExp(matcher).test(key);
  } catch {
    return key.includes(matcher); // 非法正则 → 退化子串
  }
}

/**
 * 把 hooks settings 挂上 EventBus。返回一个 Unsubscribe,解除全部订阅。
 *
 * @param bus     core EventBus
 * @param settings settings 形状 hooks 配置
 * @param runHook  host 注入的**同步**命令执行器
 */
export function loadHooksFromSettings(
  bus: EventBusAPI,
  settings: HooksSettings,
  runHook: HookCommandRunner,
): Unsubscribe {
  const unsubs: Unsubscribe[] = [];
  for (const [name, entries] of Object.entries(settings)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const eventType = resolveEventType(name);
    const unsub = bus.subscribe(eventType, (event: CoreEvent, ctl: HookControl) => {
      for (const entry of entries) {
        if (!entry?.command) continue;
        if (!matcherHits(entry.matcher, event)) continue;
        let decision: HookDecision | void;
        try {
          decision = runHook(entry.command, event);
        } catch {
          continue; // fail-soft:坏 hook 不毒化总线传播
        }
        if (!decision) continue;
        if (decision.modify) ctl.modify(decision.modify);
        // ★ 把 structured output 字段合并到事件上,供 loop 从 publish 回执读取。
        //   additionalContext/systemMessage 原样透传;continue===false 落成
        //   continueLoop:false(loop 读到即停)。
        const extra: Partial<CoreEvent> & {
          additionalContext?: string;
          systemMessage?: string;
          continueLoop?: boolean;
          permissionDecision?: 'allow' | 'deny' | 'ask';
        } = {};
        if (decision.additionalContext != null) extra.additionalContext = decision.additionalContext;
        if (decision.systemMessage != null) extra.systemMessage = decision.systemMessage;
        if (decision.continue === false) extra.continueLoop = false;
        // PreToolUse 权限三态:合到事件回执,dispatch 经 preToolPermission 读出。
        //   'deny' 同时落 block(与既有 isBlocked 闸一致);'allow'/'ask' 仅置 permissionDecision。
        if (decision.permissionDecision != null) extra.permissionDecision = decision.permissionDecision;
        if (Object.keys(extra).length > 0) ctl.modify(extra);
        if (decision.block || decision.permissionDecision === 'deny') {
          ctl.block(decision.reason);
          return; // 已 block,后续 entry 无意义
        }
      }
    });
    unsubs.push(unsub);
  }
  return () => {
    for (const u of unsubs) u();
  };
}
