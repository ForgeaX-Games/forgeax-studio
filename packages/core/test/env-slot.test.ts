/**
 * env-slot tests —— 验证 cwd 锚点真被拼进 system prompt(防模型瞎拼绝对路径)。
 * 纯函数 + slot 形状 + buildContext 集成三层,无网络。
 */
import { test, expect, describe } from 'bun:test';
import { makeEnvSlot, renderEnvBlock } from '../src/cli/env-slot';
import { buildContext, parseArgs } from '../src/cli/main';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

function stubProvider(): LLMProvider {
  return {
    api: 'stub',
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        usage: EMPTY_USAGE as Usage,
        stopReason: 'end_turn',
      };
    },
  };
}

describe('renderEnvBlock', () => {
  test('git 仓:含 cwd / Yes / 分支 / platform / date,<env> 包裹', () => {
    const out = renderEnvBlock({
      cwd: '/abs/work/proj',
      isRepo: true,
      branch: 'main',
      platform: 'darwin',
      osVersion: '23.5.0',
      date: '2026-06-23',
    });
    expect(out.startsWith('<env>')).toBe(true);
    expect(out.endsWith('</env>')).toBe(true);
    expect(out).toContain('Working directory: /abs/work/proj');
    expect(out).toContain('Is directory a git repo: Yes');
    expect(out).toContain('Current git branch: main');
    expect(out).toContain('Platform: darwin');
    expect(out).toContain("Today's date: 2026-06-23");
  });

  test('非 git 仓:No,且不输出分支行', () => {
    const out = renderEnvBlock({
      cwd: '/tmp/x',
      isRepo: false,
      platform: 'linux',
      osVersion: '6.1',
      date: '2026-06-23',
    });
    expect(out).toContain('Is directory a git repo: No');
    expect(out).not.toContain('Current git branch');
  });
});

describe('makeEnvSlot', () => {
  test('slot 形状:name=env / static / render 含真实 cwd', () => {
    const slot = makeEnvSlot({ cwd: '/anchor/here' });
    expect(slot.name).toBe('env');
    expect(slot.dynamic).toBe(false);
    const text = slot.render({});
    expect(typeof text).toBe('string');
    expect(text as string).toContain('Working directory: /anchor/here');
  });

  test('缺省 cwd = process.cwd()', () => {
    const slot = makeEnvSlot();
    expect(slot.render({})).toContain(`Working directory: ${process.cwd()}`);
  });
});

describe('buildContext 集成', () => {
  test('env slot 排 systemPromptSlots 首位,且拼出当前 cwd', () => {
    const args = parseArgs(['--demo']);
    const ctx = buildContext(args, stubProvider());
    const slots = ctx.config.systemPromptSlots;
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0]?.name).toBe('env');
    expect(slots[0]?.render({})).toContain(`Working directory: ${process.cwd()}`);
  });
});
