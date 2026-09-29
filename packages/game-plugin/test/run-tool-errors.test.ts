import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createForgeaxMcpServer } from '../src/mcp/forgeax-server';
import { dispatch } from '../src/mcp/protocol';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('forgeax_run_current_game failure semantics', () => {
  test('returns an MCP isError result instead of successful error text', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'forgeax-run-error-'));
    roots.push(empty);
    const response = await dispatch(createForgeaxMcpServer(), {
      id: 1,
      method: 'tools/call',
      params: {
        name: 'forgeax_run_current_game',
        arguments: { target_dir: empty, start_services: true },
      },
    });
    expect(response).toMatchObject({
      result: {
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('no released Engine game found') }],
      },
    });
  });
});
