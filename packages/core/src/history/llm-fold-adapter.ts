/**
 * LLM fold adapter — 把 EventStore 里的事件流投影成 provider messages,供「开机回放」
 * (resume/replay)在新 createAgent 时重建对话历史(设计稿 §3.8.7 / §6.1:事件流是真相,
 * messages 是 fold 派生)。
 *
 * 这是 `FoldAdapter<ProviderMessage>` 的具体实现:它认得 loop 真正落进 store 的那几类
 * 会话事件——
 *   - `user_prompt.submit`(UserPromptSubmit) → 一条 user 文本消息(本轮用户输入)。
 *   - `assistant.message`(loop 自吐的字面量类型,见 agent.ts:520) → 一条 assistant
 *     消息(content 原样保留)。
 *   - `tool.result`(ToolCallResult / 兼 PostToolUse 载荷) → 一条 user 消息,内含一个
 *     `tool_result` content block(形状对齐 loop 的 toolResultsToContent,回灌 provider
 *     不会 400)。
 *   - `compaction.applied` / `compaction.revoked` → 交给 foldEvents 的压缩语义处理。
 *
 * 映射严格对齐 events.ts 里这些事件的真实 payload 形状。其余事件(turn 生命周期 / stage /
 * hook 等)`isMessage` 返回 false,fold 时被跳过。
 *
 * Boundary: 仅 core 相对 import。
 */
import type { CoreEvent } from '../events/types';
import { CoreEventType } from '../events/events';
import type { ProviderMessage } from '../provider/types';
import { foldEvents, type FoldAdapter, type EventRange } from './ledger';

/** loop 自吐的 assistant 会话事件类型(非 CoreEventType 成员,见 agent.ts:520)。 */
const ASSISTANT_MESSAGE_TYPE = 'assistant.message';

/** tool_result.content 规整成 string(对齐 agent.ts toolResultContent:对象 content
 *  会让 provider 400)。优先取常见文本字段,否则整体 JSON 化。 */
function toolResultContent(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (typeof p.stdout === 'string' && p.stdout.length > 0) return p.stdout;
    if (typeof p.message === 'string') return p.message;
    if (typeof p.result === 'string') return p.result;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

/** foldFromStore() 给每个事件挂的合成唯一 id 字段名(顶层、非 payload)。store 内事件
 *  ts 多为 0 且会话事件常无天然 id(user_prompt.submit / assistant.message 都没有),
 *  靠 type@ts 会撞键 → 压缩区间误伤。foldFromStore 按数组下标注入此字段保证唯一。 */
const FOLD_ID = '__foldId';

/** 一个事件的稳定 id:优先 foldFromStore 注入的合成 id,再 payload.id / toolUseId /
 *  appliedId,最后回退 type@ts。用于 byEventId 压缩范围匹配与 revoke 寻址。 */
function eventIdOf(e: CoreEvent): string {
  const fid = (e as unknown as Record<string, unknown>)[FOLD_ID];
  if (typeof fid === 'string') return fid;
  const p = e.payload as Record<string, unknown> | undefined;
  if (p) {
    if (typeof p.id === 'string') return p.id;
    if (typeof p.toolUseId === 'string') return p.toolUseId;
    if (typeof p.appliedId === 'string') return p.appliedId;
  }
  return `${e.type}@${e.ts}`;
}

/** CompactionApplied 落进 store 的 payload 形状(events.ts:73):
 *  `{ coveredFrom, coveredTo, replacement }`,区间是 messages 数组下标。 */
interface CompactionAppliedPayload {
  coveredFrom: number;
  coveredTo: number;
  replacement: unknown;
  /** foldFromStore() 预处理时改写上的 byEventId 区间(坐标系对齐,见下)。 */
  range?: EventRange;
}

/**
 * 把 store 事件流投影成 provider messages 的 FoldAdapter。
 *
 * 直接喂原始 store 事件时请用 `foldFromStore()` 而非裸 `foldEvents(events, llmFoldAdapter)`
 * ——因为 loop 的 CompactionApplied 用「会话消息下标」表达覆盖区间,与 ledger byIndex 的
 * 「events 数组下标」坐标系不同,需 foldFromStore() 先把它改写成 byEventId。本 adapter 的
 * `appliedRange` 读 payload.range(由 foldFromStore 预置);无 range 的裸事件回退 all。
 */
export const llmFoldAdapter: FoldAdapter<ProviderMessage> = {
  isMessage(e: CoreEvent): boolean {
    return (
      e.type === ASSISTANT_MESSAGE_TYPE ||
      e.type === CoreEventType.UserPromptSubmit ||
      e.type === CoreEventType.ToolCallResult
    );
  },

  toMessage(e: CoreEvent): ProviderMessage {
    if (e.type === ASSISTANT_MESSAGE_TYPE) {
      const p = e.payload as { role?: string; content?: unknown };
      return { role: 'assistant', content: p.content ?? [] };
    }
    if (e.type === CoreEventType.UserPromptSubmit) {
      const p = e.payload as { prompt?: unknown };
      return { role: 'user', content: typeof p.prompt === 'string' ? p.prompt : String(p.prompt ?? '') };
    }
    // ToolCallResult → user 消息,内含一个 tool_result block(对齐 toolResultsToContent)。
    const p = e.payload as { toolUseId?: string; result?: unknown; isError?: boolean };
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: p.toolUseId,
          content: toolResultContent(p.result),
          is_error: p.isError === true,
        },
      ],
    };
  },

  eventId: eventIdOf,

  isCompactionApplied(e: CoreEvent): boolean {
    return e.type === CoreEventType.CompactionApplied;
  },

  isCompactionRevoked(e: CoreEvent): boolean {
    return e.type === CoreEventType.CompactionRevoked;
  },

  appliedRange(e: CoreEvent): EventRange {
    const p = e.payload as CompactionAppliedPayload;
    return p.range ?? { kind: 'all' };
  },

  appliedReplacement(e: CoreEvent): ProviderMessage {
    const p = e.payload as CompactionAppliedPayload;
    return p.replacement as ProviderMessage;
  },

  revokedAppliedId(e: CoreEvent): string {
    const p = e.payload as { appliedId?: string };
    return typeof p.appliedId === 'string' ? p.appliedId : '';
  },
};

/**
 * 从原始 store 事件流重建 provider messages(开机回放入口)。
 *
 * 关键坐标系对齐:loop 发的 CompactionApplied.payload 用 **会话消息下标**(coveredFrom/
 * coveredTo,即第几条派生 message)表达覆盖区间,而 ledger.foldEvents 的 byIndex 走
 * **events 数组下标**——二者不同。这里先扫一遍把每个会话事件按出现顺序编号(= 它在派生
 * messages 里的位置),再把每个 CompactionApplied 改写成 `byEventId`(ids = 落在
 * [coveredFrom,coveredTo] 内会话事件的 eventId),最后交给坐标无关的 foldEvents。
 * CompactionRevoked 原样透传(按 appliedId 寻址)。空流 → 空数组。
 */
export function foldFromStore(events: CoreEvent[]): ProviderMessage[] {
  // 给每个会话消息事件挂合成唯一 id(下标),并按序编号 → 它在派生 messages 里的逻辑位置。
  //   合成 id 解决 user_prompt.submit / assistant.message 无天然 id + ts=0 撞键的问题。
  //   仅会话消息事件需要(byEventId 范围只挑它们);CompactionApplied/Revoked 保留天然
  //   id 解析(revoke 按 payload.appliedId 寻址,不能被合成 id 顶掉)。
  const seqOf = new Map<CoreEvent, number>();
  let seq = 0;
  const tagged: CoreEvent[] = events.map((e, idx) => {
    if (!llmFoldAdapter.isMessage(e)) return e;
    const withId: CoreEvent = { ...e, [FOLD_ID]: `msg#${idx}` } as CoreEvent;
    seqOf.set(withId, seq++);
    return withId;
  });

  // 改写 CompactionApplied:会话消息下标区间 → byEventId(覆盖区间内会话事件的合成 id)。
  const rewritten: CoreEvent[] = tagged.map((e) => {
    if (e.type !== CoreEventType.CompactionApplied) return e;
    const p = e.payload as CompactionAppliedPayload;
    const ids: string[] = [];
    for (const [ce, s] of seqOf) {
      if (s >= p.coveredFrom && s <= p.coveredTo) ids.push(llmFoldAdapter.eventId(ce));
    }
    const range: EventRange = { kind: 'byEventId', ids };
    return { ...e, payload: { ...p, range } };
  });

  return foldEvents(rewritten, llmFoldAdapter);
}
