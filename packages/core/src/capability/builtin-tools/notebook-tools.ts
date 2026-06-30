/**
 * Builtin notebook tool (②) — `notebook_edit` (alias `NotebookEdit`).
 *
 * 对 Jupyter `.ipynb`(JSON)做单 cell 的
 * replace / insert / delete。IO 经注入的 `SandboxFs`(同 file-tools 约定),core 不碰 node:fs。
 *
 * Boundary: 仅 import core-local 契约。
 */
import type { CoreEvent } from '../../events/types';
import { CoreEventType } from '../../events/events';
import { buildTool, type AgentTool } from '../types';
import { requireSandboxFs } from './file-tools';

export type NotebookEditMode = 'replace' | 'insert' | 'delete';
export type NotebookCellType = 'code' | 'markdown';

interface NbCell {
  cell_type: string;
  source: string | string[];
  id?: string;
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  cells: NbCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
}

export interface NotebookEditInput {
  notebook_path: string;
  /** 目标 cell 的 id;replace/delete 必填,insert 时为「插在此 cell 之后」(省略=开头)。 */
  cell_id?: string;
  /** 新 cell 源(replace/insert 用)。 */
  new_source?: string;
  cell_type?: NotebookCellType;
  edit_mode?: NotebookEditMode;
}

export interface NotebookEditOutput {
  notebook_path: string;
  edit_mode: NotebookEditMode;
  cell_id?: string;
  cellCount: number;
}

function cellText(c: NbCell): string {
  return Array.isArray(c.source) ? c.source.join('') : c.source;
}

export function notebookEditTool(): AgentTool<NotebookEditInput, NotebookEditOutput> {
  return buildTool<NotebookEditInput, NotebookEditOutput>({
    name: 'notebook_edit',
    aliases: ['NotebookEdit'],
    searchHint: 'edit a Jupyter notebook (.ipynb) cell',
    inputJSONSchema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string', description: 'Absolute path to the .ipynb file.' },
        cell_id: { type: 'string', description: 'Target cell id (replace/delete), or anchor cell for insert.' },
        new_source: { type: 'string', description: 'New cell source (replace/insert).' },
        cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Cell type for insert (or to change on replace).' },
        edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Defaults to replace.' },
      },
      required: ['notebook_path'],
      additionalProperties: false,
    },
    maxResultSizeChars: Infinity,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async call(input, ctx): Promise<{ data: NotebookEditOutput }> {
      const fs = requireSandboxFs(ctx);
      if (typeof input.notebook_path !== 'string' || input.notebook_path === '') {
        throw new Error('notebook_edit: notebook_path must be a non-empty string');
      }
      const mode: NotebookEditMode = input.edit_mode ?? 'replace';
      const raw = await fs.readText(input.notebook_path);
      let nb: Notebook;
      try {
        nb = JSON.parse(raw) as Notebook;
      } catch {
        throw new Error(`notebook_edit: ${input.notebook_path} is not valid JSON`);
      }
      if (!Array.isArray(nb.cells)) throw new Error('notebook_edit: notebook has no cells array');

      const findIdx = (id?: string) => (id == null ? -1 : nb.cells.findIndex((c) => c.id === id));

      if (mode === 'delete') {
        const i = findIdx(input.cell_id);
        if (i < 0) throw new Error(`notebook_edit: cell_id "${input.cell_id}" not found for delete`);
        nb.cells.splice(i, 1);
      } else if (mode === 'insert') {
        if (typeof input.new_source !== 'string') {
          throw new Error('notebook_edit: new_source is required for insert');
        }
        const cell: NbCell = {
          cell_type: input.cell_type ?? 'code',
          source: input.new_source,
          id: `cell-${nb.cells.length + 1}-${cellText({ cell_type: '', source: input.new_source }).length}`,
          metadata: {},
          ...(input.cell_type === 'markdown' ? {} : { outputs: [], execution_count: null }),
        };
        const at = input.cell_id ? findIdx(input.cell_id) : -1;
        if (input.cell_id && at < 0) throw new Error(`notebook_edit: anchor cell_id "${input.cell_id}" not found`);
        nb.cells.splice(at + 1, 0, cell); // at=-1 → 开头
      } else {
        // replace
        const i = findIdx(input.cell_id);
        if (i < 0) throw new Error(`notebook_edit: cell_id "${input.cell_id}" not found for replace`);
        if (typeof input.new_source !== 'string') {
          throw new Error('notebook_edit: new_source is required for replace');
        }
        nb.cells[i].source = input.new_source;
        if (input.cell_type) nb.cells[i].cell_type = input.cell_type;
      }

      await fs.writeText(input.notebook_path, JSON.stringify(nb, null, 1));
      return {
        data: { notebook_path: input.notebook_path, edit_mode: mode, cell_id: input.cell_id, cellCount: nb.cells.length },
      };
    },
    mapResult: (o, id): CoreEvent => ({
      type: CoreEventType.ToolCallResult,
      payload: {
        toolUseId: id,
        isError: false,
        result: `Notebook ${o.edit_mode} applied to ${o.notebook_path} (${o.cellCount} cells)`,
      },
      ts: Date.now(),
    }),
  });
}

// ─── notebook_read ─────────────────────────────────────────────────────────
//
// 补齐「有写无读」:notebook_edit 改 cell 前,agent 需先 notebook_read 看内容
// + 拿 cell id 才能定位。读 .ipynb 为 cells + outputs。
// IO 同 notebook_edit:经注入的 SandboxFs(core 不碰 node:fs)。

/** 单 cell 的某条 output(已抽成文本;图片 output 先只出占位文本 / 留 hook)。 */
export interface NotebookCellOutput {
  /** jupyter output_type:stream / execute_result / display_data / error。 */
  output_type: string;
  /** 抽出的文本内容(stdout/stderr/text/plain、error traceback 等)。 */
  text?: string;
  /** 非文本(图片等)output 的 MIME 类型,文本暂以占位呈现;后续多模态可据此带出。 */
  imageMimeType?: string;
}

/** notebook_read 输出的单 cell 形状(id 供 notebook_edit 定位)。 */
export interface NotebookReadCell {
  /** cell id;notebook_edit 据此定位 replace/insert/delete。可能为 undefined(旧 nb)。 */
  id?: string;
  cell_type: string;
  /** 已拼接的 cell 源(数组 source 已 join)。 */
  source: string;
  /** 该 cell 的 outputs(已抽成文本;markdown cell 无 outputs)。 */
  outputs: NotebookCellOutput[];
}

export interface NotebookReadInput {
  notebook_path: string;
}

export interface NotebookReadOutput {
  notebook_path: string;
  cellCount: number;
  cells: NotebookReadCell[];
}

/** 把一条 jupyter output 抽成 {output_type, text?/imageMimeType?}。 */
function parseOutput(out: unknown): NotebookCellOutput {
  const o = (out ?? {}) as Record<string, unknown>;
  const output_type = typeof o.output_type === 'string' ? o.output_type : 'unknown';

  // stream:{ output_type:'stream', name, text:string|string[] }
  if (output_type === 'stream') {
    const t = o.text;
    return { output_type, text: Array.isArray(t) ? (t as string[]).join('') : String(t ?? '') };
  }

  // error:{ output_type:'error', ename, evalue, traceback:string[] }
  if (output_type === 'error') {
    const tb = Array.isArray(o.traceback) ? (o.traceback as string[]).join('\n') : '';
    const head = [o.ename, o.evalue].filter(Boolean).join(': ');
    return { output_type, text: [head, tb].filter(Boolean).join('\n') };
  }

  // execute_result / display_data:{ ..., data: { 'text/plain': ..., 'image/png': ... } }
  const data = (o.data ?? {}) as Record<string, unknown>;
  if (data && typeof data === 'object') {
    const plain = data['text/plain'];
    if (plain != null) {
      return { output_type, text: Array.isArray(plain) ? (plain as string[]).join('') : String(plain) };
    }
    // 无 text/plain 但有图片:先出占位文本 + 记 MIME,留多模态 hook(对齐 011 约定)。
    const imageKey = Object.keys(data).find((k) => k.startsWith('image/'));
    if (imageKey) {
      return { output_type, imageMimeType: imageKey, text: `[${imageKey} output]` };
    }
  }

  return { output_type };
}

export function notebookReadTool(): AgentTool<NotebookReadInput, NotebookReadOutput> {
  return buildTool<NotebookReadInput, NotebookReadOutput>({
    name: 'notebook_read',
    aliases: ['NotebookRead'],
    searchHint: 'read a Jupyter notebook (.ipynb) as cells + outputs',
    inputJSONSchema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string', description: 'Absolute path to the .ipynb file.' },
      },
      required: ['notebook_path'],
      additionalProperties: false,
    },
    // read 永不超限 persist(对齐 read_file / notebook_edit)。
    maxResultSizeChars: Infinity,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input, ctx): Promise<{ data: NotebookReadOutput }> {
      const fs = requireSandboxFs(ctx);
      if (typeof input.notebook_path !== 'string' || input.notebook_path === '') {
        throw new Error('notebook_read: notebook_path must be a non-empty string');
      }
      const raw = await fs.readText(input.notebook_path);
      let nb: Notebook;
      try {
        nb = JSON.parse(raw) as Notebook;
      } catch {
        throw new Error(`notebook_read: ${input.notebook_path} is not valid JSON`);
      }
      if (!Array.isArray(nb.cells)) throw new Error('notebook_read: notebook has no cells array');

      const cells: NotebookReadCell[] = nb.cells.map((c) => ({
        id: c.id,
        cell_type: c.cell_type,
        source: cellText(c),
        outputs: Array.isArray(c.outputs) ? c.outputs.map(parseOutput) : [],
      }));

      return {
        data: { notebook_path: input.notebook_path, cellCount: cells.length, cells },
      };
    },
    mapResult: (o, id): CoreEvent => ({
      type: CoreEventType.ToolCallResult,
      payload: {
        toolUseId: id,
        isError: false,
        result: `Notebook ${o.notebook_path} read (${o.cellCount} cells)`,
        cellCount: o.cellCount,
      },
      ts: Date.now(),
    }),
  });
}

/** notebook 工具聚合包(builtin 层)。 */
export function notebookToolsPack() {
  return {
    name: 'notebook-tools',
    layer: 'builtin' as const,
    tools: [notebookEditTool(), notebookReadTool()],
  };
}
