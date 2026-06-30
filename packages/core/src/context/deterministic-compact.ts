/**
 * Deterministic compaction L1 (Stream C / #4·#5·#12) — 无 LLM、纯规则的"狠瘦一遍"。
 *
 * 压缩管线第一层:对**待压缩范围**无条件做确定性瘦身,不花 token、不联网:
 *   - **剥图片/多媒体**(#4):image/audio/video/binary block → 占位文字 block。
 *   - **omit tool 结果**(#4):tool_result block 的 content / `role:'tool'` 消息 content → 占位。
 *   - **omit 大参数**(#4):tool_use 的 input 大字段(content/code/widget_code…)→ `<omitted>`。
 *   - **保护区**:最近 keepRecent 条消息整条不动(默认 0 —— 管线已在外层切走保留尾)。
 * 然后 `estimateTokens` + `isSufficient` 给管线判 sufficiency 短路(#12):L1 后若已够小,跳过 LLM。
 *
 * 与 micro-compaction 的区别:micro 是**每轮、时间门控**(60min 冷 cache 才清);本层是**压缩时
 * 无条件**剥离。二者各管一摊,不互相调用。
 *
 * 全部纯函数、无 IO、无 Date.now;`content` 为 unknown,防御式处理(对齐 micro-compaction)。
 * Boundary: 仅 import core-local 类型。
 */

/** 占位文本(剥离后装回,保结构 → tool_use/tool_result 配对不破)。 */
export const OMIT_IMAGE = '[image omitted in compaction]';
export const OMIT_MEDIA = '[media omitted in compaction]';
export const OMIT_TOOL_RESULT = '[tool result omitted in compaction]';
export const OMIT_ARG = '<omitted>';

/** 默认被 omit 的 tool_use 大参数字段。 */
export const DEFAULT_LARGE_ARG_FIELDS = ['content', 'code', 'widget_code', 'file_text', 'new_string'] as const;

/** 粗估 token(~4 char/token)。 */
export function estimateTokens(messages: readonly unknown[]): number {
  let chars = 0;
  for (const m of messages) {
    const rec = asRecord(m);
    const c = rec?.content;
    chars += typeof c === 'string' ? c.length : JSON.stringify(c ?? m).length;
  }
  return Math.ceil(chars / 4);
}

/** L1 后是否已"足够小"(#12 sufficiency 短路):estimated ≤ effective × ratio。 */
export function isSufficient(estimatedTokens: number, effectiveWindow: number, ratio: number): boolean {
  return estimatedTokens <= effectiveWindow * ratio;
}

export interface DeterministicCompactOptions {
  /** 保护最近 N 条消息整条不剥(默认 0)。 */
  keepRecent?: number;
  /** 仅剥这些工具名的 tool_result(omit/空 = 全部)。 */
  compactableToolNames?: readonly string[];
  /** 额外 omit 的大参数字段(并入默认集)。 */
  largeArgFields?: readonly string[];
}

export interface DeterministicResult<M> {
  messages: M[];
  estimatedTokens: number;
  /** 被剥的 block/消息计数(0 = no-op,messages 为原引用)。 */
  stripped: number;
}

/**
 * 对 messages 做确定性剥离。无任何剥离时返回**原引用**(廉价 no-op 检测,C-U8)。
 */
export function deterministicCompact<M>(
  messages: readonly M[],
  options: DeterministicCompactOptions = {},
): DeterministicResult<M> {
  const keepRecent = Math.max(0, options.keepRecent ?? 0);
  const allowed =
    options.compactableToolNames && options.compactableToolNames.length > 0
      ? new Set(options.compactableToolNames)
      : null;
  const largeFields = new Set<string>([...DEFAULT_LARGE_ARG_FIELDS, ...(options.largeArgFields ?? [])]);

  const protectFrom = messages.length - keepRecent; // 此下标(含)之后受保护
  let stripped = 0;

  const out = messages.map((msg, i) => {
    if (i >= protectFrom) return msg; // 保护区原样
    const rec = asRecord(msg);
    if (!rec) return msg;

    // role:'tool' 单条 → 整条 content omit
    if (rec.role === 'tool') {
      if (rec.content === OMIT_TOOL_RESULT) return msg;
      if (allowed && !allowed.has(strOrUndef(rec.toolName) ?? '')) return msg;
      stripped++;
      return { ...rec, content: OMIT_TOOL_RESULT } as unknown as M;
    }

    if (!Array.isArray(rec.content)) return msg;

    let touched = false;
    const newContent = rec.content.map((block) => {
      const b = asRecord(block);
      if (!b) return block;
      const kind = classifyBlock(b);

      if (kind === 'image') {
        touched = true;
        return { type: 'text', text: OMIT_IMAGE };
      }
      if (kind === 'media') {
        touched = true;
        return { type: 'text', text: OMIT_MEDIA };
      }
      if (b.type === 'tool_result') {
        if (b.content === OMIT_TOOL_RESULT) return block;
        if (allowed && !allowed.has(strOrUndef(b.name) ?? '')) return block;
        touched = true;
        return { ...b, content: OMIT_TOOL_RESULT };
      }
      if (b.type === 'tool_use') {
        const input = asRecord(b.input);
        if (!input) return block;
        let argTouched = false;
        const newInput: Record<string, unknown> = { ...input };
        for (const k of Object.keys(newInput)) {
          if (largeFields.has(k) && newInput[k] !== OMIT_ARG) {
            newInput[k] = OMIT_ARG;
            argTouched = true;
          }
        }
        if (!argTouched) return block;
        touched = true;
        return { ...b, input: newInput };
      }
      return block;
    });

    if (!touched) return msg;
    stripped++;
    return { ...rec, content: newContent } as unknown as M;
  });

  if (stripped === 0) {
    return { messages: messages as unknown as M[], estimatedTokens: estimateTokens(messages), stripped: 0 };
  }
  return { messages: out, estimatedTokens: estimateTokens(out), stripped };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

type BlockKind = 'image' | 'media' | 'tool_result' | 'tool_use' | 'other';

/** block 大类:image / media(audio·video·binary) / tool_result / tool_use / other。 */
function classifyBlock(b: Record<string, unknown>): BlockKind {
  const type = strOrUndef(b.type);
  if (type === 'image') return 'image';
  if (type === 'tool_result') return 'tool_result';
  if (type === 'tool_use') return 'tool_use';
  // mime/source 嗅探(provider 各自规范化:source.media_type / mimeType)
  const mime = mimeOf(b);
  if (mime) {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/') || mime.startsWith('video/')) return 'media';
    if (!mime.startsWith('text/')) return 'media'; // 其它二进制
  }
  if (type === 'audio' || type === 'video') return 'media';
  return 'other';
}

function mimeOf(b: Record<string, unknown>): string | undefined {
  const src = asRecord(b.source);
  const m = strOrUndef(src?.media_type) ?? strOrUndef(b.mimeType) ?? strOrUndef(b.media_type);
  return m?.toLowerCase();
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
