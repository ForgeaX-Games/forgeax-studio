/**
 * Dynamic reminder slot (C7 extra) — a boundary-后、不缓存的动态提醒注入点。
 *
 * 设计稿: 最终实现方案 §5 (动态段在 SYSTEM_PROMPT_DYNAMIC_BOUNDARY 之后、每轮重算、
 * 永不缓存)。对齐:
 *   - cli `context-window/dynamic-reminder.ts` —— 把动态变更块渲染成一段注入文本。
 *   - 动态提醒用 system-reminder 标签包裹,模型据此识别"这是运行时附注、非用户输入"。
 *
 * 与静态 slot 的差异:本 slot `dynamic=true` / `cacheScope=null`,落在 boundary
 * 之后,故字节变化不会破坏前缀 cache。文本由 host 提供的 getter 每轮拉取(get() 返回
 * null 即本轮不注入),core 不解释其语义。
 *
 * Boundary: 仅 import core-local 类型。
 */
import type { Slot, SlotContext } from '../capability/types';

/** system-reminder 包裹标签。 */
const SYSTEM_REMINDER_OPEN = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE = '</system-reminder>';

/**
 * 把一段动态提醒文本包进 `<system-reminder>…</system-reminder>`。
 * 已是空串/全空白则原样返回(交由调用方决定丢弃),否则 trim 后包裹。
 */
export function wrapSystemReminder(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  return `${SYSTEM_REMINDER_OPEN}\n${trimmed}\n${SYSTEM_REMINDER_CLOSE}`;
}

/**
 * 构造一个动态提醒 Slot:
 *  - `dynamic = true` —— 每轮重算(静态缓存不复用)。
 *  - `cacheScope = null` —— boundary 之后、永不缓存(字节抖动不破前缀 cache)。
 *  - `render` —— 调用 host 提供的 `get()`:返回 null/空白 → 本轮跳过(返回 null),
 *    否则用 `wrapSystemReminder` 包裹后注入。
 */
export function makeDynamicReminderSlot(get: () => string | null): Slot {
  return {
    name: 'dynamic-reminder',
    dynamic: true,
    cacheScope: null,
    render(_ctx: SlotContext): string | null {
      const value = get();
      if (value === null) return null;
      const wrapped = wrapSystemReminder(value);
      return wrapped.length === 0 ? null : wrapped;
    },
  };
}
