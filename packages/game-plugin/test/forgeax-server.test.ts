import { describe, expect, test } from 'bun:test';
import { createForgeaxMcpServer, publicPreviewResult } from '../src/mcp/forgeax-server';

describe('ForgeaX MCP server modes', () => {
  test('keeps target_dir local to stdio and adds authoring tools only for HTTP mode', () => {
    const local = createForgeaxMcpServer();
    const remote = createForgeaxMcpServer({ root: '/tmp/project', authoringTools: true, allowTargetDir: false });
    const localStatus = local.tools.find((tool) => tool.name === 'forgeax_status_lite')!;
    const remoteStatus = remote.tools.find((tool) => tool.name === 'forgeax_status_lite')!;
    const remoteRun = remote.tools.find((tool) => tool.name === 'forgeax_run_current_game')!;

    expect((localStatus.inputSchema.properties as any).target_dir).toBeDefined();
    expect((remoteStatus.inputSchema.properties as any).target_dir).toBeUndefined();
    expect((remoteRun.inputSchema.properties as any).target_dir).toBeUndefined();
    expect(remote.tools.some((tool) => tool.name === 'forgeax_game_write_file')).toBe(true);
    expect(local.tools.some((tool) => tool.name === 'forgeax_game_write_file')).toBe(false);
  });

  test('rewrites only the preview URL onto the configured public origin', () => {
    const input = [
      'game: demo',
      'preview_url: http://127.0.0.1:15173/preview/?game=demo',
      'runtime_logs.local_file: /tmp/runtime.log',
    ].join('\n');
    expect(publicPreviewResult(input, 'https://studio.example.test')).toContain(
      'preview_url: https://studio.example.test/preview/?game=demo',
    );
    expect(publicPreviewResult(input, 'not-a-url')).toBe(input);
  });
});
