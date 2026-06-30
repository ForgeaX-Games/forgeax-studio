/**
 * Memory inspection — `/memory` 命令的 A 层底层能力(列条目 + 指向 MEMORY.md 可编辑)。
 *
 * 022 任务 A 层:用户需要命令查看当前记忆条目 / 直接编辑,但 memory 子系统(scan/
 * recall/slot/tools)只暴露给「模型召回」用,没有「人查看 / 编辑」出口。这里在 memory
 * 能力内补两个**纯函数**:
 *   - `listMemory(fs, memoryDir)`:扫盘列当前记忆条目(复用 `scanMemoryFiles`),并带上
 *     常驻索引 `MEMORY.md` 的路径与存在性,供 serve/TUI 渲染。
 *   - `openMemory(memoryDir)`:返回 `MEMORY.md` 绝对路径,供编辑入口(打开编辑器)。
 *
 * 设计取舍:不内置任何 taxonomy(沿用 scan 的 frontmatter 透传);只读不写盘(查看/
 * 定位语义,写由 remember 工具负责)。接收注入入参(SandboxFs + memoryDir),不自取盘,
 * 与上层(serve/host)解耦——上层只需把已有的 sandboxFs / memoryDir 喂进来。
 *
 * Boundary: 仅 import core-local 类型。
 */
import type { SandboxFs } from '../../inject/types';
import type { MemoryHeader } from './scan';
import { scanMemoryFiles, MEMORY_INDEX_FILE } from './scan';

/** 单条记忆条目的视图(供命令/serve 渲染;不含正文,正文经 memory_search 召回)。 */
export interface MemoryEntry {
  /** 相对 memoryDir 的路径(可能含子目录)。 */
  filename: string;
  /** 绝对路径(供编辑入口定位 / 校验)。 */
  filePath: string;
  /** frontmatter.name(无则 null)。 */
  name: string | null;
  /** frontmatter.description(无则 null)。 */
  description: string | null;
  /** frontmatter.type 原样字符串(core 不解释 taxonomy;无则 undefined)。 */
  type: string | undefined;
  /** 修改时间(毫秒;调用方可自行渲染 freshness)。 */
  mtimeMs: number;
}

/** `listMemory` 结果:当前条目 + 常驻索引信息(给 serve/TUI 一份完整快照)。 */
export interface MemoryListing {
  /** 记忆落盘根目录(原样回带,方便上层展示)。 */
  memoryDir: string;
  /** 当前记忆条目(mtime 新→旧;排除 MEMORY.md 索引;封顶同 scan 的 200)。 */
  entries: MemoryEntry[];
  /** 常驻索引 `MEMORY.md` 的绝对路径(无论是否存在都给出,供编辑入口用)。 */
  indexPath: string;
  /** 索引文件当前是否存在(缺失说明从未 remember 过 / 待重建)。 */
  indexExists: boolean;
}

/** 极简 path join(对齐本目录其它文件:纯字符串拼接,避免平台分隔符问题)。 */
function join(a: string, b: string): string {
  if (a.endsWith('/')) return a + b;
  return `${a}/${b}`;
}

/** 把 scan 的 header 投影为对外的 MemoryEntry(字段挑选,语义不变)。 */
function toEntry(h: MemoryHeader): MemoryEntry {
  return {
    filename: h.filename,
    filePath: h.filePath,
    name: h.name,
    description: h.description,
    type: h.type,
    mtimeMs: h.mtimeMs,
  };
}

/**
 * 列当前记忆条目 + 常驻索引信息。纯函数,IO 全经注入的 SandboxFs。
 * 复用 `scanMemoryFiles`(同样的 frontmatter 解析 / mtime 排序 / 封顶 / 排除 MEMORY.md),
 * 保证「命令看到的条目」与「模型召回扫到的条目」一致。
 */
export function listMemory(fs: SandboxFs, memoryDir: string): MemoryListing {
  const headers = scanMemoryFiles(fs, memoryDir);
  const indexPath = join(memoryDir, MEMORY_INDEX_FILE);
  return {
    memoryDir,
    entries: headers.map(toEntry),
    indexPath,
    indexExists: fs.existsSync(indexPath),
  };
}

/**
 * 返回常驻索引 `MEMORY.md` 的绝对路径,供「编辑入口」打开(由上层决定用什么编辑器)。
 * 不触盘、不创建文件——只是路径推导;文件是否存在交给 `listMemory().indexExists`。
 */
export function openMemory(memoryDir: string): string {
  return join(memoryDir, MEMORY_INDEX_FILE);
}
