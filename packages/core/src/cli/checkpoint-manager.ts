/** CheckpointManager —— 回退点的「文件侧」会话级编排(core TUI 形态)。
 *
 *  职责(只管文件 + 索引;对话侧由 driver 的内存快照 + Repl 的 messages 承担):
 *  - 每条用户消息 emit 前对工作目录(cwd)拍 CAS 快照(消息锚点,失败不阻塞聊天);
 *  - rewind / cancel(Redo)/ overwriteDirty / undoOverwrite 文件编排:
 *      pre-rewind 快照(fail-closed)→ 脏文件处理 → restore;
 *  - 定格规则:新 user_input 到达时 finalizePending(此后 cancel 失效);
 *  - 索引:<sessionsDir>/<sessionId>/checkpoints.jsonl(append-only),重启可重建。
 *
 *  与 forgeax-cli 同名实现的差异:剥掉 Session / ledger / eventBus / 多 agent 耦合
 *  与 interruptAgents(打断在飞轮由 driver 在调本类前 abort());对话 boundary 不写 WAL、
 *  不发 mask 事件 —— 由 driver 持有的 convo/messages 内存快照承担(见 driver useAgent)。
 *  单会话:core TUI 一进程一会话,故不维护 sessions map。
 *
 *  并发:per-instance promise 链互斥,所有 restore 类操作串行。
 *
 *  Boundary(HOST 层 src/cli):仅 node: builtins + 相对 import。 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SnapshotStore, type DiffStats } from "./checkpoint-store";

interface MessageRecord {
  kind: "message";
  msgId: string;
  /** 第几条用户消息(0-based),供 /resume 后按序 re-link(best-effort)。 */
  ordinal: number;
  ts: number;
  manifestId: string | null; // null = 该消息时刻无 store / 快照失败
}

interface RewindRecord {
  kind: "rewind";
  boundaryId: string;
  targetMsgId: string;
  ts: number;
  preManifestId: string | null; // 回退前盘上状态(Redo 的落点)
  keptDirty: string[];
}

interface StatusRecord {
  kind: "rewind-status";
  boundaryId: string;
  status: "cancelled" | "finalized";
  ts: number;
}

interface OverwriteRecord {
  kind: "overwrite";
  boundaryId: string;
  safetyManifestId: string;
  files: string[];
  ts: number;
}

type CheckpointJsonlRecord =
  | MessageRecord
  | RewindRecord
  | StatusRecord
  | OverwriteRecord
  | { kind: "overwrite-undo"; boundaryId: string; ts: number };

export interface PendingRewind {
  boundaryId: string;
  targetMsgId: string;
  preManifestId: string | null;
  keptDirty: string[];
  /** 「这些文件也回退」之后的撤销锚点。 */
  overwrite: { safetyManifestId: string; files: string[] } | null;
}

export interface CheckpointEntry {
  msgId: string;
  ordinal: number;
  ts: number;
  hasCode: boolean;
}

export type RewindResult =
  | { boundaryId: string; filesChanged: string[]; keptDirty: string[] }
  | { error: string };

export interface CheckpointManagerOptions {
  /** 工作目录 = 快照目标。一般是 process.cwd()。 */
  cwd: string;
  /** 会话 id(= WAL 子目录名),索引落该会话目录下。 */
  sessionId: string;
  /** 会话 WAL 根目录(与 resume-fold.defaultSessionsDir 同源)。 */
  sessionsDir: string;
}

export class CheckpointManager {
  private readonly store: SnapshotStore | null;
  private readonly targetDir: string | null;
  private readonly indexFile: string;

  private readonly messages = new Map<string, MessageRecord>();
  private readonly order: string[] = []; // msgId 时间序
  private pendingRec: PendingRewind | null = null;
  /** 上次 restore 把盘面带到的 manifest;脏检测基准。null = 从未 restore。 */
  private lastRestoreManifestId: string | null = null;
  /** 最近一次 restore 类操作(rewind 或 cancel)的脏文件账本。
   *  「这些文件也回退 / 撤销」挂在这上面而不是 pending 上 —— 核心场景
   *  「回退→手改→恢复(cancel)→这些文件也回退」发生在 pending 已清空之后。
   *  opId 复用 boundaryId。 */
  private lastOp: {
    opId: string;
    keptDirty: string[];
    restoreTargetManifestId: string | null;
    overwrite: { safetyManifestId: string; files: string[] } | null;
  } | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(opts: CheckpointManagerOptions) {
    this.indexFile = `${opts.sessionsDir}/${opts.sessionId}/checkpoints.jsonl`;
    // 目标 = cwd(总是存在);storeRoot 落 <cwd>/.forgeax/checkpoints。
    //   构造期试探可写性,失败则 store=null → 优雅降级(文件回退不可用,对话回退照常)。
    let store: SnapshotStore | null = null;
    let targetDir: string | null = null;
    try {
      if (existsSync(opts.cwd)) {
        targetDir = opts.cwd;
        store = new SnapshotStore(`${opts.cwd}/.forgeax/checkpoints`);
      }
    } catch {
      /* cwd 不可用 → 纯对话模式 */
    }
    this.store = store;
    this.targetDir = targetDir;
    this.loadIndex();
  }

  /** 文件回退是否可用(store 就绪)。driver 据此决定是否在回退时走文件侧。 */
  hasStore(): boolean {
    return this.store != null && this.targetDir != null;
  }

  // ─── index io ──────────────────────────────────────────────────────────

  /** 启动 / 重启后从 checkpoints.jsonl 重建内存状态。 */
  private loadIndex(): void {
    let raw: string;
    try {
      raw = readFileSync(this.indexFile, "utf-8");
    } catch {
      return; // 新会话
    }
    const rewinds = new Map<string, RewindRecord>();
    const status = new Map<string, StatusRecord["status"]>();
    const overwrites = new Map<string, OverwriteRecord | null>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let rec: CheckpointJsonlRecord;
      try {
        rec = JSON.parse(line) as CheckpointJsonlRecord;
      } catch {
        continue;
      }
      if (rec.kind === "message") {
        if (!this.messages.has(rec.msgId)) this.order.push(rec.msgId);
        this.messages.set(rec.msgId, rec);
      } else if (rec.kind === "rewind") {
        rewinds.set(rec.boundaryId, rec);
        status.delete(rec.boundaryId);
        overwrites.set(rec.boundaryId, null);
      } else if (rec.kind === "rewind-status") {
        status.set(rec.boundaryId, rec.status);
      } else if (rec.kind === "overwrite") {
        overwrites.set(rec.boundaryId, rec);
      } else if (rec.kind === "overwrite-undo") {
        overwrites.set(rec.boundaryId, null);
      }
    }
    // 最后一条仍 pending 的 rewind(没有 cancelled/finalized)恢复为挂起态。
    let lastPending: RewindRecord | null = null;
    for (const r of rewinds.values()) {
      if (!status.has(r.boundaryId)) lastPending = !lastPending || r.ts > lastPending.ts ? r : lastPending;
    }
    if (lastPending) {
      const ow = overwrites.get(lastPending.boundaryId) ?? null;
      this.pendingRec = {
        boundaryId: lastPending.boundaryId,
        targetMsgId: lastPending.targetMsgId,
        preManifestId: lastPending.preManifestId,
        keptDirty: lastPending.keptDirty,
        overwrite: ow ? { safetyManifestId: ow.safetyManifestId, files: ow.files } : null,
      };
      const target = this.messages.get(lastPending.targetMsgId);
      if (target?.manifestId) this.lastRestoreManifestId = target.manifestId;
    }
  }

  private record(rec: CheckpointJsonlRecord): void {
    mkdirSync(dirname(this.indexFile), { recursive: true });
    appendFileSync(this.indexFile, JSON.stringify(rec) + "\n", "utf-8");
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  // ─── message snapshot ────────────────────────────────────────────────────

  /** 用户消息 emit 前调用。失败不抛(快照失败不阻塞聊天,只是该消息无文件回退能力);
   *  无 store(纯会话)记录 manifestId=null,对话回退仍可用。 */
  snapshotForMessage(msgId: string): void {
    let manifestId: string | null = null;
    if (this.store && this.targetDir) {
      try {
        manifestId = this.store.snapshot(this.targetDir, { msgId }).id;
      } catch (err) {
        process.stderr.write(`[checkpoint] snapshot for ${msgId} failed: ${(err as Error).message}\n`);
      }
    }
    const ordinal = this.order.length;
    const rec: MessageRecord = { kind: "message", msgId, ordinal, ts: Date.now(), manifestId };
    try {
      this.record(rec);
    } catch (err) {
      process.stderr.write(`[checkpoint] index append failed: ${(err as Error).message}\n`);
      // 仍登记进内存,文件回退本会话可用(只是重启后丢索引)。
    }
    if (!this.messages.has(msgId)) this.order.push(msgId);
    this.messages.set(msgId, rec);
  }

  // ─── queries ──────────────────────────────────────────────────────────────

  list(): CheckpointEntry[] {
    return this.order.map((msgId) => {
      const r = this.messages.get(msgId)!;
      return { msgId, ordinal: r.ordinal, ts: r.ts, hasCode: r.manifestId !== null };
    });
  }

  pending(): PendingRewind | null {
    return this.pendingRec;
  }

  /** 确认面板的 diff 预览(盘上现状 vs 目标 checkpoint)。 */
  preview(msgId: string): DiffStats | { error: string } {
    const rec = this.messages.get(msgId);
    if (!rec) return { error: `unknown msgId: ${msgId}` };
    if (!rec.manifestId || !this.store || !this.targetDir) {
      return { filesChanged: [], insertions: 0, deletions: 0, binaryOrLarge: 0, files: [] };
    }
    const manifest = this.store.loadManifest(rec.manifestId);
    if (!manifest) return { error: `manifest missing for ${msgId}` };
    return this.store.diffStats(this.targetDir, manifest);
  }

  // ─── restore-class operations(全部走锁)──────────────────────────────────

  /** 文件回退到 msgId 锚点的快照。
   *  全新回退 = 干净还原(disk 精确等于目标 checkpoint);仅「挂起态内再回退」才保留挂起
   *  期间手改 —— 否则正常回退里「基线之后出现的文件」会被误判脏文件保留(回退删不掉文件)。
   *  调用前:driver 应已 abort() 在飞轮。 */
  rewind(msgId: string): Promise<RewindResult> {
    return this.withLock(async () => {
      const rec = this.messages.get(msgId);
      if (!rec) return { error: `unknown msgId: ${msgId}` };
      if (!rec.manifestId) return { error: `msgId ${msgId} has no code checkpoint` };
      if (!this.store || !this.targetDir) return { error: "no code store" };

      // 挂起态内再回退:手改防护(keptDirty)只对这种场景生效。在 cancel 旧 pending 前捕获。
      const wasPending = this.pendingRec != null;

      // 单活跃 boundary 模型:旧 boundary 作废,新 boundary 接管;Redo 落点继承第一次回退前状态。
      let inheritedPre: string | null = null;
      if (this.pendingRec) {
        inheritedPre = this.pendingRec.preManifestId;
        this.record({ kind: "rewind-status", boundaryId: this.pendingRec.boundaryId, status: "cancelled", ts: Date.now() });
        this.pendingRec = null;
      }

      // pre-rewind 快照 —— Redo 的落点。fail-closed:拍不下来就不回退。
      let preManifestId: string | null = inheritedPre;
      if (!preManifestId) {
        try {
          preManifestId = this.store.snapshot(this.targetDir, { kind: "pre-rewind" }).id;
        } catch (err) {
          return { error: `pre-rewind snapshot failed: ${(err as Error).message}` };
        }
      }

      const target = this.store.loadManifest(rec.manifestId);
      if (!target) return { error: `manifest missing for ${msgId}` };
      const dirty = wasPending ? this.dirtySet() : new Set<string>();
      const res = this.store.restore(this.targetDir, target, { exclude: dirty });
      const filesChanged = [...res.written, ...res.deleted];
      const keptDirty = res.skippedDirty;
      this.lastRestoreManifestId = rec.manifestId;

      const boundaryId = randomUUID();
      this.lastOp = { opId: boundaryId, keptDirty, restoreTargetManifestId: rec.manifestId, overwrite: null };
      this.record({ kind: "rewind", boundaryId, targetMsgId: msgId, ts: Date.now(), preManifestId, keptDirty });
      this.pendingRec = { boundaryId, targetMsgId: msgId, preManifestId, keptDirty, overwrite: null };
      return { boundaryId, filesChanged, keptDirty };
    });
  }

  /** 恢复(Redo)文件:把盘恢复到 pre-rewind 快照。挂起态手改默认保留。 */
  cancel(boundaryId: string): Promise<{ keptDirty: string[] } | { error: string }> {
    return this.withLock(async () => {
      if (!this.pendingRec || this.pendingRec.boundaryId !== boundaryId) {
        return { error: `boundary ${boundaryId} is not pending (cancelled/finalized/unknown)` };
      }
      const pending = this.pendingRec;
      let keptDirty: string[] = [];
      if (pending.preManifestId && this.store && this.targetDir) {
        const pre = this.store.loadManifest(pending.preManifestId);
        if (!pre) return { error: "pre-rewind manifest missing" };
        const dirty = this.dirtySet();
        const res = this.store.restore(this.targetDir, pre, { exclude: dirty });
        keptDirty = res.skippedDirty;
        this.lastRestoreManifestId = pending.preManifestId;
        this.lastOp = { opId: boundaryId, keptDirty, restoreTargetManifestId: pending.preManifestId, overwrite: null };
      }
      this.record({ kind: "rewind-status", boundaryId, status: "cancelled", ts: Date.now() });
      this.pendingRec = null;
      return { keptDirty };
    });
  }

  /** 「这些文件也回退」:显式覆盖上次 restore 保留的脏文件,覆盖前 safety 快照 fail-closed。
   *  挂在 lastOp(rewind 或 cancel)上,不要求仍处挂起态。 */
  overwriteDirty(boundaryId: string): Promise<{ files: string[] } | { error: string }> {
    return this.withLock(async () => {
      const op = this.lastOp;
      if (!op || op.opId !== boundaryId) return { error: `boundary ${boundaryId} is not the latest restore op` };
      if (!this.store || !this.targetDir || !op.restoreTargetManifestId) return { error: "no code restore in effect" };
      if (op.keptDirty.length === 0) return { files: [] };
      const files = new Set(op.keptDirty);
      let safetyManifestId: string;
      try {
        safetyManifestId = this.store.snapshot(this.targetDir, { kind: "safety" }).id;
      } catch (err) {
        return { error: `safety snapshot failed, aborted: ${(err as Error).message}` };
      }
      const target = this.store.loadManifest(op.restoreTargetManifestId);
      if (!target) return { error: "restore target manifest missing" };
      this.store.restore(this.targetDir, target, { only: files });
      const fileList = [...files];
      this.record({ kind: "overwrite", boundaryId, safetyManifestId, files: fileList, ts: Date.now() });
      op.overwrite = { safetyManifestId, files: fileList };
      op.keptDirty = [];
      if (this.pendingRec?.boundaryId === boundaryId) {
        this.pendingRec.overwrite = op.overwrite;
        this.pendingRec.keptDirty = [];
      }
      return { files: fileList };
    });
  }

  /** 「撤销」:把被覆盖的脏文件从 safety 快照写回。 */
  undoOverwrite(boundaryId: string): Promise<{ files: string[] } | { error: string }> {
    return this.withLock(async () => {
      const op = this.lastOp;
      if (!op || op.opId !== boundaryId || !op.overwrite) return { error: `no overwrite to undo for ${boundaryId}` };
      if (!this.store || !this.targetDir) return { error: "no code store" };
      const safety = this.store.loadManifest(op.overwrite.safetyManifestId);
      if (!safety) return { error: "safety manifest missing" };
      const files = new Set(op.overwrite.files);
      this.store.restore(this.targetDir, safety, { only: files });
      this.record({ kind: "overwrite-undo", boundaryId, ts: Date.now() });
      op.keptDirty = op.overwrite.files;
      op.overwrite = null;
      if (this.pendingRec?.boundaryId === boundaryId) {
        this.pendingRec.keptDirty = op.keptDirty;
        this.pendingRec.overwrite = null;
      }
      return { files: [...files] };
    });
  }

  /** 新 user_input 到达 → 定格(此后 cancel 失效)。 */
  finalizePending(): void {
    if (!this.pendingRec) return;
    const boundaryId = this.pendingRec.boundaryId;
    this.record({ kind: "rewind-status", boundaryId, status: "finalized", ts: Date.now() });
    this.pendingRec = null;
  }

  // ─── internals ──────────────────────────────────────────────────────────

  /** 挂起态脏检测:diff(当前盘, 上次 restore 落点)→ changed + onlyOnDisk。
   *  无 restore 基准(从未回退)→ 空集。 */
  private dirtySet(): Set<string> {
    if (!this.store || !this.targetDir || !this.lastRestoreManifestId) return new Set();
    const baseline = this.store.loadManifest(this.lastRestoreManifestId);
    if (!baseline) return new Set();
    const d = this.store.diffDiskVsManifest(this.targetDir, baseline);
    return new Set([...d.changed, ...d.onlyOnDisk]);
  }
}
