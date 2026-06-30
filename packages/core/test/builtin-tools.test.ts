/**
 * TOOLS tests — builtin tools pack (②).
 *
 * 用内存 stub 的 SandboxFs / TerminalManager 测每个工具：call 行为、谓词
 * (isReadOnly / isConcurrencySafe / isEnabled)、mapResult 形状。不打真 IO。
 */
import { test, expect, describe } from 'bun:test';
import type { SandboxFs, DirEnt, StatResult, TerminalManager, RunResult, RunOpts } from '../src/inject/types';
import type { ToolContext } from '../src/capability/types';
import { CoreEventType } from '../src/events/events';
import {
  builtinToolsPack,
  readFileTool,
  writeFileTool,
  editFileTool,
  bashTool,
  grepTool,
  globTool,
  globToRegExp,
} from '../src/capability/builtin-tools/index';

// ─── stub SandboxFs (内存树) ─────────────────────────────────────────────────

class MemFs implements SandboxFs {
  files = new Map<string, string>();
  mkdirCalls: Array<{ path: string; recursive?: boolean }> = [];
  madeDirs = new Set<string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.files.set(k, v);
  }

  private dirs(): Set<string> {
    const set = new Set<string>();
    for (const p of this.files.keys()) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return set;
  }

  readTextSync(path: string): string {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT ${path}`);
    return v;
  }
  writeTextSync(path: string, content: string): void {
    this.files.set(path, content);
  }
  mkdirSync(path: string, opts?: { recursive?: boolean }): void {
    this.mkdirCalls.push({ path, recursive: opts?.recursive });
    this.madeDirs.add(path);
  }
  existsSync(path: string): boolean {
    return this.files.has(path) || this.dirs().has(path) || this.madeDirs.has(path);
  }
  unlinkSync(path: string): void {
    this.files.delete(path);
  }
  renameSync(from: string, to: string): void {
    const v = this.readTextSync(from);
    this.files.set(to, v);
    this.files.delete(from);
  }
  statSync(path: string): StatResult {
    const isFile = this.files.has(path);
    const isDir = this.dirs().has(path);
    return {
      isFile,
      isDir,
      size: isFile ? (this.files.get(path) as string).length : 0,
      mtime: 0,
    };
  }
  readdirSync(path: string, opts?: { withFileTypes?: boolean }): string[] | DirEnt[] {
    const prefix = path === '' || path === '.' ? '' : path.replace(/\/$/, '') + '/';
    const childNames = new Set<string>();
    const dirNames = new Set<string>();
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const seg = rest.split('/')[0];
      if (seg === '') continue;
      if (rest.includes('/')) dirNames.add(seg);
      else childNames.add(seg);
    }
    const ents: DirEnt[] = [];
    for (const name of dirNames) ents.push({ name, isFile: false, isDir: true, isSymlink: false });
    for (const name of childNames) ents.push({ name, isFile: true, isDir: false, isSymlink: false });
    if (opts?.withFileTypes) return ents;
    return ents.map((e) => e.name);
  }
  async readText(path: string): Promise<string> {
    return this.readTextSync(path);
  }
  async writeText(path: string, content: string): Promise<void> {
    this.writeTextSync(path, content);
  }
  async readBytes(): Promise<Uint8Array> {
    throw new Error('not used');
  }
  async writeBytes(): Promise<void> {
    throw new Error('not used');
  }
  readStream(): ReadableStream<Uint8Array> {
    throw new Error('not used');
  }
  writeStream(): WritableStream<Uint8Array> {
    throw new Error('not used');
  }
}

// ─── stub TerminalManager ────────────────────────────────────────────────────

class StubTerminal implements TerminalManager {
  lastRun?: { cmd: string; args: string[]; opts?: RunOpts };
  result: RunResult = { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5 };
  throwOnRun?: Error;

  async run(cmd: string, args: string[], opts?: RunOpts): Promise<RunResult> {
    this.lastRun = { cmd, args, opts };
    if (this.throwOnRun) throw this.throwOnRun;
    return this.result;
  }
  stream(): AsyncIterable<never> {
    throw new Error('not used');
  }
  async runBackground(): Promise<never> {
    throw new Error('not used');
  }
  list(): never[] {
    return [];
  }
  async kill(): Promise<void> {}
  async killAll(): Promise<void> {}
}

// ─── ctx helper ──────────────────────────────────────────────────────────────

function ctxWith(extra: Record<string, unknown>, signal?: AbortSignal): ToolContext {
  return { signal: signal ?? new AbortController().signal, ...extra };
}

// ─── pack assembly ───────────────────────────────────────────────────────────

describe('builtinToolsPack', () => {
  test('is a builtin-layer pack including the core tools', () => {
    const pack = builtinToolsPack();
    expect(pack.layer).toBe('builtin');
    expect(pack.name).toBe('builtin-tools');
    const names = (pack.tools ?? []).map((t) => t.name);
    // 核心 6 件 + 007 后台 bash 配套(bash_output/kill_shell)。
    for (const n of ['bash', 'edit_file', 'glob', 'grep', 'read_file', 'write_file', 'bash_output', 'kill_shell']) {
      expect(names).toContain(n);
    }
  });

  test('every tool isEnabled() and exposes inputJSONSchema', () => {
    for (const t of builtinToolsPack().tools ?? []) {
      expect(t.isEnabled()).toBe(true);
      expect(t.inputJSONSchema).toBeDefined();
      expect(typeof t.maxResultSizeChars).toBe('number');
    }
  });
});

// ─── read_file ───────────────────────────────────────────────────────────────

describe('read_file', () => {
  test('predicates: read-only + concurrency-safe + maxResultSizeChars=Infinity', () => {
    const t = readFileTool();
    expect(t.isReadOnly({ file_path: '/a' })).toBe(true);
    expect(t.isConcurrencySafe({ file_path: '/a' })).toBe(true);
    expect(t.maxResultSizeChars).toBe(Infinity);
  });

  test('reads full file with line numbers', async () => {
    const fs = new MemFs({ '/a.txt': 'l1\nl2\nl3' });
    const t = readFileTool();
    const { data } = await t.call({ file_path: '/a.txt' }, ctxWith({ sandboxFs: fs }));
    expect(data.totalLines).toBe(3);
    expect(data.numLines).toBe(3);
    expect(data.content).toContain('1\tl1');
    expect(data.content).toContain('3\tl3');
  });

  test('honors offset + limit (1-based offset)', async () => {
    const fs = new MemFs({ '/a.txt': 'l1\nl2\nl3\nl4' });
    const t = readFileTool();
    const { data } = await t.call({ file_path: '/a.txt', offset: 2, limit: 2 }, ctxWith({ sandboxFs: fs }));
    expect(data.numLines).toBe(2);
    expect(data.content).toContain('2\tl2');
    expect(data.content).toContain('3\tl3');
    expect(data.content).not.toContain('l1');
    expect(data.content).not.toContain('l4');
  });

  test('mapResult → tool.result CoreEvent', async () => {
    const fs = new MemFs({ '/a.txt': 'hi' });
    const t = readFileTool();
    const { data } = await t.call({ file_path: '/a.txt' }, ctxWith({ sandboxFs: fs }));
    const ev = t.mapResult(data, 'tu_1');
    expect(ev.type).toBe(CoreEventType.ToolCallResult);
    expect((ev.payload as Record<string, unknown>).toolUseId).toBe('tu_1');
    expect((ev.payload as Record<string, unknown>).isError).toBe(false);
    expect(typeof ev.ts).toBe('number');
  });

  test('throws loud when sandboxFs missing from ctx', async () => {
    const t = readFileTool();
    await expect(t.call({ file_path: '/a' }, ctxWith({}))).rejects.toThrow(/sandboxFs is missing/);
  });
});

// ─── write_file ──────────────────────────────────────────────────────────────

describe('write_file', () => {
  test('predicates: NOT read-only / NOT concurrency-safe (fail-closed)', () => {
    const t = writeFileTool();
    expect(t.isReadOnly({ file_path: '/a', content: '' })).toBe(false);
    expect(t.isConcurrencySafe({ file_path: '/a', content: '' })).toBe(false);
    expect(t.isDestructive?.({ file_path: '/a', content: '' })).toBe(true);
  });

  test('creates a new file and reports created=true', async () => {
    const fs = new MemFs();
    const t = writeFileTool();
    const { data } = await t.call({ file_path: '/new.txt', content: 'hello' }, ctxWith({ sandboxFs: fs }));
    expect(data.created).toBe(true);
    expect(data.bytesWritten).toBe(5);
    expect(fs.files.get('/new.txt')).toBe('hello');
  });

  test('overwrites existing file and reports created=false', async () => {
    const fs = new MemFs({ '/x.txt': 'old' });
    const t = writeFileTool();
    const { data } = await t.call({ file_path: '/x.txt', content: 'new' }, ctxWith({ sandboxFs: fs }));
    expect(data.created).toBe(false);
    expect(fs.files.get('/x.txt')).toBe('new');
  });

  test('mapResult shape', async () => {
    const fs = new MemFs();
    const t = writeFileTool();
    const { data } = await t.call({ file_path: '/x', content: 'a' }, ctxWith({ sandboxFs: fs }));
    const ev = t.mapResult(data, 'tu_w');
    expect(ev.type).toBe(CoreEventType.ToolCallResult);
    expect((ev.payload as Record<string, unknown>).created).toBe(true);
  });

  // 回归(delivery=local 写盘缺陷修复):父目录不存在时先 mkdir -p,再写。
  test('creates missing parent dirs before writing (mkdir -p)', async () => {
    const fs = new MemFs();
    const t = writeFileTool();
    const { data } = await t.call(
      { file_path: '/games/spin-cube/src/e1.ts', content: '//ok' },
      ctxWith({ sandboxFs: fs }),
    );
    expect(data.created).toBe(true);
    expect(fs.files.get('/games/spin-cube/src/e1.ts')).toBe('//ok');
    // 父目录被 recursive mkdir 出来
    expect(fs.mkdirCalls).toContainEqual({ path: '/games/spin-cube/src', recursive: true });
  });

  test('does NOT mkdir when parent already exists', async () => {
    const fs = new MemFs({ '/games/g/src/existing.ts': 'x' }); // 使 /games/g/src 已存在
    const t = writeFileTool();
    await t.call({ file_path: '/games/g/src/new.ts', content: 'y' }, ctxWith({ sandboxFs: fs }));
    expect(fs.files.get('/games/g/src/new.ts')).toBe('y');
    expect(fs.mkdirCalls.length).toBe(0); // 父目录已在 → 不重复建
  });
});

// ─── edit_file ───────────────────────────────────────────────────────────────

describe('edit_file', () => {
  test('predicates: NOT read-only / NOT concurrency-safe', () => {
    const t = editFileTool();
    const i = { file_path: '/a', old_string: 'x', new_string: 'y' };
    expect(t.isReadOnly(i)).toBe(false);
    expect(t.isConcurrencySafe(i)).toBe(false);
  });

  test('replaces a unique occurrence', async () => {
    const fs = new MemFs({ '/c.txt': 'foo bar baz' });
    const t = editFileTool();
    const { data } = await t.call(
      { file_path: '/c.txt', old_string: 'bar', new_string: 'BAR' },
      ctxWith({ sandboxFs: fs }),
    );
    expect(data.replacements).toBe(1);
    expect(fs.files.get('/c.txt')).toBe('foo BAR baz');
  });

  test('throws when old_string not found', async () => {
    const fs = new MemFs({ '/c.txt': 'abc' });
    const t = editFileTool();
    await expect(
      t.call({ file_path: '/c.txt', old_string: 'zzz', new_string: 'y' }, ctxWith({ sandboxFs: fs })),
    ).rejects.toThrow(/not found/);
  });

  test('throws on ambiguous match without replace_all', async () => {
    const fs = new MemFs({ '/c.txt': 'a a a' });
    const t = editFileTool();
    await expect(
      t.call({ file_path: '/c.txt', old_string: 'a', new_string: 'b' }, ctxWith({ sandboxFs: fs })),
    ).rejects.toThrow(/not unique/);
  });

  test('replace_all replaces every occurrence', async () => {
    const fs = new MemFs({ '/c.txt': 'a a a' });
    const t = editFileTool();
    const { data } = await t.call(
      { file_path: '/c.txt', old_string: 'a', new_string: 'b', replace_all: true },
      ctxWith({ sandboxFs: fs }),
    );
    expect(data.replacements).toBe(3);
    expect(fs.files.get('/c.txt')).toBe('b b b');
  });

  test('throws when new_string === old_string', async () => {
    const fs = new MemFs({ '/c.txt': 'a' });
    const t = editFileTool();
    await expect(
      t.call({ file_path: '/c.txt', old_string: 'a', new_string: 'a' }, ctxWith({ sandboxFs: fs })),
    ).rejects.toThrow(/differ/);
  });
});

// ─── bash ────────────────────────────────────────────────────────────────────

describe('bash', () => {
  test('predicates: NOT read-only / NOT concurrency-safe / interrupt=cancel', () => {
    const t = bashTool();
    const i = { command: 'ls' };
    expect(t.isReadOnly(i)).toBe(false);
    expect(t.isConcurrencySafe(i)).toBe(false);
    expect(t.interruptBehavior?.()).toBe('cancel');
  });

  test('runs via injected TerminalManager.run with sh -c', async () => {
    const term = new StubTerminal();
    term.result = { exitCode: 0, stdout: 'hello', stderr: '', durationMs: 12 };
    const t = bashTool();
    const { data } = await t.call({ command: 'echo hello' }, ctxWith({ terminal: term }));
    expect(term.lastRun?.cmd).toBe('sh');
    expect(term.lastRun?.args).toEqual(['-c', 'echo hello']);
    expect(data.stdout).toBe('hello');
    expect(data.exitCode).toBe(0);
    expect(data.interrupted).toBe(false);
  });

  test('forwards timeout + cwd + signal as RunOpts', async () => {
    const term = new StubTerminal();
    const ac = new AbortController();
    const t = bashTool();
    await t.call({ command: 'x', timeout: 5000, cwd: '/tmp' }, ctxWith({ terminal: term }, ac.signal));
    expect(term.lastRun?.opts?.timeoutMs).toBe(5000);
    expect(term.lastRun?.opts?.cwd).toBe('/tmp');
    expect(term.lastRun?.opts?.signal).toBe(ac.signal);
  });

  test('aborted signal → interrupted result (not throw)', async () => {
    const term = new StubTerminal();
    term.throwOnRun = new Error('killed');
    const ac = new AbortController();
    ac.abort();
    const t = bashTool();
    const { data } = await t.call({ command: 'sleep 100' }, ctxWith({ terminal: term }, ac.signal));
    expect(data.interrupted).toBe(true);
    expect(data.exitCode).toBe(130);
  });

  test('mapResult: non-zero exit → isError true', async () => {
    const term = new StubTerminal();
    term.result = { exitCode: 1, stdout: '', stderr: 'boom', durationMs: 1 };
    const t = bashTool();
    const { data } = await t.call({ command: 'false' }, ctxWith({ terminal: term }));
    const ev = t.mapResult(data, 'tu_b');
    expect(ev.type).toBe(CoreEventType.ToolCallResult);
    expect((ev.payload as Record<string, unknown>).isError).toBe(true);
    expect((ev.payload as Record<string, unknown>).stderr).toBe('boom');
  });

  test('throws loud when terminal missing', async () => {
    const t = bashTool();
    await expect(t.call({ command: 'ls' }, ctxWith({}))).rejects.toThrow(/terminal is missing/);
  });
});

// ─── glob ────────────────────────────────────────────────────────────────────

describe('glob', () => {
  test('predicates: read-only + concurrency-safe', () => {
    const t = globTool();
    expect(t.isReadOnly({ pattern: '*' })).toBe(true);
    expect(t.isConcurrencySafe({ pattern: '*' })).toBe(true);
  });

  test('globToRegExp matches segments and **', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('a.js')).toBe(false);
    expect(globToRegExp('**/*.ts').test('a/b/c.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/x.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/sub/x.ts')).toBe(false);
    expect(globToRegExp('*.{ts,tsx}').test('a.tsx')).toBe(true);
  });

  test('finds matching files (relative-path glob), sorted absolute', async () => {
    const fs = new MemFs({
      '/proj/a.ts': '',
      '/proj/b.js': '',
      '/proj/sub/c.ts': '',
      '/proj/node_modules/dep.ts': '',
    });
    const t = globTool();
    const { data } = await t.call({ pattern: '**/*.ts', path: '/proj' }, ctxWith({ sandboxFs: fs }));
    // node_modules skipped; sorted
    expect(data.files).toEqual(['/proj/a.ts', '/proj/sub/c.ts']);
  });

  test('uses ctx.cwd when path omitted', async () => {
    const fs = new MemFs({ '/work/x.ts': '' });
    const t = globTool();
    const { data } = await t.call({ pattern: '*.ts' }, ctxWith({ sandboxFs: fs, cwd: '/work' }));
    expect(data.files).toEqual(['/work/x.ts']);
  });

  test('head_limit truncates', async () => {
    const fs = new MemFs({ '/p/a.ts': '', '/p/b.ts': '', '/p/c.ts': '' });
    const t = globTool();
    const { data } = await t.call({ pattern: '*.ts', path: '/p', head_limit: 2 }, ctxWith({ sandboxFs: fs }));
    expect(data.files).toHaveLength(2);
    expect(data.truncated).toBe(true);
  });

  test('mapResult shape', async () => {
    const fs = new MemFs({ '/p/a.ts': '' });
    const t = globTool();
    const { data } = await t.call({ pattern: '*.ts', path: '/p' }, ctxWith({ sandboxFs: fs }));
    const ev = t.mapResult(data, 'tu_g');
    expect(ev.type).toBe(CoreEventType.ToolCallResult);
    expect((ev.payload as Record<string, unknown>).count).toBe(1);
  });
});

// ─── grep ────────────────────────────────────────────────────────────────────

describe('grep', () => {
  test('predicates: read-only + concurrency-safe', () => {
    const t = grepTool();
    expect(t.isReadOnly({ pattern: 'x' })).toBe(true);
    expect(t.isConcurrencySafe({ pattern: 'x' })).toBe(true);
  });

  test('default mode files_with_matches', async () => {
    const fs = new MemFs({ '/p/a.txt': 'has TODO here', '/p/b.txt': 'nothing', '/p/c.txt': 'TODO again' });
    const t = grepTool();
    const { data } = await t.call({ pattern: 'TODO', path: '/p' }, ctxWith({ sandboxFs: fs }));
    expect(data.mode).toBe('files_with_matches');
    expect(data.files).toEqual(['/p/a.txt', '/p/c.txt']);
  });

  test('content mode returns matching lines with line numbers', async () => {
    const fs = new MemFs({ '/p/a.txt': 'l1\nfind me\nl3\nfind me too' });
    const t = grepTool();
    const { data } = await t.call(
      { pattern: 'find', path: '/p', output_mode: 'content' },
      ctxWith({ sandboxFs: fs }),
    );
    expect(data.mode).toBe('content');
    expect(data.matches).toHaveLength(2);
    expect(data.matches?.[0]).toEqual({ file: '/p/a.txt', lineNumber: 2, line: 'find me' });
    expect(data.matches?.[1].lineNumber).toBe(4);
  });

  test('count mode tallies per file', async () => {
    const fs = new MemFs({ '/p/a.txt': 'x\nx\ny', '/p/b.txt': 'x' });
    const t = grepTool();
    const { data } = await t.call(
      { pattern: 'x', path: '/p', output_mode: 'count' },
      ctxWith({ sandboxFs: fs }),
    );
    expect(data.mode).toBe('count');
    expect(data.counts).toEqual([
      { file: '/p/a.txt', count: 2 },
      { file: '/p/b.txt', count: 1 },
    ]);
  });

  test('case-insensitive flag -i', async () => {
    const fs = new MemFs({ '/p/a.txt': 'Hello World' });
    const t = grepTool();
    const { data } = await t.call(
      { pattern: 'hello', path: '/p', '-i': true },
      ctxWith({ sandboxFs: fs }),
    );
    expect(data.files).toEqual(['/p/a.txt']);
  });

  test('glob filter narrows files', async () => {
    const fs = new MemFs({ '/p/a.ts': 'match', '/p/b.md': 'match' });
    const t = grepTool();
    const { data } = await t.call(
      { pattern: 'match', path: '/p', glob: '*.ts' },
      ctxWith({ sandboxFs: fs }),
    );
    expect(data.files).toEqual(['/p/a.ts']);
  });

  test('searches a single file when path is a file', async () => {
    const fs = new MemFs({ '/p/only.txt': 'needle\nhaystack' });
    const t = grepTool();
    const { data } = await t.call(
      { pattern: 'needle', path: '/p/only.txt', output_mode: 'content' },
      ctxWith({ sandboxFs: fs }),
    );
    expect(data.matches).toHaveLength(1);
    expect(data.matches?.[0].file).toBe('/p/only.txt');
  });

  test('invalid regex throws', async () => {
    const fs = new MemFs({ '/p/a.txt': 'x' });
    const t = grepTool();
    await expect(
      t.call({ pattern: '(', path: '/p' }, ctxWith({ sandboxFs: fs })),
    ).rejects.toThrow(/invalid pattern/);
  });

  test('mapResult shape per mode', async () => {
    const fs = new MemFs({ '/p/a.txt': 'k' });
    const t = grepTool();
    const { data } = await t.call({ pattern: 'k', path: '/p' }, ctxWith({ sandboxFs: fs }));
    const ev = t.mapResult(data, 'tu_grep');
    expect(ev.type).toBe(CoreEventType.ToolCallResult);
    expect((ev.payload as Record<string, unknown>).mode).toBe('files_with_matches');
    expect((ev.payload as Record<string, unknown>).count).toBe(1);
  });
});
