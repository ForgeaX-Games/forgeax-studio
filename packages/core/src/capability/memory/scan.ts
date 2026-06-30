/**
 * Memory directory scan — generic memory mechanism (C8); no proprietary taxonomy.
 *
 * 扫 memory 目录下 `.md`(经注入
 * SandboxFs IO,排除 MEMORY.md 索引),解析 frontmatter(name/description/type),
 * 只读**前 30 行**(取 frontmatter,省 syscall),按 mtime **新→旧**排序,封顶
 * **200** 文件。`formatManifest` 出文本清单供选择器/索引用。
 *
 * core 不内置任何 type 枚举(具体分类全由调用方经字符串传入),
 * frontmatter `type` 原样透传。Boundary: 仅 import core-local 类型 + node:。
 */
import type { SandboxFs, DirEnt } from '../../inject/types';

/** 单个 memory 文件的头(frontmatter + mtime),不带正文(召回时再读全文)。 */
export interface MemoryHeader {
  /** 相对 memoryDir 的路径(可能含子目录)。 */
  filename: string;
  /** 绝对路径(供后续读全文 / 写闸校验)。 */
  filePath: string;
  mtimeMs: number;
  /** frontmatter.name(无则 null)。 */
  name: string | null;
  /** frontmatter.description(无则 null)。 */
  description: string | null;
  /** frontmatter.type 原样字符串(core 不解释 taxonomy;无则 undefined)。 */
  type: string | undefined;
}

/** MAX_MEMORY_FILES / FRONTMATTER_MAX_LINES。 */
export const MAX_MEMORY_FILES = 200;
export const FRONTMATTER_MAX_LINES = 30;

/** 索引文件名(不进 manifest,作常驻 index 单独注入)。 */
export const MEMORY_INDEX_FILE = 'MEMORY.md';

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

/**
 * 解析 frontmatter 中的简单 `key: value`(只取 name/description/type)。
 * 不依赖 YAML 库:memory frontmatter 是平坦标量,逐行扫 `key: value`,去引号。
 */
function parseFrontmatter(text: string): {
  name: string | null;
  description: string | null;
  type: string | undefined;
} {
  const m = text.match(FRONTMATTER_RE);
  const out = { name: null as string | null, description: null as string | null, type: undefined as string | undefined };
  if (!m) return out;
  for (const rawLine of m[1].split('\n')) {
    const line = rawLine.trimEnd();
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let val = kv[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (val === '') continue;
    if (key === 'name') out.name = val;
    else if (key === 'description') out.description = val;
    else if (key === 'type') out.type = val;
  }
  return out;
}

/** 取一个文件前 N 行(为读 frontmatter;避免整文件入内存)。 */
function readHead(fs: SandboxFs, path: string, maxLines: number): string {
  const text = fs.readTextSync(path);
  const lines = text.split('\n');
  return lines.length <= maxLines ? text : lines.slice(0, maxLines).join('\n');
}

/** 递归收集 memoryDir 下所有 `.md` 的相对路径(排除 MEMORY.md 索引)。 */
function collectMdFiles(fs: SandboxFs, root: string, rel: string, acc: string[]): void {
  const dir = rel ? join(root, rel) : root;
  let entries: DirEnt[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }) as DirEnt[];
  } catch {
    return;
  }
  for (const ent of entries) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDir) {
      collectMdFiles(fs, root, childRel, acc);
    } else if (ent.isFile && ent.name.endsWith('.md') && ent.name !== MEMORY_INDEX_FILE) {
      acc.push(childRel);
    }
  }
}

/** 极简 path join(core 只 import node:,但这里走纯字符串拼接避免平台分隔符问题)。 */
function join(a: string, b: string): string {
  if (a.endsWith('/')) return a + b;
  return `${a}/${b}`;
}

/**
 * 扫 memoryDir 下的 `.md`,读前 30 行解析 frontmatter,按 mtime 新→旧排,封顶 200。
 * 经注入的 SandboxFs 做所有 IO(同步;对齐 SandboxFs 同步 surface);目录不存在 → []。
 */
export function scanMemoryFiles(fs: SandboxFs, memoryDir: string): MemoryHeader[] {
  if (!fs.existsSync(memoryDir)) return [];
  const rels: string[] = [];
  collectMdFiles(fs, memoryDir, '', rels);

  const headers: MemoryHeader[] = [];
  for (const rel of rels) {
    const filePath = join(memoryDir, rel);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(filePath).mtime;
    } catch {
      continue;
    }
    let head = '';
    try {
      head = readHead(fs, filePath, FRONTMATTER_MAX_LINES);
    } catch {
      continue;
    }
    const fm = parseFrontmatter(head);
    headers.push({ filename: rel, filePath, mtimeMs, name: fm.name, description: fm.description, type: fm.type });
  }

  return headers.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_MEMORY_FILES);
}

/**
 * 渲染头列表为文本 manifest:每文件一行 `- [type] filename (ISO): description`。
 * 供召回选择器(selectFn)与索引 slot 用。
 */
export function formatManifest(headers: MemoryHeader[]): string {
  return headers
    .map((h) => {
      const tag = h.type ? `[${h.type}] ` : '';
      const ts = new Date(h.mtimeMs).toISOString();
      const label = h.description ?? h.name ?? '';
      return label ? `- ${tag}${h.filename} (${ts}): ${label}` : `- ${tag}${h.filename} (${ts})`;
    })
    .join('\n');
}
