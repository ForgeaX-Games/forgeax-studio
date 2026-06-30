/**
 * Builtin search tools (②) — `grep` / `glob`.
 *
 * 二者皆 **只读 + 并发安全**。
 *
 * grep/glob 常见实现直接 spawn ripgrep / fast-glob；core ② **不**直接 spawn(boundary)，
 * 也不依赖外部包——改为经注入的 `SandboxFs`(inject C3 §4.5) 用同步 readdir 递归遍历
 * 文件树，自带 glob→RegExp 转换 + 内容正则匹配。功能子集覆盖常用形态(pattern/
 * path/glob/output_mode/head_limit)，重活(ripgrep 全部 flag) 留给 host 覆盖实现。
 *
 * Boundary: 仅 import core-local 契约 + node:。
 */
import type { SandboxFs, DirEnt } from '../../inject/types';
import type { CoreEvent } from '../../events/types';
import { CoreEventType } from '../../events/events';
import { buildTool, type AgentTool, type ToolContext } from '../types';
import { requireSandboxFs } from './file-tools';

const DEFAULT_HEAD_LIMIT = 250;
/** 遍历守卫：避免病态目录树打爆遍历(纯内存遍历，无 ripgrep 的智能跳过)。 */
const MAX_WALK_FILES = 20_000;
/** 总是跳过的目录(对齐 ripgrep 默认忽略的重目录)。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn']);

// ─── glob → RegExp ───────────────────────────────────────────────────────────

/** 把一个 glob 片段(单段，不含 `/`)转成正则源码。支持 `*` `?` `[...]` `{a,b}`。 */
function globSegmentToRegex(seg: string): string {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '.' || c === '+' || c === '(' || c === ')' || c === '^' || c === '$' || c === '|' || c === '\\')
      out += '\\' + c;
    else if (c === '{') out += '(?:';
    else if (c === '}') out += ')';
    else if (c === ',') out += '|';
    else if (c === '[') out += '[';
    else if (c === ']') out += ']';
    else out += c;
  }
  return out;
}

/** 整条 glob(可含 `/` 与 `**`)→ RegExp(匹配相对路径，全段)。 */
export function globToRegExp(glob: string): RegExp {
  const parts = glob.split('/');
  const compiled = parts
    .map((p) => (p === '**' ? '.*' : globSegmentToRegex(p)))
    .join('/')
    // `**/` → 允许 0 段或多段
    .replace(/\.\*\//g, '(?:.*/)?');
  return new RegExp('^' + compiled + '$');
}

// ─── 递归遍历(经 SandboxFs.readdirSync) ──────────────────────────────────────

interface WalkHit {
  /** 相对 root 的 posix 路径。 */
  rel: string;
  /** 绝对路径(root + rel)。 */
  abs: string;
}

function joinPath(a: string, b: string): string {
  if (a === '') return b;
  return a.endsWith('/') ? a + b : a + '/' + b;
}

/** 同步深度遍历；filterRel 决定一个相对路径是否收集(为 null=全收)。 */
function walkFiles(
  fs: SandboxFs,
  root: string,
  filterRel: ((rel: string) => boolean) | null,
): WalkHit[] {
  const hits: WalkHit[] = [];
  const stack: string[] = [''];
  while (stack.length > 0) {
    if (hits.length >= MAX_WALK_FILES) break;
    const relDir = stack.pop() as string;
    const absDir = relDir === '' ? root : joinPath(root, relDir);
    let entries: DirEnt[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true }) as DirEnt[];
    } catch {
      continue; // 不可读目录 → 跳过(只读工具不应炸)
    }
    for (const ent of entries) {
      const childRel = joinPath(relDir, ent.name);
      if (ent.isDir) {
        if (SKIP_DIRS.has(ent.name)) continue;
        stack.push(childRel);
      } else if (ent.isFile) {
        if (filterRel === null || filterRel(childRel)) {
          hits.push({ rel: childRel, abs: joinPath(root, childRel) });
        }
      }
    }
  }
  return hits;
}

function resolveRoot(ctx: ToolContext, path?: string): string {
  if (path && path !== '') return path;
  const cwd = (ctx as ToolContext & { cwd?: string }).cwd;
  if (typeof cwd === 'string' && cwd !== '') return cwd;
  return '.';
}

function clampHead<T>(arr: T[], headLimit?: number): T[] {
  const n = headLimit === undefined ? DEFAULT_HEAD_LIMIT : headLimit;
  if (n <= 0) return arr; // 0 = unlimited（head_limit:0）
  return arr.slice(0, n);
}

// ─── glob ────────────────────────────────────────────────────────────────────

export interface GlobInput {
  pattern: string;
  /** 搜索根目录。省略=ctx.cwd 或 "."。 */
  path?: string;
  head_limit?: number;
}

export interface GlobOutput {
  files: string[];
  truncated: boolean;
}

export function globTool(): AgentTool<GlobInput, GlobOutput> {
  return buildTool<GlobInput, GlobOutput>({
    name: 'glob',
    aliases: ['Glob'],
    searchHint: 'find files by glob pattern',
    inputJSONSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern to match files against' },
        path: {
          type: 'string',
          description: 'The directory to search in. Defaults to the current working directory.',
        },
        head_limit: {
          type: 'number',
          description: 'Limit output to first N entries. Defaults to 250. Pass 0 for unlimited.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    maxResultSizeChars: 100_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input, ctx): Promise<{ data: GlobOutput }> {
      const fs = requireSandboxFs(ctx);
      if (typeof input.pattern !== 'string' || input.pattern === '') {
        throw new Error('glob: pattern must be a non-empty string');
      }
      const root = resolveRoot(ctx, input.path);
      const re = globToRegExp(input.pattern);
      const hits = walkFiles(fs, root, (rel) => re.test(rel));
      const all = hits.map((h) => h.abs).sort();
      const files = clampHead(all, input.head_limit);
      return { data: { files, truncated: files.length < all.length } };
    },
    mapResult(output, toolUseId): CoreEvent {
      return {
        type: CoreEventType.ToolCallResult,
        payload: {
          toolUseId,
          isError: false,
          files: output.files,
          count: output.files.length,
          truncated: output.truncated,
        },
        ts: Date.now(),
      };
    },
    renderToolUseMessage: (input) => `Globbing ${input.pattern}`,
  });
}

// ─── grep ────────────────────────────────────────────────────────────────────

export type GrepOutputMode = 'content' | 'files_with_matches' | 'count';

export interface GrepInput {
  pattern: string;
  /** 搜索根目录或单个文件。省略=ctx.cwd 或 "."。 */
  path?: string;
  /** 仅匹配此 glob 的文件(rg --glob)。 */
  glob?: string;
  /** 输出模式，默认 files_with_matches。 */
  output_mode?: GrepOutputMode;
  /** 大小写不敏感(rg -i)。 */
  '-i'?: boolean;
  /** content 模式显示行号(默认 true)。 */
  '-n'?: boolean;
  head_limit?: number;
}

export interface GrepContentLine {
  file: string;
  lineNumber: number;
  line: string;
}

export interface GrepOutput {
  mode: GrepOutputMode;
  /** content 模式。 */
  matches?: GrepContentLine[];
  /** files_with_matches 模式。 */
  files?: string[];
  /** count 模式：file → 命中行数。 */
  counts?: Array<{ file: string; count: number }>;
  truncated: boolean;
}

export function grepTool(): AgentTool<GrepInput, GrepOutput> {
  return buildTool<GrepInput, GrepOutput>({
    name: 'grep',
    aliases: ['Grep'],
    searchHint: 'search file contents by regex',
    inputJSONSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The regular expression pattern to search for in file contents',
        },
        path: {
          type: 'string',
          description: 'File or directory to search in. Defaults to the current working directory.',
        },
        glob: {
          type: 'string',
          description: 'Glob pattern to filter files (e.g. "*.ts", "*.{ts,tsx}").',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description:
            'Output mode: "content" shows matching lines, "files_with_matches" shows file paths, "count" shows match counts. Defaults to "files_with_matches".',
        },
        '-i': { type: 'boolean', description: 'Case insensitive search' },
        '-n': {
          type: 'boolean',
          description: 'Show line numbers in content mode. Defaults to true.',
        },
        head_limit: {
          type: 'number',
          description: 'Limit output to first N entries. Defaults to 250. Pass 0 for unlimited.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    maxResultSizeChars: 20_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input, ctx): Promise<{ data: GrepOutput }> {
      const fs = requireSandboxFs(ctx);
      if (typeof input.pattern !== 'string' || input.pattern === '') {
        throw new Error('grep: pattern must be a non-empty string');
      }
      const mode: GrepOutputMode = input.output_mode ?? 'files_with_matches';
      const flags = input['-i'] ? 'i' : '';
      let re: RegExp;
      try {
        re = new RegExp(input.pattern, flags);
      } catch (err) {
        throw new Error(`grep: invalid pattern — ${err instanceof Error ? err.message : String(err)}`);
      }
      const showLineNumbers = input['-n'] !== false;

      // 解析搜索目标：单文件 vs 目录树。
      const root = resolveRoot(ctx, input.path);
      let targets: WalkHit[];
      if (input.path && input.path !== '' && fs.existsSync(input.path) && fs.statSync(input.path).isFile) {
        targets = [{ rel: input.path, abs: input.path }];
      } else {
        const globRe = input.glob ? globToRegExp(input.glob) : null;
        targets = walkFiles(fs, root, (rel) => {
          if (!globRe) return true;
          // glob 既匹配整相对路径，也匹配 basename(常见 "*.ts" 写法)。
          const base = rel.split('/').pop() as string;
          return globRe.test(rel) || globRe.test(base);
        });
      }

      const contentMatches: GrepContentLine[] = [];
      const fileSet: string[] = [];
      const counts: Array<{ file: string; count: number }> = [];

      for (const t of targets) {
        let text: string;
        try {
          text = await fs.readText(t.abs);
        } catch {
          continue; // 二进制/不可读 → 跳过
        }
        const lines = text.split('\n');
        let fileCount = 0;
        for (let i = 0; i < lines.length; i++) {
          // 每行独立测试(non-global regex，避免 lastIndex 状态)。
          if (re.test(lines[i])) {
            fileCount++;
            if (mode === 'content') {
              contentMatches.push({ file: t.abs, lineNumber: i + 1, line: lines[i] });
            }
          }
        }
        if (fileCount > 0) {
          fileSet.push(t.abs);
          if (mode === 'count') counts.push({ file: t.abs, count: fileCount });
        }
      }

      if (mode === 'content') {
        const clamped = clampHead(contentMatches, input.head_limit);
        void showLineNumbers; // 行号始终在结构化结果里(showLineNumbers 仅影响渲染)
        return { data: { mode, matches: clamped, truncated: clamped.length < contentMatches.length } };
      }
      if (mode === 'count') {
        const sorted = counts.sort((a, b) => a.file.localeCompare(b.file));
        const clamped = clampHead(sorted, input.head_limit);
        return { data: { mode, counts: clamped, truncated: clamped.length < sorted.length } };
      }
      const sortedFiles = fileSet.sort();
      const clampedFiles = clampHead(sortedFiles, input.head_limit);
      return {
        data: { mode, files: clampedFiles, truncated: clampedFiles.length < sortedFiles.length },
      };
    },
    mapResult(output, toolUseId): CoreEvent {
      const payload: Record<string, unknown> = {
        toolUseId,
        isError: false,
        mode: output.mode,
        truncated: output.truncated,
      };
      if (output.mode === 'content') {
        payload.matches = output.matches ?? [];
        payload.count = output.matches?.length ?? 0;
      } else if (output.mode === 'count') {
        payload.counts = output.counts ?? [];
        payload.count = output.counts?.length ?? 0;
      } else {
        payload.files = output.files ?? [];
        payload.count = output.files?.length ?? 0;
      }
      return { type: CoreEventType.ToolCallResult, payload, ts: Date.now() };
    },
    renderToolUseMessage: (input) => `Grepping ${input.pattern}`,
  });
}
