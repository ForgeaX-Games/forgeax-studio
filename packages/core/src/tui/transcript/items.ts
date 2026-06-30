/**
 * Transcript 条目模型(梁②;reduceTranscript 输出的可渲染条目)。
 *
 * 真相在 P1 冻结的 `tui/contracts.ts`。本文件只 re-export,给 transcript/ 内部
 * (reduce.ts / Transcript.tsx)一个就近 import 入口,避免到处写相对路径回 contracts。
 * **不**在这里重定义类型——SSOT 唯一在 contracts.ts。
 *
 * Boundary(HOST 层):仅 core 相对 import。
 */
export type {
  ToolItemStatus,
  TranscriptItem,
  SessionEntry,
  AgentEvent,
} from '../contracts';
