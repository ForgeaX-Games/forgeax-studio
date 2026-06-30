/**
 * S3 —— 子 agent 终态事件 + 子结果预算兜底。
 *
 * 两件互补的小事:
 *   1. `emitSubagentStop` —— 在子 agent 跑完时往 EventBus 发一条
 *      `subagent.stop`(CoreEventType.SubagentStop)事件。父侧 hook 可借此
 *      做汇聚/审计/preventStop 之类的处理(返回经 hook 修改后的事件)。
 *   2. `budgetSubagentResult` —— 复用全局 tool-result 预算门,给「父读子结果」
 *      这一汇聚点上一道兜底,防止一个巨大的子 agent 输出把父窗炸了。
 *
 * 本文件只依赖 core-local 相对路径,不引外部包(满足 Boundary 铁律);也不碰
 * subagent.ts(并行 anti-conflict 契约)。
 */
import type { CoreEvent, EventBusAPI } from '../events/types';
import { CoreEventType } from '../events/events';
import { applyResultBudget } from '../context/tool-result-budget';

/**
 * `subagent.stop` 事件的 payload。
 *
 * 字段全部可选,以便调用方按掌握的信息渐进填充:
 *   - `agentId`    子 agent 标识(亦用作发出事件的 `source`)。
 *   - `agentType`  子 agent 类型/persona 名。
 *   - `terminalReason` 终态原因(对齐 TerminalReason 语义:completed / aborted …)。
 *   - `turns`      子 agent 跑了多少轮。
 *   - `toolCalls`  子 agent 期间发起的工具调用数。
 */
export interface SubagentStopPayload {
  agentId?: string;
  agentType?: string;
  terminalReason?: string;
  turns?: number;
  toolCalls?: number;
}

/**
 * 往 EventBus 发一条子 agent 终态事件(`subagent.stop`)。
 *
 * 同步 publish —— 订阅者按注册顺序串行跑,可 `block`/`modify`;返回**经 hook
 * 修改后**的事件(与 EventBus.publish 语义一致)。事件 `source` 取 payload.agentId,
 * 方便消费方按子 agent 归因。
 *
 * @param bus     core 单 agent hook 总线。
 * @param payload 子 agent 终态信息(见 SubagentStopPayload,字段均可选)。
 * @returns 经 hook 可能改写后的 CoreEvent。
 */
export function emitSubagentStop(bus: EventBusAPI, payload: SubagentStopPayload): CoreEvent {
  const event: CoreEvent<SubagentStopPayload> = {
    type: CoreEventType.SubagentStop,
    payload,
    ts: Date.now(),
    source: payload.agentId,
  };
  return bus.publish(event);
}

/**
 * `subagent.start` 事件的 payload(对齐 events.ts CoreEventPayloads)。
 *   - `agentId`    子 agent 标识(亦用作发出事件的 `source`)。
 *   - `agentType`  子 agent 类型/persona 名。
 *   - `role`       子 agent 角色标识(供 host 路由/展示)。
 *   - `depth`      递归深度(父=0,逐层 +1)。
 */
export interface SubagentStartPayload {
  agentId: string;
  agentType?: string;
  role?: string;
  depth?: number;
}

/**
 * 往 EventBus 发一条子 agent 启动事件(`subagent.start`)。
 *
 * 在子 loop fork 出来、进入 run 之前发,携类型/角色/深度。语义与 `emitSubagentStop`
 * 一致:同步 publish,`source` 取 payload.agentId,返回经 hook 可能改写后的事件。
 *
 * @param bus     core 单 agent hook 总线。
 * @param payload 子 agent 启动信息(见 SubagentStartPayload)。
 * @returns 经 hook 可能改写后的 CoreEvent。
 */
export function emitSubagentStart(bus: EventBusAPI, payload: SubagentStartPayload): CoreEvent {
  const event: CoreEvent<SubagentStartPayload> = {
    type: CoreEventType.SubagentStart,
    payload,
    ts: Date.now(),
    source: payload.agentId,
  };
  return bus.publish(event);
}

/**
 * `subagent.turn` 事件的 payload(对齐 events.ts CoreEventPayloads)。
 *   - `agentId` 子 agent 标识(亦用作 `source`)。
 *   - `turn`    本次进入的轮号。
 *   - `depth`   递归深度。
 */
export interface SubagentTurnPayload {
  agentId: string;
  turn: number;
  depth?: number;
}

/**
 * 往 EventBus 发一条子 agent 进轮事件(`subagent.turn`)。
 *
 * 子 loop 每进入新一轮时发,携轮号/深度。语义同上(同步 publish,`source`=agentId)。
 *
 * @param bus     core 单 agent hook 总线。
 * @param payload 子 agent 进轮信息(见 SubagentTurnPayload)。
 * @returns 经 hook 可能改写后的 CoreEvent。
 */
export function emitSubagentTurn(bus: EventBusAPI, payload: SubagentTurnPayload): CoreEvent {
  const event: CoreEvent<SubagentTurnPayload> = {
    type: CoreEventType.SubagentTurn,
    payload,
    ts: Date.now(),
    source: payload.agentId,
  };
  return bus.publish(event);
}

/**
 * `subagent.tool_call` 事件的 payload(对齐 events.ts CoreEventPayloads)。
 *   - `agentId`   子 agent 标识(亦用作 `source`)。
 *   - `toolName`  被调用的工具名。
 *   - `toolUseId` 工具调用 id。
 *   - `turn`      调用发生在第几轮(可选)。
 *   - `depth`     递归深度(可选)。
 */
export interface SubagentToolCallPayload {
  agentId: string;
  toolName: string;
  toolUseId: string;
  turn?: number;
  depth?: number;
}

/**
 * 往 EventBus 发一条子 agent 工具调用事件(`subagent.tool_call`)。
 *
 * 子 loop 每调一次工具时发,携工具名/toolUseId/轮号/深度。语义同上。
 *
 * @param bus     core 单 agent hook 总线。
 * @param payload 子 agent 工具调用信息(见 SubagentToolCallPayload)。
 * @returns 经 hook 可能改写后的 CoreEvent。
 */
export function emitSubagentToolCall(bus: EventBusAPI, payload: SubagentToolCallPayload): CoreEvent {
  const event: CoreEvent<SubagentToolCallPayload> = {
    type: CoreEventType.SubagentToolCall,
    payload,
    ts: Date.now(),
    source: payload.agentId,
  };
  return bus.publish(event);
}

/**
 * 子 agent 结果预算兜底。复用 `applyResultBudget(text, max)`,返回其 `output`:
 *   - `max === Infinity`(或任何非有限值)/ 未超阈值 → 原样返回(零回归);
 *   - 超阈值 → head-tail 预览(保头 80% + marker + 保尾 20%)。
 *
 * 用在「父 agent 读子 agent 结果」这一汇聚点,防止巨型子结果灌爆父上下文窗。
 *
 * @param text 子 agent 的全量结果文本。
 * @param max  字符上限;Infinity 表示永不裁。
 * @returns 预算后(可能被裁)的文本。
 */
export function budgetSubagentResult(text: string, max: number): string {
  return applyResultBudget(text, max).output;
}
