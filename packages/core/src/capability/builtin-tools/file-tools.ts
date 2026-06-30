/**
 * Builtin file tools (②) — `read_file` / `write_file` / `edit_file`.
 *
 * 文件工具语义:
 *   - read 只读 + 并发安全 + maxResultSizeChars=Infinity（永不 persist）；
 *   - write / edit 非只读 + 非并发安全（buildTool 默认 fail-closed），对内容做实际
 *     修改（二者均不声明并发安全）。
 *
 * IO 全部经 host 注入的 `SandboxFs`（inject C3 §4.5）——core 自己不碰 node:fs。
 * 工具从 `ToolContext` 上取注入句柄（host 把 `sandboxFs` 挂在 ctx 上，见
 * §「集成者约定」/ `requireSandboxFs`）。schema 用 `inputJSONSchema`(MCP 原样 JSON
 * Schema)——core boundary 禁外部包，故不引 zod。
 *
 * Boundary: 仅 import core-local 契约 + node:。
 */
import type { SandboxFs } from '../../inject/types';
import type { CoreEvent } from '../../events/types';
import { CoreEventType } from '../../events/events';
import { buildTool, type AgentTool, type ToolContext } from '../types';
import {
  imageBlockFromBytes,
  imageMediaTypeFromMagic,
  isImageExt,
  type ImageContentBlock,
} from '../image-block';

// ─── 集成者约定：ctx 上的注入句柄 ────────────────────────────────────────────
//
// ToolContext 是开放形状（`[key: string]: unknown`），host 在 dispatch 工具前把
// inject 包里的 `SandboxFs` / `TerminalManager` 挂到 ctx 上。约定 key：
//   ctx.sandboxFs : SandboxFs   ← file-tools 取这个
//   ctx.terminal  : TerminalManager（见 shell-tools）
// 以下 `ToolDeps` 描述这个约定形状，`requireSandboxFs` 做取值 + fail-loud。

/** ToolContext 上 host 注入的能力句柄（见上文约定）。 */
export interface ToolDeps {
  sandboxFs?: SandboxFs;
}

/** 从 ctx 取 SandboxFs；缺失即 host 注入契约被违反 → loud throw（不静默吞）。 */
export function requireSandboxFs(ctx: ToolContext): SandboxFs {
  const fs = (ctx as ToolContext & ToolDeps).sandboxFs;
  if (!fs) {
    throw new Error(
      'file-tools: ToolContext.sandboxFs is missing — host must inject SandboxFs (inject C3 §4.5) onto the ToolContext before dispatch.',
    );
  }
  return fs;
}

// ─── 共享工具函数 ────────────────────────────────────────────────────────────

/** 取路径的父目录（POSIX `/` 与 Windows `\` 都吃；无分隔符 → 空串）。不引 node:path,
 *  保持 core 不碰 node: 的约定;尾部多余分隔符先剥。 */
function parentDirOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i > 0 ? trimmed.slice(0, i) : '';
}

/** 给每行加 `<n>\t` 行号前缀（cat -n 风格）。 */
function addLineNumbers(content: string, startLine = 1): string {
  if (content === '') return '';
  return content
    .split('\n')
    .map((line, i) => `${String(startLine + i).padStart(6, ' ')}\t${line}`)
    .join('\n');
}

/** mapResult 共享：把 output 包成 tool.result CoreEvent。 */
function toResultEvent(
  toolUseId: string,
  payload: Record<string, unknown>,
  isError = false,
): CoreEvent {
  return {
    type: CoreEventType.ToolCallResult,
    payload: { toolUseId, isError, ...payload },
    ts: Date.now(),
  };
}

// ─── read_file ───────────────────────────────────────────────────────────────

export interface ReadFileInput {
  file_path: string;
  /** 起始行(1-based，含)。省略=从头读。 */
  offset?: number;
  /** 读多少行。省略=读到尾。 */
  limit?: number;
  /** 仅对 PDF 生效:页范围(如 "1-5")。当前未带 PDF→图渲染依赖,留作 forward-compat。 */
  pages?: string;
}

export interface ReadFileOutput {
  file_path: string;
  /** 带行号的内容(图片/PDF 时为人类可读占位说明)。 */
  content: string;
  /** 实际返回的行数。 */
  numLines: number;
  /** 文件总行数。 */
  totalLines: number;
  /** 多模态:命中图片时携带 provider image content block(回灌给模型看图)。 */
  imageBlocks?: ImageContentBlock[];
}

export function readFileTool(): AgentTool<ReadFileInput, ReadFileOutput> {
  return buildTool<ReadFileInput, ReadFileOutput>({
    name: 'read_file',
    aliases: ['Read'],
    searchHint: 'read a file from the filesystem',
    inputJSONSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The path to the file to read (absolute, or relative to the working directory)' },
        offset: {
          type: 'number',
          description: 'The 1-based line number to start reading from. Only provide if the file is too large to read at once.',
        },
        limit: {
          type: 'number',
          description: 'The number of lines to read. Only provide if the file is too large to read at once.',
        },
        pages: {
          type: 'string',
          description: 'PDF page range (e.g. "1-5"). Only applicable to PDF files.',
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    // read 永不超限 persist（maxResultSizeChars=Infinity）。
    maxResultSizeChars: Infinity,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input, ctx): Promise<{ data: ReadFileOutput }> {
      const fs = requireSandboxFs(ctx);
      if (typeof input.file_path !== 'string' || input.file_path === '') {
        throw new Error('read_file: file_path must be a non-empty string');
      }
      // ── 多模态分支:先判图片(扩展名命中,或无扩展名时读前 12 字节验魔数)──
      const imageOut = await tryReadImage(fs, input.file_path);
      if (imageOut) return { data: imageOut };
      // ── 文本路径(零回归)──
      const raw = await fs.readText(input.file_path);
      const allLines = raw.split('\n');
      const totalLines = allLines.length;
      const start = input.offset && input.offset > 0 ? input.offset - 1 : 0;
      const end = input.limit && input.limit > 0 ? start + input.limit : totalLines;
      const slice = allLines.slice(start, end);
      const content = addLineNumbers(slice.join('\n'), start + 1);
      return {
        data: { file_path: input.file_path, content, numLines: slice.length, totalLines },
      };
    },
    mapResult(output, toolUseId): CoreEvent {
      return toResultEvent(toolUseId, {
        file_path: output.file_path,
        content: output.content,
        numLines: output.numLines,
        totalLines: output.totalLines,
        // 图片:把 image block 透到 tool.result payload —— LOOP 的 toolResultsToContent
        //   见到 imageBlocks 即组成 content 数组([text, image…]),Anthropic 原样吃图,
        //   openai-compat 优雅降级(丢图留文,见 toolResultToText)。
        ...(output.imageBlocks && output.imageBlocks.length > 0
          ? { imageBlocks: output.imageBlocks }
          : {}),
      });
    },
    renderToolUseMessage: (input) => `Reading ${input.file_path}`,
  });
}

/** 尝试把文件读成 image block;非图片返回 null(→ read_file 回落文本路径)。
 *  判定:扩展名命中常见图片格式 → 直接读全字节;扩展名不可信(无/非图)时,读前 12
 *  字节验魔数,命中才整文件读出。这样文本文件最多多一次小读,不回归。 */
async function tryReadImage(fs: SandboxFs, path: string): Promise<ReadFileOutput | null> {
  let isImage = isImageExt(path);
  if (!isImage) {
    // 无可信扩展名 → 偷看文件头魔数。读盘失败(如目录/不存在)交给文本路径报原错。
    try {
      const head = await fs.readBytes(path, 0, 12);
      if (imageMediaTypeFromMagic(head) !== null) isImage = true;
    } catch {
      return null;
    }
  }
  if (!isImage) return null;
  const bytes = await fs.readBytes(path);
  const block = imageBlockFromBytes(bytes, path);
  return {
    file_path: path,
    content: `[image ${block.source.media_type}, ${bytes.length} bytes — returned as image content block]`,
    numLines: 0,
    totalLines: 0,
    imageBlocks: [block],
  };
}

// ─── write_file ──────────────────────────────────────────────────────────────

export interface WriteFileInput {
  file_path: string;
  content: string;
}

export interface WriteFileOutput {
  file_path: string;
  bytesWritten: number;
  /** true=新建文件，false=覆盖既有。 */
  created: boolean;
}

export function writeFileTool(): AgentTool<WriteFileInput, WriteFileOutput> {
  return buildTool<WriteFileInput, WriteFileOutput>({
    name: 'write_file',
    aliases: ['Write'],
    searchHint: 'write (create or overwrite) a file',
    inputJSONSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The path to the file to write (absolute, or relative to the working directory)',
        },
        content: { type: 'string', description: 'The content to write to the file' },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
    maxResultSizeChars: 100_000,
    // write：非只读 / 非并发安全 → 用 buildTool 默认 fail-closed（不 override）。
    isDestructive: () => true,
    async call(input, ctx): Promise<{ data: WriteFileOutput }> {
      const fs = requireSandboxFs(ctx);
      if (typeof input.file_path !== 'string' || input.file_path === '') {
        throw new Error('write_file: file_path must be a non-empty string');
      }
      if (typeof input.content !== 'string') {
        throw new Error('write_file: content must be a string');
      }
      const created = !fs.existsSync(input.file_path);
      // Agent write 语义(对齐 Write / forgeax-cli kits write_file):目标父目录不存在时
      //   先创建,避免「新建目录 / symlink 游戏 / 首次写 src」场景 ENOENT(delivery=local
      //   本进程直跑同样适用——经注入 SandboxFs.mkdirSync,不碰 node:fs)。
      const parent = parentDirOf(input.file_path);
      if (parent && !fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
      await fs.writeText(input.file_path, input.content);
      return {
        data: {
          file_path: input.file_path,
          bytesWritten: byteLength(input.content),
          created,
        },
      };
    },
    mapResult(output, toolUseId): CoreEvent {
      return toResultEvent(toolUseId, {
        file_path: output.file_path,
        bytesWritten: output.bytesWritten,
        created: output.created,
        message: `${output.created ? 'Created' : 'Updated'} ${output.file_path}`,
      });
    },
    renderToolUseMessage: (input) => `Writing ${input.file_path}`,
  });
}

// ─── edit_file ───────────────────────────────────────────────────────────────

export interface EditFileInput {
  file_path: string;
  old_string: string;
  new_string: string;
  /** true=替换所有命中；false(默认)=要求唯一命中。 */
  replace_all?: boolean;
}

export interface EditFileOutput {
  file_path: string;
  /** 实际替换的次数。 */
  replacements: number;
}

export function editFileTool(): AgentTool<EditFileInput, EditFileOutput> {
  return buildTool<EditFileInput, EditFileOutput>({
    name: 'edit_file',
    aliases: ['Edit'],
    searchHint: 'replace a string in a file',
    inputJSONSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The path to the file to modify (absolute, or relative to the working directory)' },
        old_string: { type: 'string', description: 'The text to replace' },
        new_string: {
          type: 'string',
          description: 'The text to replace it with (must be different from old_string)',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences of old_string (default false)',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    maxResultSizeChars: 100_000,
    // edit：非只读 / 非并发安全 → buildTool 默认 fail-closed（不 override）。
    isDestructive: () => true,
    async call(input, ctx): Promise<{ data: EditFileOutput }> {
      const fs = requireSandboxFs(ctx);
      if (typeof input.file_path !== 'string' || input.file_path === '') {
        throw new Error('edit_file: file_path must be a non-empty string');
      }
      if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') {
        throw new Error('edit_file: old_string and new_string must be strings');
      }
      if (input.old_string === input.new_string) {
        throw new Error('edit_file: new_string must differ from old_string');
      }
      const original = await fs.readText(input.file_path);
      const occurrences = countOccurrences(original, input.old_string);
      if (occurrences === 0) {
        throw new Error(
          `edit_file: old_string not found in ${input.file_path}`,
        );
      }
      if (!input.replace_all && occurrences > 1) {
        throw new Error(
          `edit_file: old_string is not unique in ${input.file_path} (${occurrences} matches). Provide more context or set replace_all=true.`,
        );
      }
      const replacements = input.replace_all ? occurrences : 1;
      const updated = input.replace_all
        ? original.split(input.old_string).join(input.new_string)
        : replaceFirst(original, input.old_string, input.new_string);
      await fs.writeText(input.file_path, updated);
      return { data: { file_path: input.file_path, replacements } };
    },
    mapResult(output, toolUseId): CoreEvent {
      return toResultEvent(toolUseId, {
        file_path: output.file_path,
        replacements: output.replacements,
        message: `Made ${output.replacements} replacement(s) in ${output.file_path}`,
      });
    },
    renderToolUseMessage: (input) => `Editing ${input.file_path}`,
  });
}

// ─── 内部小工具(纯函数，不打 IO) ─────────────────────────────────────────────

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function replaceFirst(haystack: string, needle: string, repl: string): string {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return haystack;
  return haystack.slice(0, idx) + repl + haystack.slice(idx + needle.length);
}
