/**
 * PLUGIN 验证用例 —— 补 manifest.ts / loader.ts / plugin/index.ts 未覆盖颗粒:
 *   manifest: validateComponentDecl 三态 (空串/坏数组项/非法类型/对象映射)、
 *     validateServersDecl (空串/坏数组项/非法类型/inline-map)、author 非对象/
 *     字段非串、description 非串、version 非串、非对象 raw。
 *   loader: ENOENT 源目录跳过 / readdir 其它错、坏 JSON manifest、validate 失败、
 *     declared 路径不存在记错、.mcp.json + manifest inline mcpServers 合并、
 *     lspServers (无默认探测)、hooks.json (wrapper / bare / 坏 JSON / 非对象 /
 *     event 非数组)、legacy components 约束默认目录、mergePluginSources 优先级。
 *   index: pluginToCapabilityPack —— 有 hooks 时 start 订阅 EventBus、publish 触发
 *     runHook、dispose 退订、runHook throw fail-soft、无 hooks 不挂 plugin、
 *     layer 由 source 派生。
 *
 * 用临时目录造 plugin.json + 组件子目录;EventBus 用真实 core 实现。
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateManifest,
  loadPlugins,
  mergePluginSources,
  pluginToCapabilityPack,
  type LoadedPlugin,
  type PluginSource,
} from '../src/capability/plugin';
import { EventBus } from '../src/events/event-bus';
import type { CoreEvent } from '../src/events/types';

// ─── temp scaffolding ──────────────────────────────────────────────────────

let ROOT: string;
beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'fx-plugin-cases-'));
});
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let counter = 0;
/** Materialize a source dir holding one plugin <name>/, with given files. */
function mkPlugin(
  manifest: unknown,
  files: Record<string, string> = {},
): { source: PluginSource; pluginDir: string } {
  const srcDir = join(ROOT, `src-${counter++}`);
  const name =
    typeof manifest === 'object' && manifest !== null && 'name' in manifest
      ? String((manifest as any).name)
      : 'unnamed';
  const pluginDir = join(srcDir, name === 'unnamed' ? `p${counter}` : name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(pluginDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return { source: { source: 'builtin', dir: srcDir }, pluginDir };
}

// ─── manifest: component / server decl error branches ─────────────────────────

describe('validateManifest — component & server decl branches', () => {
  test('component decl: empty string / bad array entry / wrong type / object-map', () => {
    expect(validateManifest({ name: 'a', commands: '' }).ok).toBe(false);
    expect(validateManifest({ name: 'a', agents: ['ok', ''] }).ok).toBe(false);
    expect(validateManifest({ name: 'a', skills: 123 }).ok).toBe(false);
    // object mapping arm is accepted (structurally opaque)
    const v = validateManifest({ name: 'a', commands: { greet: './c/greet.md' } });
    expect(v.ok).toBe(true);
  });

  test('servers decl: empty string / array w/ bad entry / wrong type / inline map', () => {
    expect(validateManifest({ name: 'a', mcpServers: '' }).ok).toBe(false);
    expect(validateManifest({ name: 'a', mcpServers: ['./x.json', 5] }).ok).toBe(false);
    expect(validateManifest({ name: 'a', mcpServers: ['./x.json', ''] }).ok).toBe(false);
    expect(validateManifest({ name: 'a', lspServers: 42 }).ok).toBe(false);
    expect(
      validateManifest({ name: 'a', mcpServers: { srv: { command: 'x' } } }).ok,
    ).toBe(true);
    expect(
      validateManifest({ name: 'a', mcpServers: ['./a.json', { srv: {} }] }).ok,
    ).toBe(true);
  });

  test('author/description/version type errors', () => {
    expect(validateManifest({ name: 'a', author: 'nope' }).ok).toBe(false);
    expect(validateManifest({ name: 'a', author: { name: 5 } }).ok).toBe(false);
    expect(validateManifest({ name: 'a', description: 9 }).ok).toBe(false);
    expect(validateManifest({ name: 'a', version: 9 }).ok).toBe(false);
    expect(validateManifest({ name: 'a', version: 'x.y' }).ok).toBe(false);
  });

  test('raw not an object / array / null → single structural error', () => {
    for (const bad of [null, 42, 'str', ['x']]) {
      const v = validateManifest(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.errors).toEqual(['plugin.json must be a JSON object']);
    }
  });

  test('legacy components: non-array / unknown kind rejected; dedup preserved', () => {
    expect(validateManifest({ name: 'a', components: 'commands' }).ok).toBe(false);
    expect(validateManifest({ name: 'a', components: ['bogus'] }).ok).toBe(false);
    const v = validateManifest({ name: 'a', components: ['commands', 'commands', 'hooks'] });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.manifest.components).toEqual(['commands', 'hooks']);
  });

  test('unknown top-level keys tolerated into extra', () => {
    const v = validateManifest({ name: 'a', vendorThing: { x: 1 } });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.manifest.extra).toMatchObject({ vendorThing: { x: 1 } });
  });
});

// ─── loader: error / path-not-exist branches ──────────────────────────────────

describe('loadPlugins — error & discovery branches', () => {
  test('missing source dir → skipped quietly (no errors)', () => {
    const res = loadPlugins([{ source: 'builtin', dir: join(ROOT, 'does-not-exist') }]);
    expect(res.plugins).toEqual([]);
    expect(res.errors).toEqual([]);
  });

  test('invalid JSON manifest → recorded error, plugin skipped', () => {
    const srcDir = join(ROOT, 'bad-json');
    const pd = join(srcDir, 'p');
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, 'plugin.json'), '{ not json ');
    const res = loadPlugins([{ source: 'builtin', dir: srcDir }]);
    expect(res.plugins).toEqual([]);
    expect(res.errors.some((e) => e.reason.includes('invalid JSON'))).toBe(true);
  });

  test('manifest validation failure → recorded error', () => {
    const { source } = mkPlugin({ name: 'Bad Name' });
    const res = loadPlugins([source]);
    expect(res.plugins).toEqual([]);
    expect(res.errors.some((e) => e.reason.includes('name:'))).toBe(true);
  });

  test('dir without plugin.json → silently skipped (not an error)', () => {
    const srcDir = join(ROOT, 'no-manifest');
    mkdirSync(join(srcDir, 'justdir'), { recursive: true });
    const res = loadPlugins([{ source: 'builtin', dir: srcDir }]);
    expect(res.plugins).toEqual([]);
    expect(res.errors).toEqual([]);
  });

  test('declared component path not found → error recorded', () => {
    const { source } = mkPlugin({ name: 'p-missing', commands: './ghost' });
    const res = loadPlugins([source]);
    expect(res.errors.some((e) => e.reason.includes('declared component path not found'))).toBe(true);
  });

  test('default dirs auto-discovered; componentKinds reflects present', () => {
    const { source } = mkPlugin(
      { name: 'p-comps' },
      {
        'commands/c.md': '# c',
        'skills/s/SKILL.md': '---\ndescription: d\n---\nbody',
      },
    );
    const res = loadPlugins([source]);
    const p = res.plugins[0]!;
    expect(p.commandsPath).toBeDefined();
    expect(p.skillsPath).toBeDefined();
    expect(new Set(p.componentKinds)).toEqual(new Set(['commands', 'skills']));
  });

  test('legacy components constrains which default dirs are probed', () => {
    const { source } = mkPlugin(
      { name: 'p-legacy', components: ['commands'] },
      { 'commands/c.md': '# c', 'agents/a.md': '# a' },
    );
    const res = loadPlugins([source]);
    const p = res.plugins[0]!;
    expect(p.commandsPath).toBeDefined();
    // agents/ exists on disk but is NOT probed (legacy constraint)
    expect(p.agentsPath).toBeUndefined();
  });

  test('mcp: .mcp.json default merged with manifest inline (inline wins on collision)', () => {
    const { source } = mkPlugin(
      { name: 'p-mcp', mcpServers: { shared: { command: 'inline' } } },
      { '.mcp.json': JSON.stringify({ mcpServers: { shared: { command: 'file' }, only: { command: 'f' } } }) },
    );
    const res = loadPlugins([source]);
    const p = res.plugins[0]!;
    expect(p.mcpServers?.shared).toMatchObject({ command: 'inline' });
    expect(p.mcpServers?.only).toMatchObject({ command: 'f' });
  });

  test('mcp from declared json-file path string', () => {
    const { source } = mkPlugin(
      { name: 'p-mcpfile', mcpServers: './servers.json' },
      { 'servers.json': JSON.stringify({ srv: { command: 'x' } }) }, // bare map, no wrapper
    );
    const res = loadPlugins([source]);
    expect(res.plugins[0]!.mcpServers?.srv).toMatchObject({ command: 'x' });
  });

  test('lsp servers: inline map resolved (no default-file probe)', () => {
    const { source } = mkPlugin({ name: 'p-lsp', lspServers: { ls: { command: 'lsp' } } });
    const res = loadPlugins([source]);
    expect(res.plugins[0]!.lspServers?.ls).toMatchObject({ command: 'lsp' });
  });

  test('lsp servers: from declared json-file path (wrapper shape)', () => {
    const { source } = mkPlugin(
      { name: 'p-lspfile', lspServers: './lsp.json' },
      { 'lsp.json': JSON.stringify({ lspServers: { gopls: { command: 'gopls' } } }) },
    );
    const res = loadPlugins([source]);
    expect(res.plugins[0]!.lspServers?.gopls).toMatchObject({ command: 'gopls' });
  });

  test('component decl object-mapping: leaves + {source} extracted to discovered paths', () => {
    const { source } = mkPlugin(
      {
        name: 'p-map',
        commands: { greet: './cmds/greet.md', help: { source: './cmds/help.md' } },
      },
      { 'cmds/greet.md': '# g', 'cmds/help.md': '# h' },
    );
    const res = loadPlugins([source]);
    const p = res.plugins[0]!;
    // both declared leaves resolved (no "not found" errors for them)
    expect(res.errors).toEqual([]);
    expect(p.commandsPaths?.length).toBe(2);
  });

  test('hooks.json wrapper shape parsed; actions normalized', () => {
    const { source } = mkPlugin(
      { name: 'p-hooks' },
      {
        'hooks/hooks.json': JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo a', if: 'Bash(*)', timeout: 5 }] },
            ],
          },
        }),
      },
    );
    const res = loadPlugins([source]);
    const cfg = res.plugins[0]!.hooksConfig!;
    expect(cfg.PreToolUse[0]).toMatchObject({ matcher: 'Bash' });
    expect(cfg.PreToolUse[0].hooks[0]).toMatchObject({ command: 'echo a', if: 'Bash(*)', timeout: 5 });
  });

  test('hooks.json bare shape + non-command action dropped + non-array event errors', () => {
    const { source } = mkPlugin(
      { name: 'p-hooks2' },
      {
        'hooks/hooks.json': JSON.stringify({
          Stop: [{ hooks: [{ type: 'command', command: 'ok' }, { type: 'noncommand' }, 'junk'] }],
          BadEvent: 'not-an-array',
        }),
      },
    );
    const res = loadPlugins([source]);
    const cfg = res.plugins[0]!.hooksConfig!;
    expect(cfg.Stop[0].hooks).toHaveLength(1); // only the command action survives
    expect(res.errors.some((e) => e.reason.includes('must be an array of matcher groups'))).toBe(true);
  });

  test('hooks.json invalid JSON → error recorded, no hooksConfig', () => {
    const { source } = mkPlugin({ name: 'p-hooks3' }, { 'hooks/hooks.json': '{bad' });
    const res = loadPlugins([source]);
    expect(res.plugins[0]!.hooksConfig).toBeUndefined();
    expect(res.errors.some((e) => e.reason.includes('invalid JSON'))).toBe(true);
  });
});

// ─── mergePluginSources precedence ────────────────────────────────────────────

describe('mergePluginSources — session > marketplace > builtin', () => {
  const mk = (name: string, source: LoadedPlugin['source']): LoadedPlugin => ({
    name,
    manifest: { name },
    path: `/p/${name}`,
    source,
    enabled: true,
    componentKinds: [],
  });

  test('higher precedence overrides same-name lower; result alpha-sorted', () => {
    const merged = mergePluginSources({
      builtin: [mk('shared', 'builtin'), mk('zb', 'builtin')],
      marketplace: [mk('shared', 'marketplace')],
      session: [mk('shared', 'session'), mk('as', 'session')],
    });
    expect(merged.map((p) => p.name)).toEqual(['as', 'shared', 'zb']);
    expect(merged.find((p) => p.name === 'shared')!.source).toBe('session');
  });

  test('empty buckets → empty list', () => {
    expect(mergePluginSources({})).toEqual([]);
  });
});

// ─── pluginToCapabilityPack — hooks → EventBus side effects ────────────────────

describe('pluginToCapabilityPack — hooks wiring', () => {
  const loadedWithHooks = (
    source: LoadedPlugin['source'] = 'builtin',
  ): LoadedPlugin => ({
    name: 'hp',
    manifest: { name: 'hp' },
    path: '/p/hp',
    source,
    enabled: true,
    componentKinds: ['hooks'],
    hooksConfig: {
      'tool.start': [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
    },
  });

  function evt(type: string): CoreEvent {
    return { type, payload: {}, ts: 0, source: 'test' };
  }

  test('start subscribes; matching publish invokes runHook; dispose unsubscribes', async () => {
    const bus = new EventBus();
    const calls: Array<{ name: string; n: number }> = [];
    const pack = pluginToCapabilityPack(loadedWithHooks(), bus, {
      runHook: (name, _e, actions) => calls.push({ name, n: actions.length }),
    });
    expect(pack.plugins).toHaveLength(1);

    const dispose = await pack.plugins![0].start({});
    bus.publish(evt('tool.start'));
    bus.publish(evt('other.event')); // no subscription → ignored
    expect(calls).toEqual([{ name: 'hp', n: 1 }]);

    dispose();
    bus.publish(evt('tool.start')); // after dispose → no further calls
    expect(calls).toHaveLength(1);
  });

  test('runHook that throws is swallowed (fail-soft, bus keeps propagating)', async () => {
    const bus = new EventBus();
    let downstream = 0;
    const pack = pluginToCapabilityPack(loadedWithHooks(), bus, {
      runHook: () => {
        throw new Error('hook boom');
      },
    });
    await pack.plugins![0].start({});
    bus.subscribe('tool.start', () => {
      downstream++;
    });
    expect(() => bus.publish(evt('tool.start'))).not.toThrow();
    expect(downstream).toBe(1); // propagation reached the later subscriber
  });

  test('no hooks → no plugins attached', () => {
    const loaded: LoadedPlugin = {
      name: 'np',
      manifest: { name: 'np' },
      path: '/p/np',
      source: 'session',
      enabled: true,
      componentKinds: [],
    };
    const pack = pluginToCapabilityPack(loaded, new EventBus());
    expect(pack.plugins).toBeUndefined();
  });

  test('layer derived from source (builtin→builtin, marketplace→user, session→session)', () => {
    const bus = new EventBus();
    expect(pluginToCapabilityPack(loadedWithHooks('builtin'), bus).layer).toBe('builtin');
    expect(pluginToCapabilityPack(loadedWithHooks('marketplace'), bus).layer).toBe('user');
    expect(pluginToCapabilityPack(loadedWithHooks('session'), bus).layer).toBe('session');
  });

  test('default runHook (no opts) is a no-op; start/dispose still work', async () => {
    const bus = new EventBus();
    const pack = pluginToCapabilityPack(loadedWithHooks(), bus);
    const dispose = await pack.plugins![0].start({});
    expect(() => bus.publish(evt('tool.start'))).not.toThrow();
    dispose();
  });
});
