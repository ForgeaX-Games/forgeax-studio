/**
 * Memory tools — `memory_search` (scan + recall) and `remember` (write + index).
 *
 * `memory_search` = scan frontmatter manifest → LLM-select
 * 召回(`recall.ts`)→ 读全文(经 SandboxFs);`remember` = 写一条 `.md`(带 frontmatter)
 * 到 memory 目录并重建 `MEMORY.md` 索引。两工具名用 C8 常量(MEMORY_SEARCH_TOOL /
 * REMEMBER_TOOL),受 `isAutoMemPath` 写闸约束(只允许写 memory 目录内)。预算遵守
 * MEMORY_BUDGET(perFileMaxLines/Bytes/perTurnMaxFiles)。
 *
 * core 不内置 LLM,也不规定 type 枚举:selectFn 经注入,`remember.type` 原样落 frontmatter。
 * Boundary: 仅 import core-local 类型 + node:。
 */
import type { SandboxFs } from '../../inject/types';
import type { AgentTool } from '../types';
import { buildTool } from '../types';
import {
  MEMORY_SEARCH_TOOL,
  REMEMBER_TOOL,
  MEMORY_BUDGET,
  type MemorySearchInput,
  type MemorySearchOutput,
  type MemoryHit,
  type RememberInput,
  type RememberOutput,
} from '../memory-seam';
import { scanMemoryFiles, MEMORY_INDEX_FILE } from './scan';
import { rebuildIndex } from './slot';
import { findRelevantMemories, type MemorySelectFn } from './recall';

// ─── freshness：mtime → "N days ago"（模型读人类文本而非 ISO）──

export function freshness(mtimeMs: number, now: number = Date.now()): string {
  const d = Math.max(0, Math.floor((now - mtimeMs) / 86_400_000));
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
}

// ─── 写闸：只允许写 memory 目录内（防越权写盘）──────────────────────────────────

/** 规整路径:折叠 `//`、解析 `.`/`..`(纯字符串,不触盘),统一无尾斜杠。 */
function normalize(p: string): string {
  const parts = p.split('/');
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
    } else {
      out.push(seg);
    }
  }
  const lead = p.startsWith('/') ? '/' : '';
  return lead + out.join('/');
}

/**
 * 写闸:`target` 是否落在 `memoryDir` 之内(含目录本身)。拒目录外 / `..` 逃逸。
 * 经此校验后方可写盘——core 的 remember 工具只允许往 memory 目录写。
 */
export function isAutoMemPath(memoryDir: string, target: string): boolean {
  const root = normalize(memoryDir);
  const t = normalize(target.startsWith('/') ? target : join(root, target));
  return t === root || t.startsWith(`${root}/`);
}

// ─── 工具构建 ───────────────────────────────────────────────────────────────────

export interface MemoryToolDeps {
  memoryDir: string;
  sandboxFs: SandboxFs;
  /** 召回选择器(可选;无则回退取最新 N)。 */
  selectFn?: MemorySelectFn;
}

function join(a: string, b: string): string {
  if (a.endsWith('/')) return a + b;
  return `${a}/${b}`;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'entry'
  );
}

/** 截到预算:先按字节,再按行。 */
function clampToBudget(text: string): string {
  let out = text;
  const lines = out.split('\n');
  if (lines.length > MEMORY_BUDGET.perFileMaxLines) {
    out = lines.slice(0, MEMORY_BUDGET.perFileMaxLines).join('\n');
  }
  if (out.length > MEMORY_BUDGET.perFileMaxBytes) {
    out = out.slice(0, MEMORY_BUDGET.perFileMaxBytes);
  }
  return out;
}

/** `memory_search`:scan + recall + 读全文(预算截断),回 hits。只读工具。 */
export function makeMemorySearchTool(deps: MemoryToolDeps): AgentTool<MemorySearchInput, MemorySearchOutput> {
  const { memoryDir, sandboxFs, selectFn } = deps;
  return buildTool<MemorySearchInput, MemorySearchOutput>({
    name: MEMORY_SEARCH_TOOL,
    searchHint: 'recall long-term memory by topic',
    inputJSONSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall (topic / question).' },
        limit: { type: 'number', description: 'Max memories to return.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    maxResultSizeChars: MEMORY_BUDGET.sessionMaxBytes,
    call: async (input) => {
      const headers = scanMemoryFiles(sandboxFs, memoryDir);
      const relevant = await findRelevantMemories(headers, input.query ?? '', selectFn, input.limit);
      const hits: MemoryHit[] = [];
      for (const h of relevant) {
        let content = '';
        try {
          content = clampToBudget(sandboxFs.readTextSync(h.filePath));
        } catch {
          continue;
        }
        hits.push({ path: h.filePath, freshness: freshness(h.mtimeMs), content });
      }
      return { data: { hits } };
    },
    mapResult: (output, toolUseId) => ({
      type: 'tool.result',
      payload: { toolUseId, tool: MEMORY_SEARCH_TOOL, hits: output.hits.length },
      ts: Date.now(),
    }),
  });
}

/** `remember`:写一条 `.md`(frontmatter + body)到 memory 目录 + 重建索引。写工具。 */
export function makeRememberTool(deps: MemoryToolDeps): AgentTool<RememberInput, RememberOutput> {
  const { memoryDir, sandboxFs } = deps;
  return buildTool<RememberInput, RememberOutput>({
    name: REMEMBER_TOOL,
    searchHint: 'persist a new long-term memory',
    inputJSONSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short title/slug for the memory.' },
        description: { type: 'string', description: 'One-line summary (used for recall relevance).' },
        type: { type: 'string', description: 'Caller-defined category tag (free string).' },
        body: { type: 'string', description: 'The memory content to persist.' },
      },
      required: ['name', 'description', 'body'],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    maxResultSizeChars: 4096,
    call: async (input) => {
      const base = slugify(input.name || input.description || 'entry');
      let name = `${base}.md`;
      let n = 2;
      while (sandboxFs.existsSync(join(memoryDir, name))) {
        name = `${base}-${n++}.md`;
      }
      const target = join(memoryDir, name);

      // 写闸:绝不写出 memory 目录之外。
      if (!isAutoMemPath(memoryDir, target)) {
        throw new Error(`remember: refusing to write outside memory dir: ${target}`);
      }

      sandboxFs.mkdirSync(memoryDir, { recursive: true });
      const body = clampToBudget(input.body ?? '');
      const fm = [
        '---',
        `name: ${escapeYaml(input.name)}`,
        `description: ${escapeYaml(input.description)}`,
        `type: ${escapeYaml(input.type)}`,
        '---',
      ].join('\n');
      sandboxFs.writeTextSync(target, `${fm}\n\n${body.trim()}\n`);

      // 重建 MEMORY.md 索引(扫盘,保证与文件一致)。
      rebuildIndex(sandboxFs, memoryDir);

      return { data: { path: target } };
    },
    mapResult: (output, toolUseId) => ({
      type: 'tool.result',
      payload: { toolUseId, tool: REMEMBER_TOOL, path: output.path },
      ts: Date.now(),
    }),
  });
}

/** 引号包裹含特殊字符的 YAML 标量值。 */
function escapeYaml(v: string): string {
  const s = (v ?? '').trim();
  if (s === '') return '""';
  if (/[:#"'\n{}[\]]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

export { MEMORY_INDEX_FILE };
