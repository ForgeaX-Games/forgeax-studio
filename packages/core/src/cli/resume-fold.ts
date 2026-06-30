/**
 * Resume 底层能力 —— 会话 WAL 的「fold→seed」与「列举可恢复会话」(018 A 层)。
 *
 * 把原先散在 `cli/main.ts` runTurn 里的「从 per-session WAL fold 出历史 seed」逻辑
 * 抽成可复用纯函数,供:
 *   - `runTurn`(启动 flag `--resume`/`--continue` 路径)调用,避免重复实现;
 *   - 未来 TUI `/resume`、serve RPC method(B 层)复用同一条 fold 路径。
 *
 * 另实现 `listSessions()`:扫 WAL 根目录列出可恢复会话。
 * 磁盘布局与 `event-store-fs.ts` / `host-context.ts` 约定一致:
 *   `<sessionsDir>/<sessionId>/events.jsonl`
 *
 * Boundary: 本文件是 core/src/cli 宿主层,允许用 node:fs(机制层 core/src 不依赖它)。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { EventStore } from '../inject/types';
import type { CoreEvent } from '../events/types';
import type { ProviderMessage } from '../provider/types';
import { foldFromStore } from '../history/llm-fold-adapter';
import { JsonlFileEventStore } from './event-store-fs';

/** WAL 文件名(与 event-store-fs / host-context 约定保持一致)。 */
const EVENTS_FILE = 'events.jsonl';

/** 默认会话 WAL 根目录(与 CliArgs.sessionsDir 默认值一致)。 */
export function defaultSessionsDir(): string {
  return process.env.FORGEAX_SESSIONS_DIR ?? `${process.cwd()}/.forgeax/sessions`;
}

/**
 * 从 per-session WAL fold 出历史对话(本轮之前的全部事件)→ ProviderMessage[]。
 *
 * 原 `runTurn` 内联实现的抽取:读出 store 全量事件 → `foldFromStore` 重建 messages。
 *   空 / 无 `read` 能力 / 无历史 → 返回 `undefined`(调用方据此走单轮,不带 history)。
 *
 * 纯函数:只读 store,不发事件、不写盘。store 的持久化由 connectStore 在同一 bus 上负责。
 */
export async function foldSessionHistory(store?: Pick<EventStore, 'read'>): Promise<ProviderMessage[] | undefined> {
  if (!store?.read) return undefined;
  const evs: CoreEvent[] = [];
  for await (const e of store.read()) evs.push(e);
  const folded = foldFromStore(evs);
  return folded.length ? folded : undefined;
}

/** 一个可恢复会话的概要(供 /resume 列表渲染)。 */
export interface SessionSummary {
  /** 会话 id(= WAL 子目录名,也是 --resume 的入参)。 */
  id: string;
  /** WAL 文件绝对路径。 */
  file: string;
  /** WAL 文件大小(字节);取不到时 0。 */
  sizeBytes: number;
  /** WAL 最后修改时间(ms epoch);取不到时 0。用于「最近活跃」排序。 */
  mtimeMs: number;
  /** 会话标题 = 首条用户输入(归一化+截断);取不到留空。用于 /resume 列表展示与搜索。 */
  title?: string;
}

/** 标题最大显示宽度(超出截断)。 */
const TITLE_MAX = 60;
/** 找首条用户输入时最多扫描的行数(user_prompt.submit 通常在文件头几行;封顶防大 WAL 全读)。 */
const TITLE_SCAN_LINES = 200;

/** 把一段文本归一化成单行标题(空白折叠 + 截断)。 */
function normalizeTitle(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > TITLE_MAX ? one.slice(0, TITLE_MAX - 1) + '…' : one;
}

/**
 * 从一个会话 WAL 抽首条用户输入作标题(fail-soft)。
 * 只读文件头 TITLE_SCAN_LINES 行,扫到第一条 `user_prompt.submit` 即返回其 prompt;
 * 读不到 / 无用户输入 / 坏行 → undefined(列表用 id 兜底显示)。
 */
function firstUserPromptTitle(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const lines = text.split('\n', TITLE_SCAN_LINES);
  for (const line of lines) {
    if (!line || line.indexOf('user_prompt.submit') === -1) continue; // 廉价预筛,避免逐行 JSON.parse
    try {
      const e = JSON.parse(line) as CoreEvent;
      if (e.type === 'user_prompt.submit') {
        const prompt = (e.payload as { prompt?: unknown }).prompt;
        if (typeof prompt === 'string' && prompt.trim()) return normalizeTitle(prompt);
      }
    } catch {
      /* 坏行跳过 */
    }
  }
  return undefined;
}

/**
 * 扫 WAL 根目录列出可恢复会话。
 *
 * 磁盘布局:`<sessionsDir>/<id>/events.jsonl`。逐个子目录探测其下的 WAL 文件;
 *   只收**真有 events.jsonl** 的目录(空目录 / 杂项文件忽略,fail-soft)。
 *   按 mtime 倒序(最近活跃在前),便于 UI 直接取首项作「续接最近」。
 *
 * 目录不存在 / 不可读 → 返回空数组(首次运行、无会话都属正常,不抛)。
 */
export function listSessions(sessionsDir: string = defaultSessionsDir()): SessionSummary[] {
  const root = resolvePath(sessionsDir);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return []; // 目录不存在 / 不可读 → 无会话
  }
  const out: SessionSummary[] = [];
  for (const id of entries) {
    const file = join(root, id, EVENTS_FILE);
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      out.push({ id, file, sizeBytes: st.size, mtimeMs: st.mtimeMs, title: firstUserPromptTitle(file) });
    } catch {
      /* 子目录无 events.jsonl / 不可读 → 跳过(非会话目录) */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs); // 最近活跃在前
  return out;
}

/**
 * 按 id 打开一个会话 WAL store 并 fold 出历史(B 层 `resume(id)` 的底层能力)。
 *
 * 纯读:new JsonlFileEventStore(指向该会话的 events.jsonl)→ foldSessionHistory。
 *   会话不存在 / 无历史 → 返回 `undefined`。**不**重建 AgentContext、**不**切换会话
 *   (那是 B 层 + 与 013 transcript 模型耦合的工作);本函数只回历史 messages。
 */
export async function foldSessionById(
  id: string,
  sessionsDir: string = defaultSessionsDir(),
): Promise<ProviderMessage[] | undefined> {
  const file = join(resolvePath(sessionsDir), id, EVENTS_FILE);
  const store = new JsonlFileEventStore(file);
  return foldSessionHistory(store);
}

/**
 * 读出一个会话 WAL 的**全量原始事件流**(供 TUI /resume 重建可渲染 transcript)。
 *
 * 与 `foldSessionById`(投影成 LLM 历史 ProviderMessage[])互补:本函数返回未折叠的
 * `CoreEvent[]`,上层(TUI rehydrate)据此既能 foldFromStore 重建 LLM 历史,又能逐事件
 * 映射回可渲染条目(user/assistant/tool_call/tool_result)。
 * 会话不存在 / 不可读 / 空 → 空数组(fail-soft,JsonlFileEventStore.read 已跳坏行)。
 */
export async function readSessionEvents(
  id: string,
  sessionsDir: string = defaultSessionsDir(),
): Promise<CoreEvent[]> {
  const file = join(resolvePath(sessionsDir), id, EVENTS_FILE);
  const store = new JsonlFileEventStore(file);
  const out: CoreEvent[] = [];
  for await (const e of store.read()) out.push(e);
  return out;
}
