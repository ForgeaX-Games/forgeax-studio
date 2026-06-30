/**
 * Auto-memory tests:auto recall(per-turn 注入)+
 * auto extract(done 后台抽取)+ provider-backed selectFn,以及 loop 集成。
 */
import { test, expect, describe } from 'bun:test';
import { AutoMemory, makeProviderSelectFn } from '../src/capability/memory/auto';
import { CoreAgent, type AutoMemoryHook } from '../src/agent/agent';
import type { SandboxFs, DirEnt } from '../src/inject/types';
import type { AgentContext } from '../src/agent/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

/** 极简内存 SandboxFs(平铺目录)。 */
class MemFs {
  files = new Map<string, { content: string; mtime: number }>();
  set(path: string, content: string, mtime = 1): void {
    this.files.set(path, { content, mtime });
  }
  existsSync(p: string): boolean {
    return this.files.has(p) || [...this.files.keys()].some((k) => k.startsWith(p.replace(/\/$/, '') + '/'));
  }
  mkdirSync(): void {}
  writeTextSync(p: string, c: string): void {
    this.files.set(p, { content: c, mtime: 999 });
  }
  readTextSync(p: string): string {
    const f = this.files.get(p);
    if (!f) throw new Error('ENOENT ' + p);
    return f.content;
  }
  statSync(p: string): { isFile: boolean; isDir: boolean; size: number; mtime: number } {
    const f = this.files.get(p);
    return { isFile: true, isDir: false, size: f?.content.length ?? 0, mtime: f?.mtime ?? 0 };
  }
  readdirSync(dir: string, opts?: { withFileTypes?: boolean }): string[] | DirEnt[] {
    const prefix = dir.replace(/\/$/, '') + '/';
    const names = [...this.files.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .filter((n) => !n.includes('/'));
    if (opts?.withFileTypes) return names.map((name) => ({ name, isFile: true, isDir: false, isSymlink: false }));
    return names;
  }
}
const asFs = (m: MemFs): SandboxFs => m as unknown as SandboxFs;

const DIR = '/mem';
function seed(): MemFs {
  const m = new MemFs();
  m.set(`${DIR}/foo.md`, `---\nname: Foo\ndescription: about foo\ntype: user\n---\nfoo body here`, 10);
  m.set(`${DIR}/bar.md`, `---\nname: Bar\ndescription: about bar\ntype: project\n---\nbar body here`, 20);
  return m;
}

function jsonProvider(json: string): LLMProvider {
  return {
    api: 'stub',
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: json }] }, usage: EMPTY_USAGE as Usage, stopReason: 'end_turn' };
    },
  };
}

describe('auto recall', () => {
  test('selectFn-picked memory injected as a system-reminder', async () => {
    const fs = seed();
    const am = new AutoMemory({ memoryDir: DIR, sandboxFs: asFs(fs), selectFn: async () => ['foo.md'] });
    const out = await am.recall('tell me about foo');
    expect(out).toContain('<system-reminder>');
    expect(out).toContain('foo body here');
    expect(out).toContain('Memory ('); // freshness header
  });

  test('surfaced dedup: second recall does not re-surface the same file', async () => {
    const fs = seed();
    const am = new AutoMemory({ memoryDir: DIR, sandboxFs: asFs(fs), selectFn: async () => ['foo.md'] });
    await am.recall('q1');
    const out2 = await am.recall('q2'); // foo already surfaced → selectFn only sees bar (which it won't pick)
    expect(out2 == null || !out2.includes('foo body here')).toBe(true);
  });

  test('no selectFn → falls back to newest, never empty when memories exist', async () => {
    const fs = seed();
    const am = new AutoMemory({ memoryDir: DIR, sandboxFs: asFs(fs) });
    const out = await am.recall('anything');
    expect(out).toContain('bar body here'); // bar mtime=20 newest
  });

  test('missing dir → null (no crash)', async () => {
    const am = new AutoMemory({ memoryDir: '/nope', sandboxFs: asFs(new MemFs()) });
    expect(await am.recall('q')).toBeNull();
  });
});

describe('auto extract', () => {
  test('writes extracted memory files + rebuilds index', async () => {
    const fs = new MemFs();
    const provider = jsonProvider(JSON.stringify({ memories: [{ type: 'user', name: 'Likes Dark Mode', description: 'pref', body: 'user prefers dark mode' }] }));
    const am = new AutoMemory({ memoryDir: DIR, sandboxFs: asFs(fs), provider, model: 'm' });
    await am.extract([{ role: 'user', content: 'I prefer dark mode' }]);
    const written = [...fs.files.keys()];
    expect(written.some((p) => p.endsWith('likes-dark-mode.md'))).toBe(true);
    expect(written.some((p) => p.endsWith('/MEMORY.md'))).toBe(true);
    expect(fs.readTextSync(`${DIR}/likes-dark-mode.md`)).toContain('user prefers dark mode');
  });

  test('throttle: extractEveryNTurns=2 skips the first call', async () => {
    const fs = new MemFs();
    const provider = jsonProvider(JSON.stringify({ memories: [{ type: 'user', name: 'X', description: 'd', body: 'b' }] }));
    const am = new AutoMemory({ memoryDir: DIR, sandboxFs: asFs(fs), provider, model: 'm', extractEveryNTurns: 2 });
    await am.extract([{ role: 'user', content: 'a' }]);
    expect(fs.files.size).toBe(0); // throttled
    await am.extract([{ role: 'user', content: 'b' }]);
    expect([...fs.files.keys()].some((p) => p.endsWith('x.md'))).toBe(true);
  });

  test('no provider → no-op', async () => {
    const fs = new MemFs();
    const am = new AutoMemory({ memoryDir: DIR, sandboxFs: asFs(fs) });
    await am.extract([{ role: 'user', content: 'a' }]);
    expect(fs.files.size).toBe(0);
  });

  test('write-gate: extracted name cannot escape the memory dir', async () => {
    const fs = new MemFs();
    const provider = jsonProvider(JSON.stringify({ memories: [{ type: 'user', name: '../../etc/passwd', description: 'd', body: 'evil' }] }));
    const am = new AutoMemory({ memoryDir: DIR, sandboxFs: asFs(fs), provider, model: 'm' });
    await am.extract([{ role: 'user', content: 'x' }]);
    // slug strips path chars → stays inside DIR; no escape
    expect([...fs.files.keys()].every((p) => p.startsWith(DIR))).toBe(true);
  });
});

describe('makeProviderSelectFn', () => {
  test('parses {"selected":[...]} from provider (incl `json fence)', async () => {
    const provider = jsonProvider('`json\n{"selected":["a.md","b.md"]}\n`');
    const fn = makeProviderSelectFn(provider, 'm');
    expect(await fn('manifest', 'q')).toEqual(['a.md', 'b.md']);
  });
});

describe('loop integration', () => {
  function ctx(): AgentContext {
    return {
      agentId: 'a',
      provider: jsonProvider('all done'),
      config: { systemPromptSlots: [], model: 'm', tools: [], maxTurns: 4 },
      toolContext: {},
    };
  }
  test('CoreAgent calls recall once and extract on completed', async () => {
    let recalls = 0;
    let extracts = 0;
    const spy: AutoMemoryHook = {
      async recall() {
        recalls++;
        return '<system-reminder>mem</system-reminder>';
      },
      async extract() {
        extracts++;
      },
    };
    const agent = new CoreAgent({ context: ctx(), autoMemory: spy });
    for await (const _ of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) {
      /* drain */
    }
    await agent.drainAutoMemory();
    expect(recalls).toBe(1);
    expect(extracts).toBe(1);
  });
});
