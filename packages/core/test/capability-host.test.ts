/**
 * CAPHOST tests — registry (name/alias lookup, assembleToolPool builtin-prefix
 * contiguity, deny filtering), loader (4-layer whole-pack override, condition
 * skip), condition evaluator (fail-closed).
 *
 * 用 `buildTool({...})` 造假工具。loader 用真实 node:fs 扫临时目录,importer
 * 注入 (避免依赖磁盘上真有可 import 的 .ts pack 模块)。
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTool, type AgentTool, type CapabilityPack } from '../src/capability/types';
import {
  CapabilityRegistry,
  toolMatchesName,
  filterByDenyRules,
} from '../src/capability/registry';
import { CapabilityLoader, type PackImporter } from '../src/capability/loader';
import { evaluateCondition } from '../src/capability/condition';

// ─── helpers ───────────────────────────────────────────────────────────────────

function fakeTool(
  name: string,
  extra: Partial<AgentTool> = {},
): AgentTool {
  return buildTool({
    name,
    call: async () => ({ data: null }),
    mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0 }),
    maxResultSizeChars: 1000,
    ...extra,
  });
}

function mcpTool(serverName: string, toolName: string): AgentTool {
  return fakeTool(`mcp__${serverName}__${toolName}`, {
    isMcp: true,
    mcpInfo: { serverName, toolName },
  });
}

// ─── registry: name/alias lookup ────────────────────────────────────────────────

describe('CapabilityRegistry — name/alias lookup', () => {
  test('finds by primary name and by alias', () => {
    const reg = new CapabilityRegistry();
    reg.registerTool(fakeTool('read', { aliases: ['view', 'cat'] }));
    expect(reg.findTool('read')?.name).toBe('read');
    expect(reg.findTool('view')?.name).toBe('read');
    expect(reg.findTool('cat')?.name).toBe('read');
    expect(reg.findTool('nope')).toBeUndefined();
    expect(reg.hasTool('view')).toBe(true);
  });

  test('toolMatchesName matches name or alias', () => {
    const t = fakeTool('grep', { aliases: ['search'] });
    expect(toolMatchesName(t, 'grep')).toBe(true);
    expect(toolMatchesName(t, 'search')).toBe(true);
    expect(toolMatchesName(t, 'find')).toBe(false);
  });

  test('alias never shadows an existing primary name', () => {
    const reg = new CapabilityRegistry();
    reg.registerTool(fakeTool('bash'));
    // a second tool aliasing "bash" must not redirect lookups away from primary
    reg.registerTool(fakeTool('shell', { aliases: ['bash'] }));
    expect(reg.findTool('bash')?.name).toBe('bash');
  });

  test('removeTool drops aliases too', () => {
    const reg = new CapabilityRegistry();
    reg.registerTool(fakeTool('edit', { aliases: ['modify'] }));
    reg.removeTool('edit');
    expect(reg.findTool('edit')).toBeUndefined();
    expect(reg.findTool('modify')).toBeUndefined();
  });
});

// ─── registry: assembleToolPool builtin-prefix contiguity ───────────────────────

describe('CapabilityRegistry — assembleToolPool', () => {
  test('builtins form a contiguous sorted prefix before MCP/extra', () => {
    const reg = new CapabilityRegistry();
    const builtin = [fakeTool('Bash'), fakeTool('Read'), fakeTool('Edit')];
    // mcp tools whose names would interleave into builtins under a flat sort
    const extra = [mcpTool('alpha', 'do'), mcpTool('zzz', 'go')];
    const pool = reg.assembleToolPool({ builtin, extra });

    const names = pool.map((t) => t.name);
    // builtin slice is sorted and contiguous
    expect(names.slice(0, 3)).toEqual(['Bash', 'Edit', 'Read']);
    // extra slice is sorted and comes entirely after builtins
    expect(names.slice(3)).toEqual(['mcp__alpha__do', 'mcp__zzz__go']);
  });

  test('uniqBy name — builtin wins on conflict (insertion-first)', () => {
    const reg = new CapabilityRegistry();
    const builtinRead = fakeTool('Read', { searchHint: 'builtin' });
    const mcpRead = fakeTool('Read', { searchHint: 'mcp', isMcp: true });
    const pool = reg.assembleToolPool({ builtin: [builtinRead], extra: [mcpRead] });
    expect(pool).toHaveLength(1);
    expect(pool[0].searchHint).toBe('builtin');
  });

  test('filterDisabled drops isEnabled()===false tools', () => {
    const reg = new CapabilityRegistry();
    const on = fakeTool('On', { isEnabled: () => true });
    const off = fakeTool('Off', { isEnabled: () => false });
    const pool = reg.assembleToolPool({ builtin: [on, off] });
    expect(pool.map((t) => t.name)).toEqual(['On']);
  });

  test('no builtin/extra → assembles from registry as one sorted prefix', () => {
    const reg = new CapabilityRegistry();
    reg.registerTool(fakeTool('Zeta'));
    reg.registerTool(fakeTool('Alpha'));
    expect(reg.assembleToolPool().map((t) => t.name)).toEqual(['Alpha', 'Zeta']);
  });
});

// ─── registry: deny filtering (装配期, filterToolsByDenyRules) ───────────────

describe('CapabilityRegistry — deny filtering at assembly time', () => {
  test('blanket tool-name deny removes the tool', () => {
    const tools = [fakeTool('Bash'), fakeTool('Read')];
    const out = filterByDenyRules(tools, { tools: ['Bash'] });
    expect(out.map((t) => t.name)).toEqual(['Read']);
  });

  test('alias-targeted deny removes the tool by alias', () => {
    const tools = [fakeTool('Read', { aliases: ['view'] })];
    expect(filterByDenyRules(tools, { tools: ['view'] })).toHaveLength(0);
  });

  test('mcp__server prefix deny strips all tools from that server', () => {
    const tools = [
      mcpTool('github', 'list'),
      mcpTool('github', 'create'),
      mcpTool('slack', 'post'),
    ];
    const out = filterByDenyRules(tools, { mcpServers: ['github'] });
    expect(out.map((t) => t.name)).toEqual(['mcp__slack__post']);
  });

  test('assembleToolPool applies deny to builtin + extra', () => {
    const reg = new CapabilityRegistry();
    const pool = reg.assembleToolPool({
      builtin: [fakeTool('Bash'), fakeTool('Read')],
      extra: [mcpTool('github', 'x')],
      deny: { tools: ['Bash'], mcpServers: ['github'] },
    });
    expect(pool.map((t) => t.name)).toEqual(['Read']);
  });
});

// ─── condition evaluator (§3.4.9, fail-closed) ──────────────────────────────────

describe('evaluateCondition — fail-closed (condition wrap)', () => {
  test('undefined condition → always active', () => {
    expect(evaluateCondition(undefined, {})).toBe(true);
  });
  test('truthy/falsy passthrough', () => {
    expect(evaluateCondition((ctx) => ctx.role === 'forge', { role: 'forge' })).toBe(true);
    expect(evaluateCondition((ctx) => ctx.role === 'forge', { role: 'iori' })).toBe(false);
  });
  test('throwing condition fails closed (false)', () => {
    expect(
      evaluateCondition(() => {
        throw new Error('boom');
      }, {}),
    ).toBe(false);
  });
});

// ─── loader: 4-layer whole-pack override + condition skip ────────────────────────

describe('CapabilityLoader — 4-layer whole-pack override + condition skip', () => {
  let root: string;
  // packName → entryPath → the pack the injected importer should return
  const packModules = new Map<string, CapabilityPack>();

  // injected importer: keyed by entryPath, returns { default: pack }
  const importer: PackImporter = async (entryPath) => {
    const pack = packModules.get(entryPath);
    if (!pack) throw new Error(`no module for ${entryPath}`);
    return { default: pack };
  };

  function makePack(
    dir: string,
    layer: 'builtin' | 'user' | 'session' | 'agent',
    name: string,
    extra: Partial<CapabilityPack> = {},
  ): void {
    const packDir = join(root, dir, name);
    mkdirSync(packDir, { recursive: true });
    const entryPath = join(packDir, 'index.ts');
    writeFileSync(entryPath, '// fake pack entry\n');
    packModules.set(entryPath, { name, layer, ...extra });
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'caphost-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('higher layer replaces same-named pack entirely (agent > builtin)', async () => {
    // same pack name "core-tools" in builtin and agent → agent wins, builtin hidden
    makePack('builtin', 'builtin', 'core-tools', { tools: [fakeTool('builtin-only')] });
    makePack('agent', 'agent', 'core-tools', { tools: [fakeTool('agent-only')] });
    // an unrelated builtin-only pack survives
    makePack('builtin', 'builtin', 'extra-pack', { tools: [fakeTool('extra')] });

    const loader = new CapabilityLoader({
      sources: [
        { layer: 'builtin', dir: join(root, 'builtin') },
        { layer: 'user', dir: join(root, 'user') },
        { layer: 'session', dir: join(root, 'session') },
        { layer: 'agent', dir: join(root, 'agent') },
      ],
      importer,
    });

    const active = await loader.load({});
    const byName = new Map(active.map((p) => [p.name, p]));
    expect(byName.size).toBe(2);
    // whole-pack replace: core-tools comes from agent layer, builtin tool gone
    expect(loader.layerOf('core-tools')).toBe('agent');
    expect(byName.get('core-tools')?.tools?.map((t) => t.name)).toEqual(['agent-only']);
    expect(byName.get('extra-pack')?.tools?.map((t) => t.name)).toEqual(['extra']);
  });

  test('condition false → whole pack skipped', async () => {
    makePack('builtin', 'builtin', 'gated', {
      tools: [fakeTool('gated-tool')],
      condition: (ctx) => ctx.role === 'forge',
    });
    const loader = new CapabilityLoader({
      sources: [{ layer: 'builtin', dir: join(root, 'builtin') }],
      importer,
    });

    const asIori = await loader.load({ role: 'iori' });
    expect(asIori.find((p) => p.name === 'gated')).toBeUndefined();

    const asForge = await loader.load({ role: 'forge' });
    expect(asForge.find((p) => p.name === 'gated')?.name).toBe('gated');
  });

  test('reload re-imports a pack and honors condition', async () => {
    makePack('builtin', 'builtin', 'hot', {
      tools: [fakeTool('hot-tool')],
      condition: (ctx) => ctx.role !== 'banned',
    });
    const loader = new CapabilityLoader({
      sources: [{ layer: 'builtin', dir: join(root, 'builtin') }],
      importer,
    });
    await loader.load({ role: 'ok' });
    const reloaded = await loader.reload('hot');
    expect(reloaded?.name).toBe('hot');

    // condition flips on reload under a context that gates it out
    await loader.load({ role: 'banned' });
    expect(await loader.reload('hot')).toBeNull();

    // vanished pack → reload returns null
    expect(await loader.reload('does-not-exist')).toBeNull();
  });
});
