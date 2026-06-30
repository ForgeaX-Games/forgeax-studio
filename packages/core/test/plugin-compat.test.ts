/**
 * PLUGIN-COMPAT — real format compatibility.
 *
 * The true on-disk contract puts component keys at the TOP LEVEL of
 * plugin.json (NOT inside a `components` array), each value being
 * `path(string) | path[] | {name:path map}` relative to the plugin root, with
 * the quirk that the manifest key is camelCase `outputStyles` while the default
 * on-disk directory is kebab `output-styles/`. mcpServers may be an inline
 * object or a json-file path; unknown top-level keys must be tolerated.
 *
 * This test materializes a real plugin in a temp dir and asserts the
 * forgeax-core loader is byte-for-byte compatible with that format.
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateManifest,
  loadPlugins,
  type LoadedPlugin,
} from '../src/capability/plugin';

describe('plugin.json compatibility (real top-level-keys format)', () => {
  let root: string;
  let builtinDir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'plugin-compat-'));
    builtinDir = join(root, 'builtin');

    // A real plugin:
    //  - camelCase `outputStyles` manifest key
    //  - inline `mcpServers` object
    //  - array `agents`
    //  - string `commands` pointing at a NON-default dir (declared extra path)
    //  - a DEFAULT `commands/` dir (always scanned, union with the declared one)
    //  - a json-file `hooks` declaration
    //  - an inline `lspServers` object
    //  - an unknown top-level key (`channels`) that must NOT cause failure
    const pdir = join(builtinDir, 'kit');
    mkdirSync(pdir, { recursive: true });

    const manifest = {
      name: 'kit',
      version: '1.2.3',
      description: 'a real plugin',
      author: { name: 'Forge', email: 'f@x.dev' },
      // top-level component keys (NOT a components[] array):
      commands: './extra-cmds', // declared extra path (file/dir)
      agents: ['./a1', './a2'], // array form
      skills: './skills', // points at default dir too — fine
      outputStyles: './styles', // camelCase key ↔ output-styles default dir
      hooks: './hooks/hooks.json', // json-file path form
      mcpServers: {
        // inline object form
        srv: { command: 'node', args: ['s.js'] },
      },
      lspServers: {
        ts: {
          command: 'typescript-language-server',
          extensionToLanguage: { '.ts': 'typescript' },
        },
      },
      // unknown / vendor top-level key — must be tolerated, not rejected:
      channels: [{ server: 'srv', displayName: 'Srv' }],
    };
    writeFileSync(join(pdir, 'plugin.json'), JSON.stringify(manifest));

    // default commands/ dir (always scanned)
    mkdirSync(join(pdir, 'commands'), { recursive: true });
    // declared extra commands path
    mkdirSync(join(pdir, 'extra-cmds'), { recursive: true });
    // declared agent files (array)
    writeFileSync(join(pdir, 'a1'), '# agent 1');
    writeFileSync(join(pdir, 'a2'), '# agent 2');
    // skills default + declared (same dir)
    mkdirSync(join(pdir, 'skills'), { recursive: true });
    // output-styles default dir (kebab) AND declared ./styles
    mkdirSync(join(pdir, 'output-styles'), { recursive: true });
    mkdirSync(join(pdir, 'styles'), { recursive: true });
    // hooks dir + hooks.json (declared by manifest path)
    mkdirSync(join(pdir, 'hooks'), { recursive: true });
    writeFileSync(
      join(pdir, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash(*)',
              hooks: [{ type: 'command', command: 'guard.sh' }],
            },
          ],
        },
      }),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('validateManifest accepts the real top-level-keys manifest', () => {
    const raw = {
      name: 'kit',
      version: '1.2.3',
      description: 'x',
      author: { name: 'F' },
      commands: './cmds',
      agents: ['./a1', './a2'],
      skills: './skills',
      outputStyles: './styles',
      hooks: './hooks/hooks.json',
      mcpServers: { srv: { command: 'node', args: ['s.js'] } },
      lspServers: { ts: { command: 'ts-ls' } },
      channels: [{ server: 'srv' }], // unknown key tolerated
    };
    const v = validateManifest(raw);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.manifest.commands).toBe('./cmds');
      expect(v.manifest.agents).toEqual(['./a1', './a2']);
      expect(v.manifest.outputStyles).toBe('./styles');
      expect(v.manifest.mcpServers).toEqual({
        srv: { command: 'node', args: ['s.js'] },
      });
      // unknown top-level key captured under `extra`, not rejected:
      expect(v.manifest.extra?.channels).toBeDefined();
    }
  });

  test('unknown top-level keys do not fail validation', () => {
    const v = validateManifest({
      name: 'p',
      somethingVendorSpecific: { a: 1 },
      anotherFutureField: 'x',
    });
    expect(v.ok).toBe(true);
  });

  test('camelCase outputStyles key normalizes to output-styles component', () => {
    const { plugins } = loadPlugins([{ source: 'builtin', dir: builtinDir }]);
    const p = plugins.find((x) => x.name === 'kit') as LoadedPlugin;
    expect(p).toBeDefined();
    expect(([...p.componentKinds] as string[]).includes('output-styles')).toBe(true);
    // default output-styles/ dir discovered
    expect(p.outputStylesPath).toContain('output-styles');
    // declared ./styles surfaced as an extra path
    expect(p.outputStylesPaths?.some((x) => x.endsWith('styles'))).toBe(true);
  });

  test('discovery = default dir ∪ manifest-declared extra paths', () => {
    const { plugins } = loadPlugins([{ source: 'builtin', dir: builtinDir }]);
    const p = plugins.find((x) => x.name === 'kit')!;

    // commands: default dir AND declared extra-cmds both present
    expect(p.commandsPath).toContain('commands');
    expect(p.commandsPaths?.some((x) => x.endsWith('extra-cmds'))).toBe(true);

    // agents: array-declared files (no default agents/ dir here)
    expect(p.agentsPath).toBeUndefined();
    expect(p.agentsPaths?.length).toBe(2);
    expect(p.agentsPaths?.some((x) => x.endsWith('a1'))).toBe(true);
    expect(p.agentsPaths?.some((x) => x.endsWith('a2'))).toBe(true);

    // at least 5 component PATHS discovered across the kinds:
    const pathCount =
      (p.commandsPath ? 1 : 0) +
      (p.commandsPaths?.length ?? 0) +
      (p.agentsPaths?.length ?? 0) +
      (p.skillsPath ? 1 : 0) +
      (p.outputStylesPath ? 1 : 0) +
      (p.outputStylesPaths?.length ?? 0) +
      (p.hooksPath ? 1 : 0);
    expect(pathCount).toBeGreaterThanOrEqual(5);
  });

  test('inline mcpServers object is resolved onto the plugin', () => {
    const { plugins } = loadPlugins([{ source: 'builtin', dir: builtinDir }]);
    const p = plugins.find((x) => x.name === 'kit')!;
    expect(p.mcpServers).toBeDefined();
    expect(p.mcpServers?.srv).toEqual({ command: 'node', args: ['s.js'] });
  });

  test('inline lspServers object is resolved onto the plugin', () => {
    const { plugins } = loadPlugins([{ source: 'builtin', dir: builtinDir }]);
    const p = plugins.find((x) => x.name === 'kit')!;
    expect(p.lspServers?.ts).toBeDefined();
  });

  test('manifest-declared hooks.json path is parsed into hooksConfig', () => {
    const { plugins } = loadPlugins([{ source: 'builtin', dir: builtinDir }]);
    const p = plugins.find((x) => x.name === 'kit')!;
    expect(p.hooksConfig?.PreToolUse?.[0]?.matcher).toBe('Bash(*)');
    expect(p.hooksConfig?.PreToolUse?.[0]?.hooks[0]?.command).toBe('guard.sh');
  });

  test('mcpServers can also be a path to a .mcp.json file', () => {
    const pdir = join(builtinDir, 'mcp-file');
    mkdirSync(pdir, { recursive: true });
    writeFileSync(
      join(pdir, 'plugin.json'),
      JSON.stringify({ name: 'mcp-file', mcpServers: './my-mcp.json' }),
    );
    writeFileSync(
      join(pdir, 'my-mcp.json'),
      JSON.stringify({
        mcpServers: { db: { command: 'dbsrv' } },
      }),
    );
    const { plugins } = loadPlugins([{ source: 'builtin', dir: builtinDir }]);
    const p = plugins.find((x) => x.name === 'mcp-file')!;
    expect(p.mcpServers?.db).toEqual({ command: 'dbsrv' });
  });

  test('default .mcp.json in plugin root is auto-loaded (no manifest decl)', () => {
    const pdir = join(builtinDir, 'mcp-default');
    mkdirSync(pdir, { recursive: true });
    writeFileSync(
      join(pdir, 'plugin.json'),
      JSON.stringify({ name: 'mcp-default' }),
    );
    writeFileSync(
      join(pdir, '.mcp.json'),
      JSON.stringify({ mcpServers: { auto: { command: 'autosrv' } } }),
    );
    const { plugins } = loadPlugins([{ source: 'builtin', dir: builtinDir }]);
    const p = plugins.find((x) => x.name === 'mcp-default')!;
    expect(p.mcpServers?.auto).toEqual({ command: 'autosrv' });
  });
});
