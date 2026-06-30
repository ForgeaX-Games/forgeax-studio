/** CheckpointManager 单测 —— 文件侧回退状态机(rewind/Redo/overwrite/undo/脏保护/重建)。
 *  走真实 fs(tmp 目录),不 mock。 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckpointManager } from "../src/cli/checkpoint-manager";

let root: string;
let cwd: string;
let sessionsDir: string;
const SID = "sess-1";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cp-mgr-test-"));
  cwd = join(root, "work");
  sessionsDir = join(root, "sessions");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const abs = join(cwd, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}
function read(rel: string): string {
  return readFileSync(join(cwd, rel), "utf-8");
}
function mgr(): CheckpointManager {
  return new CheckpointManager({ cwd, sessionId: SID, sessionsDir });
}
function ok<T>(r: T | { error: string }): T {
  if (r && typeof r === "object" && "error" in r) throw new Error(`unexpected error: ${(r as { error: string }).error}`);
  return r as T;
}

describe("CheckpointManager", () => {
  test("snapshotForMessage + list:每条消息一锚点,标 hasCode", () => {
    write("a.ts", "v1\n");
    const m = mgr();
    expect(m.hasStore()).toBe(true);
    m.snapshotForMessage("m1");
    write("a.ts", "v2\n");
    m.snapshotForMessage("m2");
    const list = m.list();
    expect(list.map((e) => e.msgId)).toEqual(["m1", "m2"]);
    expect(list.every((e) => e.hasCode)).toBe(true);
    expect(list.map((e) => e.ordinal)).toEqual([0, 1]);
  });

  test("rewind:回退到锚点 + 干净还原(删基线后新增文件)", async () => {
    write("a.ts", "v1\n");
    const m = mgr();
    m.snapshotForMessage("m1");
    // 这一轮:改 a、增 new
    write("a.ts", "v2\n");
    write("new.ts", "added\n");
    m.snapshotForMessage("m2");

    const res = ok(await m.rewind("m1"));
    expect(read("a.ts")).toBe("v1\n");
    expect(existsSync(join(cwd, "new.ts"))).toBe(false); // 干净还原:删掉基线后新增
    expect(res.filesChanged.sort()).toEqual(["a.ts", "new.ts"]);
    expect(m.pending()?.boundaryId).toBe(res.boundaryId);
  });

  test("cancel(Redo):还原到 pre-rewind(回退前最新)", async () => {
    write("a.ts", "v1\n");
    const m = mgr();
    m.snapshotForMessage("m1");
    write("a.ts", "v2\n");
    write("new.ts", "added\n");
    m.snapshotForMessage("m2");

    const { boundaryId } = ok(await m.rewind("m1"));
    expect(read("a.ts")).toBe("v1\n");
    ok(await m.cancel(boundaryId));
    // Redo → 回到回退前(v2 + new.ts)
    expect(read("a.ts")).toBe("v2\n");
    expect(read("new.ts")).toBe("added\n");
    expect(m.pending()).toBeNull();
  });

  test("脏文件保护:挂起态内手改 → 再回退保留手改", async () => {
    write("a.ts", "v1\n");
    write("b.ts", "v1\n");
    const m = mgr();
    m.snapshotForMessage("m1");
    write("a.ts", "v2\n");
    write("b.ts", "v2\n");
    m.snapshotForMessage("m2");

    const first = ok(await m.rewind("m1")); // 进挂起态,a/b 还原成 v1
    expect(read("a.ts")).toBe("v1\n");
    // 挂起态内手改 a
    write("a.ts", "hand-edit\n");
    const second = ok(await m.rewind("m1")); // 再回退:保留手改 a
    expect(read("a.ts")).toBe("hand-edit\n");
    expect(second.keptDirty).toContain("a.ts");
    expect(second.boundaryId).not.toBe(first.boundaryId);
  });

  test("overwriteDirty → undo:这些文件也回退,再撤销", async () => {
    write("a.ts", "v1\n");
    const m = mgr();
    m.snapshotForMessage("m1");
    write("a.ts", "v2\n");
    m.snapshotForMessage("m2");

    const { boundaryId } = ok(await m.rewind("m1"));
    // 挂起态内手改
    write("a.ts", "hand\n");
    ok(await m.rewind("m1")); // 保留手改
    const op = m.pending()!.boundaryId;
    expect(read("a.ts")).toBe("hand\n");

    const ow = ok(await m.overwriteDirty(op));
    expect(ow.files).toContain("a.ts");
    expect(read("a.ts")).toBe("v1\n"); // 手改也被回退掉

    ok(await m.undoOverwrite(op));
    expect(read("a.ts")).toBe("hand\n"); // 撤销:手改回来
  });

  test("checkpoints.jsonl 重启重建:挂起态 + 消息列表恢复", async () => {
    write("a.ts", "v1\n");
    const m1 = mgr();
    m1.snapshotForMessage("m1");
    write("a.ts", "v2\n");
    m1.snapshotForMessage("m2");
    const { boundaryId } = ok(await m1.rewind("m1"));

    // 新实例(模拟重启)读同一索引
    const m2 = new CheckpointManager({ cwd, sessionId: SID, sessionsDir });
    expect(m2.list().map((e) => e.msgId)).toEqual(["m1", "m2"]);
    expect(m2.pending()?.boundaryId).toBe(boundaryId);
    // 重建后 cancel 仍可用(Redo 落点持久)
    ok(await m2.cancel(boundaryId));
    expect(read("a.ts")).toBe("v2\n");
  });

  test("finalizePending:新消息到达定格后 cancel 失效", async () => {
    write("a.ts", "v1\n");
    const m = mgr();
    m.snapshotForMessage("m1");
    write("a.ts", "v2\n");
    m.snapshotForMessage("m2");
    const { boundaryId } = ok(await m.rewind("m1"));
    m.finalizePending();
    expect(m.pending()).toBeNull();
    const r = await m.cancel(boundaryId);
    expect(r).toHaveProperty("error");
  });

  test("preview:返回 diff 摘要", async () => {
    write("a.ts", "l1\nl2\n");
    const m = mgr();
    m.snapshotForMessage("m1");
    write("a.ts", "l1\nl2\nl3\n");
    m.snapshotForMessage("m2");
    const dv = ok(m.preview("m1"));
    expect(dv.filesChanged).toContain("a.ts");
    expect(dv.deletions).toBe(1); // 回退到 m1 会删掉 l3
  });
});
