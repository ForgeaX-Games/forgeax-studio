import { describe, expect, test } from 'bun:test';
import {
  BLOCK_VERSION,
  inspectBlock,
  renderBlock,
  upsertBlock,
} from '../src/agents-md/managed-block';

const BODY = '## ForgeaX\n\nUse the MCP server.';

describe('managed AGENTS.md block', () => {
  test('reports all four states', () => {
    expect(inspectBlock(undefined, BODY).status).toBe('missing_file');
    expect(inspectBlock('# User rules\n', BODY).status).toBe('missing_block');
    expect(inspectBlock(renderBlock('old body'), BODY).status).toBe('outdated');
    expect(
      inspectBlock(renderBlock(BODY).replace('Use the MCP server.', 'Use shell commands.'), BODY).status,
    ).toBe('outdated');
    expect(inspectBlock(renderBlock(BODY), BODY)).toEqual({
      status: 'current',
      foundVersion: BLOCK_VERSION,
      expectedVersion: BLOCK_VERSION,
    });
  });

  test('appends and replaces only the owned block', () => {
    const first = upsertBlock('# User rules\n', BODY);
    expect(first).toStartWith('# User rules\n\n');
    expect(first).toContain(renderBlock(BODY));

    const updated = upsertBlock(first, `${BODY}\n\nNew rule.`);
    expect(updated).toStartWith('# User rules\n\n');
    expect(updated).toContain('New rule.');
    expect(updated.match(/BEGIN FORGEAX GAME PLUGIN/g)).toHaveLength(1);
  });
});
