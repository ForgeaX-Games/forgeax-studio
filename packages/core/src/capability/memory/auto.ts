/**
 * Auto-memory engines (两个 "auto" 行为):
 *   1. **auto recall** —— 每个 user turn 自动 prefetch 相关记忆 → 作 system-reminder 注入。
 *   2. **auto extract** —— 回合结束后台抽取并写入持久记忆(forked agent),
 *      带 cursor 节流 + 互斥(单次进行中跳过)。
 *
 * 干净律:不内置 LLM —— select/extract 都用**注入的 provider** 跑 sideQuery;无 provider
 * 时 recall 退化为取最新 N、extract 跳过。Boundary: 仅 core 相对 import。
 */
import type { LLMProvider, ProviderRequest } from '../../provider/types';
import type { SandboxFs } from '../../inject/types';
import { scanMemoryFiles, formatManifest, type MemoryHeader, MEMORY_INDEX_FILE } from './scan';
import { findRelevantMemories, type MemorySelectFn } from './recall';
import { MEMORY_BUDGET } from '../memory-seam';
import { freshness, isAutoMemPath } from './tools';
import { rebuildIndex } from './slot';
import { wrapSystemReminder } from '../../context/dynamic-reminder';

const NEVER_ABORT = new AbortController().signal;

/** 收集一次 provider 调用的 assistant 文本(供 select/extract 的 sideQuery)。 */
async function collectText(provider: LLMProvider, req: ProviderRequest, signal: AbortSignal): Promise<string> {
  let text = '';
  for await (const ev of provider.stream(req, { signal })) {
    if (ev.type === 'assistant') {
      const content = (ev.message as { content?: Array<{ type: string; text?: string }> })?.content;
      if (Array.isArray(content)) {
        for (const b of content) if (b.type === 'text' && typeof b.text === 'string') text += b.text;
      }
    }
  }
  return text;
}

function tryParseJson<T>(text: string): T | null {
  // 容忍模型把 JSON 包在 `json fence 里。
  const fenced = text.match(/`(?:json)?\s*([\s\S]*?)`/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start)) as T;
  } catch {
    return null;
  }
}

const SELECT_SYS =
  'You select which stored memories are relevant to the user query. Return ONLY JSON ' +
  '{"selected":["filename.md", ...]} with at most 5 filenames you are CERTAIN are useful. Be selective; an empty list is fine.';

/** provider-backed selectFn(经 sideQuery 选相关记忆)。 */
export function makeProviderSelectFn(provider: LLMProvider, model: string): MemorySelectFn {
  return async (manifest: string, query: string): Promise<string[]> => {
    const req: ProviderRequest = {
      model,
      system: [{ type: 'text', text: SELECT_SYS }],
      tools: [],
      messages: [{ role: 'user', content: `Memory manifest:\n${manifest}\n\nUser query: ${query}` }],
      maxOutputTokens: 256,
    };
    const out = await collectText(provider, req, NEVER_ABORT);
    const parsed = tryParseJson<{ selected?: string[] }>(out);
    return Array.isArray(parsed?.selected) ? parsed!.selected!.filter((s) => typeof s === 'string') : [];
  };
}

const EXTRACT_SYS =
  'You extract durable, reusable memories from a conversation — facts about the user, their ' +
  'preferences, project constraints, or feedback that will matter in FUTURE sessions. Do NOT save ' +
  'code, file paths, transient task state, or anything derivable from the project. Return ONLY JSON ' +
  '{"memories":[{"type":"user|feedback|project|reference","name":"short-slug","description":"one line","body":"the memory"}]} ' +
  '— an empty list is correct when nothing is worth persisting.';

interface ExtractedMemory {
  type: string;
  name: string;
  description: string;
  body: string;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'memory'
  );
}

export interface AutoMemoryDeps {
  memoryDir: string;
  sandboxFs: SandboxFs;
  /** 用于默认 select/extract sideQuery;缺则 recall 退化取最新、extract 跳过。 */
  provider?: LLMProvider;
  model?: string;
  /** 覆盖默认 selectFn(否则由 provider 构造)。 */
  selectFn?: MemorySelectFn;
  /** 每 N 个 user turn 抽取一次(节流)。默认 1。 */
  extractEveryNTurns?: number;
  now?: () => number;
}

/**
 * 自动记忆引擎。host(CLI/编排层)构造并传给 CoreAgent;loop 每 user turn 调 recall、
 * done 后调 extract。结构上满足 CoreAgent 的 AutoMemoryHook 接口。
 */
export class AutoMemory {
  private readonly d: AutoMemoryDeps;
  private readonly selectFn?: MemorySelectFn;
  private readonly now: () => number;
  private readonly extractEvery: number;
  private readonly surfaced = new Set<string>();
  private sessionBytes = 0;
  private extracting = false;
  private turnsSinceExtract = 0;

  constructor(deps: AutoMemoryDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    this.extractEvery = deps.extractEveryNTurns ?? 1;
    this.selectFn = deps.selectFn ?? (deps.provider && deps.model ? makeProviderSelectFn(deps.provider, deps.model) : undefined);
  }

  /** 每个 user turn 调一次:返回要注入的 system-reminder 文本(相关记忆),或 null。 */
  async recall(query: string, _signal?: AbortSignal): Promise<string | null> {
    let headers: MemoryHeader[];
    try {
      headers = scanMemoryFiles(this.d.sandboxFs, this.d.memoryDir);
    } catch {
      return null; // 目录不存在等 → 无记忆
    }
    const fresh = headers.filter((h) => !this.surfaced.has(h.filename));
    if (fresh.length === 0) return null;

    const hits = await findRelevantMemories(fresh, query, this.selectFn);
    if (hits.length === 0) return null;

    const blocks: string[] = [];
    for (const h of hits) {
      if (this.sessionBytes >= MEMORY_BUDGET.sessionMaxBytes) break;
      let content: string;
      try {
        content = this.d.sandboxFs.readTextSync(h.filePath);
      } catch {
        continue;
      }
      // per-file 预算
      const lines = content.split('\n');
      if (lines.length > MEMORY_BUDGET.perFileMaxLines) content = lines.slice(0, MEMORY_BUDGET.perFileMaxLines).join('\n');
      if (content.length > MEMORY_BUDGET.perFileMaxBytes) content = content.slice(0, MEMORY_BUDGET.perFileMaxBytes);

      const head = `Memory (${freshness(h.mtimeMs, this.now())}): ${h.filename}`;
      blocks.push(`${head}\n\n${content}`);
      this.surfaced.add(h.filename);
      this.sessionBytes += content.length;
    }
    if (blocks.length === 0) return null;
    return wrapSystemReminder(blocks.join('\n\n---\n\n'));
  }

  /** done 后调一次(fire-and-forget):节流 + 互斥地后台抽取并写入记忆。 */
  async extract(messages: Array<{ role: string; content: unknown }>, signal?: AbortSignal): Promise<void> {
    this.turnsSinceExtract++;
    if (this.turnsSinceExtract < this.extractEvery) return;
    if (this.extracting || !this.d.provider || !this.d.model) return;
    this.extracting = true;
    try {
      const sig = signal ?? NEVER_ABORT;
      // 仅取最近若干条对话喂抽取(控制 token)。
      const recent = messages.slice(-12);
      let manifest = '';
      try {
        manifest = formatManifest(scanMemoryFiles(this.d.sandboxFs, this.d.memoryDir));
      } catch {
        /* 目录可能尚不存在 */
      }
      const convo = recent
        .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
        .join('\n');
      const req: ProviderRequest = {
        model: this.d.model,
        system: [{ type: 'text', text: EXTRACT_SYS }],
        tools: [],
        messages: [{ role: 'user', content: `Existing memories:\n${manifest}\n\nConversation:\n${convo}` }],
        maxOutputTokens: 1024,
      };
      const out = await collectText(this.d.provider, req, sig);
      const parsed = tryParseJson<{ memories?: ExtractedMemory[] }>(out);
      const mems = Array.isArray(parsed?.memories) ? parsed!.memories! : [];
      for (const m of mems) {
        if (!m || typeof m.name !== 'string' || typeof m.body !== 'string') continue;
        this.writeMemory(m);
      }
      if (mems.length > 0) rebuildIndex(this.d.sandboxFs, this.d.memoryDir);
    } catch {
      /* 抽取失败不影响主流程(后台、best-effort) */
    } finally {
      this.extracting = false;
      this.turnsSinceExtract = 0;
    }
  }

  private writeMemory(m: ExtractedMemory): void {
    const fs = this.d.sandboxFs;
    const dir = this.d.memoryDir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const path = `${dir.replace(/\/$/, '')}/${slug(m.name)}.md`;
    if (!isAutoMemPath(dir, path)) return; // 写闸:绝不写出目录
    if (path.endsWith(`/${MEMORY_INDEX_FILE}`)) return; // 不覆盖索引
    const fm = `---\nname: ${m.name}\ndescription: ${m.description ?? ''}\ntype: ${m.type ?? 'project'}\n---\n\n${m.body}\n`;
    fs.writeTextSync(path, fm);
  }
}
