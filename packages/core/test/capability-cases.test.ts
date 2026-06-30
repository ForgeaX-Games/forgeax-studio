/**
 * Capability host (CapabilityRegistry) 验证用例 —— 补 registry.ts 未覆盖颗粒:
 *   - registerSlot/findSlot/removeSlot/listSlots (注册序)
 *   - registerPlugin/findPlugin/removePlugin/listPlugins (注册序)
 *   - assembleToolPool 的 filterDisabled / extra / deny 各分支
 *   - alias 查找 + alias-vs-主名 冲突 (首注册赢、不抢主名)
 *
 * 覆盖: findToolByName (name+alias)、assembleToolPool (builtin 段 +
 * extra 段、uniqBy builtin 胜)、filterToolsByDenyRules。
 *
 * 纯内存索引,无 IO。buildTool 造工具,字面 obj 造 slot/plugin。
 */
import { test, expect, describe } from 'bun:test';
import { CapabilityRegistry } from '../src/capability/registry';
import { buildTool } from '../src/capability/types';
import type { AgentTool, Slot, Plugin } from '../src/capability/types';

// ─── helpers ───────────────────────────────────────────────────────────────

function mkTool(
  name: string,
  opts: {
    aliases?: string[];
    enabled?: boolean;
    enabledThrows?: boolean;
    mcpServer?: string;
  } = {},
): AgentTool {
  return buildTool({
    name,
    ...(opts.aliases ? { aliases: opts.aliases } : {}),
    ...(opts.mcpServer
      ? { isMcp: true, mcpInfo: { serverName: opts.mcpServer, toolName: name } }
      : {}),
    maxResultSizeChars: 1000,
    isEnabled: () => {
      if (opts.enabledThrows) throw new Error('boom');
      return opts.enabled ?? true;
    },
    async call() {
      return { data: undefined };
    },
    mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0, source: name }),
  });
}

function mkSlot(name: string): Slot {
  return { name, render: () => `slot:${name}` };
}

function mkPlugin(name: string): Plugin {
  return { name, start: () => () => {} };
}

// ─── slots ──────────────────────────────────────────────────────────────────

describe('CapabilityRegistry — slots', () => {
  test('register/find/list keeps registration order; re-register replaces in place', () => {
    const r = new CapabilityRegistry();
    r.registerSlot(mkSlot('b'));
    r.registerSlot(mkSlot('a'));
    expect(r.listSlots().map((s) => s.name)).toEqual(['b', 'a']);
    expect(r.findSlot('a')?.name).toBe('a');
    expect(r.findSlot('missing')).toBeUndefined();

    // re-register same name: replaced, order unchanged (no dup in order list)
    const replacement = mkSlot('b');
    r.registerSlot(replacement);
    expect(r.findSlot('b')).toBe(replacement);
    expect(r.listSlots().map((s) => s.name)).toEqual(['b', 'a']);
  });

  test('removeSlot drops from index + order; removing unknown is a no-op', () => {
    const r = new CapabilityRegistry();
    r.registerSlot(mkSlot('a'));
    r.registerSlot(mkSlot('b'));
    r.removeSlot('a');
    expect(r.findSlot('a')).toBeUndefined();
    expect(r.listSlots().map((s) => s.name)).toEqual(['b']);
    // unknown removal: no throw, no change
    r.removeSlot('nope');
    expect(r.listSlots().map((s) => s.name)).toEqual(['b']);
  });
});

// ─── plugins ──────────────────────────────────────────────────────────────────

describe('CapabilityRegistry — plugins', () => {
  test('register/find/list keeps registration order; re-register replaces', () => {
    const r = new CapabilityRegistry();
    r.registerPlugin(mkPlugin('p2'));
    r.registerPlugin(mkPlugin('p1'));
    expect(r.listPlugins().map((p) => p.name)).toEqual(['p2', 'p1']);
    expect(r.findPlugin('p1')?.name).toBe('p1');
    expect(r.findPlugin('missing')).toBeUndefined();

    const repl = mkPlugin('p2');
    r.registerPlugin(repl);
    expect(r.findPlugin('p2')).toBe(repl);
    expect(r.listPlugins().map((p) => p.name)).toEqual(['p2', 'p1']);
  });

  test('removePlugin drops from index + order; unknown is no-op', () => {
    const r = new CapabilityRegistry();
    r.registerPlugin(mkPlugin('p1'));
    r.registerPlugin(mkPlugin('p2'));
    r.removePlugin('p1');
    expect(r.findPlugin('p1')).toBeUndefined();
    expect(r.listPlugins().map((p) => p.name)).toEqual(['p2']);
    r.removePlugin('nope');
    expect(r.listPlugins().map((p) => p.name)).toEqual(['p2']);
  });
});

// ─── tools: alias find + conflict ─────────────────────────────────────────────

describe('CapabilityRegistry — tool alias find / conflict', () => {
  test('findTool resolves by alias; alias never shadows an existing primary name', () => {
    const r = new CapabilityRegistry();
    const real = mkTool('Read');
    const aliased = mkTool('Grep', { aliases: ['Read', 'Search'] });
    r.registerTool(real);
    r.registerTool(aliased);

    // alias "Read" collides with existing primary → primary wins
    expect(r.findTool('Read')).toBe(real);
    // free alias "Search" resolves to its tool
    expect(r.findTool('Search')).toBe(aliased);
    expect(r.findTool('Grep')).toBe(aliased);
    expect(r.findTool('none')).toBeUndefined();
    expect(r.hasTool('Search')).toBe(true);
    expect(r.hasTool('none')).toBe(false);
  });

  test('first-registered alias wins; removeTool clears its aliases', () => {
    const r = new CapabilityRegistry();
    const a = mkTool('A', { aliases: ['shared'] });
    const b = mkTool('B', { aliases: ['shared'] });
    r.registerTool(a);
    r.registerTool(b);
    // alias "shared" was claimed by A first → stays pointing at A
    expect(r.findTool('shared')).toBe(a);

    r.removeTool('A');
    // A and its alias gone; "shared" no longer resolves (B never re-claimed it)
    expect(r.findTool('A')).toBeUndefined();
    expect(r.findTool('shared')).toBeUndefined();
    expect(r.listTools().map((t) => t.name)).toEqual(['B']);
    // removing unknown tool is a no-op
    r.removeTool('ghost');
    expect(r.listTools().map((t) => t.name)).toEqual(['B']);
  });
});

// ─── assembleToolPool ─────────────────────────────────────────────────────────

describe('CapabilityRegistry — assembleToolPool', () => {
  test('no builtin/extra → sorts all registry tools by name (one builtin segment)', () => {
    const r = new CapabilityRegistry();
    r.registerTool(mkTool('Zed'));
    r.registerTool(mkTool('Alpha'));
    const pool = r.assembleToolPool();
    expect(pool.map((t) => t.name)).toEqual(['Alpha', 'Zed']);
  });

  test('builtin segment precedes extra; each sorted; builtin wins name collision (uniqBy)', () => {
    const r = new CapabilityRegistry();
    const builtinRead = mkTool('Read');
    const extraRead = mkTool('Read', { mcpServer: 'srv' }); // same name, must lose
    const pool = r.assembleToolPool({
      builtin: [mkTool('Write'), builtinRead],
      extra: [mkTool('mcp__srv__x'), extraRead],
    });
    // builtin sorted [Read, Write] then extra sorted, Read deduped to builtin copy
    expect(pool.map((t) => t.name)).toEqual(['Read', 'Write', 'mcp__srv__x']);
    expect(pool.find((t) => t.name === 'Read')).toBe(builtinRead);
  });

  test('filterDisabled=true drops isEnabled()===false; throwing predicate is fail-closed', () => {
    const r = new CapabilityRegistry();
    r.registerTool(mkTool('On'));
    r.registerTool(mkTool('Off', { enabled: false }));
    r.registerTool(mkTool('Boom', { enabledThrows: true }));
    const pool = r.assembleToolPool();
    expect(pool.map((t) => t.name)).toEqual(['On']);
  });

  test('filterDisabled=false keeps disabled tools', () => {
    const r = new CapabilityRegistry();
    r.registerTool(mkTool('On'));
    r.registerTool(mkTool('Off', { enabled: false }));
    const pool = r.assembleToolPool({ filterDisabled: false });
    expect(pool.map((t) => t.name).sort()).toEqual(['Off', 'On']);
  });

  test('deny by tool name (incl. alias) and by mcp server prefix at assembly time', () => {
    const r = new CapabilityRegistry();
    const pool = r.assembleToolPool({
      builtin: [mkTool('Keep'), mkTool('Banned', { aliases: ['B'] })],
      extra: [
        mkTool('mcp__bad__t', { mcpServer: 'bad' }),
        mkTool('mcp__ok__t', { mcpServer: 'ok' }),
      ],
      deny: { tools: ['B'], mcpServers: ['bad'] }, // alias hits Banned; server strips bad
    });
    expect(pool.map((t) => t.name)).toEqual(['Keep', 'mcp__ok__t']);
  });

  test('extra given but no builtin → builtin segment is empty (does not fall back to registry)', () => {
    const r = new CapabilityRegistry();
    r.registerTool(mkTool('Registered')); // would appear if it fell back
    const pool = r.assembleToolPool({ extra: [mkTool('Extra')] });
    expect(pool.map((t) => t.name)).toEqual(['Extra']);
  });
});
