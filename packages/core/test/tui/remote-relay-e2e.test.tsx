/**
 * /remote-control 双向中转端到端:渲染真实 <App>(demo provider),经 controller 注入一条
 * 入站消息 → 走 Repl 的轮路径驱动一轮 → 断言:① 本地 transcript 标注了来源;② agent 回复
 * 经 FakeChannel.send 发回了正确对端。另验「/remote-control + enter 拉起面板」键盘路径。
 *
 * 全离线(demo provider,无网络 / 无真 wechaty)。chdir tmp 隔离会话 WAL。
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';
import { App } from '../../src/tui/app';
import { createRemoteController } from '../../src/tui/remote/controller';
import { createFakeChannel, type FakeChannel } from '../../src/tui/remote/fake-channel';

const ARGS = { model: 'claude-opus-4-8', demo: true } as const;
const ENTER = '\r';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tmp: string;
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'repl-remote-'));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

async function mountApp(): Promise<{
  created: FakeChannel[];
  controller: ReturnType<typeof createRemoteController>;
  frame: () => string;
  stdin: { write(s: string): void };
  unmount: () => void;
}> {
  const opts = { ...ARGS, sessionsDir: join(tmp, '.forgeax/sessions'), sessionId: 's1' };
  const host = await buildHostContext({ ...opts });
  const driver = createAgentDriver({ ...opts }, host);
  const created: FakeChannel[] = [];
  const controller = createRemoteController(() => {
    const c = createFakeChannel();
    created.push(c);
    return c;
  });
  const r = render(React.createElement(App, { driver, controller }));
  return { created, controller, frame: () => r.lastFrame() ?? '', stdin: r.stdin, unmount: r.unmount };
}

describe('/remote-control bidirectional relay (full App)', () => {
  test('入站微信消息驱动一轮 + 回复发回对端 + 本地 transcript 标注来源', async () => {
    const app = await mountApp();
    try {
      await sleep(80); // 等 Repl 挂载 + 注册入站 sink
      await app.controller.addAccount('fake');
      const ch = app.created[0]!;
      ch.simulateLogin();
      const peer = { id: 'wx-alice', name: 'Alice' };
      ch.simulateInbound(peer, '现在几点');
      await sleep(400); // 等 demo 轮完成 + 出站回发
      // 本地 transcript 标注来源
      expect(app.frame()).toContain('[微信:Alice] 现在几点');
      // 回复发回了正确对端(demo provider 必产非空 assistant 文本)
      expect(ch.sent.length).toBeGreaterThanOrEqual(1);
      expect(ch.sent[0]!.peer).toEqual(peer);
      expect(ch.sent[0]!.text.length).toBeGreaterThan(0);
    } finally {
      app.unmount();
    }
  });

  test('键盘 /remote-control + enter 拉起远端控制面板', async () => {
    const app = await mountApp();
    try {
      await sleep(80);
      app.stdin.write('/remote-control');
      await sleep(40);
      app.stdin.write(ENTER); // command-menu 唯一匹配 + 无参 → 选中 → submit → 特判拉浮层
      await sleep(60);
      expect(app.frame()).toContain('远端控制');
      expect(app.frame()).toContain('添加微信账号');
    } finally {
      app.unmount();
    }
  });

  test('账号连上(online)→ 自动收起面板回到聊天界面', async () => {
    const app = await mountApp();
    try {
      await sleep(80);
      // 拉起面板
      app.stdin.write('/remote-control');
      await sleep(40);
      app.stdin.write(ENTER);
      await sleep(60);
      expect(app.frame()).toContain('远端控制');
      // 添加账号(此时仍在面板,等扫码)→ 模拟扫码登录成功
      await app.controller.addAccount('fake');
      const ch = app.created[0]!;
      await sleep(40);
      ch.simulateLogin();
      await sleep(120);
      // 连上后面板自动关闭,焦点回到聊天界面
      expect(app.frame()).not.toContain('远端控制');
      // 且 transcript 给出「已连接」反馈(否则用户不知是否连上)
      expect(app.frame()).toContain('已连接');
    } finally {
      app.unmount();
    }
  });
});
