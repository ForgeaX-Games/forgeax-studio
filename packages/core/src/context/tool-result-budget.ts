/**
 * Tool-result budget gate (C7 extra) — 全局 tool 输出预算兜底。
 *
 * 移植自最老版 agentic_os 的 tool-result 治理(03.B.1 架构 contract + 03.B.2
 * head-tail 默认策略),`maxResultSizeChars` 的「单 tool 声明策略、全局单点兜底」模型:
 *   - 单 tool 只在 AgentTool.maxResultSizeChars 声明上限(Infinity=永不裁);
 *   - LOOP 在**唯一汇聚点**(agent.ts `toolResultsToContent`)统一过本 gate,
 *     超限走 head-tail 预览,模型据 marker 感知「我看到的是被裁过的」。
 *
 * 与 03.B 的取舍(provider-neutral 简化,见设计稿「不做」):
 *   - 不做 persistedPath 落盘 + read_file 回读(host/sessionDir 领地,违 core 干净律);
 *     marker 只承载「truncated N chars」感知,不留空头 path。
 *   - 不做多媒体独立通道(MCP content block 在 bridge 原样透传,不被当文本截)。
 *
 * 纯函数,无副作用、无 IO、无 import —— 便于单测,Boundary 自然满足。
 */

/** MCP 工具结果的有界默认(对齐 03.B：MCP 不能 Infinity 无界灌窗)。host 可装配期覆写。 */
export const DEFAULT_MCP_RESULT_BUDGET = 50_000;

/** head:tail 切分比例(对齐 03.B.2 `HEAD_TAIL_HEAD_RATIO`):保头 80% + 保尾 20%。 */
export const HEAD_TAIL_HEAD_RATIO = 0.8;

export interface BudgetResult {
  /** 发给模型的最终文本(裁剪后或原样)。 */
  output: string;
  /** 是否实际裁剪。 */
  truncated: boolean;
  /** raw 原始字符数(诊断用)。 */
  originalChars: number;
  /** 截断时若 persist 回调落盘成功,返回全量结果的落地路径(可回读)。否则不设。 */
  persistedPath?: string;
}

/** 内容大类(对齐 03.B 多媒体感知 + MCP content block 形状:text/image/audio/video/binary)。 */
export type ContentKind = 'text' | 'image' | 'audio' | 'video' | 'binary';

/** applyResultBudget 可选项(向后兼容:不传则与 2-arg 行为逐字一致)。 */
export interface BudgetOptions {
  /**
   * 截断时落盘全量结果的钩子(host/sessionDir 领地,故注入而非 core 内置)。
   * 入参=全量 raw;返回落地路径(成功)或 undefined(未落盘/失败)。
   * 返回路径 → marker 内追加 `; full result at <path>` 且 BudgetResult.persistedPath 置位。
   */
  persist?: (raw: string) => string | undefined;
}

/** 构造截断 marker(N=真实省略字符数 + 可选落盘路径尾)。文案便于人/模型肉眼识别截断点。
 *  suffix 为空 → 与历史文案逐字一致(零回归);非空 → marker 内追加 `; full result at <path>`。 */
function truncationMarker(omitted: number, suffix = ''): string {
  return `\n\n... [truncated ${omitted} chars${suffix}] ...\n\n`;
}

/**
 * head-tail 预览:保头 + marker + 保尾,总长严格 ≤ maxChars(先扣 marker 再切)。
 * 对齐 03.B.2 `renderHeadTailPreview`:
 *   - 错误堆栈/退出码/源码 `export`/JSON 尾元素都在尾部 —— head-only 会丢,故保尾。
 *   - marker 用真实省略数(实际 head+tail 因 marker overhead 可能略短于 usable)。
 */
export function renderHeadTailPreview(raw: string, maxChars: number, markerSuffix = ''): string {
  // 先按一个上界 marker 估算 overhead(用 raw.length 的位数,保证够长;含可选落盘路径尾)。
  const markerOverhead = truncationMarker(raw.length, markerSuffix).length;
  const usable = Math.max(0, maxChars - markerOverhead);
  const headChars = Math.floor(usable * HEAD_TAIL_HEAD_RATIO);
  const tailChars = usable - headChars;

  const head = raw.slice(0, headChars);
  const tail = tailChars > 0 ? raw.slice(raw.length - tailChars) : '';
  const omitted = raw.length - headChars - tailChars;
  return head + truncationMarker(omitted, markerSuffix) + tail;
}

/**
 * 全局预算兜底。`maxChars === Infinity` 或未超阈值 → 恒等返回(truncated:false),
 * 保证「阈值内/无界工具」字节级与今天一致(零回归)。超限 → head-tail 预览。
 */
export function applyResultBudget(content: string, maxChars: number, opts?: BudgetOptions): BudgetResult {
  const originalChars = content.length;
  if (!Number.isFinite(maxChars) || originalChars <= maxChars) {
    return { output: content, truncated: false, originalChars };
  }
  // 截断分支:仅当注入了 persist 且落盘返回路径时,marker 内追加 `; full result at <path>`
  // 并在 BudgetResult 暴露 persistedPath。无 persist(含旧 2-arg 调用)→ markerSuffix='' →
  // 与历史输出逐字一致(零回归)。
  let persistedPath: string | undefined;
  let markerSuffix = '';
  if (opts?.persist) {
    const path = opts.persist(content);
    if (path) {
      persistedPath = path;
      markerSuffix = `; full result at ${path}`;
    }
  }
  const output = renderHeadTailPreview(content, maxChars, markerSuffix);
  return persistedPath !== undefined
    ? { output, truncated: true, originalChars, persistedPath }
    : { output, truncated: true, originalChars };
}

/** 把一个 MCP/工具 content block 形状归到一个大类。无法判别 → 'binary' (fail-safe,
 *  宁可当二进制不当文本灌窗)。识别既看显式 `type`(text/image/audio/video/resource…)
 *  也看 mimeType 前缀(image/* audio/* video/* text/*)。 */
function classifyBlock(part: unknown): ContentKind {
  if (typeof part === 'string') return 'text';
  if (!part || typeof part !== 'object') return 'binary';
  const p = part as Record<string, unknown>;
  const type = typeof p.type === 'string' ? p.type.toLowerCase() : '';
  if (type === 'text') return 'text';
  if (type === 'image') return 'image';
  if (type === 'audio') return 'audio';
  if (type === 'video') return 'video';
  // mimeType 兜底(resource / blob 等带 mimeType 的块)。
  const mime = typeof p.mimeType === 'string' ? p.mimeType.toLowerCase() : '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/')) return 'text';
  // 有 text 字段而无显式类型 → 当文本;否则二进制。
  if (typeof p.text === 'string') return 'text';
  return 'binary';
}

/**
 * 判别一个工具结果里出现了哪些内容大类(去重、保持首见顺序)。
 *   - `parts` 给定(MCP content block 数组)→ 逐块归类(忽略空数组里的 content)。
 *   - `parts` 未给 → 退化为纯文本判定:有正文 → `['text']`,空串 → `[]`。
 * 供 host 决定「该不该把这条结果当文本截」/ telemetry 多媒体占比统计用。纯函数。
 */
export function classifyContentKinds(content: string, parts?: unknown[]): ContentKind[] {
  const kinds: ContentKind[] = [];
  const add = (k: ContentKind): void => {
    if (!kinds.includes(k)) kinds.push(k);
  };
  if (Array.isArray(parts)) {
    for (const part of parts) add(classifyBlock(part));
    return kinds;
  }
  if (content.length > 0) add('text');
  return kinds;
}
