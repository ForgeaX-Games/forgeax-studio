/**
 * Builtin tools CapabilityPack (②) — reference 内核通用工具聚合包。
 *
 * `builtinToolsPack()` 返回一个 `layer: 'builtin'` 的 CapabilityPack，聚合：
 *   read_file / write_file / edit_file（file-tools）、bash（shell-tools）、
 *   grep / glob（search-tools）。
 *
 * 这些工具是 reference 实现：IO 全部经 host 注入到 `ToolContext` 上的能力句柄
 * （`sandboxFs` / `terminal`，约定见 file-tools.ts / shell-tools.ts 顶部），core 本身
 * 不打真 IO。host 可整包替换(高 layer 同名 pack 覆盖，见 CapabilityLoader)。
 *
 * Boundary: 仅 import core-local 契约。
 */
import type { CapabilityPack } from '../types';
import { readFileTool, writeFileTool, editFileTool } from './file-tools';
import { bashTool, bashOutputTool, killShellTool } from './shell-tools';
import { grepTool, globTool } from './search-tools';
import { askUserQuestionTool } from './ask-tools';

export * from './file-tools';
export * from './shell-tools';
export * from './shell-registry';
export * from './search-tools';
export * from './web-tools';
export * from './todo-tools';
export * from './notebook-tools';
export * from './message-tools';
export * from './plan-tools';
export * from './ask-tools';

/** 内核通用工具包(reference)。pack 名 'builtin-tools'，layer 'builtin'。 */
export function builtinToolsPack(): CapabilityPack {
  return {
    name: 'builtin-tools',
    layer: 'builtin',
    tools: [
      readFileTool(),
      writeFileTool(),
      editFileTool(),
      bashTool(),
      grepTool(),
      globTool(),
      // 007 后台 bash 三件套(bash run_in_background 在 bashTool 内,这两件配套)。
      bashOutputTool(),
      killShellTool(),
      // 008 结构化提问(主 agent 工具;经 ctx.askQuestion 接缝,无 host 实现时优雅降级)。
      askUserQuestionTool(),
    ],
  };
}
