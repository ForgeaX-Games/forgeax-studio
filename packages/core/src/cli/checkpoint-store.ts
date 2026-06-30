/** SnapshotStore —— 回退点(checkpoint)的内容寻址(CAS)文件快照层。
 *
 *  对一个目标目录(core TUI 的工作目录 cwd)提供 snapshot / restore / diff 三个能力,
 *  零外部依赖(不用 git)。CAS 形态:写盘路径有 agent-fs / shell / 插件多条,工具级
 *  拦截必漏,所以对整目录拍照;shadow 存放,不污染工作目录。
 *
 *  物理布局(storeRoot = <cwd>/.forgeax/checkpoints):
 *    blobs/<hh>/<sha256>            内容块,文件级去重,全局只存一份
 *    manifests/<manifestId>.json    { id, ts, files: { relPath: {h,size,mode} } }
 *
 *  性能契约:
 *    - 稳态快照 = walk + stat(mtime+size 缓存命中则不重哈希),O(目录条目数);
 *    - 哈希/拷贝只发生在内容变化的文件上(CAS);
 *    - restore 只写真正有差异的文件、删多余文件,O(差异字节);
 *    - 行级 diff 只在 preview 按需调用,带尺寸/行数上限,结果按 (hashA,hashB) 缓存。
 *
 *  Boundary(HOST 层 src/cli):仅 node: builtins + 相对 import(机制层 src 不依赖它)。
 *  源自 forgeax-cli 的同名实现;唯一实质差异:IGNORED_NAMES 增加 `.forgeax`,因为本
 *  形态目标目录 = cwd,而快照库与会话 WAL 都在 <cwd>/.forgeax 下,不剪掉会递归快照
 *  自身、且 restore 会破坏 WAL/settings。 */

import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
  rmdirSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** 不进快照的目录/文件名(任意层级命中即剪枝)。`.forgeax` 必须在内:快照库 + WAL
 *  都在它下面,既防递归快照自身,也防 restore 误伤会话状态/设置。 */
const IGNORED_NAMES = new Set([
  ".forgeax",
  "node_modules",
  ".git",
  "dist",
  "build",
  ".cache",
  ".DS_Store",
  ".forgeax-checkpoint-tmp",
]);

/** 行级 diff 的安全闸:超限只报「变更」不报行数。 */
const LINE_DIFF_MAX_BYTES = 256 * 1024;
const LINE_DIFF_MAX_LINES = 5000;

export interface ManifestEntry {
  h: string; // sha256 hex
  size: number;
  mode: number;
}

export interface Manifest {
  id: string;
  ts: number;
  files: Record<string, ManifestEntry>; // key = 相对 targetDir 的 POSIX 路径
  meta?: Record<string, unknown>;
}

export interface RestoreResult {
  written: string[];
  deleted: string[];
  /** 因 exclude(脏文件保留)被跳过的路径。 */
  skippedDirty: string[];
}

/** 单个文件的变更明细。status 站在「回退到目标快照」的视角:
 *  modified=两侧都有但内容不同;deleted=现盘有、目标快照无(回退会删);
 *  added=目标快照有、现盘无(回退会写回)。binary=行数不可知(二进制/超限)。 */
export interface FileDiffStat {
  path: string;
  status: "added" | "deleted" | "modified";
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface DiffStats {
  filesChanged: string[];
  insertions: number;
  deletions: number;
  /** 行数不可知的变更(二进制/超限)条数。 */
  binaryOrLarge: number;
  /** 逐文件明细(顺序:修改→删除→新增)。 */
  files: FileDiffStat[];
}

export class SnapshotStore {
  private readonly blobsDir: string;
  private readonly manifestsDir: string;
  /** absPath → 上次哈希时的 stat 指纹;命中则跳过重哈希。 */
  private readonly statCache = new Map<string, { mtimeNs: bigint; size: number; h: string }>();
  private readonly lineDiffCache = new Map<string, { insertions: number; deletions: number } | null>();

  constructor(public readonly storeRoot: string) {
    this.blobsDir = join(storeRoot, "blobs");
    this.manifestsDir = join(storeRoot, "manifests");
  }

  // ─── snapshot ────────────────────────────────────────────────────────────

  /** 对 targetDir 当前盘上状态拍全量 manifest;内容未变的文件零新增存储。
   *  抛错 = 快照失败(caller 决定是否阻塞:消息路径不阻塞,覆盖路径 fail-closed)。 */
  snapshot(targetDir: string, meta?: Record<string, unknown>): Manifest {
    const files: Record<string, ManifestEntry> = {};
    this._walk(targetDir, targetDir, files);
    const manifest: Manifest = { id: randomUUID(), ts: Date.now(), files, meta };
    mkdirSync(this.manifestsDir, { recursive: true });
    // 先写临时名再 rename 的原子性在单机 jsonl 场景收益低;manifest 单文件直写。
    writeFileSync(join(this.manifestsDir, `${manifest.id}.json`), JSON.stringify(manifest), "utf-8");
    return manifest;
  }

  private _walk(root: string, dir: string, out: Record<string, ManifestEntry>): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // 目录在遍历中消失 —— 视作空
    }
    for (const name of entries) {
      if (IGNORED_NAMES.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        // bigint stat → 纳秒级 mtime。毫秒粒度会漏判「同一毫秒内被同尺寸内容覆盖」
        // 的改动(如 "v1\n"→"v2\n"):snapshot 拍照后立即改写,restore 重走 _walk
        // 命中 statCache 拿到旧哈希 → 误判未变、不回写。纳秒 mtime 在两次顺序写之间
        // 严格递增,消除该竞态。
        st = statSync(abs, { bigint: true });
      } catch {
        continue; // 竞态删除
      }
      if (st.isDirectory()) {
        this._walk(root, abs, out);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = toPosix(relative(root, abs));
      const size = Number(st.size);
      const cached = this.statCache.get(abs);
      let h: string;
      if (cached && cached.mtimeNs === st.mtimeNs && cached.size === size) {
        h = cached.h;
      } else {
        const content = readFileSync(abs);
        h = sha256(content);
        this._ensureBlob(h, abs, content);
        this.statCache.set(abs, { mtimeNs: st.mtimeNs, size, h });
      }
      // stat 缓存命中时 blob 必然已存在(同一进程内写过);进程重启后缓存为空,
      // 首次 walk 会重哈希并按需补 blob,所以这里不需要二次 existsSync。
      out[rel] = { h, size, mode: Number(st.mode) & 0o777 };
    }
  }

  private _blobPath(h: string): string {
    return join(this.blobsDir, h.slice(0, 2), h);
  }

  private _ensureBlob(h: string, srcAbs: string, content?: Buffer): void {
    const p = this._blobPath(h);
    if (existsSync(p)) return;
    mkdirSync(dirname(p), { recursive: true });
    if (content) writeFileSync(p, content);
    else copyFileSync(srcAbs, p);
  }

  // ─── manifest io ─────────────────────────────────────────────────────────

  loadManifest(id: string): Manifest | null {
    try {
      return JSON.parse(readFileSync(join(this.manifestsDir, `${id}.json`), "utf-8")) as Manifest;
    } catch {
      return null;
    }
  }

  // ─── restore ─────────────────────────────────────────────────────────────

  /** 把 targetDir 恢复到 manifest 状态。
   *  - 只写内容有差异的文件;manifest 没有而盘上有的(非 ignore)文件删除;
   *  - opts.exclude(相对路径集合)= 脏文件保留:既不写回也不删除;
   *  - opts.only = 只动这些路径(用于「这些文件也回退 / 撤销」的局部恢复)。 */
  restore(
    targetDir: string,
    manifest: Manifest,
    opts: { exclude?: Set<string>; only?: Set<string> } = {},
  ): RestoreResult {
    const written: string[] = [];
    const deleted: string[] = [];
    const skippedDirty: string[] = [];

    const current: Record<string, ManifestEntry> = {};
    this._walk(targetDir, targetDir, current);

    const considered = (rel: string): boolean => {
      if (opts.only && !opts.only.has(rel)) return false;
      if (opts.exclude?.has(rel)) {
        skippedDirty.push(rel);
        return false;
      }
      return true;
    };

    // 写回:目标里有、盘上缺失或内容不同
    for (const [rel, entry] of Object.entries(manifest.files)) {
      if (!considered(rel)) continue;
      const cur = current[rel];
      if (cur && cur.h === entry.h) continue;
      const abs = join(targetDir, ...rel.split("/"));
      const blob = this._blobPath(entry.h);
      if (!existsSync(blob)) {
        // blob 丢失 —— 跳过该文件,留给 caller 上报;不让单文件损坏炸掉整次 restore
        process.stderr.write(`[checkpoint] missing blob ${entry.h} for ${rel}, skipped\n`);
        continue;
      }
      mkdirSync(dirname(abs), { recursive: true });
      copyFileSync(blob, abs);
      try {
        chmodSync(abs, entry.mode);
      } catch {
        /* 非关键 */
      }
      this.statCache.delete(abs);
      written.push(rel);
    }

    // 删除:盘上有、目标里没有
    for (const rel of Object.keys(current)) {
      if (manifest.files[rel]) continue;
      if (!considered(rel)) continue;
      const abs = join(targetDir, ...rel.split("/"));
      try {
        unlinkSync(abs);
        this.statCache.delete(abs);
        deleted.push(rel);
        this._pruneEmptyDirs(targetDir, dirname(abs));
      } catch {
        /* 已不存在 */
      }
    }

    return { written, deleted, skippedDirty };
  }

  /** 删除文件后清掉空目录(只清到 targetDir 为止)。 */
  private _pruneEmptyDirs(root: string, dir: string): void {
    let d = dir;
    while (d.startsWith(root) && d !== root) {
      try {
        if (readdirSync(d).length > 0) return;
        rmdirSync(d);
      } catch {
        return;
      }
      d = dirname(d);
    }
  }

  // ─── diff ────────────────────────────────────────────────────────────────

  /** 盘上状态 vs manifest 的文件级差异(零行级计算,亚毫秒级)。 */
  diffDiskVsManifest(
    targetDir: string,
    manifest: Manifest,
  ): { changed: string[]; onlyOnDisk: string[]; onlyInManifest: string[] } {
    const current: Record<string, ManifestEntry> = {};
    this._walk(targetDir, targetDir, current);
    return diffEntryMaps(current, manifest.files);
  }

  /** preview 用的统计:文件级必出,行级带闸。base=null 表示对比当前盘。 */
  diffStats(targetDir: string, target: Manifest, base?: Manifest | null): DiffStats {
    let a: Record<string, ManifestEntry>;
    if (base) {
      a = base.files;
    } else {
      a = {};
      this._walk(targetDir, targetDir, a);
    }
    const d = diffEntryMaps(a, target.files);
    const filesChanged = [...d.changed, ...d.onlyOnDisk, ...d.onlyInManifest];
    let insertions = 0;
    let deletions = 0;
    let binaryOrLarge = 0;
    const files: FileDiffStat[] = [];

    const countPair = (
      rel: string,
      status: FileDiffStat["status"],
      aEntry: ManifestEntry | undefined,
      bEntry: ManifestEntry | undefined,
    ) => {
      const stats = this._lineDiff(aEntry, bEntry);
      if (stats === null) {
        binaryOrLarge++;
        files.push({ path: rel, status, insertions: 0, deletions: 0, binary: true });
      } else {
        insertions += stats.insertions;
        deletions += stats.deletions;
        files.push({ path: rel, status, insertions: stats.insertions, deletions: stats.deletions, binary: false });
      }
    };
    for (const rel of d.changed) countPair(rel, "modified", a[rel], target.files[rel]);
    for (const rel of d.onlyOnDisk) countPair(rel, "deleted", a[rel], undefined);
    for (const rel of d.onlyInManifest) countPair(rel, "added", undefined, target.files[rel]);

    return { filesChanged, insertions, deletions, binaryOrLarge, files };
  }

  /** 单文件行级 diff(从 blob 池读内容);null = 二进制/超限,只算「变更」。 */
  private _lineDiff(
    a: ManifestEntry | undefined,
    b: ManifestEntry | undefined,
  ): { insertions: number; deletions: number } | null {
    const key = `${a?.h ?? "-"}:${b?.h ?? "-"}`;
    if (this.lineDiffCache.has(key)) return this.lineDiffCache.get(key)!;
    const result = this._lineDiffUncached(a, b);
    this.lineDiffCache.set(key, result);
    return result;
  }

  private _lineDiffUncached(
    a: ManifestEntry | undefined,
    b: ManifestEntry | undefined,
  ): { insertions: number; deletions: number } | null {
    if ((a && a.size > LINE_DIFF_MAX_BYTES) || (b && b.size > LINE_DIFF_MAX_BYTES)) return null;
    const aText = a ? this._readBlobText(a.h) : "";
    const bText = b ? this._readBlobText(b.h) : "";
    if (aText === null || bText === null) return null; // 二进制/blob 丢失
    const aLines = aText === "" ? [] : aText.split("\n");
    const bLines = bText === "" ? [] : bText.split("\n");
    if (aLines.length > LINE_DIFF_MAX_LINES || bLines.length > LINE_DIFF_MAX_LINES) return null;
    // b = 目标(回退后),a = 基准(当前)。insertions = 回退会加回的行。
    return lcsDiffCounts(aLines, bLines);
  }

  private _readBlobText(h: string): string | null {
    let buf: Buffer;
    try {
      buf = readFileSync(this._blobPath(h));
    } catch {
      return null;
    }
    if (buf.includes(0)) return null; // NUL 字节 → 按二进制处理
    return buf.toString("utf-8");
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function diffEntryMaps(
  a: Record<string, ManifestEntry>,
  b: Record<string, ManifestEntry>,
): { changed: string[]; onlyOnDisk: string[]; onlyInManifest: string[] } {
  const changed: string[] = [];
  const onlyOnDisk: string[] = [];
  const onlyInManifest: string[] = [];
  for (const [rel, e] of Object.entries(a)) {
    const t = b[rel];
    if (!t) onlyOnDisk.push(rel);
    else if (t.h !== e.h) changed.push(rel);
  }
  for (const rel of Object.keys(b)) {
    if (!a[rel]) onlyInManifest.push(rel);
  }
  return { changed, onlyOnDisk, onlyInManifest };
}

/** 基于 LCS 的行级 insert/delete 计数。先剥公共前后缀(典型代码编辑下剩余
 *  区间很小),剩余区间跑 O(n*m) DP;输入已被 LINE_DIFF_MAX_LINES 限幅。 */
export function lcsDiffCounts(
  aLines: string[],
  bLines: string[],
): { insertions: number; deletions: number } {
  let start = 0;
  while (start < aLines.length && start < bLines.length && aLines[start] === bLines[start]) start++;
  let aEnd = aLines.length;
  let bEnd = bLines.length;
  while (aEnd > start && bEnd > start && aLines[aEnd - 1] === bLines[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  const a = aLines.slice(start, aEnd);
  const b = bLines.slice(start, bEnd);
  if (a.length === 0) return { insertions: b.length, deletions: 0 };
  if (b.length === 0) return { insertions: 0, deletions: a.length };

  // 截断后仍然过大时退化为「全删全加」上界(防 O(n*m) 爆炸)
  if (a.length * b.length > 4_000_000) {
    return { insertions: b.length, deletions: a.length };
  }
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1).fill(0);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  const lcs = prev[n];
  return { insertions: n - lcs, deletions: m - lcs };
}
