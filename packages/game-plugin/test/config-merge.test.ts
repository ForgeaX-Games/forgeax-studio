import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findClient, type ClientSpec } from '../src/install/clients';
import { inspectConfig, mergeJsonConfig } from '../src/install/write-config';
import { hasTomlTable, upsertTomlTable } from '../src/install/toml-section';

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
