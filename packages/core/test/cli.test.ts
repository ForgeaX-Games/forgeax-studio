/**
 * CLI form tests — the runnable form factor。drives the
 * CLI pipeline with a stub provider + a real temp-dir SandboxFs path, no network.
 */
import { test, expect, describe } from 'bun:test';
import { parseArgs, buildContext, runTurn, runCli } from '../src/cli/main';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

function textProvider(text: string): LLMProvider {
  return {
    api: 'stub',
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        usage: EMPTY_USAGE as Usage,
        stopReason: 'end_turn',
      };
    },
  };
}

function toolThenText(): LLMProvider {
  let n = 0;
  return {
    api: 'stub',
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      n++;
      if (n === 1) {
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'echo hi' } }] },
          usage: EMPTY_USAGE as Usage,
          stopReason: 'tool_use',
        };
      } else {
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] },
          usage: EMPTY_USAGE as Usage,
          stopReason: 'end_turn',
        };
      }
    },
  };
}

describe('CLI arg parsing', () => {
  test('-p / --model / --demo / flags', () => {
    expect(parseArgs(['-p', 'hello']).prompt).toBe('hello');
    expect(parseArgs(['--model', 'gpt-5']).model).toBe('gpt-5');
    expect(parseArgs(['--demo']).demo).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['just a prompt']).prompt).toBe('just a prompt');
  });
});

describe('CLI pipeline runs a turn end-to-end', () => {
  test('renders assistant text from a stub provider', async () => {
    const ctx = buildContext({ model: 'm', demo: false, help: false, version: false }, textProvider('CLI works ✅'));
    let out = '';
    const reason = await runTurn(ctx, 'hi', (s) => (out += s));
    expect(out).toContain('CLI works ✅');
    expect(reason).toBe('completed');
  });

  test('real builtin bash tool runs via NodeTerminal (real IO)', async () => {
    const ctx = buildContext({ model: 'm', demo: false, help: false, version: false }, toolThenText());
    let out = '';
    const reason = await runTurn(ctx, 'run echo', (s) => (out += s));
    expect(out).toContain('⏺ bash'); // tool call rendered
    expect(reason).toBe('completed');
  });
});

describe('CLI runCli entry', () => {
  test('--help returns 0', async () => {
    expect(await runCli(['--help'])).toBe(0);
  });
  test('--version returns 0', async () => {
    expect(await runCli(['--version'])).toBe(0);
  });
  test('-p with provider override runs and returns 0', async () => {
    expect(await runCli(['-p', 'hi'], textProvider('ok'))).toBe(0);
  });
  test('no API key + no demo → exit 1 with guidance', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await runCli(['-p', 'hi'])).toBe(1);
    } finally {
      if (saved != null) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
