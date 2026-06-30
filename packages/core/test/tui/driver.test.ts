/**
 * T10 — agent driver(embed CoreAgent)用 --demo provider 跑一轮,断言事件序列。
 *
 * 走 host-context 全量装配(buildHostContext,demo=true 免 key)→ createAgentDriver
 * (直构 CoreAgent,不经 runTurn)→ driveTurn 收集 AgentEvent。验:
 *   - 序列含 turn_start … assistant … done(契约 T2 / DoD §T2)。
 *   - assistant 文本带回显(demo provider 闭环证据)。
 *   - driver.model 暴露当前模型;allowAlways / setMode / setAskUser / abort 可调不抛。
 *   - dispose 干净退出(disposers await)。
 */
import { test, expect, describe } from 'bun:test';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';
import type { AgentEvent } from '../../src/tui/contracts';

const ARGS = { model: 'claude-opus-4-8', demo: true } as const;

describe('agent driver (demo provider, no key)', () => {
  test('driveTurn emits turn_start … assistant … done in order', async () => {
    const host = await buildHostContext({ ...ARGS });
    const driver = createAgentDriver({ ...ARGS }, host);
    try {
      const events: AgentEvent[] = [];
      await driver.driveTurn('ping', (e) => events.push(e));
      const types = events.map((e) => e.type);

      expect(types).toContain('turn_start');
      expect(types).toContain('assistant');
      expect(types).toContain('done');

      // 顺序:turn_start 在 assistant 前,assistant 在 done 前。
      const iStart = types.indexOf('turn_start');
      const iAssistant = types.indexOf('assistant');
      const iDone = types.indexOf('done');
      expect(iStart).toBeLessThan(iAssistant);
      expect(iAssistant).toBeLessThan(iDone);
    } finally {
      await driver.dispose();
    }
  });

  test('assistant event carries demo echo text', async () => {
    const host = await buildHostContext({ ...ARGS });
    const driver = createAgentDriver({ ...ARGS }, host);
    try {
      const events: AgentEvent[] = [];
      await driver.driveTurn('hello-tui', (e) => events.push(e));
      const assistant = events.find((e) => e.type === 'assistant');
      expect(assistant).toBeTruthy();
      const content = (
        (assistant as Extract<AgentEvent, { type: 'assistant' }>).message.payload as {
          content?: Array<{ type: string; text?: string }>;
        }
      )?.content;
      const text = (content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      expect(text).toContain('forgeax-core(demo)');
      expect(text).toContain('hello-tui');
    } finally {
      await driver.dispose();
    }
  });

  test('done terminal is reached (turn completes)', async () => {
    const host = await buildHostContext({ ...ARGS });
    const driver = createAgentDriver({ ...ARGS }, host);
    try {
      const events: AgentEvent[] = [];
      await driver.driveTurn('ping', (e) => events.push(e));
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeTruthy();
    } finally {
      await driver.dispose();
    }
  });

  test('driver surface (model / allowAlways / setMode / setAskUser / abort) callable without throwing', async () => {
    const host = await buildHostContext({ ...ARGS });
    const driver = createAgentDriver({ ...ARGS }, host);
    try {
      expect(driver.model).toBe('claude-opus-4-8');
      expect(() => driver.setMode('default')).not.toThrow();
      expect(() => driver.setAskUser(async () => true)).not.toThrow();
      expect(() => driver.allowAlways('Bash')).not.toThrow();
      // abort 无在飞轮时安全 no-op(agent 尚未构造)。
      expect(() => driver.abort('test')).not.toThrow();
    } finally {
      await driver.dispose();
    }
  });
});
