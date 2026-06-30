/**
 * JsonlFileEventStore —— core CLI 的**磁盘 EventStore**(per-session WAL)。
 *
 * 实现 core 的 `EventStore` 契约(append + read),把会话事件流持久化成 JSONL,
 * 让独立 CLI 能跨进程 `--resume` 续多轮。
 * 事件流是真相(§6.1):`read()` 全量回放 → `foldFromStore` 重建对话历史。
 *
 * Boundary: 本文件是 core/src/cli 宿主层,允许用 node:fs(机制层 core/src 不依赖它)。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CoreEvent } from '../events/types';
import type { EventStore, ReadOpts } from '../inject/types';

export class JsonlFileEventStore implements EventStore {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  /** 顺序 append(每条一行 JSON)。空数组 no-op。同步写盘,简单可靠;CLI 单进程足够。 */
  async append(events: CoreEvent[]): Promise<void> {
    if (!events.length) return;
    const line = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    appendFileSync(this.file, line);
  }

  /** 全量(或 from/limit 切片)读出。坏行(半截/非 JSON)跳过,不毒化回放(fail-soft)。 */
  async *read(opts?: ReadOpts): AsyncIterable<CoreEvent> {
    if (!existsSync(this.file)) return;
    const lines = readFileSync(this.file, 'utf8').split('\n').filter((l) => l.length > 0);
    const start = typeof opts?.from === 'number' && opts.from > 0 ? opts.from : 0;
    const end = opts?.limit ? start + opts.limit : lines.length;
    for (let i = start; i < end && i < lines.length; i++) {
      try {
        yield JSON.parse(lines[i]) as CoreEvent;
      } catch {
        /* skip corrupt line */
      }
    }
  }
}
