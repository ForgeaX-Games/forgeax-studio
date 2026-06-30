/**
 * Micro-compaction (C7) — time-based, content-clearing of stale tool results.
 *
 * 设计稿: 最终实现方案 §12 (CTX 引擎的轻量旁路;不发 CompactionApplied 事件,只就地
 * 把老 tool_result 的 content 清空,缩小将被 provider 重写的前缀)。
 * **time-based** 路径(maybeTimeBasedMicrocompact):
 *   - 闸门(gap):距上一条 assistant 消息的时间 > gapThresholdMinutes(默认 60min,
 *     = 1h prompt-cache TTL 过期)才触发。cache 已冷,前缀必然被整段重写,所以此刻
 *     content-clear 旧 tool result 把要重写的体积压小,无 cache 损失。
 *   - 保护区(keepRecent):最近 keepRecent 条 tool_result 原样保留(floor 1 ——
 *     slice(-0) 反而保留全部,且清空全部会让模型失去工作上下文)。
 *   - 清理:保护区外的 tool_result content 替换成 CLEARED_TOOL_PLACEHOLDER。
 *
 * provider-neutral 简化:
 *   - 不限定 COMPACTABLE_TOOLS(Read/Bash/Grep/...);core 无内置工具名表,默认
 *     压缩所有 tool 消息,host 可经 `compactableToolNames` 收窄。
 *   - 不用 cache-edit / blackboard 锚点;core 是 **纯函数**:`now` 作参注入
 *     (不用 Date.now),不读写任何全局状态 —— host 负责取 now 与持久化触发时机。
 *
 * 消息形状(provider-neutral,与 ledger fold 产出的 message 对齐):
 *   - assistant 消息:{ role:'assistant', timestamp?, content?:Block[] }
 *   - tool 结果:既支持 { role:'tool', content } 单条形态,也支持 user 消息里的
 *     content 数组含 { type:'tool_result', content } 块。两者都被识别为
 *     一条「tool result」并参与 keepRecent / 清理。
 *
 * Boundary: 仅 import core-local 类型 + node:。无 import(纯算法 + 局部类型)。
 */

/** Placeholder content installed into cleared tool results (TIME_BASED_MC_CLEARED_MESSAGE). */
export const CLEARED_TOOL_PLACEHOLDER = '[Old tool result content cleared]';

/** Default idle gap before a cold-cache micro-compaction fires (60min = 1h TTL). */
export const DEFAULT_GAP_THRESHOLD_MINUTES = 60;

/** Default number of most-recent tool results preserved verbatim. */
export const DEFAULT_KEEP_RECENT = 20;

export interface MicroCompactOptions {
  /** Most-recent tool results to keep verbatim (floored at 1). Default 20. */
  keepRecent?: number;
  /** Idle gap (minutes) since the last assistant message that arms clearing.
   *  Default 60 (= 1h prompt-cache TTL). */
  gapThresholdMinutes?: number;
  /** Current time in ms (injected; the function never reads Date.now itself). */
  now: number;
  /** Restrict clearing to tool results from these tool names. Omit/empty = all. */
  compactableToolNames?: readonly string[];
}

interface ToolResultRef {
  /** Index of the message holding this tool result. */
  msgIndex: number;
  /** Index within the message content array, or -1 for a `role:'tool'` message. */
  blockIndex: number;
  toolName?: string;
}

/**
 * Time-based micro-compaction. Pure: returns a new message array with stale
 * tool-result content cleared, or the **same reference** when the trigger
 * doesn't fire (gap under threshold / no assistant message / nothing to clear)
 * so callers can cheaply detect a no-op.
 */
export function microCompact<M>(messages: readonly M[], options: MicroCompactOptions): M[] {
  const keepRecent = Math.max(1, options.keepRecent ?? DEFAULT_KEEP_RECENT);
  const gapThresholdMinutes = options.gapThresholdMinutes ?? DEFAULT_GAP_THRESHOLD_MINUTES;
  const allowed =
    options.compactableToolNames && options.compactableToolNames.length > 0
      ? new Set(options.compactableToolNames)
      : null;

  // ── gate: idle gap since last assistant message ──────────────────────────
  const lastAssistantTs = findLastAssistantTimestamp(messages);
  if (lastAssistantTs === undefined) return messages.slice();
  const gapMinutes = (options.now - lastAssistantTs) / 60_000;
  if (!Number.isFinite(gapMinutes) || gapMinutes < gapThresholdMinutes) {
    return messages.slice();
  }

  // ── collect tool results in encounter order ──────────────────────────────
  const refs: ToolResultRef[] = [];
  messages.forEach((msg, msgIndex) => {
    const rec = asRecord(msg);
    if (!rec) return;
    if (rec.role === 'tool') {
      refs.push({ msgIndex, blockIndex: -1, toolName: strOrUndef(rec.toolName) });
      return;
    }
    const content = rec.content;
    if (Array.isArray(content)) {
      content.forEach((block, blockIndex) => {
        const b = asRecord(block);
        if (b && b.type === 'tool_result') {
          refs.push({ msgIndex, blockIndex, toolName: strOrUndef(b.name) });
        }
      });
    }
  });

  // Filter to compactable tools (if a name set was provided).
  const candidate = allowed
    ? refs.filter((r) => r.toolName !== undefined && allowed.has(r.toolName))
    : refs;

  // ── protection zone: keep the most-recent keepRecent ─────────────────────
  const clearTargets = candidate.slice(0, Math.max(0, candidate.length - keepRecent));
  if (clearTargets.length === 0) return messages.slice();

  // Group targets by message for an efficient single pass.
  const byMsg = new Map<number, ToolResultRef[]>();
  for (const ref of clearTargets) {
    const list = byMsg.get(ref.msgIndex);
    if (list) list.push(ref);
    else byMsg.set(ref.msgIndex, [ref]);
  }

  let cleared = 0;
  const out = messages.map((msg, msgIndex) => {
    const targets = byMsg.get(msgIndex);
    if (!targets) return msg;
    // 不变量:target 仅来自 refs,而 refs 只在 collect 阶段从「对象消息」的 role:'tool' 或
    //   数组 content(含 tool_result)收集 → 此处 msg 必为对象,且非 tool 即数组 content。
    //   故用断言表达不变量,避免不可达的防御分支(纯函数同源,content 不会中途变)。
    const rec = msg as Record<string, unknown>;

    // role:'tool' single-content message → clear whole content.
    if (rec.role === 'tool') {
      if (rec.content === CLEARED_TOOL_PLACEHOLDER) return msg;
      cleared++;
      return { ...rec, content: CLEARED_TOOL_PLACEHOLDER } as unknown as M;
    }

    // 否则必为带 tool_result 块的数组 content(不变量)→ 清目标块。
    const clearBlocks = new Set(targets.map((t) => t.blockIndex));
    let touched = false;
    const newContent = (rec.content as unknown[]).map((block, blockIndex) => {
      if (!clearBlocks.has(blockIndex)) return block;
      const b = asRecord(block);
      if (!b || b.content === CLEARED_TOOL_PLACEHOLDER) return block;
      touched = true;
      return { ...b, content: CLEARED_TOOL_PLACEHOLDER };
    });
    if (touched) cleared++;
    return (touched ? { ...rec, content: newContent } : msg) as unknown as M;
  });

  return cleared === 0 ? messages.slice() : out;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function findLastAssistantTimestamp(messages: readonly unknown[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const rec = asRecord(messages[i]);
    if (rec && rec.role === 'assistant') {
      const ts = rec.timestamp;
      if (typeof ts === 'number') return ts;
      if (typeof ts === 'string') {
        const n = Date.parse(ts);
        if (!Number.isNaN(n)) return n;
      }
      // assistant with no usable timestamp → treat as unknown (skip gating).
      return undefined;
    }
  }
  return undefined;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
