/** checkpoint-store 单测 —— SnapshotStore(CAS)/ lcsDiffCounts 纯逻辑。
 *  走真实 fs(tmp 目录),不 mock。源自 forgeax-cli 的 checkpoint.test.ts(SnapshotStore 部分)。 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SnapshotStore, lcsDiffCounts } from "../src/cli/checkpoint-store";

let workDir: string;
let storeDir: string;
let targetDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "cp-store-test-"));
  storeDir = join(workDir, "store");
  targetDir = join(workDir, "work");
  mkdirSync(targetDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const abs = join(targetDir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function countBlobs(store: SnapshotStore): number {
  const blobs = join(store.storeRoot, "blobs");
  if (!existsSync(blobs)) return 0;
  let n = 0;
  for (const d of readdirSync(blobs)) n += readdirSync(join(blobs, d)).length;
  return n;
}

describe("SnapshotStore", () => {
  test("snapshot 覆盖全目录 + ignore 规则(含 .forgeax)", () => {
    write("main.ts", "console.log(1)\n");
    write("src/util.ts", "export const x = 1\n");
    mkdirSync(join(targetDir, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(targetDir, "node_modules/pkg/index.js"), "ignored");
    writeFileSync(join(targetDir, ".DS_Store"), "ignored");
    // .forgeax(快照库 + WAL 所在)必须被剪枝,否则递归快照自身。
    mkdirSync(join(targetDir, ".forgeax/sessions"), { recursive: true });
    writeFileSync(join(targetDir, ".forgeax/sessions/events.jsonl"), "ignored");
    const store = new SnapshotStore(storeDir);
    const m = store.snapshot(targetDir);
    expect(Object.keys(m.files).sort()).toEqual(["main.ts", "src/util.ts"]);
    expect(store.loadManifest(m.id)?.id).toBe(m.id);
  });

  test("CAS 去重:未变文件零新增 blob;相同内容跨版本只存一份", () => {
    write("a.ts", "AAA\n");
    write("b.ts", "BBB\n");
    const store = new SnapshotStore(storeDir);
    store.snapshot(targetDir);
    expect(countBlobs(store)).toBe(2);
    write("b.ts", "BBB2\n");
    store.snapshot(targetDir);
    expect(countBlobs(store)).toBe(3); // 只多 b 的新版本
    write("b.ts", "BBB\n"); // 改回老内容
    store.snapshot(targetDir);
    expect(countBlobs(store)).toBe(3); // 内容寻址:不重复存
  });

  test("restore:跨版本一次到位,含删除/新增语义", () => {
    write("a.ts", "v1-a\n");
    write("gone.ts", "will-be-deleted\n");
    const store = new SnapshotStore(storeDir);
    const m1 = store.snapshot(targetDir);

    // turn1: 改 a、删 gone、加 new
    write("a.ts", "v2-a\n");
    rmSync(join(targetDir, "gone.ts"));
    write("deep/new.ts", "added-later\n");
    const m2 = store.snapshot(targetDir);

    // 回退到 m1:a 还原、gone 复活、new 删除(空目录清理)
    const res = store.restore(targetDir, m1);
    expect(readFileSync(join(targetDir, "a.ts"), "utf-8")).toBe("v1-a\n");
    expect(readFileSync(join(targetDir, "gone.ts"), "utf-8")).toBe("will-be-deleted\n");
    expect(existsSync(join(targetDir, "deep/new.ts"))).toBe(false);
    expect(existsSync(join(targetDir, "deep"))).toBe(false);
    expect(res.written.sort()).toEqual(["a.ts", "gone.ts"]);
    expect(res.deleted).toEqual(["deep/new.ts"]);

    // 再向前跳回 m2(撤销回退的等价操作)
    store.restore(targetDir, m2);
    expect(readFileSync(join(targetDir, "a.ts"), "utf-8")).toBe("v2-a\n");
    expect(existsSync(join(targetDir, "gone.ts"))).toBe(false);
    expect(readFileSync(join(targetDir, "deep/new.ts"), "utf-8")).toBe("added-later\n");
  });

  test("只写差异文件(未变文件 mtime 不动)", async () => {
    write("stable.ts", "same\n");
    write("hot.ts", "v1\n");
    const store = new SnapshotStore(storeDir);
    const m1 = store.snapshot(targetDir);
    write("hot.ts", "v2\n");
    const before = statSync(join(targetDir, "stable.ts")).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const res = store.restore(targetDir, m1);
    expect(res.written).toEqual(["hot.ts"]);
    expect(statSync(join(targetDir, "stable.ts")).mtimeMs).toBe(before);
  });

  test("exclude:脏文件保留(不写回不删除)", () => {
    write("a.ts", "v1\n");
    const store = new SnapshotStore(storeDir);
    const m1 = store.snapshot(targetDir);
    write("a.ts", "user-edit\n");
    write("user-new.ts", "user-created\n");
    const res = store.restore(targetDir, m1, { exclude: new Set(["a.ts", "user-new.ts"]) });
    expect(readFileSync(join(targetDir, "a.ts"), "utf-8")).toBe("user-edit\n");
    expect(existsSync(join(targetDir, "user-new.ts"))).toBe(true);
    expect(res.skippedDirty.sort()).toEqual(["a.ts", "user-new.ts"]);
  });

  test("only:局部恢复(这些文件也回退 / 撤销)", () => {
    write("a.ts", "v1\n");
    write("b.ts", "v1\n");
    const store = new SnapshotStore(storeDir);
    const m1 = store.snapshot(targetDir);
    write("a.ts", "v2\n");
    write("b.ts", "v2\n");
    store.restore(targetDir, m1, { only: new Set(["a.ts"]) });
    expect(readFileSync(join(targetDir, "a.ts"), "utf-8")).toBe("v1\n");
    expect(readFileSync(join(targetDir, "b.ts"), "utf-8")).toBe("v2\n"); // 不在 only 内,不动
  });

  test("diffStats:行级统计 + 二进制按变更计数", () => {
    write("code.ts", "line1\nline2\nline3\n");
    writeFileSync(join(targetDir, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    const store = new SnapshotStore(storeDir);
    const m1 = store.snapshot(targetDir);
    write("code.ts", "line1\nCHANGED\nline3\nline4\n");
    writeFileSync(join(targetDir, "bin.dat"), Buffer.from([0, 9, 9]));
    const stats = store.diffStats(targetDir, m1);
    expect(stats.filesChanged.sort()).toEqual(["bin.dat", "code.ts"]);
    expect(stats.insertions).toBe(1);
    expect(stats.deletions).toBe(2);
    expect(stats.binaryOrLarge).toBe(1);
  });

  test("diffStats.files:逐文件 status / 行数 / binary", () => {
    write("code.ts", "a\nb\nc\n");
    write("old.ts", "x\n");
    writeFileSync(join(targetDir, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    const store = new SnapshotStore(storeDir);
    const m1 = store.snapshot(targetDir);

    // 改 code、删 old、增 extra、改 bin —— 回到 m1 视角:code=改,old=新增(写回),
    // extra=删除,bin=改(二进制)。
    write("code.ts", "a\nB\nc\nd\n");
    rmSync(join(targetDir, "old.ts"));
    write("extra.ts", "new1\nnew2\n");
    writeFileSync(join(targetDir, "bin.dat"), Buffer.from([9, 9]));

    const stats = store.diffStats(targetDir, m1);
    const byPath = Object.fromEntries(stats.files.map((f) => [f.path, f]));

    expect(stats.files.length).toBe(stats.filesChanged.length);
    expect(byPath["code.ts"]).toMatchObject({ status: "modified", binary: false });
    expect(byPath["old.ts"]).toMatchObject({ status: "added", binary: false });
    expect(byPath["extra.ts"]).toMatchObject({ status: "deleted", binary: false });
    expect(byPath["bin.dat"]).toMatchObject({ status: "modified", binary: true });
    // 行级统计仍与聚合一致
    const sumIns = stats.files.reduce((n, f) => n + f.insertions, 0);
    const sumDel = stats.files.reduce((n, f) => n + f.deletions, 0);
    expect(sumIns).toBe(stats.insertions);
    expect(sumDel).toBe(stats.deletions);
  });
});

describe("lcsDiffCounts", () => {
  test("公共前后缀剥离 + 计数", () => {
    expect(lcsDiffCounts(["a", "b", "c"], ["a", "x", "c"])).toEqual({ insertions: 1, deletions: 1 });
    expect(lcsDiffCounts([], ["a", "b"])).toEqual({ insertions: 2, deletions: 0 });
    expect(lcsDiffCounts(["a"], ["a"])).toEqual({ insertions: 0, deletions: 0 });
  });
});
