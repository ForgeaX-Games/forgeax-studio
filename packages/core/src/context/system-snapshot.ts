/**
 * System-snapshot (C7 extra) — 纯函数:对 system block 集做快照 + 两次装配间 diff。
 *
 * 设计稿: 最终实现方案 §5/§12 (cache 字节稳定性是命中前提)。
 *   - cli `context-window/system-snapshot.ts` —— replay + diff 两个纯函数。
 *   - per-section 缓存:
 *     段值不变则复用、变了才重算并破 cache。本模块把"段是否变"算出来,供上层判断
 *     prompt cache 会不会失效(哪个 block 抖了 → 前缀 cache 断在哪)。
 *
 * core 的 `SystemBlock`(provider/types)无 name 字段,故 diff 以 `NamedSystemBlock`
 * (name + block)为单位:name 是稳定身份,text 是字节内容。
 *
 * Zero I/O / zero side-effects。Boundary: 仅 import core-local 类型。
 */
import type { SystemBlock } from '../provider/types';

/** 携带稳定身份的 system block(name 用于跨装配对齐;block 是 core 的 SystemBlock)。 */
export interface NamedSystemBlock {
  name: string;
  block: SystemBlock;
}

/** 快照里单个 block 的最小留痕(text 决定字节稳定性,cacheScope 影响命中域)。 */
export interface SnapshotEntry {
  text: string;
  cacheScope?: 'global' | 'org' | null;
}

/**
 * 把一组 NamedSystemBlock 折成快照 Map<name, SnapshotEntry>。
 * 同名后者覆盖前者(与装配产出顺序一致:后写为准)。
 */
export function replaySystemSnapshot(
  blocks: readonly NamedSystemBlock[],
): Map<string, SnapshotEntry> {
  const map = new Map<string, SnapshotEntry>();
  for (const { name, block } of blocks) {
    map.set(name, { text: block.text, cacheScope: block.cacheScope });
  }
  return map;
}

/** 两次装配间的 diff 结果。`changed` 含新增 + 文本/scope 变化的 block 名。 */
export interface SystemSnapshotDiff {
  /** 字节稳定 = 没有任何 block 新增/变更/删除 → prompt cache 不会因 system 段失效。 */
  stable: boolean;
  /** 文本或 cacheScope 变化(或新增)的 block name。 */
  changed: string[];
  /** prev 有、next 无的 block name。 */
  removed: string[];
}

/**
 * Diff 两个快照:计算从 `prev` 到 `next` 哪些 block 变了。
 *  - `changed`: next 中文本或 cacheScope 与 prev 不同(或 prev 没有的新 block)。
 *  - `removed`: prev 有而 next 没有的 block。
 *  - `stable`: changed + removed 皆空 → 字节稳定,prompt cache 命中不受影响。
 * 纯函数:不 mutate 入参。
 */
export function diffSystemBlocks(
  prev: ReadonlyMap<string, SnapshotEntry>,
  next: ReadonlyMap<string, SnapshotEntry>,
): SystemSnapshotDiff {
  const changed: string[] = [];
  for (const [name, entry] of next) {
    const before = prev.get(name);
    if (before === undefined) {
      changed.push(name);
      continue;
    }
    if (before.text !== entry.text || before.cacheScope !== entry.cacheScope) {
      changed.push(name);
    }
  }

  const removed: string[] = [];
  for (const name of prev.keys()) {
    if (!next.has(name)) removed.push(name);
  }

  return { stable: changed.length === 0 && removed.length === 0, changed, removed };
}
