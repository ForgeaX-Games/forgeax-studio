/**
 * 回退点 UI 端到端:渲染真实 <App>,模拟「双击 ESC → 选回退点 → 看 diff → 再 enter 确认」
 * 全键盘流程,断言盘上文件被真正还原。用 demo provider(turn 不改文件),手动写文件模拟
 * 「这一轮 agent 改了文件」。chdir 到 tmp 隔离。
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';
import type { AgentDriver } from '../../src/tui/contracts';
import { App } from '../../src/tui/app';
import { createRemoteController } from '../../src/tui/remote/controller';
import { createFakeChannel } from '../../src/tui/remote/fake-channel';

const ARGS = { model: 'claude-opus-4-8', demo: true } as const;
const ESC = String.fromCharCode(27);
const ENTER = '\r';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  prevCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'repl-cp-'));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe('回退点 UI flow reverts files', () => {
  test('type -> ESC ESC -> enter(select) -> enter(confirm) reverts foo.ts', async () => {
    writeFileSync(join(tmp, 'foo.ts'), 'v1\n');
    const opts = { ...ARGS, sessionsDir: join(tmp, '.forgeax/sessions'), sessionId: 's1' };
    const host = await buildHostContext({ ...opts });
    const driver: AgentDriver = createAgentDriver({ ...opts }, host);
    const controller = createRemoteController(() => createFakeChannel());
    const { stdin, lastFrame, unmount } = render(React.createElement(App, { driver, controller }));
    try {
      await sleep(60);
      // 1) 发一轮(submit 内 checkpointTurn 对 cwd 拍快照:foo=v1)
      stdin.write('change foo');
      await sleep(30);
      stdin.write(ENTER); // enter -> submit -> demo turn(不改文件)
      await sleep(250); // 等 turn 完成(busy 落回)

      // 2) 模拟「这一轮 agent 把 foo 改成 v2」
      writeFileSync(join(tmp, 'foo.ts'), 'v2\n');
      expect(readFileSync(join(tmp, 'foo.ts'), 'utf-8')).toBe('v2\n');

      // 3) 双击 ESC 拉起回退点面板(空闲 + 空输入)
      stdin.write(ESC);
      await sleep(50);
      stdin.write(ESC);
      await sleep(100);
      // 面板应已弹出(确认 UI 路径活着)
      expect(lastFrame()).toContain('回退点');

      // 4) enter 选中回退点 -> 进 confirm(显示 diff)
      stdin.write(ENTER);
      await sleep(100);
      expect(lastFrame()).toContain('确认回退');

      // 5) enter 确认 -> 真正执行回退(文件还原)
      stdin.write(ENTER);
      await sleep(250);

      // ★ 关键断言:foo.ts 已还原到 v1
      expect(readFileSync(join(tmp, 'foo.ts'), 'utf-8')).toBe('v1\n');
    } finally {
      unmount();
      await driver.dispose();
    }
  });
});
