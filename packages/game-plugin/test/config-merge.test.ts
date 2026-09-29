import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findClient, type ClientSpec } from '../src/install/clients';
import {
  configuredGameVersion,
  inspectConfig,
  mergeJsonConfig,
  mergeTomlConfig,
} from '../src/install/write-config';
import { hasTomlTable, upsertTomlTable } from '../src/install/toml-section';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('configuration merge', () => {
  test('original-plan clients resolve to their native config shapes', () => {
    const project = '/tmp/forgeax-project';

    const trae = findClient('trae');
    expect(trae?.scope).toBe('project');
    expect(trae?.path(project)).toBe(join(project, '.trae', 'mcp.json'));
    expect(trae?.serverMapKey).toEqual(['mcpServers']);

    const codebuddy = findClient('codebuddy');
    expect(codebuddy?.path(project)).toEndWith(join('.codebuddy', '.mcp.json'));
    expect(findClient('workbuddy')).toBe(codebuddy);

    const zcode = findClient('zcode');
    expect(zcode?.scope).toBe('user');
    expect(zcode?.path(project)).toEndWith(join('.zcode', 'cli', 'config.json'));
    expect(zcode?.serverMapKey).toEqual(['mcp', 'servers']);
  });

  test('TOML replacement preserves neighbouring tables byte-for-byte', () => {
    const input = [
      'model = "gpt-test"',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      '',
      '',
      '[mcp_servers.forgeax]',
      'command = "old"',
      'args = ["old"]',
      '',
      '[projects."/tmp/demo"]',
      'trust_level = "trusted"',
      '',
      '',
      '',
    ].join('\n');

    const output = upsertTomlTable(input, {
      header: 'mcp_servers.forgeax',
      body: ['command = "npx"', 'args = ["-y", "@forgeax/game"]'],
    });

    expect(output).toStartWith('model = "gpt-test"\n\n[mcp_servers.other]\ncommand = "other"\n\n\n');
    expect(output).toEndWith('[projects."/tmp/demo"]\ntrust_level = "trusted"\n\n\n');
    expect(output).not.toContain('command = "old"');
    expect(output).toContain('[mcp_servers.forgeax]\ncommand = "npx"');
  });

  test('TOML replacement recognizes quoted keys and trailing header comments', () => {
    const input = [
      '[mcp_servers."forgeax"] # managed locally',
      'command = "old"',
      '',
      '[mcp_servers.other]',
      'command = "keep"',
      '',
    ].join('\n');
    expect(hasTomlTable(input, 'mcp_servers.forgeax')).toBeTrue();

    const output = upsertTomlTable(input, {
      header: 'mcp_servers.forgeax',
      body: ['command = "new"'],
    });
    expect(output).toContain('[mcp_servers."forgeax"] # managed locally\ncommand = "new"');
    expect(output.match(/managed locally/g)).toHaveLength(1);
    expect(output).toContain('[mcp_servers.other]\ncommand = "keep"');
  });

  test('Codex hook table keys may contain brackets inside quoted segments', () => {
    const hookHeader = '[hooks.state."browser@openai-bundled:plugin.json#hooks[0]:stop:0:0"]';
    const input = `${hookHeader}\ntrusted_hash = "sha256:abc"\n`;
    const output = mergeTomlConfig(input, {
      command: 'node',
      args: ['server.js'],
    }).content;

    expect(output).toStartWith(input);
    expect(output).toContain('[mcp_servers.forgeax]\ncommand = "node"');
    expect(() => mergeTomlConfig('[hooks.state.bad] trailing\n', {
      command: 'node',
      args: ['server.js'],
    })).toThrow(/invalid TOML table header/);
  });

  test('merges a separately named Asset3D server without replacing forgeax', () => {
    const input = '[mcp_servers.forgeax]\ncommand = "npx"\n';
    const output = mergeTomlConfig(input, {
      command: 'npx',
      args: ['-y', '@forgeax/game@0.3.5', 'asset3d', 'mcp'],
    }, 'asset3d-search').content;
    expect(output).toStartWith(input);
    expect(output).toContain('[mcp_servers.asset3d-search]');
    expect(output.match(/\[mcp_servers\.forgeax\]/g)).toHaveLength(1);
  });

  test('inspects a separately named Asset3D server without treating forgeax as it', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-custom-server-inspect-'));
    const spec: ClientSpec = {
      id: 'codex', label: 'Codex', format: 'toml', scope: 'user',
      path: () => join(root, 'config.toml'), commandShape: 'split',
    };
    try {
      writeFileSync(spec.path(root), '[mcp_servers.forgeax]\ncommand = "npx"\n');
      expect(inspectConfig(spec, root, {
        command: 'npx', args: ['asset3d', 'mcp'],
      }, 'asset3d-search').state).toBe('not_configured');
      writeFileSync(spec.path(root), '[mcp_servers.asset3d-search]\ncommand = "foreign"\n');
      expect(inspectConfig(spec, root, {
        command: 'npx', args: ['asset3d', 'mcp'],
      }, 'asset3d-search').state).toBe('different');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('TOML replacement refuses competing inline and parent-table definitions', () => {
    expect(() =>
      upsertTomlTable('mcp_servers.forgeax = { command = "custom" }\n', {
        header: 'mcp_servers.forgeax',
        body: ['command = "new"'],
      }),
    ).toThrow('refusing to append a duplicate table');
    expect(() =>
      upsertTomlTable('"mcp_servers".\'forgeax\' = { command = "custom" }\n', {
        header: 'mcp_servers.forgeax',
        body: ['command = "new"'],
      }),
    ).toThrow('refusing to append a duplicate table');
    expect(() =>
      upsertTomlTable('"mcp_\\u0073ervers"."forgeax" = { command = "custom" }\n', {
        header: 'mcp_servers.forgeax',
        body: ['command = "new"'],
      }),
    ).toThrow('refusing to append a duplicate table');

    expect(() =>
      upsertTomlTable('mcp_servers = { forgeax = { command = "custom" } }\n', {
        header: 'mcp_servers.forgeax',
        body: ['command = "new"'],
      }),
    ).toThrow('refusing to append a duplicate table');

    expect(() =>
      upsertTomlTable('[mcp_servers]\nforgeax = { command = "custom" }\n', {
        header: 'mcp_servers.forgeax',
        body: ['command = "new"'],
      }),
    ).toThrow('refusing to append a duplicate table');
  });

  test('Codex inspection recognizes a quoted forgeax table', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-toml-inspect-'));
    const path = join(root, 'config.toml');
    const spec: ClientSpec = {
      id: 'codex',
      label: 'Codex',
      format: 'toml',
      scope: 'user',
      path: () => path,
      commandShape: 'split',
    };
    writeFileSync(
      path,
      '[mcp_servers."forgeax"] # user comment\ncommand = "node"\nargs = ["server.js"]\n',
    );
    try {
      expect(inspectConfig(spec, root, { command: 'node', args: ['server.js'] }).state).toBe(
        'current',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reads the configured plugin version from TOML and JSON client entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-version-inspect-'));
    const tomlPath = join(root, 'config.toml');
    const jsonPath = join(root, 'mcp.json');
    const codex: ClientSpec = {
      id: 'codex',
      label: 'Codex',
      format: 'toml',
      scope: 'user',
      path: () => tomlPath,
      commandShape: 'split',
    };
    const cursor: ClientSpec = {
      id: 'cursor',
      label: 'Cursor',
      format: 'json',
      scope: 'user',
      path: () => jsonPath,
      serverMapKey: ['mcpServers'],
      commandShape: 'split',
    };
    writeFileSync(
      tomlPath,
      '[mcp_servers.forgeax]\ncommand = "npx"\nargs = ["-y", "-p", "@forgeax/game@0.3.2", "forgeax-game", "mcp"]\n',
    );
    writeFileSync(
      jsonPath,
      JSON.stringify({
        mcpServers: {
          forgeax: { command: process.execPath, args: ['/tmp/game-plugin/dist/main.js', 'mcp'] },
        },
      }),
    );
    try {
      expect(configuredGameVersion(codex, root)).toBe('0.3.2');
      expect(configuredGameVersion(cursor, root)).toBe('local/custom');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('JSON merge preserves other servers and unrelated settings', () => {
    const spec: ClientSpec = {
      id: 'cursor',
      label: 'Cursor',
      format: 'json',
      scope: 'user',
      path: () => '/tmp/mcp.json',
      serverMapKey: ['mcpServers'],
      commandShape: 'split',
    };
    const existing = JSON.stringify({
      theme: 'dark',
      mcpServers: { other: { command: 'other-bin', args: ['serve'] } },
    });
    const entry = { command: 'npx', args: ['-y', '-p', '@forgeax/game', 'forgeax-game', 'mcp'] };

    const merged = mergeJsonConfig(existing, spec, entry);
    expect(JSON.parse(merged.content)).toEqual({
      theme: 'dark',
      mcpServers: {
        other: { command: 'other-bin', args: ['serve'] },
        forgeax: entry,
      },
    });
    expect(merged.changed).toBeTrue();
  });

  test('ZCode merge preserves native settings and is idempotent', () => {
    const zcode = findClient('zcode')!;
    const entry = { command: 'npx', args: ['-y', '-p', '@forgeax/game', 'forgeax-game', 'mcp'] };
    const existing = JSON.stringify({
      locale: 'zh-CN',
      mcp: {
        servers: { memory: { command: 'memory-server', args: [] } },
        reconnectOnStart: true,
      },
      permissions: { mode: 'plan' },
    });

    const merged = mergeJsonConfig(existing, zcode, entry);
    expect(JSON.parse(merged.content)).toEqual({
      locale: 'zh-CN',
      mcp: {
        servers: {
          memory: { command: 'memory-server', args: [] },
          forgeax: entry,
        },
        reconnectOnStart: true,
      },
      permissions: { mode: 'plan' },
    });
    expect(merged.changed).toBeTrue();
    expect(mergeJsonConfig(merged.content, zcode, entry).changed).toBeFalse();
  });

  test('ZCode merge refuses incompatible native MCP nesting', () => {
    const zcode = findClient('zcode')!;
    expect(() =>
      mergeJsonConfig(JSON.stringify({ mcp: ['user-owned'] }), zcode, {
        command: 'node',
        args: ['server.js'],
      }),
    ).toThrow('refusing to overwrite existing user data');
    expect(() =>
      mergeJsonConfig(JSON.stringify({ mcp: { servers: false } }), zcode, {
        command: 'node',
        args: ['server.js'],
      }),
    ).toThrow('refusing to overwrite existing user data');
  });

  test('JSON merge refuses to replace an incompatible existing server map', () => {
    const spec: ClientSpec = {
      id: 'cursor',
      label: 'Cursor',
      format: 'json',
      scope: 'user',
      path: () => '/tmp/mcp.json',
      serverMapKey: ['mcpServers'],
      commandShape: 'split',
    };
    expect(() =>
      mergeJsonConfig(
        JSON.stringify({ theme: 'dark', mcpServers: ['user-owned', 'value'] }),
        spec,
        { command: 'node', args: ['server.js'] },
      ),
    ).toThrow('refusing to overwrite existing user data');
  });
});
