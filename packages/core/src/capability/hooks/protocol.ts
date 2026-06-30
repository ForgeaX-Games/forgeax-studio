/**
 * Hook stdin/stdout 线协议(③) —— hook 的 JSON wire format。
 *
 * hook I/O 约定:host 把一个 core 事件序列化成
 * **stdin JSON**(`HookInputJSON`)喂给 hook 命令;命令在 **stdout** 回吐一段
 * 决议 JSON,host 解析成 `HookDecision` 再回喂 `HookControl`(见 from-settings.ts)。
 *
 * 本文件只负责**形状翻译**(core 事件 ⇄ wire JSON),不 spawn、不读写磁盘
 * (那是 host 的 `HookCommandRunner` 的事)。fail-open 是铁律:空/非法 stdout 一律
 * 解析成 `{}`(放行),坏 hook 不得毒化总线。
 *
 * Boundary: 仅 import core-local 契约 + `node:` builtin(本文件无 node 依赖)。
 */
import type { CoreEvent } from '../../events/types';
import { CoreEventType } from '../../events/events';
import type { HookDecision } from './from-settings';

/**
 * 喂给 hook 命令的 stdin JSON(wire 形状)。
 *
 * `hook_event_name` 是 hook 侧的事件名(PreToolUse/PostToolUse/Stop/…);
 * 工具类字段(`tool_name`/`tool_input`/`tool_response`)与 `prompt` 视事件而定可缺省;
 * `session_id`/`cwd`/`transcript_path` 由 host 上下文补齐。开放成员允许 host 透传扩展键。
 */
export interface HookInputJSON {
  /** hook 事件名,如 'PreToolUse' / 'PostToolUse' / 'Stop' / 'UserPromptSubmit'。 */
  hook_event_name: string;
  /** 工具名(pre/post tool 事件携带)。 */
  tool_name?: string;
  /** 工具入参(PreToolUse 携带)。 */
  tool_input?: unknown;
  /** 工具结果(PostToolUse 携带)。 */
  tool_response?: unknown;
  /** 当前会话 id。 */
  session_id?: string;
  /** 工作目录。 */
  cwd?: string;
  /** transcript 路径(host 提供时透传)。 */
  transcript_path?: string;
  /** 用户 prompt 文本(UserPromptSubmit 携带)。 */
  prompt?: string;
  /** Stop/SubagentStop 重入标记(`stop_hook_active`):上一次 Stop hook
   *  阻止收尾导致 loop 续轮时为 true,供 hook 命令识别重入、避免无限阻止。 */
  stop_hook_active?: boolean;
  /** 开放扩展键,host 可透传额外字段。 */
  [k: string]: unknown;
}

/**
 * CoreEventType → hook 事件名 的反向映射。
 *
 * 注:`PostToolUse` 复用 `tool.result`(ToolCallResult);`Stop` 用专用 'stop' 事件。
 * 未列于此表的 core 事件类型,`eventToHookInput` 会回退到原始 `event.type` 作名字。
 */
const CORE_TO_bc_NAME: Record<string, string> = {
  [CoreEventType.ToolCallRequested]: 'PreToolUse',
  [CoreEventType.ToolCallResult]: 'PostToolUse',
  [CoreEventType.Stop]: 'Stop',
  [CoreEventType.SubagentStop]: 'SubagentStop',
  [CoreEventType.UserPromptSubmit]: 'UserPromptSubmit',
  [CoreEventType.SessionStart]: 'SessionStart',
  [CoreEventType.SessionEnd]: 'SessionEnd',
  [CoreEventType.PreCompact]: 'PreCompact',
  [CoreEventType.PostCompact]: 'PostCompact',
  [CoreEventType.Notification]: 'Notification',
};

/**
 * 把一个 core 事件翻译成 hook stdin JSON。
 *
 * - `hook_event_name`:查 `CORE_TO_bc_NAME`;未知则回退到 `event.type` 原样。
 * - 从 `event.payload` 上**就地**取 `toolName`/`input`/`result`/`prompt`(存在才填),
 *   分别落到 `tool_name`/`tool_input`/`tool_response`/`prompt`。
 * - `session_id`/`cwd` 由 `ctx` 注入(缺省不填)。
 *
 * @param event core 运行时事件
 * @param ctx   host 上下文(sessionId / cwd),可选
 * @returns wire stdin JSON
 */
export function eventToHookInput(
  event: CoreEvent,
  ctx?: { sessionId?: string; cwd?: string; transcriptPath?: string },
): HookInputJSON {
  const hookEventName = CORE_TO_bc_NAME[event.type] ?? event.type;
  const out: HookInputJSON = { hook_event_name: hookEventName };

  const payload = (event.payload ?? undefined) as
    | { toolName?: unknown; input?: unknown; result?: unknown; prompt?: unknown; stopHookActive?: unknown }
    | undefined;
  if (payload && typeof payload === 'object') {
    if (typeof payload.toolName === 'string') out.tool_name = payload.toolName;
    if (payload.input !== undefined) out.tool_input = payload.input;
    if (payload.result !== undefined) out.tool_response = payload.result;
    if (typeof payload.prompt === 'string') out.prompt = payload.prompt;
    // Stop/SubagentStop 重入标记(stop_hook_active)。
    if (payload.stopHookActive === true) out.stop_hook_active = true;
  }

  if (ctx?.sessionId !== undefined) out.session_id = ctx.sessionId;
  if (ctx?.cwd !== undefined) out.cwd = ctx.cwd;
  if (ctx?.transcriptPath !== undefined) out.transcript_path = ctx.transcriptPath;

  return out;
}

/** hook 命令在 stdout 回吐的决议 JSON(wire 形状)。 */
interface HookOutputJSON {
  /** 'block' → 拦截;'approve' → 显式放行(等价于不拦)。 */
  decision?: 'block' | 'approve';
  /** 拦截/决议理由。 */
  reason?: string;
  /** false → 中止后续(loop continue=false)。 */
  continue?: boolean;
  /** 注入给用户/上层的系统消息。 */
  systemMessage?: string;
  /** hook 专属输出;`additionalContext` 会被并进上下文;
   *  `permissionDecision`(allow/deny/ask)= PreToolUse 权限三态。 */
  hookSpecificOutput?: {
    additionalContext?: string;
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    [k: string]: unknown;
  };
}

/**
 * 解析 hook 命令的 stdout 成 `HookDecision`。
 *
 * 映射规则:
 * - `decision === 'block'` → `{ block: true, reason }`。
 * - `continue === false` → `{ continue: false }`(additive 字段,H2 加宽)。
 * - `hookSpecificOutput.additionalContext` → `{ additionalContext }`。
 * - `systemMessage` → `{ systemMessage }`。
 *
 * **fail-open 铁律**:空 stdout、纯空白、或非 JSON 文本 → 返回 `{}`(放行)。
 * 对尾随空白 / 半截输出鲁棒(trim 后再 parse,parse 抛错即吞掉)。
 *
 * @param stdout hook 命令的标准输出
 * @returns 解析后的决议(空 = 放行)
 */
export function parseHookOutput(stdout: string): HookDecision {
  if (typeof stdout !== 'string') return {};
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return {};

  let parsed: HookOutputJSON;
  try {
    parsed = JSON.parse(trimmed) as HookOutputJSON;
  } catch {
    return {}; // 非 JSON / 半截输出 → 放行
  }
  if (parsed == null || typeof parsed !== 'object') return {};

  // HookDecision 被 H2 additive 加宽(continue/additionalContext/systemMessage),
  // 故此处用宽松形状装配,避免与 from-settings 的窄声明耦合。
  const decision: HookDecision & {
    continue?: boolean;
    additionalContext?: string;
    systemMessage?: string;
    permissionDecision?: 'allow' | 'deny' | 'ask';
  } = {};

  if (parsed.decision === 'block') {
    decision.block = true;
    if (typeof parsed.reason === 'string') decision.reason = parsed.reason;
  }
  if (parsed.continue === false) decision.continue = false;
  const addl = parsed.hookSpecificOutput?.additionalContext;
  if (typeof addl === 'string') decision.additionalContext = addl;
  if (typeof parsed.systemMessage === 'string') decision.systemMessage = parsed.systemMessage;

  // PreToolUse 权限三态(`hookSpecificOutput.permissionDecision`):
  //   deny → 同时落 block(reason 取 permissionDecisionReason);allow/ask → 仅置 permissionDecision。
  const pd = parsed.hookSpecificOutput?.permissionDecision;
  if (pd === 'allow' || pd === 'deny' || pd === 'ask') {
    decision.permissionDecision = pd;
    if (pd === 'deny') {
      decision.block = true;
      const reason = parsed.hookSpecificOutput?.permissionDecisionReason;
      if (typeof reason === 'string' && decision.reason == null) decision.reason = reason;
    }
  }

  return decision;
}
