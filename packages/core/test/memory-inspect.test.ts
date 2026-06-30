/**
 * Memory inspect tests — `/memory` 命令 A 层底层能力(022)。
 *
 * 覆盖:listMemory 复用 scan(mtime 新→旧、排除 MEMORY.md)+ 带回 indexPath/indexExists;
 * 空目录 → 空条目 + 索引不存在;openMemory 推导 MEMORY.md 路径(不触盘);路径拼接对
 * memoryDir 尾斜杠健壮。用假同步 SandboxFs(与 memory.test.ts 同款)。
 */
import { test, expect, describe } from 'bun:test';
import type { SandboxFs, StatResult, DirEnt } from '../src/inject/types';
import { listMemory, openMemory } from '../src/capability/memory/inspect';

// ─── fake SandboxFs (in-memory, sync surface only;对齐 memory.test.ts) ──────────────

interface FakeFile {
  content: string;
  mtime: number;
}

function fakeFs(seed: Record<string, FakeFile> = {}): SandboxFs {
  const files = new Map<string, FakeFile>();
  for (const [k, v] of Object.entries(seed)) files.set(norm(k), v);
  const dirs = new Set<string>();
  for (const k of files.keys()) {
    let p = parent(k);
    while (p && !dirs.has(p)) {
      dirs.add(p);
      p = parent(p);
    }
  }

  const ctx: SandboxFs = {
    readTextSync(path) {
      const f = files.get(norm(path));
      if (!f) throw new Error(`ENOENT ${path}`);
      return f.content;
    },
    writeTextSync(path, content) {
      const p = norm(path);
      files.set(p, { content, mtime: files.get(p)?.mtime ?? Date.now() });
      let d = parent(p);
      while (d) {
        dirs.add(d);
        d = parent(d);
      }
    },
    mkdirSync(path) {
      let d = norm(path);
      while (d) {
        dirs.add(d);
        d = parent(d);
      }
    },
    existsSync(path) {
      const p = norm(path);
      return files.has(p) || dirs.has(p);
    },
    unlinkSync(path) {
      files.delete(norm(path));
    },
    renameSync(from, to) {
      const f = files.get(norm(from));
      if (f) {
        files.set(norm(to), f);
        files.delete(norm(from));
      }
    },
    statSync(path): StatResult {
      const p = norm(path);
      const f = files.get(p);
      if (f) return { isFile: true, isDir: false, size: f.content.length, mtime: f.mtime };
      if (dirs.has(p)) return { isFile: false, isDir: true, size: 0, mtime: 0 };
      throw new Error(`ENOENT ${path}`);
    },
    readdirSync(path, opts): string[] | DirEnt[] {
      const root = norm(path);
      const children = new Map<string, { isFile: boolean; isDir: boolean }>();
      for (const k of files.keys()) {
        if (parent(k) === root) children.set(base(k), { isFile: true, isDir: false });
      }
      for (const d of dirs) {
        if (parent(d) === root) children.set(base(d), { isFile: false, isDir: true });
      }
      if (opts?.withFileTypes) {
        return [...children.entries()].map(([name, t]) => ({
          name,
          isFile: t.isFile,
          isDir: t.isDir,
          isSymlink: false,
        }));
      }
      return [...children.keys()];
    },
    async readText(path) {
      return ctx.readTextSync(path);
    },
    async writeText(path, content) {
      ctx.writeTextSync(path, content);
    },
    async readBytes() {
      return new Uint8Array();
    },
    async writeBytes() {},
    readStream() {
      throw new Error('not impl');
    },
    writeStream() {
      throw new Error('not impl');
    },
  };
  return ctx;
}

function norm(p: string): string {
  return p.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}
function parent(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '' : p.slice(0, i);
}
function base(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function mdFile(type: string, name: string, description: string, body: string, mtime: number): FakeFile {
  return {
    content: `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`,
    mtime,
  };
}

const DIR = '/mem';

// ─── listMemory ─────────────────────────────────────────────────────────────────

describe('listMemory', () => {
  test('lists entries newest-first, excludes MEMORY.md, carries index info', () => {
    const fs = fakeFs({
      '/mem/a.md': mdFile('user', 'A', 'desc-a', 'body a', 1000),
      '/mem/b.md': mdFile('project', 'B', 'desc-b', 'body b', 3000),
      '/mem/sub/c.md': mdFile('feedback', 'C', 'desc-c', 'body c', 2000),
      '/mem/MEMORY.md': { content: '# index', mtime: 9999 },
    });
    const listing = listMemory(fs, DIR);
    expect(listing.memoryDir).toBe(DIR);
    expect(listing.entries.map((e) => e.filename)).toEqual(['b.md', 'sub/c.md', 'a.md']);
    expect(listing.entries[0].type).toBe('project');
    expect(listing.entries[0].description).toBe('desc-b');
    expect(listing.entries[0].name).toBe('B');
    expect(listing.entries[0].mtimeMs).toBe(3000);
    // MEMORY.md is the index, not a listed entry
    expect(listing.entries.find((e) => e.filename === 'MEMORY.md')).toBeUndefined();
    // index info
    expect(listing.indexPath).toBe('/mem/MEMORY.md');
    expect(listing.indexExists).toBe(true);
  });

  test('empty / missing dir → no entries, index absent', () => {
    const listing = listMemory(fakeFs(), '/nope');
    expect(listing.entries).toEqual([]);
    expect(listing.indexPath).toBe('/nope/MEMORY.md');
    expect(listing.indexExists).toBe(false);
  });

  test('entries present but index not yet built → indexExists false', () => {
    const fs = fakeFs({ '/mem/a.md': mdFile('user', 'A', 'da', 'x', 1) });
    const listing = listMemory(fs, DIR);
    expect(listing.entries).toHaveLength(1);
    expect(listing.indexExists).toBe(false);
  });
});

// ─── openMemory ─────────────────────────────────────────────────────────────────

describe('openMemory', () => {
  test('returns MEMORY.md path under memoryDir (no IO)', () => {
    expect(openMemory(DIR)).toBe('/mem/MEMORY.md');
  });

  test('robust to trailing slash on memoryDir', () => {
    expect(openMemory('/mem/')).toBe('/mem/MEMORY.md');
  });
});
