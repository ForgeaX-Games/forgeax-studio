/**
 * Memory tools validation cases (≥90% target) — fills the uncovered gaps in
 * src/capability/memory/tools.ts:
 *   - clampToBudget line-clamp branch (97)
 *   - memory_search readTextSync throw → continue/skip (122)
 *   - memory_search mapResult → CoreEvent (129-132)
 *   - remember filename-collision dedup loop (152)
 *   - remember write-gate refusal (158)
 *   - remember mapResult → CoreEvent (177-180)
 *   - isAutoMemPath boundary edges (`..`, prefix, dir-itself)
 *
 * Boundary: only core-local relative imports + node:. In-memory SandboxFs stub
 * (the throw-on-read variant exercises the try/catch skip paths).
 */
import { test, expect, describe } from 'bun:test';
import type { SandboxFs, StatResult, DirEnt } from '../src/inject/types';
import { MEMORY_BUDGET, MEMORY_SEARCH_TOOL, REMEMBER_TOOL } from '../src/capability/memory-seam';
import { makeRememberTool, makeMemorySearchTool, isAutoMemPath } from '../src/capability/memory/tools';

// ─── in-memory SandboxFs stub (sync surface only) ─────────────────────────────

interface FakeFile {
  content: string;
  mtime: number;
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

interface FakeFs extends SandboxFs {
  dump(): Record<string, string>;
  /** force readTextSync to throw for paths matching this substring. */
  failReadOn?: string;
}

function fakeFs(seed: Record<string, FakeFile> = {}): FakeFs {
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

  const ctx: FakeFs = {
    failReadOn: undefined,
    readTextSync(path) {
      if (ctx.failReadOn && path.includes(ctx.failReadOn)) {
        throw new Error(`forced read failure: ${path}`);
      }
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

function mdFile(type: string, name: string, description: string, body: string, mtime: number): FakeFile {
  return {
    content: `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`,
    mtime,
  };
}

const DIR = '/mem';
const ctx = () => ({ signal: new AbortController().signal });

// ─── isAutoMemPath edges ──────────────────────────────────────────────────────

describe('isAutoMemPath edges', () => {
  test('dir itself is allowed', () => {
    expect(isAutoMemPath('/mem', '/mem')).toBe(true);
  });
  test('nested + relative resolve under root', () => {
    expect(isAutoMemPath('/mem', '/mem/sub/x.md')).toBe(true);
    expect(isAutoMemPath('/mem', 'sub/x.md')).toBe(true);
  });
  test('.. escape rejected', () => {
    expect(isAutoMemPath('/mem', '/mem/../x.md')).toBe(false);
    expect(isAutoMemPath('/mem', '../x.md')).toBe(false);
    expect(isAutoMemPath('/mem', '/mem/sub/../../x.md')).toBe(false);
  });
  test('sibling with shared prefix is NOT inside (boundary check)', () => {
    expect(isAutoMemPath('/mem', '/membership/x.md')).toBe(false);
  });
  test('.. that stays inside after a deeper segment is allowed', () => {
    // /mem/a/../b.md normalizes to /mem/b.md → inside.
    expect(isAutoMemPath('/mem', '/mem/a/../b.md')).toBe(true);
  });
  test('memoryDir given with trailing slash still normalizes', () => {
    expect(isAutoMemPath('/mem/', '/mem/x.md')).toBe(true);
  });
});

// ─── remember: write + dedup + index + gate + mapResult ───────────────────────

describe('makeRememberTool', () => {
  test('writes a .md (frontmatter + body), creates dir, rebuilds index', async () => {
    const fs = fakeFs();
    const tool = makeRememberTool({ memoryDir: DIR, sandboxFs: fs });
    const res = await tool.call(
      { type: 'note', name: 'My Pref', description: 'a pref', body: 'likes dark mode' },
      ctx(),
    );
    const path = (res.data as { path: string }).path;
    expect(path).toBe('/mem/my-pref.md');
    const written = fs.readTextSync(path);
    expect(written).toContain('name: My Pref');
    expect(written).toContain('type: note');
    expect(written).toContain('likes dark mode');
    expect(fs.readTextSync('/mem/MEMORY.md')).toContain('[note] my-pref.md');
  });

  test('filename collision appends -2, -3 (dedup loop, line 152)', async () => {
    const fs = fakeFs({
      '/mem/dup.md': mdFile('note', 'Dup', 'd', 'b', 1),
      '/mem/dup-2.md': mdFile('note', 'Dup', 'd', 'b', 1),
    });
    const tool = makeRememberTool({ memoryDir: DIR, sandboxFs: fs });
    const res = await tool.call({ type: 'note', name: 'Dup', description: 'd', body: 'new' }, ctx());
    expect((res.data as { path: string }).path).toBe('/mem/dup-3.md');
  });

  test('falls back to description then "entry" for the slug', async () => {
    const fs = fakeFs();
    const tool = makeRememberTool({ memoryDir: DIR, sandboxFs: fs });
    const byDesc = await tool.call({ type: 't', name: '', description: 'Use Desc', body: 'b' }, ctx());
    expect((byDesc.data as { path: string }).path).toBe('/mem/use-desc.md');
    const byNothing = await tool.call({ type: 't', name: '', description: '', body: 'b' }, ctx());
    expect((byNothing.data as { path: string }).path).toBe('/mem/entry.md');
  });

  test('body clamped to per-file byte budget on write', async () => {
    const fs = fakeFs();
    const tool = makeRememberTool({ memoryDir: DIR, sandboxFs: fs });
    const big = 'X'.repeat(MEMORY_BUDGET.perFileMaxBytes + 4000);
    const res = await tool.call({ type: 't', name: 'big', description: 'd', body: big }, ctx());
    const path = (res.data as { path: string }).path;
    const body = fs.readTextSync(path).split('---')[2] ?? '';
    expect(body.length).toBeLessThanOrEqual(MEMORY_BUDGET.perFileMaxBytes + 5);
  });

  test('escapes YAML special chars in frontmatter values', async () => {
    const fs = fakeFs();
    const tool = makeRememberTool({ memoryDir: DIR, sandboxFs: fs });
    const res = await tool.call(
      { type: 'note', name: 'has: colon', description: 'a "quote"', body: 'b' },
      ctx(),
    );
    const written = fs.readTextSync((res.data as { path: string }).path);
    expect(written).toContain('name: "has: colon"');
    expect(written).toContain('description: "a \\"quote\\""');
  });

  test('mapResult emits a tool.result CoreEvent with path (177-180)', () => {
    const fs = fakeFs();
    const tool = makeRememberTool({ memoryDir: DIR, sandboxFs: fs });
    const ev = tool.mapResult({ path: '/mem/p.md' }, 'tu-1');
    expect(ev.type).toBe('tool.result');
    expect(ev.payload).toEqual({ toolUseId: 'tu-1', tool: REMEMBER_TOOL, path: '/mem/p.md' });
    expect(typeof ev.ts).toBe('number');
  });

  test('write-gate predicates: not read-only, not concurrency-safe, not destructive', () => {
    const fs = fakeFs();
    const tool = makeRememberTool({ memoryDir: DIR, sandboxFs: fs });
    expect(tool.isReadOnly({} as never)).toBe(false);
    expect(tool.isConcurrencySafe({} as never)).toBe(false);
    expect(tool.isDestructive?.({} as never)).toBe(false);
  });

  test('write target always stays inside memory dir (gate never triggers via call)', async () => {
    // NOTE (无法直接命中 line 158): the in-tool gate `isAutoMemPath(memoryDir,
    // target)` throws only if the resolved target escapes its root, but `target`
    // = join(memoryDir, slugify(...)) always normalizes back inside memoryDir, so
    // the throw is defensively unreachable through call(). The escape *logic* is
    // verified directly in the `isAutoMemPath edges` block above. Here we assert
    // the produced path is always confined.
    const fs = fakeFs();
    const tool = makeRememberTool({ memoryDir: DIR, sandboxFs: fs });
    const res = await tool.call({ type: 't', name: '../../etc/passwd', description: 'd', body: 'b' }, ctx());
    const path = (res.data as { path: string }).path;
    expect(isAutoMemPath(DIR, path)).toBe(true);
    expect(path.startsWith('/mem/')).toBe(true);
  });
});

// ─── memory_search: hits, clamp, skip-on-read-fail, selectFn, mapResult ───────

describe('makeMemorySearchTool', () => {
  test('returns hits with path + freshness + content', async () => {
    const fs = fakeFs({ '/mem/x.md': mdFile('user', 'X', 'about x', 'content of x', Date.now()) });
    const tool = makeMemorySearchTool({ memoryDir: DIR, sandboxFs: fs });
    const res = await tool.call({ query: 'x' }, ctx());
    const hits = (res.data as { hits: Array<{ path: string; content: string; freshness?: string }> }).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('/mem/x.md');
    expect(hits[0].content).toContain('content of x');
    expect(hits[0].freshness).toBe('today');
  });

  test('content clamped by LINE budget (line 97 branch)', async () => {
    const manyLines = Array.from({ length: MEMORY_BUDGET.perFileMaxLines + 50 }, (_, i) => `line${i}`).join('\n');
    const fs = fakeFs({ '/mem/l.md': mdFile('user', 'L', 'lines', manyLines, Date.now()) });
    const tool = makeMemorySearchTool({ memoryDir: DIR, sandboxFs: fs });
    const res = await tool.call({ query: 'q' }, ctx());
    const hits = (res.data as { hits: Array<{ content: string }> }).hits;
    expect(hits[0].content.split('\n').length).toBeLessThanOrEqual(MEMORY_BUDGET.perFileMaxLines);
  });

  test('content clamped by BYTE budget', async () => {
    const big = 'L'.repeat(MEMORY_BUDGET.perFileMaxBytes + 5000);
    const fs = fakeFs({ '/mem/big.md': mdFile('user', 'Big', 'big', big, Date.now()) });
    const tool = makeMemorySearchTool({ memoryDir: DIR, sandboxFs: fs });
    const res = await tool.call({ query: 'q' }, ctx());
    const hits = (res.data as { hits: Array<{ content: string }> }).hits;
    expect(hits[0].content.length).toBeLessThanOrEqual(MEMORY_BUDGET.perFileMaxBytes);
  });

  test('readTextSync throwing on a hit → that file is skipped (line 122 catch)', async () => {
    const fs = fakeFs({
      '/mem/good.md': mdFile('user', 'G', 'good', 'good content', 2000),
      '/mem/bad.md': mdFile('user', 'B', 'bad', 'bad content', 1000),
    });
    // scan reads head (first 30 lines) fine; force the *full-text* read of bad.md
    // to throw only after scan. Since scan also calls readTextSync, we instead make
    // it fail for 'bad' on every read — scan will then drop bad.md too, so target
    // only the full-text read by failing a path that scan tolerates. Simplest: fail
    // reads containing 'bad' and confirm only good.md survives.
    fs.failReadOn = 'bad';
    const tool = makeMemorySearchTool({ memoryDir: DIR, sandboxFs: fs });
    const res = await tool.call({ query: 'q' }, ctx());
    const hits = (res.data as { hits: Array<{ path: string }> }).hits;
    expect(hits.map((h) => h.path)).toEqual(['/mem/good.md']);
  });

  test('full-text read failing after scan → hit skipped via try/catch continue (line 122)', async () => {
    const fs = fakeFs({ '/mem/only.md': mdFile('user', 'O', 'only', 'body', Date.now()) });
    const tool = makeMemorySearchTool({ memoryDir: DIR, sandboxFs: fs });
    // scan calls readTextSync once (head read); the recall full-text read is the
    // 2nd read. Fail every read after the first so scan succeeds but the per-hit
    // readTextSync inside call() throws → hit is skipped (continue), hits == [].
    const realRead = fs.readTextSync.bind(fs);
    let reads = 0;
    fs.readTextSync = (p: string): string => {
      reads++;
      if (reads > 1) throw new Error('post-scan read failure');
      return realRead(p);
    };
    const res = await tool.call({ query: 'q' }, ctx());
    expect((res.data as { hits: unknown[] }).hits).toEqual([]);
  });

  test('honors injected selectFn ordering', async () => {
    const fs = fakeFs({
      '/mem/a.md': mdFile('user', 'A', 'da', 'aaa', 2000),
      '/mem/b.md': mdFile('user', 'B', 'db', 'bbb', 1000),
    });
    const tool = makeMemorySearchTool({ memoryDir: DIR, sandboxFs: fs, selectFn: async () => ['b.md'] });
    const res = await tool.call({ query: 'q' }, ctx());
    const hits = (res.data as { hits: Array<{ path: string }> }).hits;
    expect(hits.map((h) => h.path)).toEqual(['/mem/b.md']);
  });

  test('missing query defaults to empty string (no throw)', async () => {
    const fs = fakeFs({ '/mem/a.md': mdFile('user', 'A', 'd', 'body', Date.now()) });
    const tool = makeMemorySearchTool({ memoryDir: DIR, sandboxFs: fs });
    const res = await tool.call({} as never, ctx());
    expect((res.data as { hits: unknown[] }).hits).toHaveLength(1);
  });

  test('empty memory dir → no hits', async () => {
    const tool = makeMemorySearchTool({ memoryDir: DIR, sandboxFs: fakeFs() });
    const res = await tool.call({ query: 'q' }, ctx());
    expect((res.data as { hits: unknown[] }).hits).toEqual([]);
  });

  test('read-only predicates: isReadOnly + isConcurrencySafe true', () => {
    const tool = makeMemorySearchTool({ memoryDir: DIR, sandboxFs: fakeFs() });
    expect(tool.isReadOnly({} as never)).toBe(true);
    expect(tool.isConcurrencySafe({} as never)).toBe(true);
  });

  test('mapResult emits a tool.result CoreEvent with hit count (129-132)', () => {
    const tool = makeMemorySearchTool({ memoryDir: DIR, sandboxFs: fakeFs() });
    const ev = tool.mapResult({ hits: [{ path: 'a', content: 'c' }, { path: 'b', content: 'd' }] }, 'tu-9');
    expect(ev.type).toBe('tool.result');
    expect(ev.payload).toEqual({ toolUseId: 'tu-9', tool: MEMORY_SEARCH_TOOL, hits: 2 });
    expect(typeof ev.ts).toBe('number');
  });
});
