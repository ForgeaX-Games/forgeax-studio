/**
 * Memory capability pack (C8) — generic long-term memory mechanism.
 *
 * core 只出**通用机制**:scan(frontmatter manifest)+ recall(LLM-select over
 * manifest,无 embedding)+ tools(memory_search / remember,写闸限 memory 目录)+
 * slot(常驻 MEMORY.md 索引)。**不含任何专有分类语义**——taxonomy 由调用方经
 * `remember.type` 字符串与 selectFn 自行定义。
 *
 * memdir 机制。host 注入 memoryDir(落盘位置)、sandboxFs(IO)、
 * 可选 selectFn(召回选择器,背靠小模型 side-query)。
 *
 * Boundary: 仅 import core-local 类型。
 */
import type { CapabilityPack } from '../types';
import type { SandboxFs } from '../../inject/types';
import type { MemorySelectFn } from './recall';
import { makeMemorySearchTool, makeRememberTool } from './tools';
import { makeMemorySlot } from './slot';

export type { MemoryHeader } from './scan';
export { scanMemoryFiles, formatManifest, MAX_MEMORY_FILES, FRONTMATTER_MAX_LINES, MEMORY_INDEX_FILE } from './scan';
export type { MemorySelectFn, RelevantMemory } from './recall';
export { findRelevantMemories } from './recall';
export { makeMemorySearchTool, makeRememberTool, isAutoMemPath, freshness, type MemoryToolDeps } from './tools';
export { makeMemorySlot, rebuildIndex, type MemorySlotDeps } from './slot';
export { AutoMemory, makeProviderSelectFn, type AutoMemoryDeps } from './auto';
export { listMemory, openMemory, type MemoryEntry, type MemoryListing } from './inspect';

export interface MemoryPackDeps {
  /** 记忆落盘根目录(host 经 PathConvention 决定布局)。 */
  memoryDir: string;
  /** 抽象 IO(host 注入)。 */
  sandboxFs: SandboxFs;
  /** 召回选择器(可选;无则回退取最新 N)。 */
  selectFn?: MemorySelectFn;
}

/** 组装 memory capability pack(builtin 层)。 */
export function memoryPack(deps: MemoryPackDeps): CapabilityPack {
  const toolDeps = { memoryDir: deps.memoryDir, sandboxFs: deps.sandboxFs, selectFn: deps.selectFn };
  return {
    name: 'memory',
    layer: 'builtin',
    tools: [makeMemorySearchTool(toolDeps), makeRememberTool(toolDeps)],
    slots: [makeMemorySlot({ memoryDir: deps.memoryDir, sandboxFs: deps.sandboxFs })],
  };
}
