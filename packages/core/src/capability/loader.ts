/**
 * CapabilityLoader — 从注入的目录列表按层加载 CapabilityPack。
 *
 * 设计稿: core-layer-spec §3.4 (capability host) + §0″ (干净律: core 只出 ABI +
 * loader,具体包经 inject 注入)。对齐 cli `kits/base-loader.ts`:
 *   - 4 层源序 **builtin → user → session → agent**,**整包替换同名** (whole-kit
 *     override, last wins;禁止 per-file Frankenstein 合并)。
 *   - `condition` 不通过 ⇒ **整包跳过** (`wrapWithKitCondition` 包级准入语义,
 *     这里前移到加载期: 求值后整包 in/out)。
 *   - dynamic import 用 `?v=<hash>` cache-bust (`importFactory`),热重载靠换 hash。
 *
 * 与 cli 的差异 (core 干净律):
 *   - core 不知道 PathManager / agent.json / KitsConfig —— 目录列表由集成者 inject。
 *   - core 不做 condition.ts 文件发现;每个 pack 自带 `condition` 字段 (C2)。
 *   - 真正的 FSWatcher 由 inject 提供;loader 只给 `reload(packName)` 入口 + hash
 *     占位 (集成者用 mtime/内容 hash 喂进来,或用默认 mtime 探测)。
 *
 * Boundary: 仅 import C2 契约 + condition evaluator + node:fs / node:path。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CapabilityPack,
  CapabilityLayer,
  ConditionContext,
} from './types';
import { evaluateCondition } from './condition';

// ─── 注入面 ────────────────────────────────────────────────────────────────────

/** 一个加载源 = 一层 + 该层 pack 根目录。集成者按 builtin→user→session→agent 给。 */
export interface CapabilitySource {
  readonly layer: CapabilityLayer;
  readonly dir: string;
}

/**
 * pack 模块导入器。集成者 inject 真正的 dynamic import (`?v=<hash>` cache-bust)。
 * 给定 pack 入口绝对路径 (+ 可选 cache-bust hash),返回模块对象。
 * 默认 importer 用原生 `import(path?v=hash)`。
 */
export type PackImporter = (
  entryPath: string,
  cacheBust?: string,
) => Promise<unknown>;

/** 从一个模块对象里取出 CapabilityPack (default 或 named `pack`)。 */
function extractPack(mod: unknown): CapabilityPack | null {
  if (mod === null || typeof mod !== 'object') return null;
  const m = mod as Record<string, unknown>;
  const cand = (m.default ?? m.pack) as unknown;
  if (cand === null || typeof cand !== 'object') return null;
  const p = cand as Partial<CapabilityPack>;
  if (typeof p.name !== 'string' || typeof p.layer !== 'string') return null;
  return cand as CapabilityPack;
}

/** 内部记录: 一个 pack 当前的来源 (热重载/override 追溯用)。 */
interface PackRecord {
  pack: CapabilityPack;
  layer: CapabilityLayer;
  entryPath: string;
}

const LAYER_ORDER: Record<CapabilityLayer, number> = {
  builtin: 0,
  user: 1,
  session: 2,
  agent: 3,
};

const DEFAULT_IMPORTER: PackImporter = (entryPath, cacheBust) =>
  import(cacheBust ? `${entryPath}?v=${cacheBust}` : entryPath);

export interface CapabilityLoaderOptions {
  sources: readonly CapabilitySource[];
  importer?: PackImporter;
  /** pack 目录下的入口文件名候选 (按序首个存在者胜)。 */
  entryFiles?: readonly string[];
  /**
   * cache-bust hash 计算。默认用入口文件 mtimeMs (FSWatcher 重载时 mtime 变 →
   * hash 变 → 新 ESM ref)。集成者可换成内容 hash。
   */
  hashOf?: (entryPath: string) => string;
}

const DEFAULT_ENTRY_FILES = ['index.ts', 'index.js', 'pack.ts', 'pack.js'];

function defaultHashOf(entryPath: string): string {
  try {
    return String(statSync(entryPath).mtimeMs);
  } catch {
    return '0';
  }
}

/**
 * CapabilityLoader: 扫目录 → 按层定胜出源 (整包替换) → import → condition gate →
 * 产出激活 pack 列表。集成者拿到后灌进 CapabilityRegistry / 起 plugins。
 */
export class CapabilityLoader {
  private readonly sources: readonly CapabilitySource[];
  private readonly importer: PackImporter;
  private readonly entryFiles: readonly string[];
  private readonly hashOf: (p: string) => string;

  /** packName → 当前胜出记录 (整包替换后)。 */
  private readonly loaded = new Map<string, PackRecord>();
  /** packName → 该 pack 是否通过 condition (供 reload 复用 ctx 判断)。 */
  private lastCtx: ConditionContext = {};

  constructor(opts: CapabilityLoaderOptions) {
    this.sources = opts.sources;
    this.importer = opts.importer ?? DEFAULT_IMPORTER;
    this.entryFiles = opts.entryFiles ?? DEFAULT_ENTRY_FILES;
    this.hashOf = opts.hashOf ?? defaultHashOf;
  }

  /**
   * 发现各源目录下的 pack 目录,按层定胜出 (后层覆盖前层同名 = 整包替换)。
   * 返回 packName → {layer, dir, entryPath}。低层完全隐藏,无 per-file 合并。
   */
  private discover(): Map<string, { layer: CapabilityLayer; entryPath: string }> {
    // packName → 胜出 (layer 序号最大者胜)
    const winner = new Map<
      string,
      { layer: CapabilityLayer; entryPath: string; rank: number }
    >();

    for (const src of this.sources) {
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(src.dir, { withFileTypes: true });
      } catch {
        continue; // 源目录不存在 → 跳过
      }
      const rank = LAYER_ORDER[src.layer];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('.')) continue;
        const packDir = join(src.dir, e.name);
        const entryPath = this.resolveEntry(packDir);
        if (!entryPath) continue; // 没有入口文件 → 不是 pack
        const prev = winner.get(e.name);
        // 后层 (rank 大) 整包替换;同 rank 保留先遇 (源列表顺序内稳定)。
        if (!prev || rank > prev.rank) {
          winner.set(e.name, { layer: src.layer, entryPath, rank });
        }
      }
    }

    const out = new Map<string, { layer: CapabilityLayer; entryPath: string }>();
    for (const [name, w] of winner) out.set(name, { layer: w.layer, entryPath: w.entryPath });
    return out;
  }

  /** 在 pack 目录里找入口文件 (按 entryFiles 序首个存在者)。 */
  private resolveEntry(packDir: string): string | null {
    for (const f of this.entryFiles) {
      const p = join(packDir, f);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        // 继续试下一个候选
      }
    }
    return null;
  }

  /**
   * 全量加载: 发现 → import → condition gate (整包跳过) → 填 this.loaded。
   * 返回**激活** (condition 通过) 的 pack 列表,按 packName 字典序稳定。
   */
  async load(ctx: ConditionContext = {}): Promise<CapabilityPack[]> {
    this.lastCtx = ctx;
    this.loaded.clear();
    const discovered = this.discover();

    const active: CapabilityPack[] = [];
    for (const [name, info] of discovered) {
      const pack = await this.importPack(info.entryPath);
      if (!pack) continue;
      // record (即便 condition 不通过也记: reload 时能按同名找到入口;但不产出)
      this.loaded.set(name, { pack, layer: info.layer, entryPath: info.entryPath });
      if (evaluateCondition(pack.condition, ctx)) active.push(pack);
    }

    active.sort((a, b) => a.name.localeCompare(b.name));
    return active;
  }

  /** import 单个 pack 入口 (cache-bust),抽出 CapabilityPack;失败返回 null。 */
  private async importPack(entryPath: string): Promise<CapabilityPack | null> {
    try {
      const mod = await this.importer(entryPath, this.hashOf(entryPath));
      return extractPack(mod);
    } catch (err) {
      process.stderr.write(
        `[CapabilityLoader] failed to load pack at "${entryPath}": ${
          (err as Error)?.message ?? String(err)
        }\n`,
      );
      return null;
    }
  }

  /**
   * 热重载单个 pack (FSWatcher ingress)。重新计算该 pack 在当前源里的胜出入口
   * (层级可能变了),用新 hash dynamic import 拿到新 ESM ref。
   *
   * 返回:
   *   - CapabilityPack —— 重载后 condition 通过,集成者应重新注册/替换。
   *   - null           —— pack 已消失 (各层都没了) 或 condition 不再通过;
   *                       集成者应据此卸载该 pack 的 tools/slots/plugins。
   */
  async reload(packName: string): Promise<CapabilityPack | null> {
    const discovered = this.discover();
    const info = discovered.get(packName);
    if (!info) {
      // 各层都没了 → 卸载
      this.loaded.delete(packName);
      return null;
    }
    const pack = await this.importPack(info.entryPath);
    if (!pack) {
      this.loaded.delete(packName);
      return null;
    }
    this.loaded.set(packName, { pack, layer: info.layer, entryPath: info.entryPath });
    return evaluateCondition(pack.condition, this.lastCtx) ? pack : null;
  }

  /** 当前激活 (condition 通过) 的 pack 列表。 */
  activePacks(): CapabilityPack[] {
    const out: CapabilityPack[] = [];
    for (const rec of this.loaded.values()) {
      if (evaluateCondition(rec.pack.condition, this.lastCtx)) out.push(rec.pack);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** 某 pack 当前胜出层 (调试/追溯)。 */
  layerOf(packName: string): CapabilityLayer | undefined {
    return this.loaded.get(packName)?.layer;
  }
}
