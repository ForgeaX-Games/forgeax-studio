/**
 * System-prompt assembler (C7) — slots → cache-aware SystemBlock[].
 *
 * 设计稿: 最终实现方案 §5 (统一首段 slot：T0 魂 + M4 preamble 共用一个 host 可控
 * 稳定首段) + §0″。
 *   - 段顺序：静态段 → SYSTEM_PROMPT_DYNAMIC_BOUNDARY 哨兵 → 动态段。
 *   - (splitSysPromptPrefix) —— global / org / null 三模式的
 *     cacheScope 边界：boundary 之前可 'global'，之后 null。
 *
 * 装配顺序(产出顺序即 system block 顺序):
 *   1. leading 首段 —— host 可控稳定文本(T0 魂 + M4 preamble 共用)。务必字节稳定
 *      地进入 cache 前缀。sysprompt-prefix 放 attribution 之后、静态段之前；
 *      它的 cacheScope 在 global 模式下是 null(自身不打 global 断点，但落在静态
 *      前缀里使后续静态段稳定命中)。leading.cacheScope = null。
 *   2. 静态 slots —— boundary 之前；globalCacheEnabled 时 'global'，否则 'org'。
 *      slot 可用自己的 cacheScope 覆盖(尊重 Slot.cacheScope)。
 *   3. SYSTEM_PROMPT_DYNAMIC_BOUNDARY 哨兵 —— 仅 globalCacheEnabled 时插入
 *      (`shouldUseGlobalCacheScope()` 才发哨兵)。它本身是一个 cacheScope=null
 *      的零长度边界块,标记静态/动态的 cache 分界(provider 据此打 cache_control)。
 *   4. 动态 slots —— boundary 之后；每轮重算，永不缓存(cacheScope=null)。
 *
 * Boundary: 仅 import core-local 类型。
 */
import type { Slot, SlotContext } from '../capability/types';
import type { SystemBlock } from '../provider/types';
import type {
  CacheScope,
  LeadingSystemSlot,
  SystemPromptAssembleInput,
  SystemPromptAssembler,
} from './types';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './types';

async function renderSlot(slot: Slot, ctx: SlotContext): Promise<string | null> {
  return slot.render(ctx);
}

/** Default static cacheScope: 'global' when host enabled global cache, else 'org'
 *  (splitSysPromptPrefix: global-mode static = 'global'; default/3P = 'org'). */
function defaultStaticScope(globalCacheEnabled: boolean): CacheScope {
  return globalCacheEnabled ? 'global' : 'org';
}

export class DefaultSystemPromptAssembler implements SystemPromptAssembler {
  async assemble(input: SystemPromptAssembleInput): Promise<SystemBlock[]> {
    const { leading, staticSlots, dynamicSlots, ctx, globalCacheEnabled = false } = input;
    const blocks: SystemBlock[] = [];

    // 1. leading 首段(T0 魂 + M4 preamble)——最前、进 cache 前缀、cacheScope=null。
    const leadingText = renderLeading(leading);
    if (leadingText !== null && leadingText.length > 0) {
      blocks.push({ type: 'text', text: leadingText, cacheScope: null });
    }

    // 2. 静态 slots(boundary 之前)。
    const staticScope = defaultStaticScope(globalCacheEnabled);
    for (const slot of staticSlots) {
      const text = await renderSlot(slot, ctx);
      if (text === null || text.length === 0) continue;
      blocks.push({
        type: 'text',
        text,
        cacheScope: slot.cacheScope ?? staticScope,
      });
    }

    // 3. DYNAMIC_BOUNDARY 哨兵(仅 global cache 模式发；shouldUseGlobalCacheScope)。
    if (globalCacheEnabled) {
      // boundary:true → provider 转 wire 时剔除(哨兵只标 cache 分界,不发给模型)。
      blocks.push({ type: 'text', text: SYSTEM_PROMPT_DYNAMIC_BOUNDARY, cacheScope: null, boundary: true });
    }

    // 4. 动态 slots(boundary 之后)——每轮重算，永不缓存。
    for (const slot of dynamicSlots) {
      const text = await renderSlot(slot, ctx);
      if (text === null || text.length === 0) continue;
      blocks.push({ type: 'text', text, cacheScope: null });
    }

    return blocks;
  }
}

function renderLeading(leading: LeadingSystemSlot | undefined): string | null {
  if (!leading) return null;
  return leading.render();
}

/** Convenience default instance (host may inject its own; this is the §12 ③ default). */
export const systemPromptAssembler: SystemPromptAssembler = new DefaultSystemPromptAssembler();
