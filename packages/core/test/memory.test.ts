/**
 * MEMpack tests — generic memory capability pack (C8).
 *
 * 覆盖:scan 解析 frontmatter + mtime 新→旧排序 + 封顶 200;recall 无 selectFn 回退取
 * 最新 N + selectFn 注入选择 + 选择器失败回退 + 幻觉文件名丢弃;remember 写闸(拒目录
 * 外)+ 写盘 + 重建索引;slot 注入索引封顶 entrypoint 预算;预算遵守(per-file 截断、
 * perTurnMaxFiles 上限)。用假同步 SandboxFs。
 *
 * **零 soul / T0-T1-T2 语义**:taxonomy 全经 type 字符串由测试传入。
 */
import { test, expect, describe } from 'bun:test';
import type { SandboxFs, StatResult, DirEnt } from '../src/inject/types';
import { MEMORY_BUDGET, MEMORY_SEARCH_TOOL, REMEMBER_TOOL } from '../src/capability/memory-seam';
import { scanMemoryFiles, formatManifest } from '../src/capability/memory/scan';
import { findRelevantMemories } from '../src/capability/memory/recall';
import { isAutoMemPath, freshness } from '../src/capability/memory/tools';
import { memoryPack } from '../src/capability/memory';

// ─── fake SandboxFs (in-memory, sync surface only) ───────────────────────────────

interface FakeFile {
  content: string;
  mtime: number;
}

function fakeFs(seed: Record<string, FakeFile> = {}): SandboxFs & { dump(): Record<string, string> } {
  const files = new Map<string, FakeFile>();
  for (const [k, v] of Object.entries(seed)) files.set(norm(k), v);
  const dirs = new Set<string>();
  // seed parent dirs
  for (const k of files.keys()) {
    let p = parent(k);
    while (p && !dirs.has(p)) {
      dirs.add(p);
      p = parent(p);
    }
  }

  const ctx: SandboxFs & { dump(): Record<string, string> } = {
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
    dump() {
      const out: Record<string, string> = {};
      for (const [k, v] of files) out[k] = v.content;
      return out;
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

// ─── scan ───────────────────────────────────────────────────────────────────────

describe('scanMemoryFiles', () => {
  test('parses frontmatter, sorts newest-first, excludes MEMORY.md', () => {
    const fs = fakeFs({
      '/mem/a.md': mdFile('user', 'A', 'desc-a', 'body a', 1000),
      '/mem/b.md': mdFile('project', 'B', 'desc-b', 'body b', 3000),
      '/mem/sub/c.md': mdFile('feedback', 'C', 'desc-c', 'body c', 2000),
      '/mem/MEMORY.md': { content: '# index', mtime: 9999 },
    });
    const headers = scanMemoryFiles(fs, DIR);
    expect(headers.map((h) => h.filename)).toEqual(['b.md', 'sub/c.md', 'a.md']);
    expect(headers[0].type).toBe('project');
    expect(headers[0].description).toBe('desc-b');
    expect(headers[0].name).toBe('B');
    // MEMORY.md excluded
    expect(headers.find((h) => h.filename === 'MEMORY.md')).toBeUndefined();
  });

  test('missing dir → []', () => {
    expect(scanMemoryFiles(fakeFs(), '/nope')).toEqual([]);
  });

  test('caps at 200 files (MAX_MEMORY_FILES)', () => {
    const seed: Record<string, FakeFile> = {};
    for (let i = 0; i < 250; i++) {
      seed[`/mem/f${i}.md`] = mdFile('user', `n${i}`, `d${i}`, 'x', i);
    }
    const headers = scanMemoryFiles(fakeFs(seed), DIR);
    expect(headers).toHaveLength(200);
    // newest-first → highest mtime survives
    expect(headers[0].mtimeMs).toBe(249);
  });

  test('formatManifest renders one line per file with type tag', () => {
    const fs = fakeFs({ '/mem/a.md': mdFile('user', 'A', 'about a', 'body', 0) });
    const manifest = formatManifest(scanMemoryFiles(fs, DIR));
    expect(manifest).toContain('[user] a.md');
    expect(manifest).toContain('about a');
  });
});

// ─── recall ───────────────────────────────────────────────────────────────────────

describe('findRelevantMemories', () => {
  const fs = fakeFs({
    '/mem/a.md': mdFile('user', 'A', 'desc-a', 'x', 1000),
    '/mem/b.md': mdFile('user', 'B', 'desc-b', 'x', 3000),
    '/mem/c.md': mdFile('user', 'C', 'desc-c', 'x', 2000),
  });
  const headers = scanMemoryFiles(fs, DIR); // [b, c, a]

  test('no selectFn → fallback to newest N', async () => {
    const out = await findRelevantMemories(headers, 'q');
    expect(out.map((h) => h.filename)).toEqual(['b.md', 'c.md', 'a.md']);
  });

  test('selectFn injection picks named files in selector order', async () => {
    const select = async (_manifest: string, _q: string) => ['a.md', 'c.md'];
    const out = await findRelevantMemories(headers, 'q', select);
    expect(out.map((h) => h.filename)).toEqual(['a.md', 'c.md']);
  });

  test('selectFn receives the manifest text', async () => {
    let seen = '';
    await findRelevantMemories(headers, 'topic', async (m) => {
      seen = m;
      return [];
    });
    expect(seen).toContain('b.md');
    expect(seen).toContain('desc-a');
  });

  test('hallucinated filenames are dropped', async () => {
    const out = await findRelevantMemories(headers, 'q', async () => ['ghost.md', 'b.md']);
    expect(out.map((h) => h.filename)).toEqual(['b.md']);
  });

  test('selectFn throwing → fallback to newest', async () => {
    const out = await findRelevantMemories(headers, 'q', async () => {
      throw new Error('boom');
    });
    expect(out.map((h) => h.filename)).toEqual(['b.md', 'c.md', 'a.md']);
  });

  test('respects perTurnMaxFiles budget cap', async () => {
    const many: Record<string, FakeFile> = {};
    for (let i = 0; i < 10; i++) many[`/mem/m${i}.md`] = mdFile('user', `${i}`, `${i}`, 'x', i);
    const hs = scanMemoryFiles(fakeFs(many), DIR);
    const out = await findRelevantMemories(hs, 'q');
    expect(out.length).toBe(MEMORY_BUDGET.perTurnMaxFiles);
  });

  test('limit narrows but never exceeds budget', async () => {
    const out = await findRelevantMemories(headers, 'q', undefined, 2);
    expect(out).toHaveLength(2);
  });
});

// ─── write gate ───────────────────────────────────────────────────────────────────

describe('isAutoMemPath (write gate)', () => {
  test('allows paths inside memory dir', () => {
    expect(isAutoMemPath('/mem', '/mem/foo.md')).toBe(true);
    expect(isAutoMemPath('/mem', '/mem/sub/foo.md')).toBe(true);
    expect(isAutoMemPath('/mem', 'foo.md')).toBe(true); // relative resolves under root
  });
  test('rejects paths outside memory dir', () => {
    expect(isAutoMemPath('/mem', '/etc/passwd')).toBe(false);
    expect(isAutoMemPath('/mem', '/mem/../escape.md')).toBe(false);
    expect(isAutoMemPath('/mem', '../escape.md')).toBe(false);
    expect(isAutoMemPath('/mem', '/membership/x.md')).toBe(false); // prefix-not-boundary
  });
});

// ─── tools: remember + memory_search ────────────────────────────────────────────────

describe('memoryPack tools', () => {
  test('remember writes a .md with frontmatter + rebuilds index', async () => {
    const fs = fakeFs();
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const remember = pack.tools!.find((t) => t.name === REMEMBER_TOOL)!;
    const ctx = { signal: new AbortController().signal };
    const res = await remember.call(
      { type: 'note', name: 'My Pref', description: 'a preference', body: 'likes dark mode' },
      ctx,
    );
    const path = (res.data as { path: string }).path;
    expect(path).toBe('/mem/my-pref.md');
    const written = fs.readTextSync(path);
    expect(written).toContain('type: note');
    expect(written).toContain('likes dark mode');
    // index rebuilt
    expect(fs.existsSync('/mem/MEMORY.md')).toBe(true);
    expect(fs.readTextSync('/mem/MEMORY.md')).toContain('[note] my-pref.md');
  });

  test('memory_search returns hits with freshness + content', async () => {
    const fs = fakeFs({
      '/mem/x.md': mdFile('user', 'X', 'about x', 'content of x', Date.now()),
    });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const search = pack.tools!.find((t) => t.name === MEMORY_SEARCH_TOOL)!;
    const ctx = { signal: new AbortController().signal };
    const res = await search.call({ query: 'x' }, ctx);
    const hits = (res.data as { hits: Array<{ path: string; content: string; freshness?: string }> }).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('/mem/x.md');
    expect(hits[0].content).toContain('content of x');
    expect(hits[0].freshness).toBe('today');
  });

  test('memory_search per-file content clamped to budget', async () => {
    const big = 'L'.repeat(MEMORY_BUDGET.perFileMaxBytes + 5000);
    const fs = fakeFs({ '/mem/big.md': mdFile('user', 'Big', 'big one', big, Date.now()) });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const search = pack.tools!.find((t) => t.name === MEMORY_SEARCH_TOOL)!;
    const res = await search.call({ query: 'q' }, { signal: new AbortController().signal });
    const hits = (res.data as { hits: Array<{ content: string }> }).hits;
    expect(hits[0].content.length).toBeLessThanOrEqual(MEMORY_BUDGET.perFileMaxBytes);
  });

  test('memory_search honors injected selectFn', async () => {
    const fs = fakeFs({
      '/mem/a.md': mdFile('user', 'A', 'da', 'aaa', 2000),
      '/mem/b.md': mdFile('user', 'B', 'db', 'bbb', 1000),
    });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs, selectFn: async () => ['b.md'] });
    const search = pack.tools!.find((t) => t.name === MEMORY_SEARCH_TOOL)!;
    const res = await search.call({ query: 'q' }, { signal: new AbortController().signal });
    const hits = (res.data as { hits: Array<{ path: string }> }).hits;
    expect(hits.map((h) => h.path)).toEqual(['/mem/b.md']);
  });

  test('freshness renders human age', () => {
    const now = Date.now();
    expect(freshness(now, now)).toBe('today');
    expect(freshness(now - 86_400_000, now)).toBe('yesterday');
    expect(freshness(now - 3 * 86_400_000, now)).toBe('3 days ago');
  });
});

// ─── slot ───────────────────────────────────────────────────────────────────────

describe('memory slot', () => {
  test('renders resident MEMORY.md index', async () => {
    const fs = fakeFs({ '/mem/MEMORY.md': { content: '# MEMORY index\n\n- [user] a.md (x): hi', mtime: 0 } });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const slot = pack.slots!.find((s) => s.name === 'memory')!;
    const out = await slot.render({});
    expect(out).toContain('MEMORY index');
    expect(out).toContain('a.md');
  });

  test('falls back to live manifest when index missing', async () => {
    const fs = fakeFs({ '/mem/a.md': mdFile('user', 'A', 'desc-a', 'body', 0) });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const slot = pack.slots!.find((s) => s.name === 'memory')!;
    const out = await slot.render({});
    expect(out).toContain('a.md');
  });

  test('empty memory → null (no injection)', async () => {
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fakeFs() });
    const slot = pack.slots!.find((s) => s.name === 'memory')!;
    expect(await slot.render({})).toBeNull();
  });

  test('index render clamped to entrypoint byte budget', async () => {
    const huge = '- line\n'.repeat(MEMORY_BUDGET.entrypointMaxLines + 500);
    const fs = fakeFs({ '/mem/MEMORY.md': { content: `# i\n\n${huge}`, mtime: 0 } });
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fs });
    const slot = pack.slots!.find((s) => s.name === 'memory')!;
    const out = (await slot.render({})) as string;
    expect(out.split('\n').length).toBeLessThanOrEqual(MEMORY_BUDGET.entrypointMaxLines);
    expect(out.length).toBeLessThanOrEqual(MEMORY_BUDGET.entrypointMaxBytes);
  });
});

// ─── pack shape ───────────────────────────────────────────────────────────────────

describe('memoryPack assembly', () => {
  test('exposes both tools + memory slot at builtin layer', () => {
    const pack = memoryPack({ memoryDir: DIR, sandboxFs: fakeFs() });
    expect(pack.name).toBe('memory');
    expect(pack.layer).toBe('builtin');
    expect(pack.tools!.map((t) => t.name).sort()).toEqual([MEMORY_SEARCH_TOOL, REMEMBER_TOOL].sort());
    expect(pack.slots!.map((s) => s.name)).toEqual(['memory']);
  });
});
